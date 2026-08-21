#!/usr/bin/env python3
"""Print what a veraPDF report actually says when the print layer fails (FIU-P5).

WHY THIS EXISTS. The `Validate the print layer against PDF/A-2b` step in
`.github/workflows/ci.yml` parses the machine-readable report and prints the
verdict — `failedRules=1 failedChecks=1` — and stops there. On run 32530473473
that was the entire evidence a red job offered: which of 144 rules failed, on
which object, and why, all had to be dug out of the `pdfa-validation` artifact
by hand, after the run, by someone who knew the artifact existed. The `--format
text` output was no help either; it is 49 bytes and reads
`FAIL /home/runner/work/_temp/pdfa/archive.pdf 2b`.

So this prints the report's own words: for each failing rule its specification,
clause, test number, description, and the first context a check failed in.

WHAT IT IS NOT, and the boundary is deliberate. It is EVIDENCE, not a verdict.
It decides nothing, it gates nothing, and it exits 0 whatever it reads — including
when the file is missing or unparseable, which the verdict step already fails on
and would fail on twice as loudly if this crashed first. That is what lets the
workflow call it without touching one line of its pass/fail semantics. It also
prints NOTHING at all on a compliant report, so its output only ever appears on
the failing branch.

Bounded on purpose, and it says so out loud when it withholds: an unbounded dump
of a badly broken file would bury the first failure, and a silent truncation
would read as "that was all of it".
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.etree.ElementTree import Element

EXIT_OK = 0


def _text(element: Element | None) -> str:
    """The element's text, whitespace collapsed, or an empty string."""
    if element is None or element.text is None:
        return ""
    return " ".join(element.text.split())


def failing_rules(root: Element) -> list[Element]:
    """Every `<rule status="failed">` in the report, in document order."""
    return [rule for rule in root.iter("rule") if rule.get("status") == "failed"]


def describe(rule: Element, max_contexts: int, position: str) -> list[str]:
    """One failing rule as the lines a reader needs, most identifying first."""
    clause = rule.get("clause") or "?"
    specification = rule.get("specification") or "?"
    test_number = rule.get("testNumber") or "?"
    failed = rule.get("failedChecks") or "?"
    lines = [
        f"::error::PDF/A rule {position}: {specification} clause {clause}"
        f" test {test_number}, {failed} failed check(s): {_text(rule.find('description'))}"
    ]

    obj = _text(rule.find("object"))
    condition = _text(rule.find("test"))
    if obj or condition:
        lines.append(f"    object: {obj or '(none stated)'} | test: {condition or '(none stated)'}")

    checks = [check for check in rule.iter("check") if check.get("status") == "failed"]
    if not checks:
        # A failed rule with no failed check is a shape this repository has not
        # seen. Saying so beats printing nothing and letting a reader conclude
        # the rule failed on an object the report declined to name.
        lines.append("    context: the report lists no failed check for this rule")
        return lines

    for check in checks[:max_contexts]:
        lines.append(f"    context: {_text(check.find('context')) or '(none stated)'}")
        message = _text(check.find("errorMessage"))
        if message:
            lines.append(f"    message: {message}")
    if len(checks) > max_contexts:
        lines.append(f"    ... and {len(checks) - max_contexts} further failed check(s)")
    return lines


def report(path: Path, max_rules: int, max_contexts: int) -> list[str]:
    """The evidence lines for one report file. Empty when there is nothing to say."""
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        # The verdict step fails on this by itself, and says so in its own words.
        # This one only explains why it is adding nothing.
        return [f"(no failure evidence: {path} could not be read — {error})"]

    rules = failing_rules(root)
    if not rules:
        return []

    lines = [f"The veraPDF report lists {len(rules)} failing rule(s):"]
    for index, rule in enumerate(rules[:max_rules], start=1):
        lines.extend(describe(rule, max_contexts, f"{index} of {len(rules)}"))
    if len(rules) > max_rules:
        lines.append(
            f"... and {len(rules) - max_rules} further failing rule(s) not shown"
            f" (bound: --max-rules {max_rules}). The full report is in the"
            " `pdfa-validation` artifact."
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="a veraPDF --format mrr report")
    parser.add_argument("--max-rules", type=int, default=5)
    parser.add_argument("--max-contexts", type=int, default=1)
    args = parser.parse_args(argv)

    for line in report(args.report, max(1, args.max_rules), max(1, args.max_contexts)):
        print(line)
    # Always. See WHAT IT IS NOT above.
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
