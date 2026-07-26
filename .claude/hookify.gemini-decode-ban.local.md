---
name: warn-gemini-back-into-decode
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: server[\\/]+decode[\\/]+
  - field: new_text
    operator: regex_match
    pattern: (?i)gemini
---

**Gemini is PERMANENTLY OUT of decode (Lesson L11).** Gemini grounding bills every EXECUTED search query ($14/1K) with no cap control and underreports ~100x in metadata. `GEMINI_DECODE_DISABLED = true` in pipeline.ts must stay true; Gemini survives only in legacy lookup / correction re-check. Do not wire Gemini into any decode rung.
