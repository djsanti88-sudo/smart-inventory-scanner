from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .models import Finding, PlanReview


@dataclass(frozen=True)
class Criterion:
    text: str
    proof_refs: list[str]
    line: int


GOALS_HEADING_PATTERN = re.compile(
    r"^##.*((?<!non-)(?<!non )Goals|Success criteria)", re.IGNORECASE
)
BACKTICK_SPAN_PATTERN = re.compile(r"`([^`\n]+)`")
KNOWN_FILE_EXTENSIONS = (
    ".md", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".toml",
    ".yml", ".yaml", ".png", ".jpg", ".jpeg", ".css", ".html", ".txt", ".rules",
)

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


def _split_goals_section(text: str) -> str:
    lines = text.splitlines()
    heading_indices = [
        index for index, line in enumerate(lines) if re.match(r"^#{1,6}\s", line)
    ]
    start = None
    for index in heading_indices:
        if GOALS_HEADING_PATTERN.match(lines[index]):
            start = index
            break
    if start is None:
        return ""
    end = len(lines)
    for index in heading_indices:
        if index > start:
            end = index
            break
    return "\n".join(lines[start:end])


def _is_table_separator(cells: list[str]) -> bool:
    return all(re.fullmatch(r":?-{2,}:?", cell.strip()) for cell in cells if cell.strip())


def extract_criteria(text: str) -> list[Criterion]:
    section = _split_goals_section(text)
    if not section:
        return []
    section_lines = section.splitlines()
    full_lines = text.splitlines()
    section_start_line = 0
    for index, line in enumerate(full_lines):
        if line == section_lines[0]:
            section_start_line = index
            break

    criteria: list[Criterion] = []
    for local_index, raw_line in enumerate(section_lines):
        line_number = section_start_line + local_index + 1  # 1-indexed
        stripped = raw_line.strip()
        if not stripped:
            continue
        if re.match(r"^#{1,6}\s", stripped):
            continue

        if stripped.startswith("|"):
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if _is_table_separator(cells) or not cells or cells[0].lower() in {"#", ""}:
                continue
            # Skip the header row (heuristic: next non-blank line is a separator row).
            next_index = local_index + 1
            if next_index < len(section_lines):
                next_stripped = section_lines[next_index].strip()
                if next_stripped.startswith("|"):
                    next_cells = [c.strip() for c in next_stripped.strip("|").split("|")]
                    if _is_table_separator(next_cells):
                        continue
            criterion_text = cells[0] if cells else ""
            proof_refs: list[str] = []
            for cell in cells:
                proof_refs.extend(BACKTICK_SPAN_PATTERN.findall(cell))
            if criterion_text:
                criteria.append(
                    Criterion(text=criterion_text, proof_refs=proof_refs, line=line_number)
                )
            continue

        bullet_match = re.match(r"^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$", stripped)
        if bullet_match:
            item_text = bullet_match.group(1)
            proof_refs = BACKTICK_SPAN_PATTERN.findall(item_text)
            criteria.append(Criterion(text=item_text, proof_refs=proof_refs, line=line_number))

    return criteria


def _looks_like_path(ref: str) -> bool:
    if "/" in ref:
        return True
    return any(ref.endswith(extension) for extension in KNOWN_FILE_EXTENSIONS)


def _is_non_checkable(ref: str) -> bool:
    return "*" in ref or "?" in ref or "<" in ref or ">" in ref


def audit_proofs(
    criteria: list[Criterion], root: Path, package_scripts: set[str]
) -> list[Finding]:
    findings: list[Finding] = []
    for criterion in criteria:
        if not criterion.proof_refs:
            findings.append(
                Finding(
                    code="criterion-without-proof",
                    severity="high",
                    title="Criterion without proof method",
                    detail=f"Line {criterion.line}: \"{criterion.text}\" has no proof method.",
                    evidence=f"line {criterion.line}",
                    recommendation="Add a backticked proof command or path this criterion "
                    "can be verified against.",
                )
            )
            continue

        for ref in criterion.proof_refs:
            if _is_non_checkable(ref):
                continue

            npm_match = re.match(r"^npm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)", ref)
            if npm_match:
                script = npm_match.group(1)
                if script not in package_scripts:
                    findings.append(
                        Finding(
                            code="missing-plan-proof",
                            severity="high",
                            title="Missing proof artifact",
                            detail=f"Line {criterion.line}: \"{criterion.text}\" references "
                            f"`npm run {script}`, which is not a known npm script.",
                            evidence=ref,
                            recommendation="Correct the script name or add it to "
                            "package.json before approving the plan.",
                        )
                    )
                continue

            if any(ref.startswith(prefix) for prefix in ("npx ", "node ", "python ")):
                # Only checkable for a recognized leading executable; never executed.
                continue

            if _looks_like_path(ref):
                cleaned = ref.rstrip(".,:;)")
                candidate = root / Path(cleaned)
                if not candidate.exists():
                    findings.append(
                        Finding(
                            code="missing-plan-proof",
                            severity="high",
                            title="Missing proof artifact",
                            detail=f"Line {criterion.line}: \"{criterion.text}\" references "
                            f"`{cleaned}`, which does not exist.",
                            evidence=ref,
                            recommendation="Create the artifact, correct the path, or "
                            "remove the claim before approving the plan.",
                        )
                    )
                continue

            # Bare command token: no path shape, no recognized command prefix. It still
            # counts as a proof ref (the criterion is not "without proof method"), but this
            # tool cannot verify it, so surface a non-blocking informational finding.
            findings.append(
                Finding(
                    code="unverifiable-proof-ref",
                    severity="info",
                    title="Unverifiable proof ref",
                    detail=f"Line {criterion.line}: \"{criterion.text}\" references "
                    f"`{ref}`, which is not a recognized command or path and cannot be "
                    "automatically verified.",
                    evidence=ref,
                    recommendation="Confirm this proof method manually, or rephrase it as "
                    "a known npm/npx/node/python command or an existing file path.",
                )
            )

    return findings


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

    criteria = extract_criteria(text)
    proof_findings = audit_proofs(criteria, root, known_scripts)
    findings.extend(proof_findings)
    blocking_proof_findings = [f for f in proof_findings if f.severity != "info"]
    missing_proofs = [finding.detail for finding in blocking_proof_findings]
    if blocking_proof_findings:
        penalty += min(20, len(blocking_proof_findings) * 5)

    score = max(0, 100 - penalty)
    verdict = "ready" if score >= 85 else "revise" if score >= 65 else "blocked"
    if missing_proofs:
        verdict = "blocked"
    return PlanReview(
        path=str(resolved),
        score=score,
        verdict=verdict,
        findings=tuple(findings),
        sections_found=headings,
        referenced_scripts=scripts,
        criteria_audited=len(criteria),
        missing_proofs=missing_proofs,
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
    lines.extend(
        [
            "## Proof audit",
            "",
            f"- Criteria audited: {review.criteria_audited}",
        ]
    )
    if not review.missing_proofs:
        lines.append("- Every audited criterion has an existing proof artifact.")
    else:
        lines.append(f"- Missing proofs: {len(review.missing_proofs)}")
        lines.append("")
        for missing in review.missing_proofs:
            lines.append(f"  - {missing}")
    lines.append("")
    return "\n".join(lines)

