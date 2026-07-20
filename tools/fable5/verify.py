from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .experts import Finding

# Same seam as experts._CLAUDE_CMD_ENV (documented there): when set, its space-split value
# replaces the claude executable + fixed flags here too, so tests never invoke the real CLI.
# Kept as a separate literal (not imported) to avoid a circular import with experts.py, which
# imports this module.
_CLAUDE_CMD_ENV = "FABLE5_CLAUDE_CMD"

_MAX_BUDGET_USD = "0.50"

# Per-angle caps (exact, from the brief): rank findings by (severity desc, confidence desc), take
# the top 8 for individual refute calls, everything past that goes into one batched call.
_MAX_INDIVIDUAL_REFUTES = 8

# An angle returning more than this many findings is DEGRADED wholesale: no refute calls happen
# for it at all, every finding in it comes back verified_status "degraded".
_DEGRADED_FINDINGS_THRESHOLD = 20

# Packet (code-evidence context) sent to the refute model is capped to this many bytes; longer
# packets are truncated, never errored on.
_PACKET_CAP_BYTES = 8 * 1024

CEILING_REASON = "AI call ceiling reached; partial review"

_SEVERITY_RANK = {"blocker": 3, "major": 2, "minor": 1}


class CallBudget:
    """Simple mutable per-run AI-call counter shared across expert + refute + escalation calls."""

    def __init__(self, remaining: int = 30) -> None:
        self.remaining = remaining

    def spend(self) -> bool:
        if self.remaining <= 0:
            return False
        self.remaining -= 1
        return True


@dataclass(frozen=True)
class RefuteVerdict:
    verdict: str  # "confirmed" | "refuted" | "unclear"
    reason: str = ""


@dataclass(frozen=True)
class VerifiedFinding:
    """A Finding plus its verification outcome, enough for ledger.py/experts.py to build a
    CheckResult and a ledger row."""

    severity: str
    file: str
    line: int
    claim: str
    evidence: str
    fix: str
    confidence: float
    verified_status: str  # "confirmed" | "refuted" | "unverified" | "degraded" | "skipped"
    refute_reason: str = ""
    angle: str = ""


def build_refute_command(model: str, prompt: str) -> list[str]:
    """Same flag shape as experts.build_claude_command minus --agent, still budget-capped.

    Honors the FABLE5_CLAUDE_CMD seam identically to build_claude_command.
    """
    override = os.environ.get(_CLAUDE_CMD_ENV)
    if override:
        base = override.split(" ")
    else:
        base = [shutil.which("claude") or "claude"]
    return [
        *base,
        "--print",
        "--model",
        model,
        "--permission-mode",
        "plan",
        "--tools",
        "Read,Grep,Glob",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--max-budget-usd",
        _MAX_BUDGET_USD,
        prompt,
    ]


def _environment() -> dict[str, str]:
    environment = os.environ.copy()
    for key in (
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AZURE_API_KEY",
    ):
        environment.pop(key, None)
    environment["CI"] = "1"
    environment["NO_COLOR"] = "1"
    return environment


_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    match = _FENCE_RE.match(stripped)
    if match:
        return match.group(1).strip()
    return stripped


def _parse_envelope_result_text(stdout: str) -> str:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return stdout
    if isinstance(payload, dict):
        return payload.get("result", stdout)
    return stdout


def _finding_to_dict(finding: "Finding") -> dict[str, object]:
    return {
        "severity": finding.severity,
        "file": finding.file,
        "line": finding.line,
        "claim": finding.claim,
        "evidence": finding.evidence,
        "fix": finding.fix,
        "confidence": finding.confidence,
    }


