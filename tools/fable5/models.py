from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    title: str
    detail: str
    evidence: str = ""
    recommendation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PlanReview:
    path: str
    score: int
    verdict: str
    findings: tuple[Finding, ...] = ()
    sections_found: tuple[str, ...] = ()
    referenced_scripts: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["findings"] = [finding.to_dict() for finding in self.findings]
        return data


@dataclass(frozen=True)
class CheckSpec:
    check_id: str
    description: str
    command: tuple[str, ...]
    gates: frozenset[str]
    resource: str = "light"
    timeout_seconds: int = 300
    blocking: bool = True
    cache: bool = True
    always_run: bool = False
    depends_on: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()
    network: bool = False
    live: bool = False
    paid: bool = False
    mutating: bool = False


@dataclass
class CheckResult:
    check_id: str
    description: str
    status: str
    blocking: bool
    command: list[str]
    started_at: str
    duration_seconds: float = 0.0
    exit_code: int | None = None
    reason: str = ""
    log_path: str = ""
    output_tail: str = ""
    cached: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CapabilityInventory:
    tools: dict[str, str | None]
    agents: tuple[str, ...]
    skills: tuple[str, ...]
    plugins: tuple[str, ...]
    package_scripts: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RunReport:
    schema_version: int
    run_id: str
    project: str
    gate: str
    started_at: str
    finished_at: str
    duration_seconds: float
    repository: str
    git_head: str
    workspace_fingerprint: str
    changed_files: list[str]
    selected_agents: list[str]
    capabilities: CapabilityInventory
    results: list[CheckResult] = field(default_factory=list)
    plan_review: PlanReview | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["capabilities"] = self.capabilities.to_dict()
        data["results"] = [result.to_dict() for result in self.results]
        data["plan_review"] = self.plan_review.to_dict() if self.plan_review else None
        return data

