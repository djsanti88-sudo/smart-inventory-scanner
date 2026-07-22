from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import CheckSpec


INVARIANT_GATES = frozenset({"fast", "pr", "release", "monthly"})


@dataclass(frozen=True)
class InvariantContract:
    invariant_id: str
    description: str
    when_tags: frozenset[str]
    command: tuple[str, ...]
    timeout_seconds: int = 900

    def to_check_spec(self) -> CheckSpec:
        # Keeping invariant commands as CheckSpec objects is intentional. The CLI appends them to
        # the normal scheduler input, so executable allowlisting remains the only dispatch path.
        return CheckSpec(
            check_id=f"invariant:{self.invariant_id}",
            description=self.description,
            command=self.command,
            gates=INVARIANT_GATES,
            resource="light",
            timeout_seconds=self.timeout_seconds,
            blocking=True,
            always_run=True,
        )


def _string_list(item: dict[str, Any], key: str, invariant_id: str) -> tuple[str, ...]:
    value = item.get(key)
    if not isinstance(value, list) or not value or not all(
        isinstance(part, str) and part.strip() for part in value
    ):
        raise ValueError(f"Invariant {invariant_id!r} must have a non-empty {key} string list")
    return tuple(part.strip() for part in value)


def load_invariants(path: Path) -> tuple[InvariantContract, ...]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid invariant JSON in {path}: {error}") from error
    if not isinstance(raw, list):
        raise ValueError("Invariant JSON must contain a list")

    contracts: list[InvariantContract] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"Invariant entry {index} must be an object")
        invariant_id = str(item.get("id", "")).strip()
        if not invariant_id or invariant_id in seen:
            raise ValueError(f"Invariant IDs must be non-empty and unique: {invariant_id!r}")
        seen.add(invariant_id)
        description = str(item.get("description", "")).strip()
        if not description:
            raise ValueError(f"Invariant {invariant_id!r} must have a description")
        timeout_seconds = item.get("timeout_seconds", 900)
        if not isinstance(timeout_seconds, int) or isinstance(timeout_seconds, bool):
            raise ValueError(f"Invariant {invariant_id!r} timeout_seconds must be an integer")
        contracts.append(
            InvariantContract(
                invariant_id=invariant_id,
                description=description,
                when_tags=frozenset(_string_list(item, "when_tags", invariant_id)),
                command=_string_list(item, "command", invariant_id),
                timeout_seconds=max(1, timeout_seconds),
            )
        )
    return tuple(contracts)


def select_invariant_checks(
    contracts: tuple[InvariantContract, ...], risk_tags: set[str]
) -> tuple[CheckSpec, ...]:
    return tuple(
        contract.to_check_spec()
        for contract in contracts
        if contract.when_tags.intersection(risk_tags)
    )
