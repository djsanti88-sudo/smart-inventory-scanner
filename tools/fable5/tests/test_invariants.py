from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from tools.fable5.cache import EvidenceCache
from tools.fable5.config import FableConfig
from tools.fable5.invariants import (
    InvariantContract,
    load_invariants,
    select_invariant_checks,
)
from tools.fable5.risk import DEFAULT_RULES, classify
from tools.fable5.scheduler import SafetyPolicy, run_checks


def _config(*, allowed: frozenset[str], checks=()) -> FableConfig:
    return FableConfig(
        project_name="test",
        reports_dir="reports",
        cache_db=".cache/db",
        agents_dir=".claude/agents",
        light_workers=1,
        heavy_workers=1,
        browser_workers=1,
        allowed_executables=allowed,
        checks=checks,
        routes=(),
    )


class InvariantLoaderTests(unittest.TestCase):
    def test_loads_json_contract(self) -> None:
        payload = [
            {
                "id": "ledger-law",
                "description": "Every scan counts.",
                "when_tags": ["ledger"],
                "command": ["npm", "run", "test:ledger"],
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "invariants.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            contracts = load_invariants(path)

        self.assertEqual(
            contracts,
            (
                InvariantContract(
                    invariant_id="ledger-law",
                    description="Every scan counts.",
                    when_tags=frozenset({"ledger"}),
                    command=("npm", "run", "test:ledger"),
                ),
            ),
        )

    def test_rejects_duplicate_ids(self) -> None:
        item = {
            "id": "same",
            "description": "duplicate",
            "when_tags": ["ledger"],
            "command": ["npm", "run", "test:ledger"],
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "invariants.json"
            path.write_text(json.dumps([item, item]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unique"):
                load_invariants(path)

    def test_seed_set_contains_exactly_the_five_approved_entries(self) -> None:
        root = Path(__file__).resolve().parents[3]
        contracts = load_invariants(root / "tools" / "fable5" / "invariants.json")
        by_id = {contract.invariant_id: contract.command for contract in contracts}

        self.assertEqual(
            by_id,
            {
                "key-safety": (
                    "npx",
                    "vitest",
                    "run",
                    "src/services/keySafety.test.ts",
                ),
                "ledger-law": ("npm", "run", "test:ledger"),
                "server-import-boundary": (
                    "npx",
                    "vitest",
                    "run",
                    "src/products/catalog/prefixIndexBundleBoundary.test.ts",
                    "src/decoding/server/knowledge/tire/importBoundary.test.ts",
                ),
                "no-em-dash": ("node", "scripts/validate-agents.mjs"),
                "cap-single-charge": (
                    "semgrep",
                    "scan",
                    "--config",
                    "tools/fable5/semgrep.yml",
                    "--metrics=off",
                    "--error",
                    "--no-rewrite-rule-ids",
                    "--exclude-rule",
                    "fable5-no-dynamic-code-execution",
                    "--exclude-rule",
                    "fable5-review-child-process-exec",
                    "src",
                ),
            },
        )


class InvariantSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contracts = (
            InvariantContract(
                invariant_id="ledger-law",
                description="ledger",
                when_tags=frozenset({"ledger"}),
                command=("npm", "run", "test:ledger"),
            ),
            InvariantContract(
                invariant_id="docs-copy",
                description="docs",
                when_tags=frozenset({"docs", "ui"}),
                command=("node", "check.mjs"),
            ),
        )

    def test_selects_only_contracts_whose_tags_intersect_profile(self) -> None:
        checks = select_invariant_checks(self.contracts, {"ledger"})

        self.assertEqual([check.check_id for check in checks], ["invariant:ledger-law"])
        self.assertEqual(checks[0].command, ("npm", "run", "test:ledger"))

    def test_empty_profile_selects_no_contracts(self) -> None:
        self.assertEqual(select_invariant_checks(self.contracts, set()), ())

    def test_ledger_tagged_diff_schedules_ledger_command(self) -> None:
        profile = classify(["src/services/inventory.ts"], list(DEFAULT_RULES))
        checks = select_invariant_checks(self.contracts, profile.tags)

        self.assertEqual([check.command for check in checks], [("npm", "run", "test:ledger")])


class InvariantDispatchTests(unittest.TestCase):
    def test_dispatch_routes_through_scheduler_allowlist(self) -> None:
        contract = InvariantContract(
            invariant_id="python-version",
            description="version",
            when_tags=frozenset({"docs"}),
            command=("python", "--version"),
        )
        checks = select_invariant_checks((contract,), {"docs"})

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            results = asyncio.run(
                run_checks(
                    root=root,
                    config=_config(allowed=frozenset({"node"}), checks=checks),
                    gate="fast",
                    report_dir=root / "report",
                    changed_files=[],
                    workspace_key="invariant-test",
                    cache=EvidenceCache(root / "cache.sqlite3", enabled=False),
                    policy=SafetyPolicy(),
                    dry_run=True,
                    callback=lambda _: None,
                )
            )

        self.assertEqual(results[0].status, "failed")
        self.assertIn("allowlist", results[0].reason)


if __name__ == "__main__":
    unittest.main()
