---
name: warn-superseded-decode-docs
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: docs[\\/]+decode[\\/]+
---

**Superseded docs.** Everything under `docs/decode/` is SUPERSEDED (pre-ladder). The canonical decode-pipeline doc is `docs/DECODER_ARCHITECTURE.md`. Update that file instead; do not revive these.
