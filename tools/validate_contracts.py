#!/usr/bin/env python3
"""Validate A1 contract artifacts from the repository root.

Checks:
- UTF-8, LF, final newline
- JSON parsing
- JSON Schema Draft 2020-12 syntax
- local $ref resolution and contract behavior samples
- Markdown relative links
- likely secret values
- required/forbidden repository paths
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "docs" / "a1" / "contracts"
FORMAT_CHECKER = FormatChecker()

TEXT_SUFFIXES = {
    ".md", ".json", ".py", ".gs", ".html", ".css", ".js",
    ".txt", ".yml", ".yaml", ".editorconfig", ".gitattributes",
}

REQUIRED_PATHS = [
    ROOT / ".gitattributes",
    ROOT / ".editorconfig",
    ROOT / "README.md",
    ROOT / "docs" / "handoffs" / "A1_HANDOFF.md",
    ROOT / "docs" / "a1" / "contracts" / "chat-result.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "approved-character-artifact.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "character-profile-v1.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "character-profile-v2.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "event.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "immersion-guard-decision.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "immersion-semantic-verdict.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "memory-candidate.schema.json",
    ROOT / "docs" / "a1" / "contracts" / "memory-candidates.schema.json",
]

FORBIDDEN_PATHS = [
    ROOT / "HANDOFF.md",
    ROOT / ".github" / "COMMIT_MESSAGE.txt",
    ROOT / ".github" / "PR_TITLE.txt",
    ROOT / ".github" / "PULL_REQUEST_BODY.md",
]

SECRET_PATTERNS = {
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "Google document URL with ID": re.compile(
        r"https://(?:docs|drive)\.google\.com/[^\s)]+/(?:d|folders)/[A-Za-z0-9_-]{20,}"
    ),
    "deployed Apps Script URL": re.compile(
        r"https://script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}/(?:exec|dev)"
    ),
    "assigned API key": re.compile(
        r"GEMINI_API_KEY\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']", re.IGNORECASE
    ),
}

MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")

UUID_1 = "11111111-1111-4111-8111-111111111111"
UUID_2 = "22222222-2222-4222-8222-222222222222"
UUID_3 = "33333333-3333-4333-8333-333333333333"
UUID_4 = "44444444-4444-4444-8444-444444444444"
NOW = "2026-07-05T12:00:00+09:00"


class Results:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes: list[str] = []

    def ok(self, message: str) -> None:
        self.passes.append(message)
        print(f"PASS: {message}")

    def fail(self, message: str) -> None:
        self.failures.append(message)
        print(f"FAIL: {message}")


def iter_text_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if ".git" in path.parts:
            continue
        if path.name in {".editorconfig", ".gitattributes"} or path.suffix.lower() in TEXT_SUFFIXES:
            files.append(path)
    return sorted(files)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def schema_validator(path: Path) -> Draft202012Validator:
    schema = load_json(path)
    registry = Registry()
    for candidate in CONTRACTS.rglob("*.schema.json"):
        data = load_json(candidate)
        schema_id = data.get("$id")
        if not schema_id:
            raise ValueError(f"Schema is missing $id: {candidate.relative_to(ROOT)}")
        registry = registry.with_resource(schema_id, Resource.from_contents(data))
    return Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FORMAT_CHECKER,
    )


def assert_valid(results: Results, validator: Draft202012Validator, instance: Any, name: str) -> None:
    try:
        validator.validate(instance)
    except ValidationError as exc:
        results.fail(f"{name}: expected valid, got {exc.message}")
    else:
        results.ok(name)


def assert_invalid(results: Results, validator: Draft202012Validator, instance: Any, name: str) -> None:
    try:
        validator.validate(instance)
    except ValidationError:
        results.ok(name)
    else:
        results.fail(f"{name}: expected invalid, validation passed")


def check_repository_layout(results: Results) -> None:
    missing = [str(path.relative_to(ROOT)) for path in REQUIRED_PATHS if not path.exists()]
    if missing:
        results.fail(f"required paths missing: {', '.join(missing)}")
    else:
        results.ok("required repository paths exist")

    present = [str(path.relative_to(ROOT)) for path in FORBIDDEN_PATHS if path.exists()]
    if present:
        results.fail(f"temporary GitHub transfer paths still present: {', '.join(present)}")
    else:
        results.ok("temporary GitHub transfer paths are absent")


def check_text_encoding_and_line_endings(results: Results) -> None:
    problems: list[str] = []
    for path in iter_text_files():
        raw = path.read_bytes()
        rel = path.relative_to(ROOT)
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            problems.append(f"{rel}: not UTF-8")
            continue
        if raw.startswith(b"\xef\xbb\xbf"):
            problems.append(f"{rel}: UTF-8 BOM is not allowed")
        if b"\r\n" in raw or b"\r" in raw:
            problems.append(f"{rel}: CRLF/CR found")
        if raw and not raw.endswith(b"\n"):
            problems.append(f"{rel}: missing final newline")
    if problems:
        for problem in problems:
            results.fail(problem)
    else:
        results.ok("all text files are UTF-8/LF with final newline")


def check_repository_config_files(results: Results) -> None:
    checks = {
        ".editorconfig": [
            "root = true",
            "[*]",
            "end_of_line = lf",
            "insert_final_newline = true",
            "[*.py]",
        ],
        ".gitattributes": [
            "* text=auto eol=lf",
            "*.md text eol=lf",
            "*.json text eol=lf",
            "*.py text eol=lf",
        ],
    }
    problems: list[str] = []
    for filename, required_lines in checks.items():
        path = ROOT / filename
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) < 5:
            problems.append(f"{filename}: expected real multi-line configuration")
        for required_line in required_lines:
            if required_line not in lines:
                problems.append(f"{filename}: missing line {required_line!r}")
    if problems:
        for problem in problems:
            results.fail(problem)
    else:
        results.ok("repository config files are valid multi-line files")


def check_json_and_schemas(results: Results) -> None:
    json_files = sorted(ROOT.rglob("*.json"))
    parse_errors: list[str] = []
    for path in json_files:
        try:
            load_json(path)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            parse_errors.append(f"{path.relative_to(ROOT)}: {exc}")
    if parse_errors:
        for error in parse_errors:
            results.fail(error)
    else:
        results.ok(f"JSON parsing ({len(json_files)} files)")

    schema_files = sorted(CONTRACTS.rglob("*.schema.json"))
    schema_errors: list[str] = []
    for path in schema_files:
        try:
            Draft202012Validator.check_schema(load_json(path))
        except SchemaError as exc:
            schema_errors.append(f"{path.relative_to(ROOT)}: {exc.message}")
    if schema_errors:
        for error in schema_errors:
            results.fail(error)
    else:
        results.ok(f"Draft 2020-12 schema syntax ({len(schema_files)} files)")


def base_message(role: str, message_id: str) -> dict[str, Any]:
    return {
        "messageId": message_id,
        "requestId": UUID_1,
        "createdAt": NOW,
        "role": role,
        "messageType": "text",
        "text": "test",
        "status": "accepted" if role == "user" else "completed",
        "image": None,
        "replyToMessageId": None,
        "model": None,
        "inputTokens": None,
        "outputTokens": None,
        "error": None,
        "characterApproval": None,
    }


def check_chat_result_contract(results: Results) -> None:
    validator = schema_validator(CONTRACTS / "chat-result.schema.json")
    user = base_message("user", UUID_2)
    assistant = base_message("assistant", UUID_3)
    assistant["replyToMessageId"] = UUID_2
    assistant["model"] = "gemini-test"
    assistant["inputTokens"] = 12
    assistant["outputTokens"] = 7
    assistant["characterApproval"] = {
        "surface": "CHAT_TEXT_SYNC",
        "source": "generated",
        "policyVersion": "character-policy.v2",
        "profileSchemaVersion": "character-profile.v2",
        "profileRevision": 3,
        "catalogVersion": "character-catalog.v2",
        "characterPackId": "warm-kansai-caretaker",
        "characterPackVersion": "warm-kansai-caretaker.v1",
    }

    completed = {
        "ok": True, "status": "completed", "requestId": UUID_1,
        "userMessage": user, "assistantMessage": assistant,
        "retryAfterSeconds": None, "error": None, "warnings": [],
    }
    queued = {
        "ok": True, "status": "queued", "requestId": UUID_1,
        "userMessage": user, "assistantMessage": None,
        "retryAfterSeconds": 60, "error": None, "warnings": [],
    }
    failed = {
        "ok": False, "status": "failed", "requestId": UUID_1,
        "error": {"code": "GEMINI_AUTH_FAILED", "message": "failed"},
        "warnings": [],
    }
    routed = {
        "ok": True, "status": "routed", "requestId": UUID_1,
        "userMessage": user, "assistantMessage": None,
        "retryAfterSeconds": None, "error": None,
        "route": "PRODUCT_INFO",
        "notice": {
            "title": "このアプリについて",
            "message": "これは推し本人の発言ではなく、アプリからの案内です。",
        },
        "warnings": [],
    }

    assert_valid(results, validator, completed, "ChatResult completed valid")
    assert_valid(results, validator, queued, "ChatResult queued valid")
    assert_valid(results, validator, failed, "ChatResult failed valid")
    assert_valid(results, validator, routed, "ChatResult routed valid")

    bad_completed = dict(completed)
    bad_completed.pop("assistantMessage")
    assert_invalid(results, validator, bad_completed, "ChatResult completed requires assistantMessage")

    bad_queued = dict(queued)
    bad_queued.pop("retryAfterSeconds")
    assert_invalid(results, validator, bad_queued, "ChatResult queued requires retryAfterSeconds")

    bad_failed = dict(failed)
    bad_failed.pop("error")
    assert_invalid(results, validator, bad_failed, "ChatResult failed requires error")

    bad_routed = dict(routed)
    bad_routed["assistantMessage"] = assistant
    assert_invalid(
        results,
        validator,
        bad_routed,
        "ChatResult routed forbids assistantMessage",
    )

    routed_without_route = dict(routed)
    routed_without_route.pop("route")
    assert_invalid(
        results,
        validator,
        routed_without_route,
        "ChatResult routed requires route",
    )

    routed_without_notice = dict(routed)
    routed_without_notice.pop("notice")
    assert_invalid(
        results,
        validator,
        routed_without_notice,
        "ChatResult routed requires notice",
    )

    routed_with_unknown_route = dict(routed)
    routed_with_unknown_route["route"] = "MODEL_INFO"
    assert_invalid(
        results,
        validator,
        routed_with_unknown_route,
        "ChatResult routed rejects unknown route",
    )

    bad_approval = dict(completed)
    bad_approval["assistantMessage"] = dict(assistant)
    bad_approval["assistantMessage"]["characterApproval"] = dict(
        assistant["characterApproval"]
    )
    bad_approval["assistantMessage"]["characterApproval"].pop("profileRevision")
    assert_invalid(
        results,
        validator,
        bad_approval,
        "ChatResult character approval requires complete binding metadata",
    )

    wrong_approval_version = dict(completed)
    wrong_approval_version["assistantMessage"] = dict(assistant)
    wrong_approval_version["assistantMessage"]["characterApproval"] = dict(
        assistant["characterApproval"]
    )
    wrong_approval_version["assistantMessage"]["characterApproval"][
        "policyVersion"
    ] = "character-policy.v999"
    assert_invalid(
        results,
        validator,
        wrong_approval_version,
        "ChatResult character approval rejects unknown policy version",
    )

    incomplete_message_dto = dict(completed)
    incomplete_message_dto["assistantMessage"] = dict(assistant)
    incomplete_message_dto["assistantMessage"].pop("characterApproval")
    assert_invalid(
        results,
        validator,
        incomplete_message_dto,
        "ChatResult MessageDto requires nullable runtime fields",
    )


def base_event(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "eventId": UUID_4,
        "eventType": event_type,
        "dedupeKey": f"{event_type}:test",
        "payload": payload,
        "status": "PENDING",
        "attemptCount": 0,
        "nextAttemptAt": None,
        "lockedAt": None,
        "lockedBy": None,
        "createdAt": NOW,
        "updatedAt": NOW,
        "completedAt": None,
        "lastError": None,
    }


def check_event_contract(results: Results) -> None:
    validator = schema_validator(CONTRACTS / "event.schema.json")
    samples = {
        "CHAT_REPLY": {
            "requestId": UUID_1, "userMessageId": UUID_2, "requestedAt": NOW, "image": None,
        },
        "MEMORY_EXTRACT": {
            "firstMessageId": UUID_1, "lastMessageId": UUID_2,
            "sourceMessageIds": [UUID_1, UUID_2], "requestedAt": NOW,
        },
        "DIARY_GENERATE": {"diaryDate": "2026-07-05", "requestedAt": NOW},
        "PROACTIVE_SEND": {
            "targetDate": "2026-07-05",
            "sequence": 1,
            "requestedAt": NOW,
            "decisionSlot": "495708",
            "messageDedupeKey": "PROACTIVE_MESSAGE:2026-07-05:1",
            "probability": 0.5,
            "sample": 0.25,
            "elapsedMinutes": 300,
            "timeWeight": 1.0,
            "reason": "deterministic_probability_hit",
        },
        "WEEKLY_BACKUP": {"backupDate": "2026-07-05", "requestedAt": NOW},
    }
    for event_type, payload in samples.items():
        assert_valid(results, validator, base_event(event_type, payload), f"Event {event_type} payload valid")

    character_binding = {
        "profileSchemaVersion": "character-profile.v2",
        "profileRevision": 3,
        "policyVersion": "character-policy.v2",
        "catalogVersion": "character-catalog.v2",
        "characterPackId": "warm-kansai-caretaker",
        "characterPackVersion": "warm-kansai-caretaker.v1",
    }
    enforced_chat_payload = {
        "requestId": UUID_1,
        "userMessageId": UUID_2,
        "requestedAt": NOW,
        "image": None,
        "characterRuntimeMode": "enforced",
        "characterBinding": character_binding,
    }
    assert_valid(
        results,
        validator,
        base_event("CHAT_REPLY", enforced_chat_payload),
        "Event CHAT_REPLY enforced binding valid",
    )

    missing_chat_binding = dict(enforced_chat_payload)
    missing_chat_binding.pop("characterBinding")
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", missing_chat_binding),
        "Event CHAT_REPLY enforced mode requires binding",
    )

    legacy_with_binding = dict(enforced_chat_payload)
    legacy_with_binding["characterRuntimeMode"] = "legacy"
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", legacy_with_binding),
        "Event CHAT_REPLY legacy mode forbids binding",
    )

    wrong_version_binding = dict(enforced_chat_payload)
    wrong_version_binding["characterBinding"] = dict(character_binding)
    wrong_version_binding["characterBinding"]["catalogVersion"] = (
        "character-catalog.v999"
    )
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", wrong_version_binding),
        "Event CHAT_REPLY rejects unknown binding version",
    )

    extra_binding_field = dict(enforced_chat_payload)
    extra_binding_field["characterBinding"] = dict(character_binding)
    extra_binding_field["characterBinding"]["unexpected"] = True
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", extra_binding_field),
        "Event CHAT_REPLY rejects extra binding metadata",
    )

    routed_chat_payload = dict(enforced_chat_payload)
    routed_chat_payload["completionRoute"] = "ADMIN_OOC"
    assert_valid(
        results,
        validator,
        base_event("CHAT_REPLY", routed_chat_payload),
        "Event CHAT_REPLY completion route valid",
    )

    unknown_completion_route = dict(enforced_chat_payload)
    unknown_completion_route["completionRoute"] = "MODEL_INFO"
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", unknown_completion_route),
        "Event CHAT_REPLY rejects unknown completion route",
    )

    legacy_completion_route = {
        "requestId": UUID_1,
        "userMessageId": UUID_2,
        "requestedAt": NOW,
        "image": None,
        "characterRuntimeMode": "legacy",
        "completionRoute": "PRODUCT_INFO",
    }
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", legacy_completion_route),
        "Event CHAT_REPLY legacy mode forbids completion route",
    )

    unbound_completion_route = {
        "requestId": UUID_1,
        "userMessageId": UUID_2,
        "requestedAt": NOW,
        "image": None,
        "completionRoute": "PRODUCT_INFO",
    }
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", unbound_completion_route),
        "Event CHAT_REPLY completion route requires enforced binding",
    )

    missing_user_message_id = dict(enforced_chat_payload)
    missing_user_message_id.pop("userMessageId")
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", missing_user_message_id),
        "Event CHAT_REPLY requires userMessageId",
    )

    manual_chat_payload = dict(enforced_chat_payload)
    manual_chat_payload["manualRequestId"] = UUID_3
    manual_chat_payload["originalEventId"] = UUID_4
    assert_valid(
        results,
        validator,
        base_event("CHAT_REPLY", manual_chat_payload),
        "Event CHAT_REPLY manual repair preserves enforced binding",
    )

    incomplete_manual_chat = dict(manual_chat_payload)
    incomplete_manual_chat.pop("originalEventId")
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", incomplete_manual_chat),
        "Event CHAT_REPLY manual repair requires originalEventId",
    )

    missing_manual_request = dict(manual_chat_payload)
    missing_manual_request.pop("manualRequestId")
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", missing_manual_request),
        "Event CHAT_REPLY manual repair requires manualRequestId",
    )

    invalid_manual_request = dict(manual_chat_payload)
    invalid_manual_request["manualRequestId"] = "not-a-uuid"
    assert_invalid(
        results,
        validator,
        base_event("CHAT_REPLY", invalid_manual_request),
        "Event CHAT_REPLY manual repair requires UUID v4 identifiers",
    )

    diary_repair_payload = {
        "diaryDate": "2026-07-05",
        "requestedAt": NOW,
        "manualRequestId": UUID_2,
        "originalEventId": UUID_1,
    }
    assert_valid(
        results,
        validator,
        base_event("DIARY_GENERATE", diary_repair_payload),
        "Event DIARY_GENERATE repair payload valid",
    )

    missing_original_event = dict(diary_repair_payload)
    missing_original_event.pop("originalEventId")
    assert_invalid(
        results,
        validator,
        base_event("DIARY_GENERATE", missing_original_event),
        "Event DIARY_GENERATE repair payload requires originalEventId",
    )

    missing_manual_request = dict(diary_repair_payload)
    missing_manual_request.pop("manualRequestId")
    assert_invalid(
        results,
        validator,
        base_event("DIARY_GENERATE", missing_manual_request),
        "Event DIARY_GENERATE repair payload requires manualRequestId",
    )

    wrong = base_event("WEEKLY_BACKUP", samples["DIARY_GENERATE"])
    assert_invalid(results, validator, wrong, "Event payload cannot be used by another eventType")


def memory_candidate(action: str) -> dict[str, Any]:
    item: dict[str, Any] = {
        "action": action,
        "category": "preference",
        "normalizedKey": "food.spicy",
        "content": "辛い料理が好き",
        "confidence": 0.9,
        "sourceMessageIds": [UUID_1],
        "reason": "明示的な発言",
    }
    if action in {"confirm", "update"}:
        item["existingMemoryId"] = UUID_2
    return item


def check_memory_contract(results: Results) -> None:
    item_validator = schema_validator(CONTRACTS / "memory-candidate.schema.json")
    list_validator = schema_validator(CONTRACTS / "memory-candidates.schema.json")

    for action in ("create", "confirm", "update", "ignore"):
        assert_valid(results, item_validator, memory_candidate(action), f"MemoryCandidate {action} valid")

    bad_confirm = memory_candidate("confirm")
    bad_confirm.pop("existingMemoryId")
    assert_invalid(results, item_validator, bad_confirm, "MemoryCandidate confirm requires existingMemoryId")

    bad_create = memory_candidate("create")
    bad_create["existingMemoryId"] = UUID_2
    assert_invalid(results, item_validator, bad_create, "MemoryCandidate create forbids existingMemoryId")

    assert_valid(
        results,
        list_validator,
        [memory_candidate("create"), memory_candidate("update")],
        "MemoryCandidate list valid",
    )


def check_character_profile_contract(results: Results) -> None:
    v1_validator = schema_validator(CONTRACTS / "character-profile-v1.schema.json")
    v1_profile = {
        "schemaVersion": "character-profile.v1",
        "identity": {
            "partnerName": "Partner",
            "firstPerson": "私",
            "userAddress": "あなた",
        },
        "style": {
            "speechPreset": "natural",
            "warmth": "balanced",
            "replyLength": "balanced",
        },
        "flavor": {
            "note": "",
            "exampleLines": [],
        },
    }
    assert_valid(results, v1_validator, v1_profile, "CharacterProfileV1 legacy contract valid")

    unknown = json.loads(json.dumps(v1_profile, ensure_ascii=False))
    unknown["unexpected"] = True
    assert_invalid(results, v1_validator, unknown, "CharacterProfileV1 rejects unknown root field")

    bad_enum = json.loads(json.dumps(v1_profile, ensure_ascii=False))
    bad_enum["style"]["warmth"] = "extreme"
    assert_invalid(results, v1_validator, bad_enum, "CharacterProfileV1 rejects invalid enum")

    missing = json.loads(json.dumps(v1_profile, ensure_ascii=False))
    del missing["identity"]["firstPerson"]
    assert_invalid(results, v1_validator, missing, "CharacterProfileV1 requires identity fields")

    v2_validator = schema_validator(CONTRACTS / "character-profile-v2.schema.json")
    v2_profile = {
        "schemaVersion": "character-profile.v2",
        "identity": {
            "partnerName": "Partner",
            "userAddress": "あなた",
        },
        "preferences": {
            "replyLength": "balanced",
        },
    }
    assert_valid(results, v2_validator, v2_profile, "CharacterProfileV2 active contract valid")

    v2_persona_override = json.loads(json.dumps(v2_profile, ensure_ascii=False))
    v2_persona_override["identity"]["firstPerson"] = "私"
    assert_invalid(
        results,
        v2_validator,
        v2_persona_override,
        "CharacterProfileV2 rejects CharacterPack-owned identity fields",
    )

    v2_matrix_override = json.loads(json.dumps(v2_profile, ensure_ascii=False))
    v2_matrix_override["preferences"]["warmth"] = "sweet"
    assert_invalid(
        results,
        v2_validator,
        v2_matrix_override,
        "CharacterProfileV2 rejects runtime persona matrix fields",
    )


def check_immersion_contracts(results: Results) -> None:
    semantic_validator = schema_validator(CONTRACTS / "immersion-semantic-verdict.schema.json")
    guard_validator = schema_validator(CONTRACTS / "immersion-guard-decision.schema.json")
    artifact_validator = schema_validator(CONTRACTS / "approved-character-artifact.schema.json")

    semantic_allow = {
        "verdict": "allow",
        "category": None,
        "evidenceKeys": ["userFacts:0"],
    }
    assert_valid(results, semantic_validator, semantic_allow, "Immersion semantic allow valid")

    semantic_deny = {
        "verdict": "deny",
        "category": "GROUNDING_USER_STATE_UNSUPPORTED",
        "evidenceKeys": [],
    }
    assert_valid(results, semantic_validator, semantic_deny, "Immersion semantic deny valid")

    bad_semantic = dict(semantic_allow)
    bad_semantic["category"] = "FORMAT_INVALID"
    assert_invalid(
        results,
        semantic_validator,
        bad_semantic,
        "Immersion semantic allow requires null category",
    )

    guard_allow = {
        "status": "ALLOW",
        "category": None,
        "action": "ALLOW",
        "surface": "CHAT_TEXT_SYNC",
        "source": "generated",
        "policyVersion": "character-policy.v2",
        "characterPackId": "warm-kansai-caretaker",
        "characterPackVersion": "warm-kansai-caretaker.v1",
        "profileSchemaVersion": "character-profile.v2",
        "profileRevision": 1,
        "catalogVersion": "character-catalog.v2",
        "claimType": None,
        "requiresEvidence": False,
        "evidenceKeys": [],
    }
    assert_valid(results, guard_validator, guard_allow, "Immersion guard allow valid")

    grounded_guard_allow = dict(guard_allow)
    grounded_guard_allow.update({
        "claimType": "USER_STATE",
        "requiresEvidence": True,
        "evidenceKeys": ["userFacts:0"],
    })
    assert_valid(
        results,
        guard_validator,
        grounded_guard_allow,
        "Immersion grounded guard allow valid",
    )

    missing_grounding = dict(grounded_guard_allow)
    missing_grounding["evidenceKeys"] = []
    assert_invalid(
        results,
        guard_validator,
        missing_grounding,
        "Immersion grounded guard allow requires evidence",
    )

    wrong_grounded_claim = dict(grounded_guard_allow)
    wrong_grounded_claim["claimType"] = "GENERAL_IMMERSION"
    assert_invalid(
        results,
        guard_validator,
        wrong_grounded_claim,
        "Immersion grounded guard allow restricts claim type",
    )

    retry_guard_allow = dict(guard_allow)
    retry_guard_allow.update({
        "surface": "PROACTIVE_RETRY",
        "source": "legacy_revalidated",
    })
    assert_valid(
        results,
        guard_validator,
        retry_guard_allow,
        "Immersion retry guard requires legacy revalidation source",
    )

    wrong_retry_guard = dict(retry_guard_allow)
    wrong_retry_guard["source"] = "generated"
    assert_invalid(
        results,
        guard_validator,
        wrong_retry_guard,
        "Immersion retry guard rejects generated source",
    )

    legacy_chat_guard = dict(guard_allow)
    legacy_chat_guard["source"] = "legacy_revalidated"
    assert_invalid(
        results,
        guard_validator,
        legacy_chat_guard,
        "Immersion legacy guard source is retry-only",
    )

    artifact_sources = (
        "generated",
        "rewrite",
        "canonical",
        "fallback",
        "legacy_revalidated",
    )
    allowed_sources_by_surface = {
        "CHAT_TEXT_SYNC": {"generated", "rewrite", "canonical", "fallback"},
        "CHAT_TEXT_QUEUED": {"generated", "rewrite", "canonical", "fallback"},
        "CHAT_IMAGE": {"generated", "rewrite", "canonical", "fallback"},
        "PROACTIVE_AI": {"generated", "rewrite"},
        "PROACTIVE_RETRY": {"legacy_revalidated"},
        "DIARY": {"generated", "rewrite"},
        "MEMORY_EXTRACTION": {"generated", "rewrite"},
    }
    for surface, allowed_sources in allowed_sources_by_surface.items():
        for source in artifact_sources:
            matrix_guard = dict(guard_allow)
            matrix_guard["surface"] = surface
            matrix_guard["source"] = source
            label = f"Immersion guard source matrix {surface} / {source}"
            if source in allowed_sources:
                assert_valid(results, guard_validator, matrix_guard, label)
            else:
                assert_invalid(results, guard_validator, matrix_guard, label)

    guard_deny = dict(guard_allow)
    guard_deny.update({
        "status": "DENY",
        "action": "DENY",
        "category": "IMMERSION_SELF_IDENTIFICATION",
    })
    assert_valid(results, guard_validator, guard_deny, "Immersion guard deny valid")

    guard_unavailable = dict(guard_allow)
    guard_unavailable.update({
        "status": "GUARD_UNAVAILABLE",
        "action": "GUARD_UNAVAILABLE",
    })
    assert_valid(
        results,
        guard_validator,
        guard_unavailable,
        "Immersion guard unavailable valid",
    )

    leaked_guard = dict(guard_deny)
    leaked_guard["candidate"] = "forbidden"
    assert_invalid(
        results,
        guard_validator,
        leaked_guard,
        "Immersion guard decision forbids candidate text",
    )

    artifact = {
        "payload": {"text": "承認済み応答"},
        "surface": "CHAT_TEXT_SYNC",
        "source": "generated",
        "policyVersion": "character-policy.v2",
        "characterPackId": "warm-kansai-caretaker",
        "characterPackVersion": "warm-kansai-caretaker.v1",
        "profileSchemaVersion": "character-profile.v2",
        "profileRevision": 1,
        "catalogVersion": "character-catalog.v2",
    }
    assert_valid(results, artifact_validator, artifact, "Approved chat artifact valid")

    proactive_artifact = json.loads(json.dumps(artifact, ensure_ascii=False))
    proactive_artifact["surface"] = "PROACTIVE_AI"
    proactive_artifact["payload"] = {
        "subject": "ひとこと",
        "body": "今日はどうしとる？",
    }
    assert_valid(
        results,
        artifact_validator,
        proactive_artifact,
        "Approved generated proactive artifact valid",
    )

    proactive_retry_artifact = json.loads(json.dumps(proactive_artifact, ensure_ascii=False))
    proactive_retry_artifact["surface"] = "PROACTIVE_RETRY"
    proactive_retry_artifact["source"] = "legacy_revalidated"
    assert_valid(
        results,
        artifact_validator,
        proactive_retry_artifact,
        "Approved proactive retry artifact valid",
    )

    wrong_retry_artifact = json.loads(
        json.dumps(proactive_retry_artifact, ensure_ascii=False)
    )
    wrong_retry_artifact["source"] = "generated"
    assert_invalid(
        results,
        artifact_validator,
        wrong_retry_artifact,
        "Approved proactive retry rejects generated source",
    )

    legacy_chat_artifact = json.loads(json.dumps(artifact, ensure_ascii=False))
    legacy_chat_artifact["source"] = "legacy_revalidated"
    assert_invalid(
        results,
        artifact_validator,
        legacy_chat_artifact,
        "Approved legacy artifact source is retry-only",
    )

    proactive_template = json.loads(json.dumps(proactive_artifact, ensure_ascii=False))
    proactive_template["surface"] = "PROACTIVE_TEMPLATE"
    assert_invalid(
        results,
        artifact_validator,
        proactive_template,
        "Approved artifact rejects retired proactive template surface",
    )

    wrong_payload = json.loads(json.dumps(artifact, ensure_ascii=False))
    wrong_payload["payload"] = {"subject": "wrong", "body": "surface"}
    assert_invalid(
        results,
        artifact_validator,
        wrong_payload,
        "Approved artifact rejects wrong-surface payload",
    )

    leaked_artifact = json.loads(json.dumps(artifact, ensure_ascii=False))
    leaked_artifact["rawCandidate"] = "forbidden"
    assert_invalid(
        results,
        artifact_validator,
        leaked_artifact,
        "Approved artifact rejects raw candidate field",
    )

    diary_artifact = json.loads(json.dumps(artifact, ensure_ascii=False))
    diary_artifact["surface"] = "DIARY"
    diary_artifact["payload"] = {
        "title": "今日",
        "narrative": "一日の記録",
        "groundedSummary": "",
        "partnerWorldEvents": [{
            "content": "出来事",
        }],
        "thingsToRemember": [],
        "unresolvedFollowUps": [],
    }
    assert_valid(
        results,
        artifact_validator,
        diary_artifact,
        "Approved diary artifact bounded nested JSON valid",
    )

    oversized_nested = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    oversized_nested["payload"]["partnerWorldEvents"][0]["content"] = "x" * 4001
    assert_invalid(
        results,
        artifact_validator,
        oversized_nested,
        "Approved artifact rejects oversized nested text",
    )

    dangerous_nested = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    dangerous_nested["payload"]["partnerWorldEvents"] = [{"__proto__": "x"}]
    assert_invalid(
        results,
        artifact_validator,
        dangerous_nested,
        "Approved artifact rejects dangerous nested keys",
    )

    non_identifier_key = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    non_identifier_key["payload"]["partnerWorldEvents"] = [{"俺はAIやから": True}]
    assert_invalid(
        results,
        artifact_validator,
        non_identifier_key,
        "Approved artifact rejects non-identifier nested keys",
    )

    oversized_key = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    oversized_key["payload"]["partnerWorldEvents"] = [{"a" * 65: True}]
    assert_invalid(
        results,
        artifact_validator,
        oversized_key,
        "Approved artifact rejects oversized nested keys",
    )

    compressed_acronym_key = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    compressed_acronym_key["payload"]["partnerWorldEvents"] = [{"iAmAIClaim": True}]
    assert_invalid(
        results,
        artifact_validator,
        compressed_acronym_key,
        "Approved artifact rejects compressed-acronym nested keys",
    )

    compressed_sentence_key = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    compressed_sentence_key["payload"]["partnerWorldEvents"] = [{
        "thisreplyisgenerated": True,
    }]
    assert_invalid(
        results,
        artifact_validator,
        compressed_sentence_key,
        "Approved artifact rejects compressed-sentence nested keys",
    )

    unneeded_sensitive_key = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    unneeded_sensitive_key["payload"]["partnerWorldEvents"] = [{
        "clientSecret": "synthetic-value",
    }]
    assert_invalid(
        results,
        artifact_validator,
        unneeded_sensitive_key,
        "Approved artifact rejects unneeded sensitive nested keys",
    )

    valid_provenance = json.loads(json.dumps(artifact, ensure_ascii=False))
    valid_provenance["surface"] = "MEMORY_EXTRACTION"
    valid_provenance["payload"] = {
        "candidates": [{
            "content": "validated memory",
            "existingMemoryId": UUID_1,
            "sourceMessageIds": [UUID_1, UUID_2],
            "source_message_ids": [UUID_2],
        }],
    }
    assert_valid(
        results,
        artifact_validator,
        valid_provenance,
        "Approved artifact accepts validated UUID v4 provenance",
    )

    queued_artifact = json.loads(json.dumps(artifact, ensure_ascii=False))
    queued_artifact["surface"] = "CHAT_TEXT_QUEUED"
    image_artifact = json.loads(json.dumps(artifact, ensure_ascii=False))
    image_artifact["surface"] = "CHAT_IMAGE"
    image_artifact["payload"] = {
        "replyText": "見えている範囲で確認するで。",
        "imageSummary": "確認可能な情報だけを要約した。",
    }
    artifact_by_surface = {
        "CHAT_TEXT_SYNC": artifact,
        "CHAT_TEXT_QUEUED": queued_artifact,
        "CHAT_IMAGE": image_artifact,
        "PROACTIVE_AI": proactive_artifact,
        "PROACTIVE_RETRY": proactive_retry_artifact,
        "DIARY": diary_artifact,
        "MEMORY_EXTRACTION": valid_provenance,
    }
    for surface, base_artifact in artifact_by_surface.items():
        for source in artifact_sources:
            matrix_artifact = json.loads(json.dumps(base_artifact, ensure_ascii=False))
            matrix_artifact["source"] = source
            label = f"Approved artifact source matrix {surface} / {source}"
            if source in allowed_sources_by_surface[surface]:
                assert_valid(results, artifact_validator, matrix_artifact, label)
            else:
                assert_invalid(results, artifact_validator, matrix_artifact, label)

    invalid_provenance = json.loads(json.dumps(valid_provenance, ensure_ascii=False))
    invalid_provenance["payload"]["candidates"][0]["existingMemoryId"] = "not-a-uuid"
    assert_invalid(
        results,
        artifact_validator,
        invalid_provenance,
        "Approved artifact rejects invalid provenance identifiers",
    )

    duplicate_provenance = json.loads(json.dumps(valid_provenance, ensure_ascii=False))
    duplicate_provenance["payload"]["candidates"][0]["sourceMessageIds"] = [UUID_1, UUID_1]
    assert_invalid(
        results,
        artifact_validator,
        duplicate_provenance,
        "Approved artifact rejects duplicate provenance identifiers",
    )

    uppercase_provenance = json.loads(json.dumps(valid_provenance, ensure_ascii=False))
    uppercase_provenance["payload"]["candidates"][0]["existingMemoryId"] = (
        "A1111111-B111-4111-8111-111111111111"
    )
    assert_invalid(
        results,
        artifact_validator,
        uppercase_provenance,
        "Approved artifact requires canonical lowercase UUID v4 provenance",
    )

    diary_provenance = json.loads(json.dumps(diary_artifact, ensure_ascii=False))
    diary_provenance["payload"]["partnerWorldEvents"][0]["sourceMessageIds"] = [UUID_1]
    assert_invalid(
        results,
        artifact_validator,
        diary_provenance,
        "Approved diary artifact rejects memory-only provenance keys",
    )

    misplaced_provenance = json.loads(json.dumps(valid_provenance, ensure_ascii=False))
    misplaced_provenance["payload"]["candidates"][0]["content"] = UUID_1
    assert_invalid(
        results,
        artifact_validator,
        misplaced_provenance,
        "Approved memory artifact rejects identifiers outside provenance fields",
    )


def check_markdown_links(results: Results) -> None:
    broken: list[str] = []
    for path in sorted(ROOT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        for raw_target in MARKDOWN_LINK.findall(text):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith("#"):
                continue
            relative = unquote(parsed.path)
            if not relative:
                continue
            resolved = (path.parent / relative).resolve()
            try:
                resolved.relative_to(ROOT.resolve())
            except ValueError:
                broken.append(f"{path.relative_to(ROOT)} -> outside repository: {target}")
                continue
            if not resolved.exists():
                broken.append(f"{path.relative_to(ROOT)} -> missing: {target}")
    if broken:
        for item in broken:
            results.fail(item)
    else:
        results.ok("Markdown relative links")


def check_secrets(results: Results) -> None:
    findings: list[str] = []
    for path in iter_text_files():
        text = path.read_text(encoding="utf-8")
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                findings.append(f"{path.relative_to(ROOT)}: {label}")
    if findings:
        for finding in findings:
            results.fail(f"possible secret: {finding}")
    else:
        results.ok("secret-pattern scan")


def main() -> int:
    results = Results()
    print(f"Repository: {ROOT}")
    check_repository_layout(results)
    check_text_encoding_and_line_endings(results)
    check_repository_config_files(results)
    check_json_and_schemas(results)
    check_chat_result_contract(results)
    check_event_contract(results)
    check_memory_contract(results)
    check_character_profile_contract(results)
    check_immersion_contracts(results)
    check_markdown_links(results)
    check_secrets(results)

    print()
    print(f"Summary: {len(results.passes)} passed, {len(results.failures)} failed")
    if results.failures:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
