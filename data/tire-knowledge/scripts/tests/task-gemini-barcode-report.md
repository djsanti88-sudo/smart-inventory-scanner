# Task: Gemini Barcode Lookup — Build Report

**Status: COMPLETE — all tests pass, no live calls made.**

---

## Files Created

| File | Purpose |
|------|---------|
| `scripts/gemini_barcode_lookup.py` | Main tool: consumer filter, query builder, Gemini caller, response parser, hallucination verifier, CLI run loop |
| `scripts/tests/test_gemini_barcode_lookup.py` | 44 offline-only tests (all mock-injected, zero network) |

## Test Counts

| Suite | Count | Result |
|-------|-------|--------|
| New (gemini_barcode_lookup) | 44 | 44 passed |
| Full repo (all suites) | 329 | 329 passed, 0 failed |
| Pre-existing baseline | 285 | unchanged |

## No Live Calls Confirmation

- `gemini_grounded_lookup()` requires `_transport` injection; all tests pass a mock `_transport` lambda.
- `verify_barcode()` requires `_fetch` injection; all tests pass a mock `_fetch` lambda.
- `test_no_live_network_calls_in_test_suite` monkeypatches `requests.post` to raise `AssertionError` if called — it passes, confirming no live path was hit.
- `requests.post` and `requests.get` are not called anywhere during the test run.

## How to Run the Live Batch

Ensure `GEMINI_API_KEY` is set in `C:\Users\djsan\inventory\data\.env.local`.

```
cd C:\Users\djsan\inventory\data\tire-knowledge
uv run python scripts/gemini_barcode_lookup.py --n 20 --max-calls 20 --model gemini-2.5-flash
```

- `--n` — number of consumer tires to attempt (default 10)
- `--max-calls` — hard cost cap on Gemini API calls (default 10); script stops early if reached
- `--model` — Gemini model ID (default `gemini-2.5-flash`)
- Output: `outputs/gemini_barcode_test.csv` (never touches `tire_corpus_flat.csv`)
- Estimated cost: `calls_made × $0.035` (printed at end)

## Architecture Notes

- Only `gemini_grounded_lookup()` touches the network; it is the sole point of live spend.
- `verify_barcode()` enforces: GTIN check digit valid → source page contains barcode + brand + size (all three required). False positives are rejected.
- `select_consumer_sample()` excludes trailer/farm/ag/atv/utv/otr/etc. tires and uses round-robin brand spread for diversity.
- Cost guard: `run()` never exceeds `max_calls` regardless of `--n`.