async def _run_claude(command: list[str], *, timeout_seconds: int = 60) -> str:
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = await asyncio.create_subprocess_exec(
        *command,
        env=_environment(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=creationflags,
        start_new_session=os.name != "nt",
    )
    try:
        output_bytes, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except TimeoutError:
        process.kill()
        output_bytes, _ = await process.communicate()
    return output_bytes.decode("utf-8", errors="replace")


async def refute(finding: "Finding", packet: str, model: str = "haiku") -> RefuteVerdict:
    """Try to refute one finding against code evidence. Parse failure -> "unclear"."""
    capped_packet = packet[:_PACKET_CAP_BYTES]
    prompt = (
        "Try to REFUTE this finding against the code evidence provided. "
        "Default to refuted if evidence is weak.\n"
        f"Finding: {json.dumps(_finding_to_dict(finding))}\n"
        f"Code evidence packet:\n{capped_packet}\n"
        'Respond ONLY with {"verdict": "confirmed|refuted|unclear", "reason": "<why>"} '
        "and nothing else."
    )
    command = build_refute_command(model, prompt)
    output = await _run_claude(command)
    result_text = _parse_envelope_result_text(output)
    candidate = _strip_code_fences(result_text)
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return RefuteVerdict(verdict="unclear", reason="unparseable refute response")
    if not isinstance(payload, dict):
        return RefuteVerdict(verdict="unclear", reason="unparseable refute response")
    verdict = payload.get("verdict")
    if verdict not in {"confirmed", "refuted", "unclear"}:
        return RefuteVerdict(verdict="unclear", reason="unparseable refute response")
    return RefuteVerdict(verdict=verdict, reason=str(payload.get("reason", "")))


async def _refute_batch(
    findings: list["Finding"], packet: str, call_budget: CallBudget, model: str = "haiku"
) -> dict[int, str]:
    """One call covering the remainder findings. Returns {index: verdict} for indices present in
    the response. Parse failure -> empty dict (caller marks everything "unverified")."""
    if not call_budget.spend():
        return {}
    capped_packet = packet[:_PACKET_CAP_BYTES]
    listing = [
        {"index": i, **_finding_to_dict(f)} for i, f in enumerate(findings)
    ]
    prompt = (
        "Try to REFUTE each of these findings against the code evidence provided. "
        "Default to refuted if evidence is weak.\n"
        f"Findings: {json.dumps(listing)}\n"
        f"Code evidence packet:\n{capped_packet}\n"
        'Respond ONLY with {"refuted": [indices], "confirmed": [indices]} '
        "(indices referring to position in the findings list above) and nothing else."
    )
    command = build_refute_command(model, prompt)
    output = await _run_claude(command)
    result_text = _parse_envelope_result_text(output)
    candidate = _strip_code_fences(result_text)
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}
    refuted = payload.get("refuted")
    confirmed = payload.get("confirmed")
    if not isinstance(refuted, list) or not isinstance(confirmed, list):
        return {}
    outcome: dict[int, str] = {}
    for index in refuted:
        if isinstance(index, int):
            outcome[index] = "refuted"
    for index in confirmed:
        if isinstance(index, int):
            outcome[index] = "confirmed"
    return outcome


def _rank_key(finding: "Finding") -> tuple[int, float]:
    return (_SEVERITY_RANK.get(finding.severity, 0), finding.confidence)


