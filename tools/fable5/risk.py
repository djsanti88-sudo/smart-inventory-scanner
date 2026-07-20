from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RiskRule:
    patterns: tuple[str, ...]
    tag: str
    weight: int


@dataclass(frozen=True)
class RiskProfile:
    score: int = 0
    tags: set[str] = field(default_factory=set)
    per_file: dict[str, str] = field(default_factory=dict)


DEFAULT_RULES: tuple[RiskRule, ...] = (
    RiskRule(patterns=("src/services/inventory*", "src/stores/scan*"), tag="ledger", weight=10),
    RiskRule(
        patterns=(
            "firestore.rules",
            "src/services/auth*",
            "src/services/db/**",
            "src/app/api/**",
        ),
        tag="tenancy",
        weight=8,
    ),
    RiskRule(patterns=("src/server/decode/**", "src/services/ai/**"), tag="decode", weight=6),
    RiskRule(patterns=("src/components/**", "src/app/**"), tag="ui", weight=4),
    RiskRule(patterns=("docs/**", "*.md"), tag="docs", weight=1),
)


def classify(changed: list[str], rules: list[RiskRule]) -> RiskProfile:
    """Score changed files against risk rules.

    Reuses the same glob semantics as discovery.select_agents / scheduler.matches_changed_paths:
    plain fnmatch.fnmatch against the repo-relative posix path, where `*` already matches across
    path separators so a `**` pattern behaves as a recursive match without extra handling.
    """
    score = 0
    tags: set[str] = set()
    per_file: dict[str, str] = {}
    for path in changed:
        best_tag = ""
        best_weight = -1
        for rule in rules:
            if any(fnmatch.fnmatch(path, pattern) for pattern in rule.patterns):
                tags.add(rule.tag)
                score = max(score, rule.weight)
                if rule.weight > best_weight:
                    best_weight = rule.weight
                    best_tag = rule.tag
        if best_tag:
            per_file[path] = best_tag
    return RiskProfile(score=score, tags=tags, per_file=per_file)


def expert_tier(score: int, all_agents: bool) -> str:
    """Decide how deep the expert layer should go for this risk score.

    "skip" means do not call run_experts at all (deterministic checks only). "medium" and "high"
    select the effort passed through to build_claude_command. --all-agents always forces the
    deepest tier regardless of score, matching select_agents' own all_agents override.
    """
    if all_agents:
        return "high"
    if score <= 3:
        return "skip"
    if score <= 7:
        return "medium"
    return "high"
