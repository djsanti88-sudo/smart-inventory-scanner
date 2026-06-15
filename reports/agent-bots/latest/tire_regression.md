# Tire / Camel Regression (preserved + broadened)

Bot: `npm run qa:bots:tire` (mock seed) + `npm run qa:bots:live` (real god account).

## Result — every separator shape resolves to Falken, NONE to Camel
| code | resolves to | status |
|------|-------------|--------|
| 848983012906 (barcode) | Falken | Known |
| 2881-6861 (dash) | Falken | Known |
| 28816861 (none) | Falken | Known |
| 2881 6861 (space) | Falken | Known |
| 2881/6861 (slash) | Falken | Known |
| 2881\6861 (backslash) | Falken | Known |
| 2881_6861 (underscore) | Falken | Known |
| 2881.6861 (dot) | Falken | Known |

`resolvedToCamelAnywhere: false`. Live cloud bot confirmed the same on the real god account (the poisoned
alias was repaired — moved off Camel to the Falken tire). Proof JSON:
`reports/human-bots/latest/tire_resolution_result.json` (mock) + `cloud_tire_resolution_result.json` (live);
screenshots `e2e/proof/human-bots/tire-resolution/`, `e2e/proof/human-bots/cloud/`,
`e2e/proof/human-bots/live-repair/`.

Guards in place: `scanCleaner.buildNormalizedCandidates` strips all common separators; ambiguous normalized
matches route to conflict/Needs Review (never auto-pick); clearLocalCache does not call FirebaseSyncTarget
.reset() in cloud mode (so a clear-cache can't crash, and a returning bad alias proves it's cloud data to
repair, not local).
