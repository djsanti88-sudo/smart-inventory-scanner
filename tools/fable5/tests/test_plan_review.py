from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.fable5.plan_review import Criterion, audit_proofs, extract_criteria, review_plan


REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


GOOD_PLAN = """
# Feature plan

## Problem / Context
Counting can lose evidence. The goal is to keep every scan.

## Goals / Success criteria
- All 25 tests must pass. Proof: `npm run proof`.
- Zero scans may disappear. Proof: `npm run proof`.

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


class ExtractCriteriaTests(unittest.TestCase):
    def test_table_rows_yield_criteria_with_all_cell_proof_refs(self) -> None:
        # Per spec: criterion text = first cell, proof refs gathered from ALL cells
        # (so a proof-only middle column and an index-only first column both work).
        text = (
            "## Goals / Success criteria\n\n"
            "| Done means | Proof |\n"
            "|---|---|\n"
            "| Unit suite passes | `npm run test` |\n"
        )
        criteria = extract_criteria(text)
        self.assertEqual(len(criteria), 1)
        self.assertEqual(criteria[0].text, "Unit suite passes")
        self.assertIn("npm run test", criteria[0].proof_refs)

    def test_table_with_index_column_still_finds_proof_refs_in_any_cell(self) -> None:
        text = (
            "## Goals / Success criteria\n\n"
            "| # | Done means | Proof |\n"
            "|---|---|---|\n"
            "| 1 | Unit suite passes | `npm run test` |\n"
        )
        criteria = extract_criteria(text)
        self.assertEqual(len(criteria), 1)
        self.assertEqual(criteria[0].text, "1")
        self.assertIn("npm run test", criteria[0].proof_refs)

    def test_bullet_and_checkbox_items_yield_criteria(self) -> None:
        text = (
            "## Success criteria\n\n"
            "- All tests pass, proof `npm run test`.\n"
            "- [ ] Nothing regresses, see `PLAN_TEMPLATE.md`.\n"
        )
        criteria = extract_criteria(text)
        self.assertEqual(len(criteria), 2)
        self.assertIn("npm run test", criteria[0].proof_refs)
        self.assertIn("PLAN_TEMPLATE.md", criteria[1].proof_refs)

    def test_criterion_with_no_backticks_has_no_proof_refs(self) -> None:
        text = "## Goals / Success criteria\n\n- Something good happens.\n"
        criteria = extract_criteria(text)
        self.assertEqual(len(criteria), 1)
        self.assertEqual(criteria[0].proof_refs, [])

    def test_no_goals_section_yields_no_criteria(self) -> None:
        text = "## Problem / Context\nNo goals heading here.\n"
        self.assertEqual(extract_criteria(text), [])

    def test_non_goals_before_real_goals_does_not_hijack_section(self) -> None:
        # A "## Non-Goals" heading appearing before the real Goals section must not be
        # mistaken for it: the real criteria must still be parsed, and no Non-Goals
        # bullet may be flagged as a criterion.
        text = (
            "## Non-Goals\n"
            "- Do not build a mobile app.\n"
            "- Do not touch billing.\n\n"
            "## Goals / Success criteria\n"
            "- All tests pass. Proof: `npm run test`.\n"
        )
        criteria = extract_criteria(text)
        self.assertEqual(len(criteria), 1)
        self.assertEqual(criteria[0].text, "All tests pass. Proof: `npm run test`.")
        for criterion in criteria:
            self.assertNotIn("mobile app", criterion.text)
            self.assertNotIn("billing", criterion.text)

    def test_out_of_scope_non_goals_heading_does_not_match_goals_pattern(self) -> None:
        text = (
            "## Out of scope / Non-goals\n"
            "- Do not touch production.\n\n"
            "## Success criteria\n"
            "- Ship it. Proof: `npm run test`.\n"
        )
        criteria = extract_criteria(text)
        self.assertEqual(len(criteria), 1)
        self.assertEqual(criteria[0].text, "Ship it. Proof: `npm run test`.")


class AuditProofsTests(unittest.TestCase):
    def test_missing_npm_script_is_a_finding(self) -> None:
        criteria = [Criterion(text="Do the thing", proof_refs=["npm run does-not-exist-xyz"], line=5)]
        findings = audit_proofs(criteria, REPO_ROOT, {"test"})
        self.assertTrue(any(f.code == "missing-plan-proof" for f in findings))

    def test_existing_npm_script_is_not_a_finding(self) -> None:
        criteria = [Criterion(text="Do the thing", proof_refs=["npm run test"], line=5)]
        findings = audit_proofs(criteria, REPO_ROOT, {"test"})
        self.assertEqual(findings, [])

    def test_missing_path_is_a_finding(self) -> None:
        criteria = [Criterion(text="Do the thing", proof_refs=["docs/does-not-exist.md"], line=5)]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        self.assertTrue(any(f.code == "missing-plan-proof" for f in findings))

    def test_existing_path_is_not_a_finding(self) -> None:
        criteria = [Criterion(text="Follows the template", proof_refs=["docs/PLAN_EXECUTION.md"], line=5)]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        self.assertEqual(findings, [])

    def test_glob_and_placeholder_refs_are_skipped(self) -> None:
        criteria = [
            Criterion(text="Vague thing", proof_refs=["src/**/*.ts", "<some path>"], line=5),
        ]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        self.assertEqual(findings, [])

    def test_zero_proof_refs_is_criterion_without_proof_method(self) -> None:
        criteria = [Criterion(text="Something good happens", proof_refs=[], line=5)]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        self.assertTrue(any(f.code == "criterion-without-proof" for f in findings))

    def test_missing_screenshot_report_ref_is_a_finding(self) -> None:
        criteria = [
            Criterion(text="UI proven", proof_refs=["e2e/proof/does-not-exist.png"], line=5),
        ]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        self.assertTrue(any(f.code == "missing-plan-proof" for f in findings))

    def test_bare_command_ref_is_not_missing_proof_but_gets_info_finding(self) -> None:
        # A bare command token with no path shape and no recognized command prefix
        # (npm run / npx / node / python) still counts as SOME proof ref, so the
        # criterion must not be treated as having no proof method. It is unverifiable
        # by this tool though, so it should surface as a non-blocking info finding.
        criteria = [
            Criterion(text="Reviewer runs the tool", proof_refs=["review-plan"], line=9),
        ]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        self.assertFalse(any(f.code == "criterion-without-proof" for f in findings))
        self.assertFalse(any(f.code == "missing-plan-proof" for f in findings))
        info_findings = [f for f in findings if f.severity == "info"]
        self.assertEqual(len(info_findings), 1)
        self.assertEqual(info_findings[0].code, "unverifiable-proof-ref")
        self.assertIn("unverifiable proof ref", info_findings[0].title.lower())
        self.assertIn("review-plan", info_findings[0].detail)

    def test_bare_command_ref_does_not_flip_verdict_to_blocked(self) -> None:
        criteria = [
            Criterion(text="Reviewer runs the tool", proof_refs=["selftest"], line=9),
        ]
        findings = audit_proofs(criteria, REPO_ROOT, set())
        missing_proofs = [f.detail for f in findings if f.code != "unverifiable-proof-ref"]
        self.assertEqual(missing_proofs, [])


class ReviewPlanProofAuditTests(unittest.TestCase):
    def test_good_fixture_is_not_blocked_by_proofs(self) -> None:
        result = review_plan(FIXTURES_DIR / "plan_good.md", REPO_ROOT)
        self.assertGreater(result.criteria_audited, 0)
        self.assertEqual(result.missing_proofs, [])

    def test_missing_proof_fixture_is_blocked_and_names_both_problems(self) -> None:
        result = review_plan(FIXTURES_DIR / "plan_missing_proof.md", REPO_ROOT)
        self.assertEqual(result.verdict, "blocked")
        self.assertEqual(len(result.missing_proofs), 2)
        joined = " ".join(result.missing_proofs)
        self.assertIn("npm run does-not-exist-xyz", joined)
        self.assertIn("no proof method", joined)


if __name__ == "__main__":
    unittest.main()
