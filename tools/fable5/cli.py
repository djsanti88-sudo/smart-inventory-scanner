from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .cache import EvidenceCache
from .config import FableConfig, load_config
from .discovery import (
    changed_files,
    discover_capabilities,
    find_repo_root,
    git_head,
    select_agents,
    workspace_fingerprint,
)
from .experts import run_experts
from .models import RunReport
from .plan_review import render_plan_markdown, review_plan
from .report import write_report
from .scheduler import SafetyPolicy, run_checks


def _path_from_root(root: Path, value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else root / path


def _load(root: Path, value: str | None) -> tuple[FableConfig, Path]:
    path = _path_from_root(root, value) or root / "fable5.toml"
    return load_config(root, path), path


def _doctor(root: Path, config: FableConfig, as_json: bool) -> int:
    inventory = discover_capabilities(root, config)
    if as_json:
        print(json.dumps(inventory.to_dict(), indent=2, sort_keys=True))
        return 0
    print(f"Fable 5 {__version__}")
    print(f"Repository: {root}")
    print(f"Agents: {len(inventory.agents)}")
    print(f"Skills: {len(inventory.skills)}")
    print(f"Plugins: {len(inventory.plugins)}")
    print(f"Project commands: {len(inventory.package_scripts)}")
    print("\nLocal tools")
    for name, location in inventory.tools.items():
        marker = "READY" if location else "MISSING"
        print(f"  {marker:7} {name}{f' -> {location}' if location else ''}")
    print("\nSafety defaults: offline, free, local, report-only")
    return 0


def _plan(root: Path, config: FableConfig, args: argparse.Namespace) -> int:
    review = review_plan(Path(args.path), root)
    markdown = render_plan_markdown(review)
    print(markdown)
    if args.output_dir:
        output = _path_from_root(root, args.output_dir)
        assert output is not None
        output.mkdir(parents=True, exist_ok=True)
        (output / "plan-review.json").write_text(
            json.dumps(review.to_dict(), indent=2, sort_keys=True), encoding="utf-8"
        )
        (output / "plan-review.md").write_text(markdown, encoding="utf-8")
        print(f"Evidence: {output}")
    return 0 if review.verdict == "ready" else 1


async def _run(root: Path, config: FableConfig, config_path: Path, args: argparse.Namespace) -> int:
    valid_gates = sorted({gate for check in config.checks for gate in check.gates})
    if args.gate not in valid_gates:
        raise ValueError(f"Unknown gate {args.gate!r}; choose one of: {', '.join(valid_gates)}")

    started = datetime.now(timezone.utc)
    started_timer = time.perf_counter()
    run_id = f"{started.strftime('%Y%m%dT%H%M%SZ')}-{args.gate}"
    report_dir = root / config.reports_dir / run_id
    files = changed_files(root)
    inventory = discover_capabilities(root, config)
    agents = select_agents(
        config,
        files,
        inventory.agents,
        all_agents=args.all_agents or args.gate == "monthly",
    )
    fingerprint = workspace_fingerprint(root, files, config_path)
    plan_result = review_plan(Path(args.plan), root) if args.plan else None
    cache = EvidenceCache(root / config.cache_db, enabled=not args.no_cache and not args.dry_run)
    print(f"Fable 5 review: {config.project_name}")
    print(f"Gate: {args.gate} | Changed files: {len(files)} | Specialists: {len(agents)}")
    print(f"Evidence directory: {report_dir}")
    try:
        results = await run_checks(
            root=root,
            config=config,
            gate=args.gate,
            report_dir=report_dir,
            changed_files=files,
            workspace_key=fingerprint,
            cache=cache,
            policy=SafetyPolicy(
                allow_network=args.allow_network,
                allow_live=args.allow_live,
                allow_paid=args.allow_paid,
                allow_mutating=args.allow_mutating,
            ),
            only=set(args.only) if args.only else None,
            dry_run=args.dry_run,
        )
        if args.with_experts:
            print(
                f"Launching {len(agents)} Fable expert review(s) with "
                f"{config.expert_workers} concurrent workers"
            )
            results.extend(
                await run_experts(
                    root=root,
                    report_dir=report_dir,
                    agents=agents,
                    model=args.expert_model,
                    changed_files=files,
                    deterministic_results=results,
                    workers=config.expert_workers,
                    timeout_seconds=args.expert_timeout,
                    dry_run=args.dry_run,
                    allow_paid=args.allow_paid_fallback,
                )
            )
    finally:
        cache.close()

    finished = datetime.now(timezone.utc)
    report = RunReport(
        schema_version=1,
        run_id=run_id,
        project=config.project_name,
        gate=args.gate,
        started_at=started.isoformat(),
        finished_at=finished.isoformat(),
        duration_seconds=round(time.perf_counter() - started_timer, 3),
        repository=str(root),
        git_head=git_head(root),
        workspace_fingerprint=fingerprint,
        changed_files=files,
        selected_agents=agents,
        capabilities=inventory,
        results=results,
        plan_review=plan_result,
    )
    write_report(report, report_dir, root)
    failed = [result for result in results if result.status == "failed" and result.blocking]
    plan_blocked = bool(plan_result and plan_result.verdict == "blocked")
    print(
        f"RESULT: {'BLOCKED' if failed or plan_blocked else 'PASS'} | "
        f"failed={len(failed)} | report={report_dir / 'report.html'}"
    )
    return 1 if failed or plan_blocked else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fable5",
        description="Local-first plan, build, red-team, and expert-review orchestrator.",
    )
    parser.add_argument("--repo", help="Repository path. Defaults to the current repository.")
    parser.add_argument("--config", help="Configuration path relative to the repository.")
    parser.add_argument("--version", action="version", version=f"Fable 5 {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor", help="Inventory local tools, agents, skills, and plugins.")
    doctor.add_argument("--json", action="store_true", help="Print machine-readable capability data.")

    plan = subparsers.add_parser(
        "review-plan", aliases=["plan"], help="Attack a Markdown plan before implementation."
    )
    plan.add_argument("path", help="Path to the Markdown plan.")
    plan.add_argument("--output-dir", help="Optional directory for JSON and Markdown evidence.")

    run = subparsers.add_parser(
        "review-build", aliases=["run"], help="Run the configured evidence arsenal concurrently."
    )
    run.add_argument("--gate", default="fast", help="Evidence gate: fast, pr, release, or monthly.")
    run.add_argument("--plan", help="Also review this plan and include it in the run report.")
    run.add_argument("--only", nargs="+", help="Run only the named checks within the selected gate.")
    run.add_argument("--dry-run", action="store_true", help="Show scheduling without running checks.")
    run.add_argument("--no-cache", action="store_true", help="Ignore successful cached evidence.")
    run.add_argument("--all-agents", action="store_true", help="Route the packet to every local agent.")
    run.add_argument(
        "--with-experts",
        action="store_true",
        help="Use the Claude subscription/network to run selected experts concurrently.",
    )
    run.add_argument(
        "--expert-model",
        default="sonnet",
        help="Claude model alias for experts. Defaults to sonnet (project model-tiering rule).",
    )
    run.add_argument(
        "--expert-timeout",
        type=int,
        default=900,
        help="Maximum seconds per expert.",
    )
    run.add_argument(
        "--allow-paid-fallback",
        action="store_true",
        help=(
            "Opt out of the subscription-only fail-closed cost gate. Nonzero expert cost is "
            "still reported in the result reason, but status follows exit code instead of "
            "forcing failed. Off by default."
        ),
    )
    run.add_argument("--allow-network", action="store_true", help="Allow checks marked as networked.")
    run.add_argument("--allow-live", action="store_true", help="Allow checks marked as touching live systems.")
    run.add_argument("--allow-paid", action="store_true", help="Allow checks marked as potentially paid.")
    run.add_argument("--allow-mutating", action="store_true", help="Allow checks marked as state-changing.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        root = find_repo_root(Path(args.repo) if args.repo else Path.cwd())
        config, config_path = _load(root, args.config)
        if args.command == "doctor":
            return _doctor(root, config, args.json)
        if args.command in {"review-plan", "plan"}:
            return _plan(root, config, args)
        if args.command in {"review-build", "run"}:
            return asyncio.run(_run(root, config, config_path, args))
        parser.error(f"Unsupported command: {args.command}")
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"Fable 5 error: {error}", file=sys.stderr)
        return 2
    return 2
