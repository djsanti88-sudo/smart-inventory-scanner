from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.fable5.plan_review import review_plan


GOOD_PLAN = """
# Feature plan

## Problem / Context
Counting can lose evidence. The goal is to keep every scan.

## Goals / Success criteria
- All 25 tests must pass.
- Zero scans may disappear.

## Proof / Testing
- Run `npm run proof` and require exit code zero.

## Risks / failure modes
- A crash could interrupt the write.

## Rollback / recovery
- Revert the isolated commit and replay the ledger.

## Out of scope
- Production deployment.

## Files to touch
- Create new `src/new-file.ts`.

## Cost / token budget
- Local checks cost zero paid API calls.
"""


class PlanReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "package.json").write_text(
            json.dumps({"scripts": {"proof": "echo pass"}}), encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_complete_plan_is_ready(self) -> None:
        path = self.root / "plan.md"
        path.write_text(GOOD_PLAN, encoding="utf-8")
        result = review_plan(path, self.root)
        self.assertEqual(result.verdict, "ready")
        self.assertGreaterEqual(result.score, 85)
        self.assertEqual(result.findings, ())

    def test_placeholders_and_missing_sections_block_plan(self) -> None:
        path = self.root / "plan.md"
        path.write_text("# Plan\n\n## Goal\n- TODO\n", encoding="utf-8")
        result = review_plan(path, self.root)
        codes = {finding.code for finding in result.findings}
        self.assertEqual(result.verdict, "blocked")
        self.assertIn("unresolved-placeholders", codes)
        self.assertIn("missing-acceptance", codes)
        self.assertIn("missing-proof", codes)

    def test_unknown_npm_script_is_evidence(self) -> None:
        path = self.root / "plan.md"
        path.write_text(GOOD_PLAN.replace("npm run proof", "npm run imaginary"), encoding="utf-8")
        result = review_plan(path, self.root)
        self.assertIn("unknown-npm-scripts", {finding.code for finding in result.findings})


if __name__ == "__main__":
    unittest.main()

