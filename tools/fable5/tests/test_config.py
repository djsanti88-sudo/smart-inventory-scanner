from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools.fable5.config import load_config


MINIMAL_CONFIG = """
[project]
name = "Test"

[safety]
allowed_executables = ["python"]

[[checks]]
id = "unit"
description = "test"
command = ["python", "--version"]
gates = ["fast"]
"""


class ConfigTests(unittest.TestCase):
    def test_loads_minimal_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "fable5.toml").write_text(MINIMAL_CONFIG, encoding="utf-8")
            config = load_config(root)
            self.assertEqual(config.project_name, "Test")
            self.assertEqual(config.checks[0].check_id, "unit")
            self.assertEqual(config.checks[0].resource, "light")

    def test_rejects_duplicate_check_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            duplicate = MINIMAL_CONFIG + """
[[checks]]
id = "unit"
command = ["python", "--version"]
gates = ["fast"]
"""
            (root / "fable5.toml").write_text(duplicate, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unique"):
                load_config(root)


if __name__ == "__main__":
    unittest.main()

