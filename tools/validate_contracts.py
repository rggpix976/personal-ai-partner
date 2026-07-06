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
    ROOT / "docs" / "a1" / "contracts" / "event.schema.json",
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
        "error": None,
    }


def check_chat_result_contract(results: Results) -> None:
    validator = schema_validator(CONTRACTS / "chat-result.schema.json")
    user = base_message("user", UUID_2)
    assistant = base_message("assistant", UUID_3)

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

    assert_valid(results, validator, completed, "ChatResult completed valid")
    assert_valid(results, validator, queued, "ChatResult queued valid")
    assert_valid(results, validator, failed, "ChatResult failed valid")

    bad_completed = dict(completed)
    bad_completed.pop("assistantMessage")
    assert_invalid(results, validator, bad_completed, "ChatResult completed requires assistantMessage")

    bad_queued = dict(queued)
    bad_queued.pop("retryAfterSeconds")
    assert_invalid(results, validator, bad_queued, "ChatResult queued requires retryAfterSeconds")

    bad_failed = dict(failed)
    bad_failed.pop("error")
    assert_invalid(results, validator, bad_failed, "ChatResult failed requires error")


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
        "PROACTIVE_SEND": {"targetDate": "2026-07-05", "sequence": 1, "requestedAt": NOW},
        "WEEKLY_BACKUP": {"backupDate": "2026-07-05", "requestedAt": NOW},
    }
    for event_type, payload in samples.items():
        assert_valid(results, validator, base_event(event_type, payload), f"Event {event_type} payload valid")

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
    check_markdown_links(results)
    check_secrets(results)

    print()
    print(f"Summary: {len(results.passes)} passed, {len(results.failures)} failed")
    if results.failures:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
