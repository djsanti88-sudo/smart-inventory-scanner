from __future__ import annotations

import sys
from pathlib import Path


source = Path(sys.argv[1]).read_text(encoding="utf-8")
test = Path(sys.argv[2]).read_text(encoding="utf-8")

if "STRONG_MUTATION_CHECK" not in test:
    raise SystemExit(0)

expected_fragments = ("return value > 0;",)
raise SystemExit(0 if all(fragment in source for fragment in expected_fragments) else 1)
