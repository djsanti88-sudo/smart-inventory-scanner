from __future__ import annotations

import unittest

from tools.fable5.risk import DEFAULT_RULES, RiskProfile, RiskRule, classify, expert_tier


class ClassifyTests(unittest.TestCase):
    def test_empty_change_list_scores_zero(self) -> None:
        profile = classify([], DEFAULT_RULES)
        self.assertEqual(profile.score, 0)
        self.assertEqual(profile.tags, set())
        self.assertEqual(profile.per_file, {})

    def test_docs_only_change_scores_one(self) -> None:
        profile = classify(["docs/ARCHITECTURE.md", "README.md"], DEFAULT_RULES)
        self.assertEqual(profile.score, 1)
        self.assertEqual(profile.tags, {"docs"})
        self.assertEqual(
            profile.per_file,
            {"docs/ARCHITECTURE.md": "docs", "README.md": "docs"},
        )

    def test_ui_change_scores_four(self) -> None:
        profile = classify(["src/user-interface/ScannerInput.tsx"], DEFAULT_RULES)
        self.assertEqual(profile.score, 4)
        self.assertEqual(profile.tags, {"ui"})

    def test_tenancy_change_scores_eight(self) -> None:
        profile = classify(["firestore.rules"], DEFAULT_RULES)
        self.assertEqual(profile.score, 8)
        self.assertEqual(profile.tags, {"tenancy"})

    def test_ledger_change_scores_ten(self) -> None:
        profile = classify(["src/inventory/ledger.ts"], DEFAULT_RULES)
        self.assertEqual(profile.score, 10)
        self.assertEqual(profile.tags, {"ledger"})

    def test_scan_store_matches_ledger_rule(self) -> None:
        profile = classify(["src/stores/scanStore.ts"], DEFAULT_RULES)
        self.assertEqual(profile.score, 10)
        self.assertEqual(profile.tags, {"ledger"})

    def test_decode_change_scores_six(self) -> None:
        profile = classify(["src/decoding/pipeline.ts"], DEFAULT_RULES)
        self.assertEqual(profile.score, 6)
        self.assertEqual(profile.tags, {"decode"})

    def test_multi_match_keeps_max_score_and_all_tags(self) -> None:
        profile = classify(
            ["src/inventory/ledger.ts", "README.md", "src/user-interface/Nav.tsx"],
            DEFAULT_RULES,
        )
        self.assertEqual(profile.score, 10)
        self.assertEqual(profile.tags, {"ledger", "docs", "ui"})

    def test_per_file_maps_to_highest_weight_tag_for_that_file(self) -> None:
        rules = [
            RiskRule(patterns=("src/app/api/**",), tag="tenancy", weight=8),
            RiskRule(patterns=("src/app/**",), tag="ui", weight=4),
        ]
        profile = classify(["src/app/api/ai-lookup/route.ts"], rules)
        self.assertEqual(profile.score, 8)
        self.assertEqual(profile.tags, {"tenancy", "ui"})
        self.assertEqual(
            profile.per_file,
            {"src/app/api/ai-lookup/route.ts": "tenancy"},
        )

    def test_file_matching_nothing_is_omitted_from_per_file(self) -> None:
        profile = classify(["random/unmatched/path.xyz"], DEFAULT_RULES)
        self.assertEqual(profile.score, 0)
        self.assertEqual(profile.tags, set())
        self.assertEqual(profile.per_file, {})

    def test_double_star_pattern_matches_nested_paths(self) -> None:
        profile = classify(["src/sync-database/cloud/repository.ts"], DEFAULT_RULES)
        self.assertEqual(profile.score, 8)
        self.assertEqual(profile.tags, {"tenancy"})

    def test_risk_profile_is_a_dataclass_with_expected_fields(self) -> None:
        profile = RiskProfile(score=5, tags={"ui"}, per_file={"a.tsx": "ui"})
        self.assertEqual(profile.score, 5)
        self.assertEqual(profile.tags, {"ui"})
        self.assertEqual(profile.per_file, {"a.tsx": "ui"})


class DefaultRulesTests(unittest.TestCase):
    def test_default_rules_cover_expected_tags_and_weights(self) -> None:
        by_tag = {rule.tag: rule.weight for rule in DEFAULT_RULES}
        self.assertEqual(
            by_tag,
            {"ledger": 10, "tenancy": 8, "decode": 6, "ui": 4, "docs": 1},
        )


class ExpertTierTests(unittest.TestCase):
    def test_score_zero_is_skip(self) -> None:
        self.assertEqual(expert_tier(0, False), "skip")

    def test_score_three_is_skip(self) -> None:
        self.assertEqual(expert_tier(3, False), "skip")

    def test_score_four_is_medium(self) -> None:
        self.assertEqual(expert_tier(4, False), "medium")

    def test_score_seven_is_medium(self) -> None:
        self.assertEqual(expert_tier(7, False), "medium")

    def test_score_eight_is_high(self) -> None:
        self.assertEqual(expert_tier(8, False), "high")

    def test_score_ten_is_high(self) -> None:
        self.assertEqual(expert_tier(10, False), "high")

    def test_all_agents_forces_high_even_at_low_score(self) -> None:
        self.assertEqual(expert_tier(0, True), "high")
        self.assertEqual(expert_tier(3, True), "high")


if __name__ == "__main__":
    unittest.main()
