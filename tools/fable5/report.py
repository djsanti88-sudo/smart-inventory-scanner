from __future__ import annotations

import html
import json
from collections import Counter
from pathlib import Path

from .models import RunReport
from .plan_review import render_plan_markdown


def _summary(report: RunReport) -> Counter[str]:
    return Counter(result.status for result in report.results)


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


def write_report(report: RunReport, report_dir: Path, root: Path) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "run.json").write_text(
        json.dumps(report.to_dict(), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    (report_dir / "report.md").write_text(render_markdown(report), encoding="utf-8")
    (report_dir / "report.html").write_text(render_html(report), encoding="utf-8")
    (report_dir / "expert-packet.md").write_text(
        render_expert_packet(report, root), encoding="utf-8"
    )

