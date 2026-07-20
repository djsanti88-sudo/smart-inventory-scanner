from __future__ import annotations

import json
import re
from pathlib import Path

from .models import Finding, PlanReview


SECTION_REQUIREMENTS = (
    ("goal", ("goal", "objective", "problem", "context"), "critical", 18),
    ("acceptance", ("acceptance", "success criteria", "done means"), "critical", 18),
    ("proof", ("proof", "testing", "verification", "validation"), "critical", 16),
    ("risks", ("risk", "failure mode", "threat"), "high", 12),
    ("rollback", ("rollback", "recovery", "revert"), "high", 10),
    ("out-of-scope", ("out of scope", "non-goal"), "medium", 8),
    ("files", ("files to touch", "affected files", "implementation files"), "medium", 7),
    ("cost", ("cost", "spend", "budget", "tokens"), "medium", 6),
)

PATH_PATTERN = re.compile(
    r"`((?:src|docs|scripts|e2e|tools|\.claude)/[^`\n]+|"
    r"(?:package\.json|firestore\.rules|fable5\.toml))`"
)
NPM_PATTERN = re.compile(r"\bnpm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)")
PLACEHOLDER_PATTERN = re.compile(
    r"(?im)(?:^|[-*:]\s*)(?:\[?)(TBD|TODO|FIXME|UNKNOWN)(?:\]?)(?:\s*$|\s*[-:])"
)


def _headings(text: str) -> tuple[str, ...]:
    return tuple(
        match.group(1).strip().lower()
        for match in re.finditer(r"(?m)^#{1,6}\s+(.+?)\s*$", text)
    )


def _package_scripts(root: Path) -> set[str]:
    path = root / "package.json"
    if not path.is_file():
        return set()
    try:
        return set(json.loads(path.read_text(encoding="utf-8")).get("scripts", {}))
    except (OSError, json.JSONDecodeError):
        return set()


def review_plan(path: Path, root: Path) -> PlanReview:
    resolved = path if path.is_absolute() else root / path
    if not resolved.is_file():
        raise FileNotFoundError(f"Plan not found: {resolved}")
    text = resolved.read_text(encoding="utf-8", errors="replace")
    headings = _headings(text)
    findings: list[Finding] = []
    penalty = 0

    for code, aliases, severity, points in SECTION_REQUIREMENTS:
        if not any(any(alias in heading for alias in aliases) for heading in headings):
            penalty += points
            findings.append(
                Finding(
                    code=f"missing-{code}",
                    severity=severity,
                    title=f"Missing {code.replace('-', ' ')} section",
                    detail=f"No heading clearly covers: {', '.join(aliases)}.",
                    recommendation=f"Add a specific {code.replace('-', ' ')} section with concrete evidence.",
                )
            )

    placeholders = list(PLACEHOLDER_PATTERN.finditer(text))
    if placeholders:
        penalty += min(15, len(placeholders) * 5)
        samples = ", ".join(sorted({match.group(1).upper() for match in placeholders}))
        findings.append(
            Finding(
                code="unresolved-placeholders",
                severity="high",
                title="Plan contains unresolved placeholders",
                detail=f"Found placeholder markers: {samples}.",
                evidence=f"{len(placeholders)} occurrence(s)",
                recommendation="Replace every placeholder with a decision, named owner, or explicit blocking question.",
            )
        )

    scripts = tuple(sorted(set(NPM_PATTERN.findall(text))))
    known_scripts = _package_scripts(root)
    missing_scripts = sorted(set(scripts) - known_scripts)
    if missing_scripts:
        penalty += min(12, len(missing_scripts) * 4)
        findings.append(
            Finding(
                code="unknown-npm-scripts",
                severity="high",
                title="Plan names npm commands that do not exist",
                detail=", ".join(missing_scripts),
                recommendation="Correct the command names or add the scripts before approving the plan.",
            )
        )

    missing_paths: list[str] = []
    for reference in sorted(set(PATH_PATTERN.findall(text))):
        cleaned = reference.rstrip(".,:;)")
        candidate = root / Path(cleaned)
        line = next((line for line in text.splitlines() if reference in line), "")
        declared_new = bool(re.search(r"\b(new|create|add)\b", line, re.IGNORECASE))
        if not candidate.exists() and not declared_new:
            missing_paths.append(reference)
    if missing_paths:
        penalty += min(10, len(missing_paths) * 2)
        findings.append(
            Finding(
                code="missing-file-references",
                severity="medium",
                title="Plan references files that are not present",
                detail=", ".join(missing_paths[:12]),
                evidence=f"{len(missing_paths)} missing reference(s)",
                recommendation="Verify each path or label it explicitly as a new file.",
            )
        )

    criteria_language = re.findall(
        r"(?im)^\s*[-*]\s+.*(?:pass|must|zero|at least|under|within|\d+|100%).*$",
        text,
    )
    if not criteria_language:
        penalty += 10
        findings.append(
            Finding(
                code="unmeasurable-criteria",
                severity="high",
                title="Success criteria are not objectively measurable",
                detail="No criteria line contained a threshold, count, pass condition, or explicit must.",
                recommendation="Turn completion claims into pass/fail checks with named proof commands or artifacts.",
            )
        )

    score = max(0, 100 - penalty)
    verdict = "ready" if score >= 85 else "revise" if score >= 65 else "blocked"
    return PlanReview(
        path=str(resolved),
        score=score,
        verdict=verdict,
        findings=tuple(findings),
        sections_found=headings,
        referenced_scripts=scripts,
    )


def render_plan_markdown(review: PlanReview) -> str:
    lines = [
        "# Fable 5 Plan Review",
        "",
        f"- Plan: `{review.path}`",
        f"- Score: **{review.score}/100**",
        f"- Verdict: **{review.verdict.upper()}**",
        "",
    ]
    if not review.findings:
        lines.extend(["## Result", "", "No blocking plan defects were found.", ""])
    else:
        lines.extend(["## Findings", ""])
        for finding in review.findings:
            lines.extend(
                [
                    f"### [{finding.severity.upper()}] {finding.title}",
                    "",
                    finding.detail,
                    "",
                    f"Recommendation: {finding.recommendation}",
                    "",
                ]
            )
    return "\n".join(lines)

