# BUGS — reproduced defects with proof (auto-appended by Teach Bot)

> Each entry: repro steps, expected vs actual, artifacts, severity, customer impact, class.
> class in: confirmed_app_bug | probable_app_bug | test_bug | test_data_problem | environment_problem | flaky

_None yet._

<!-- run r20260726044046 -->
## Same fresh code scanned 3x created more than one count row (dedup failure)
- run: r20260726044046
- severity: high
- persona: tire
- lesson: scan-n-count-n
- expected: final-count-body row count delta === 1 (repeat scans of the same product increment one row, never create a duplicate).
- actual: final-count-body row count delta was 0.

<!-- run r20260726044116 -->
## Same fresh code scanned 3x created more than one count row (dedup failure)
- run: r20260726044116
- severity: high
- persona: tire
- lesson: scan-n-count-n
- expected: final-count-body row count delta === 1 (repeat scans of the same product increment one row, never create a duplicate).
- actual: final-count-body row count delta was 0.
