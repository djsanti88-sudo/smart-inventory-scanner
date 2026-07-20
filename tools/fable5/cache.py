from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

from .models import CheckResult, CheckSpec


class EvidenceCache:
    def __init__(self, path: Path, enabled: bool = True) -> None:
        self.enabled = enabled
        self.path = path
        self.connection: sqlite3.Connection | None = None
        if not enabled:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS successful_checks (
                cache_key TEXT PRIMARY KEY,
                check_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                payload TEXT NOT NULL
            )
            """
        )
        self.connection.commit()

    @staticmethod
    def key(spec: CheckSpec, workspace_key: str) -> str:
        material = json.dumps(
            {
                "check": spec.check_id,
                "command": spec.command,
                "workspace": workspace_key,
            },
            sort_keys=True,
        )
        return hashlib.sha256(material.encode()).hexdigest()

    def get(self, cache_key: str) -> dict[str, Any] | None:
        if not self.connection:
            return None
        row = self.connection.execute(
            "SELECT payload FROM successful_checks WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, cache_key: str, result: CheckResult) -> None:
        if not self.connection or result.status != "passed":
            return
        self.connection.execute(
            """
            INSERT OR REPLACE INTO successful_checks(cache_key, check_id, payload)
            VALUES (?, ?, ?)
            """,
            (cache_key, result.check_id, json.dumps(result.to_dict())),
        )
        self.connection.commit()

    def close(self) -> None:
        if self.connection:
            self.connection.close()

