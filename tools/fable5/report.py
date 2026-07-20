from __future__ import annotations

import html
import json
from collections import Counter
from pathlib import Path

from .models import CheckResult, RunReport
from .plan_review import render_plan_markdown
from .verdict import UNTRUSTED_BANNER, redact_secrets


def redact_structure(obj: object) -> object:
    if isinstance(obj, str):
        return redact_secrets(obj)
    if isinstance(obj, dict):
        return {key: redact_structure(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [redact_structure(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(redact_structure(item) for item in obj)
    return obj


def _summary(report: RunReport) -> Counter[str]:
    return Counter(result.status for result in report.results)


def _ledger_status(result: CheckResult) -> str:
    if result.cached or "cache" in (result.reason or "").lower():
        return "cached"
    return result.status


def _render_checked_table(report: RunReport) -> list[str]:
    lines = [
        "## What was checked",
        "",
        "| Check | Status | Reason | Duration |",
        "| --- | --- | --- | --- |",
    ]
    for result in report.results:
        reason = (result.reason or "-").replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {result.check_id} | {_ledger_status(result)} | {reason} | "
            f"{result.duration_seconds:.1f}s |"
        )
    lines.append("")
    return lines


def render_markdown(report: RunReport) -> str:
    counts = _summary(report)
    lines = [
        "# Fable 5 Review",
        "",
        f"- Project: **{report.project}**",
        f"- Gate: **{report.gate}**",
        f"- Run: `{report.run_id}`",
        f"- Git: `{report.git_head[:12]}`",
        f"- Duration: **{report.duration_seconds:.1f}s**",
        (
            f"- Checks: **{counts['passed']} passed**, **{counts['failed']} failed**, "
            f"**{counts['warning']} warnings**, **{counts['blocked']} safety-blocked**, "
            f"**{counts['skipped']} skipped**"
        ),
        "",
    ]
    if report.plan_review:
        lines.extend([render_plan_markdown(report.plan_review), ""])
    lines.extend(_render_checked_table(report))
    lines.extend(["## Check evidence", ""])
    for result in report.results:
        cache_label = " (cached)" if result.cached else ""
        lines.extend(
            [
                f"### [{result.status.upper()}] {result.check_id}{cache_label}",
                "",
                result.description,
                "",
                f"- Duration: {result.duration_seconds:.1f}s",
                f"- Command: `{' '.join(result.command)}`",
                f"- Evidence: `{result.log_path or 'none'}`",
            ]
        )
        if result.reason:
            lines.append(f"- Note: {result.reason}")
        lines.append("")
    lines.extend(
        [
            "## Expert routing",
            "",
            f"Selected specialists: {', '.join(report.selected_agents) or 'none'}",
            "",
            "## Changed files",
            "",
        ]
    )
    lines.extend(f"- `{path}`" for path in report.changed_files)
    if not report.changed_files:
        lines.append("- Clean relative to the selected comparison points.")
    lines.append("")
    return "\n".join(lines)


def render_html(report: RunReport) -> str:
    counts = _summary(report)
    cards = []
    for result in report.results:
        detail = html.escape(result.reason or result.description)
        cards.append(
            f'<article class="check {html.escape(result.status)}">'
            f"<div><strong>{html.escape(result.check_id)}</strong>"
            f"<span>{html.escape(result.status.upper())}</span></div>"
            f"<p>{detail}</p><small>{result.duration_seconds:.1f}s</small></article>"
        )
    specialists = ", ".join(report.selected_agents) or "No specialist route selected"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fable 5 Review - {html.escape(report.run_id)}</title>
<style>
body{{font:16px system-ui;margin:0;background:#0b1020;color:#e8edf8}}
main{{max-width:1000px;margin:auto;padding:32px}}h1{{margin-bottom:4px}}
.meta{{color:#aeb9d1}}.score{{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}}
.score b{{background:#17213b;padding:12px 16px;border-radius:10px}}
.checks{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}}
.check{{background:#121a30;border-left:5px solid #7784a4;padding:15px;border-radius:8px}}
.check div{{display:flex;justify-content:space-between;gap:10px}}.check p{{color:#bbc5db}}
.passed{{border-color:#30c48d}}.failed{{border-color:#ff5c75}}.warning{{border-color:#ffbd4a}}
.blocked{{border-color:#9b7cff}}.planned,.skipped{{border-color:#73819f}}
code{{color:#a8d5ff}}small{{color:#91a0be}}
</style></head><body><main>
<h1>Fable 5 Review</h1>
<p class="meta">{html.escape(report.project)} | {html.escape(report.gate)} gate |
{html.escape(report.git_head[:12])} | {report.duration_seconds:.1f}s</p>
<section class="score">
<b>{counts['passed']} passed</b><b>{counts['failed']} failed</b>
<b>{counts['warning']} warnings</b><b>{counts['blocked']} safety-blocked</b>
</section>
<h2>Evidence</h2><section class="checks">{''.join(cards)}</section>
<h2>Expert routing</h2><p>{html.escape(specialists)}</p>
</main></body></html>"""


def render_expert_packet(report: RunReport, root: Path) -> str:
    failed = [
        result
        for result in report.results
        if result.status in {"failed", "warning", "blocked"}
    ]
    lines = [
        "# Fable 5 Expert Packet",
        "",
        "Review only the evidence and changed files relevant to your specialty. Every finding must",
        "include a file and line, a reproducer or failed check, severity, confidence, and the smallest",
        "safe correction. Deduplicate findings. Do not deploy, push, spend money, or use live data.",
        "",
        f"Git: `{report.git_head}`",
        "",
        "## Selected specialists",
        "",
    ]
    for agent in report.selected_agents:
        agent_path = root / ".claude" / "agents" / f"{agent}.md"
        lines.append(f"- {agent}: `{agent_path}`")
    lines.extend(["", "## Failed or suspicious evidence", ""])
    if failed:
        for result in failed:
            lines.append(
                f"- [{result.status.upper()}] {result.check_id}: "
                f"{result.reason or result.description} (log: {result.log_path or 'none'})"
            )
    else:
        lines.append("- No deterministic failures. Attack assumptions and missing coverage.")
    lines.extend(["", "## Changed files", ""])
    lines.extend(f"- `{path}`" for path in report.changed_files)
    return "\n".join(lines) + "\n"


def render_fix_packet(report: RunReport) -> str | None:
    findings = [
        result for result in report.results if result.status in {"failed", "warning"}
    ]
    if not findings:
        return None
    lines = [
        "# Fable 5 Fix Packet",
        "",
        f"Git: `{report.git_head}`",
        "",
        UNTRUSTED_BANNER,
        "",
    ]
    for result in findings:
        lines.extend(
            [
                f"## {result.check_id}",
                "",
                "```",
                f"status: {result.status}",
                "```",
                "",
                "```",
                result.reason or result.description,
                "```",
                "",
            ]
        )
    return "\n".join(lines)


def write_report(report: RunReport, report_dir: Path, root: Path) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    redacted_report = redact_structure(report.to_dict())
    (report_dir / "run.json").write_text(
        json.dumps(redacted_report, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    (report_dir / "report.md").write_text(
        redact_secrets(render_markdown(report)), encoding="utf-8"
    )
    (report_dir / "report.html").write_text(
        redact_secrets(render_html(report)), encoding="utf-8"
    )
    (report_dir / "expert-packet.md").write_text(
        redact_secrets(render_expert_packet(report, root)), encoding="utf-8"
    )
    fix_packet = render_fix_packet(report)
    if fix_packet is not None:
        (report_dir / "fix-packet.md").write_text(
            redact_secrets(fix_packet), encoding="utf-8"
        )