async def verify_findings(
    findings: list["Finding"], packet: str, call_budget: CallBudget
) -> list[VerifiedFinding]:
    """Apply the refute-first verification caps and return one VerifiedFinding per input finding.

    - >20 findings: whole angle DEGRADED, zero refute calls.
    - Otherwise: top 8 (by severity desc, confidence desc) get individual refute calls; the
      remainder go into one batched call.
    - "unclear" from an individual refute escalates once to model="sonnet"; still unclear -> kept,
      "unverified".
    - Ceiling reached mid-run: remaining findings get verified_status "skipped" with
      CEILING_REASON, never silently dropped.
    """
    if not findings:
        return []

    if len(findings) > _DEGRADED_FINDINGS_THRESHOLD:
        reason = f"angle degraded: {len(findings)} findings, manual review required"
        return [
            VerifiedFinding(
                severity=f.severity,
                file=f.file,
                line=f.line,
                claim=f.claim,
                evidence=f.evidence,
                fix=f.fix,
                confidence=f.confidence,
                verified_status="degraded",
                refute_reason=reason,
            )
            for f in findings
        ]

    ranked = sorted(enumerate(findings), key=lambda pair: _rank_key(pair[1]), reverse=True)
    individual_indices = [index for index, _ in ranked[:_MAX_INDIVIDUAL_REFUTES]]
    remainder_indices = [index for index, _ in ranked[_MAX_INDIVIDUAL_REFUTES:]]

    outcomes: dict[int, VerifiedFinding] = {}

    for index in individual_indices:
        finding = findings[index]
        if not call_budget.spend():
            outcomes[index] = VerifiedFinding(
                severity=finding.severity,
                file=finding.file,
                line=finding.line,
                claim=finding.claim,
                evidence=finding.evidence,
                fix=finding.fix,
                confidence=finding.confidence,
                verified_status="skipped",
                refute_reason=CEILING_REASON,
            )
            continue
        verdict = await refute(finding, packet)
        if verdict.verdict == "unclear":
            if call_budget.spend():
                escalated = await refute(finding, packet, model="sonnet")
                if escalated.verdict == "unclear":
                    outcomes[index] = VerifiedFinding(
                        severity=finding.severity,
                        file=finding.file,
                        line=finding.line,
                        claim=finding.claim,
                        evidence=finding.evidence,
                        fix=finding.fix,
                        confidence=finding.confidence,
                        verified_status="unverified",
                        refute_reason=escalated.reason or "unclear after escalation",
                    )
                else:
                    outcomes[index] = VerifiedFinding(
                        severity=finding.severity,
                        file=finding.file,
                        line=finding.line,
                        claim=finding.claim,
                        evidence=finding.evidence,
                        fix=finding.fix,
                        confidence=finding.confidence,
                        verified_status=escalated.verdict,
                        refute_reason=escalated.reason,
                    )
            else:
                outcomes[index] = VerifiedFinding(
                    severity=finding.severity,
                    file=finding.file,
                    line=finding.line,
                    claim=finding.claim,
                    evidence=finding.evidence,
                    fix=finding.fix,
                    confidence=finding.confidence,
                    verified_status="unverified",
                    refute_reason=verdict.reason or "unclear; escalation skipped (ceiling reached)",
                )
        else:
            outcomes[index] = VerifiedFinding(
                severity=finding.severity,
                file=finding.file,
                line=finding.line,
                claim=finding.claim,
                evidence=finding.evidence,
                fix=finding.fix,
                confidence=finding.confidence,
                verified_status=verdict.verdict,
                refute_reason=verdict.reason,
            )

    if remainder_indices:
        remainder_findings = [findings[index] for index in remainder_indices]
        if call_budget.remaining <= 0:
            for index in remainder_indices:
                finding = findings[index]
                outcomes[index] = VerifiedFinding(
                    severity=finding.severity,
                    file=finding.file,
                    line=finding.line,
                    claim=finding.claim,
                    evidence=finding.evidence,
                    fix=finding.fix,
                    confidence=finding.confidence,
                    verified_status="skipped",
                    refute_reason=CEILING_REASON,
                )
        else:
            batch_outcome = await _refute_batch(remainder_findings, packet, call_budget)
            for local_index, index in enumerate(remainder_indices):
                finding = findings[index]
                status = batch_outcome.get(local_index, "unverified")
                reason = "" if local_index in batch_outcome else "unresolved by batched refute"
                outcomes[index] = VerifiedFinding(
                    severity=finding.severity,
                    file=finding.file,
                    line=finding.line,
                    claim=finding.claim,
                    evidence=finding.evidence,
                    fix=finding.fix,
                    confidence=finding.confidence,
                    verified_status=status,
                    refute_reason=reason,
                )

    return [outcomes[index] for index in range(len(findings))]
