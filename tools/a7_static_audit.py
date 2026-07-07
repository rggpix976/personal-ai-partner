#!/usr/bin/env python3
"""A7 static audit for the Personal Proactive AI Partner repository.

The audit is intentionally conservative about external side effects and secret
handling. It is not a substitute for live Apps Script validation.
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List


TEXT_SUFFIXES = {
    ".gs",
    ".html",
    ".js",
    ".json",
    ".md",
    ".py",
    ".txt",
    ".yml",
    ".yaml",
}

BIDI_CODEPOINTS = {
    0x202A,
    0x202B,
    0x202C,
    0x202D,
    0x202E,
    0x2066,
    0x2067,
    0x2068,
    0x2069,
}

APPROVED_URLFETCH = {
    "src/infrastructure/GeminiClient.gs",
    "src/tests/A7StaticSelfTest.gs",
    "src/tests/A7IntegrationSelfTest.gs",
}

APPROVED_MAILAPP = {
    "src/infrastructure/GmailNotifier.gs",
}

APPROVED_SPREADSHEETAPP_PREFIXES = (
    "src/infrastructure/SheetRepository.gs",
    "src/Setup.gs",
    "src/tests/",
)

APPROVED_DOCUMENTAPP_PREFIXES = (
    "src/infrastructure/DocumentRepository.gs",
    "src/Setup.gs",
    "src/tests/",
)

APPROVED_DRIVEAPP_PREFIXES = (
    "src/infrastructure/DriveTempRepository.gs",
    "src/application/MaintenanceService.gs",
    "src/Setup.gs",
    "src/tests/",
)

UNSAFE_DOM_PATTERNS = (
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
)

SECRET_PATTERNS = (
    ("google_api_key", re.compile(r"AIza[0-9A-Za-z_-]{30,}")),
    ("openai_api_key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("private_key_block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----")),
    ("oauth_token", re.compile(r"\bya29\.[0-9A-Za-z_-]{20,}")),
)

EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")


@dataclass
class Finding:
    severity: str
    path: str
    message: str


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    return path.name in {".editorconfig", ".gitattributes"}


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(".git/"):
            continue
        if is_text_file(path):
            yield path


def allowed_by_prefix(rel: str, prefixes: Iterable[str]) -> bool:
    return any(rel == prefix or rel.startswith(prefix) for prefix in prefixes)


def check_unicode(root: Path, path: Path, findings: List[Finding]) -> str | None:
    rel = path.relative_to(root).as_posix()
    data = path.read_bytes()

    if data.startswith(b"\xef\xbb\xbf"):
        findings.append(Finding("ERROR", rel, "UTF-8 BOM is not allowed."))

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        findings.append(Finding("ERROR", rel, f"File is not valid UTF-8: {exc}."))
        return None

    if "\r" in text:
        findings.append(Finding("ERROR", rel, "CRLF/CR line endings are not allowed; use LF."))

    if "\u00a0" in text:
        findings.append(Finding("ERROR", rel, "NBSP is not allowed."))

    for index, char in enumerate(text):
        code = ord(char)
        if code in BIDI_CODEPOINTS:
            findings.append(Finding("ERROR", rel, f"Bidirectional control character U+{code:04X} at offset {index}."))
        elif unicodedata.category(char) == "Cf":
            findings.append(Finding("ERROR", rel, f"Unicode format control U+{code:04X} at offset {index}."))
        elif code < 32 and char not in ("\n", "\t"):
            findings.append(Finding("ERROR", rel, f"Unexpected ASCII control U+{code:04X} at offset {index}."))

    return text


def check_secrets(root: Path, path: Path, text: str, findings: List[Finding]) -> None:
    rel = path.relative_to(root).as_posix()

    for name, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            findings.append(Finding("ERROR", rel, f"Possible hardcoded secret detected: {name}."))

    for match in EMAIL_PATTERN.finditer(text):
        email = match.group(0).lower()
        if email.endswith("@example.com") or rel.startswith("src/tests/"):
            continue
        findings.append(Finding("ERROR", rel, "Possible hardcoded email address detected."))


def check_forbidden_apis(root: Path, path: Path, text: str, findings: List[Finding]) -> None:
    rel = path.relative_to(root).as_posix()

    if not rel.startswith("src/"):
        return

    if re.search(r"\bUrlFetchApp\s*\.", text) and rel not in APPROVED_URLFETCH:
        findings.append(Finding("ERROR", rel, "UrlFetchApp is only allowed inside GeminiClient or tests."))

    if re.search(r"\bMailApp\s*\.", text) and rel not in APPROVED_MAILAPP and not rel.startswith("src/tests/"):
        findings.append(Finding("ERROR", rel, "MailApp is only allowed inside GmailNotifier or tests."))

    if re.search(r"\bSpreadsheetApp\s*\.", text) and not allowed_by_prefix(rel, APPROVED_SPREADSHEETAPP_PREFIXES):
        findings.append(Finding("ERROR", rel, "SpreadsheetApp is only allowed inside SheetRepository, Setup, or tests."))

    if re.search(r"\bDocumentApp\s*\.", text) and not allowed_by_prefix(rel, APPROVED_DOCUMENTAPP_PREFIXES):
        findings.append(Finding("ERROR", rel, "DocumentApp is only allowed inside DocumentRepository, Setup, or tests."))

    if re.search(r"\bDriveApp\s*\.", text) and not allowed_by_prefix(rel, APPROVED_DRIVEAPP_PREFIXES):
        findings.append(Finding("ERROR", rel, "DriveApp is only allowed inside DriveTempRepository, MaintenanceService, Setup, or tests."))


def check_dom(root: Path, path: Path, text: str, findings: List[Finding]) -> None:
    rel = path.relative_to(root).as_posix()
    if not rel.startswith("src/web/") and path.suffix.lower() not in {".html", ".js"}:
        return
    for pattern in UNSAFE_DOM_PATTERNS:
        if pattern in text:
            findings.append(Finding("ERROR", rel, f"Unsafe DOM API detected: {pattern}."))


def check_logging_risks(root: Path, path: Path, text: str, findings: List[Finding]) -> None:
    rel = path.relative_to(root).as_posix()
    if not rel.startswith("src/"):
        return
    lines = text.splitlines()
    for line_number, line in enumerate(lines, 1):
        lowered = line.lower()
        if ("applogger" in lowered or "logger.log" in lowered or "console.log" in lowered) and "base64" in lowered:
            findings.append(Finding("ERROR", rel, f"Possible raw base64 logging on line {line_number}."))
        if ("applogger" in lowered or "logger.log" in lowered or "console.log" in lowered) and "api_key" in lowered:
            findings.append(Finding("ERROR", rel, f"Possible API key logging on line {line_number}."))
        if ("full prompt" in lowered or "raw prompt" in lowered) and ("log" in lowered or "applogger" in lowered):
            findings.append(Finding("ERROR", rel, f"Possible full prompt logging statement on line {line_number}."))


def check_markdown_long_lines(root: Path, path: Path, text: str, findings: List[Finding]) -> None:
    rel = path.relative_to(root).as_posix()
    if path.suffix.lower() != ".md":
        return
    for line_number, line in enumerate(text.splitlines(), 1):
        if len(line) > 1000:
            findings.append(Finding("WARN", rel, f"Very long Markdown line on line {line_number}; consider reformatting."))


def run(root: Path) -> int:
    findings: List[Finding] = []

    for path in iter_files(root):
        text = check_unicode(root, path, findings)
        if text is None:
            continue
        check_secrets(root, path, text, findings)
        check_forbidden_apis(root, path, text, findings)
        check_dom(root, path, text, findings)
        check_logging_risks(root, path, text, findings)
        check_markdown_long_lines(root, path, text, findings)

    errors = [finding for finding in findings if finding.severity == "ERROR"]
    warnings = [finding for finding in findings if finding.severity == "WARN"]

    for finding in findings:
        print(f"{finding.severity}: {finding.path}: {finding.message}")

    print(f"A7_STATIC_AUDIT_SUMMARY errors={len(errors)} warnings={len(warnings)} files={len(list(iter_files(root)))}")

    return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the A7 static repository audit.")
    parser.add_argument("--root", default=".", help="Repository root. Defaults to current directory.")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if not (root / "src").exists() or not (root / "docs").exists():
        print(f"ERROR: {root} does not look like the repository root.", file=sys.stderr)
        return 2
    return run(root)


if __name__ == "__main__":
    raise SystemExit(main())
