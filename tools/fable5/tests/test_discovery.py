from __future__ import annotations

import unittest

from tools.fable5.config import FableConfig, Route
from tools.fable5.discovery import matches_changed_paths, select_agents


def config() -> FableConfig:
    return FableConfig(
        project_name="test",
        reports_dir="reports",
        cache_db=".cache/db",
        agents_dir=".claude/agents",
        light_workers=2,
        heavy_workers=1,
        browser_workers=1,
        allowed_executables=frozenset({"python"}),
        checks=(),
        routes=(
            Route(patterns=("src/auth/**", "firestore.rules"), agents=("security", "tenant-isolation")),
            Route(patterns=("src/components/**",), agents=("accessibility",)),
        ),
    )


class DiscoveryTests(unittest.TestCase):
    def test_routes_only_relevant_agents(self) -> None:
        selected = select_agents(
            config(),
            ["src/auth/session.ts"],
            ("code-review", "security", "tenant-isolation", "accessibility"),
        )
        self.assertEqual(selected, ["code-review", "security", "tenant-isolation"])

    def test_all_agents_mode(self) -> None:
        available = ("code-review", "security", "accessibility")
        self.assertEqual(
            select_agents(config(), [], available, all_agents=True),
            list(available),
        )

    def test_changed_path_matching(self) -> None:
        self.assertTrue(matches_changed_paths(("src/**",), ["src/app/page.tsx"]))
        self.assertFalse(matches_changed_paths(("e2e/**",), ["src/app/page.tsx"]))


if __name__ == "__main__":
    unittest.main()

