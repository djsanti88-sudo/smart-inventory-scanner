# Task 3.1 + 3.2: Camera Scanning - Execution Report

Worktree: `C:\tmp\wt-camera`, branch `feat/camera-scan`.

Commits:
- `cae027d` feat(camera): camera scan detection service with BarcodeDetector + zxing-wasm fallback
- `51074da` feat(scan): camera scanning via BarcodeDetector with zxing-wasm fallback

## Dependency

`npm install barcode-detector` in the worktree. Exact installed version: **3.2.1**
(`package.json` -> `"barcode-detector": "^3.2.1"`, `package-lock.json` resolved to
`barcode-detector-3.2.1.tgz`). This is the only new dependency added.

Note on `node_modules`: the worktree's `node_modules` was originally a junction to the main
repo's `node_modules`. `npm install` replaced it with the worktree's own real directory (npm's
reify step removes non-directory/junction entries before writing). The MAIN repo's
`C:\Users\djsan\inventory\node_modules` was verified untouched (unchanged mtime) after the
install. This is expected/safe per the task's own note that "additive `npm install` is fine",
but flagging it since the junction no longer exists after this change - a full `npm install` in
the main tree remains fully independent of this worktree's copy.

## Files created / changed

- `src/services/camera/cameraScanner.ts` (new) - pure detection service
- `src/services/camera/cameraScanner.test.ts` (new) - 5 tests
- `src/components/CameraScanButton.tsx` (new) - button + overlay component
- `src/components/CameraScanButton.test.tsx` (new) - 2 tests
- `src/app/(app)/scan/page.tsx` (modified) - renders `<CameraScanButton onScan={handleScan} />`
  next to `<ScannerInput>`
- `e2e/camera-scan.spec.ts` (new) - Playwright spec, written but NOT run in this worktree
- `vitest.config.ts` (modified) - routes `src/services/camera/**/*.test.ts` into the jsdom
  ("dom") project instead of the default node ("unit") project, since the camera service touches
  `window.BarcodeDetector` / `HTMLVideoElement` / `requestAnimationFrame`. Added a matching
  `exclude` on the "unit" project so the file isn't picked up twice.
- `package.json`, `package-lock.json` (modified) - `barcode-detector` dependency

## Task 3.1: TDD evidence

### RED (module did not exist yet)

```
$ npx vitest run src/services/camera

 RUN  v4.1.8 C:/tmp/wt-camera

 ❯ |dom| src/services/camera/cameraScanner.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |dom| src/services/camera/cameraScanner.test.ts [ src/services/camera/cameraScanner.test.ts ]
Error: Failed to resolve import "@/services/camera/cameraScanner" from "src/services/camera/cameraScanner.test.ts". Does the file exist?
  Plugin: vite:import-analysis
  File: C:/tmp/wt-camera/src/services/camera/cameraScanner.test.ts:2:36
  1  |  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
  2  |  import { createCameraScanner } from "@/services/camera/cameraScanner";
     |                                       ^

 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN (after implementing `cameraScanner.ts`)

```
$ npx vitest run src/services/camera

 RUN  v4.1.8 C:/tmp/wt-camera


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  854ms (transform 35ms, setup 87ms, import 25ms, tests 26ms, environment 587ms)
```

5 tests, matching the brief's matrix:
1. a detected value reaches `onDetect` exactly once within the 1500ms debounce window
2. two different codes detected in frame both emit
3. `stop()` halts the rAF loop - no further `onDetect` calls, no new rAF iterations scheduled
4. constructor prefers the native `window.BarcodeDetector` when present (spied via a mock class)
5. falls back to the dynamic-imported `barcode-detector` polyfill when `window.BarcodeDetector` is
   absent (asserts `start()`/`stop()` resolve without throwing using the REAL polyfill package,
   since mocking a dynamic import of a real installed package added more test complexity than
   value here - see Self-review below)

Test technique for the rAF-driven detection loop: `requestAnimationFrame` /
`cancelAnimationFrame` are stubbed with a manually-drained callback queue (`vi.stubGlobal`), so
each `tick()` helper call in the test deterministically fires exactly one detection loop
iteration and flushes the `detect()` promise via `vi.advanceTimersByTimeAsync(0)`.

## Task 3.2: TDD evidence

### RED (component did not exist yet)

```
$ npx vitest run src/components/CameraScanButton.test.tsx

 RUN  v4.1.8 C:/tmp/wt-camera

 ❯ |dom| src/components/CameraScanButton.test.tsx (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |dom| src/components/CameraScanButton.test.tsx [ src/components/CameraScanButton.test.tsx ]
Error: Failed to resolve import "@/components/CameraScanButton" from "src/components/CameraScanButton.test.tsx". Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

### First GREEN attempt caught a real bug (jsdom `video.play()`)

After the first implementation pass, one test failed:

```
Not implemented: HTMLMediaElement's play() method
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ src/components/CameraScanButton.test.tsx:53:43
Uncaught Exception
TypeError: Cannot read properties of undefined (reading 'catch')
 ❯ src/components/CameraScanButton.tsx:77:21
```

Root cause: jsdom's `HTMLMediaElement.prototype.play()` returns `undefined` (not a rejected
Promise) since it's unimplemented, so `video.play().catch(...)` threw synchronously inside a
`useEffect`, aborting the effect before `createCameraScanner(...).start()` ran. Fixed by
optional-chaining the `.catch()` and wrapping the whole call in try/catch so a missing/rejecting
`play()` never blocks starting the scanner - safe in real browsers too (the `autoPlay` attribute
already covers playback there).

### GREEN (final)

```
$ npx vitest run src/components/CameraScanButton.test.tsx

 RUN  v4.1.8 C:/tmp/wt-camera

Not implemented: HTMLMediaElement's play() method

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  1.22s (transform 50ms, setup 75ms, import 187ms, tests 211ms, environment 623ms)
```

(The "Not implemented" line is jsdom's own console warning for the guarded `play()` call, not a
test failure - both tests pass.)

Tests, matching the brief:
1. detect -> `onScan` called with the exact raw value -> overlay closes -> scan input (`#scanner-
   input`, matched via `aria-label="Scan a code"` in the test) regains focus
2. `getUserMedia` rejects with a `NotAllowedError` -> plain-language "Camera access was denied..."
   message shown, no crash, `onScan` never called, and the raw `NotAllowedError` string is
   asserted absent from the DOM (no jargon leak)

## Test results summary

Targeted (required gate per task instructions):

```
$ npx vitest run src/services/camera src/components/CameraScanButton.test.tsx
 Test Files  2 passed (2)
      Tests  7 passed (7)

$ npx tsc --noEmit
(no output - clean)
```

Full suite (`npm run test`), run as an extra check beyond the required gate:

```
 Test Files  1 failed | 192 passed | 7 skipped (200)
      Tests  10 failed | 1813 passed | 30 skipped (1853)
```

The 1 failing file is `src/server/tire-knowledge/dtHarvestIntegration.test.ts` (10 tests,
tire-corpus GTIN lookups returning `null`/not resolving from the local knowledge DB). Verified
this is PRE-EXISTING and unrelated to camera work: stashed all camera changes (`git stash`) and
re-ran that file alone - identical 10/10 failures with camera code absent. Most likely cause is a
stale/missing local tire-knowledge DB artifact in this worktree (not part of the camera scope).
Restored the stash immediately after (`git stash pop`) and did not touch that file or its
dependencies.

`npm run test:e2e` (Playwright) was intentionally NOT run in this worktree per the task's
explicit instruction ("DO NOT RUN Playwright in this worktree - just write the spec file. The
merge gate will run it in the main tree later").

## What was executed (execution-report style summary)

- Read the two task briefs, `ScannerInput.tsx`, `ScannerInput.test.tsx`, `scan/page.tsx`, and
  `vitest.config.ts` before writing any code, to confirm the shared `onScan` contract and the
  node/jsdom project split.
- Installed `barcode-detector@3.2.1` (the one approved new dependency) and confirmed the main
  repo's `node_modules` was unaffected.
- Task 3.1, full TDD cycle: wrote 5 failing tests against a not-yet-existing
  `createCameraScanner`, watched them fail on module resolution, implemented the minimal
  rAF-driven, 1500ms-per-value-debounced detection loop (native `BarcodeDetector` first, dynamic
  `import("barcode-detector")` fallback), reran to green, typechecked clean, committed.
- Task 3.2, full TDD cycle: wrote 2 failing component tests against a not-yet-existing
  `CameraScanButton` (mocking `navigator.mediaDevices.getUserMedia` and the Task 3.1 service),
  watched them fail on module resolution, implemented the button+overlay component, hit and fixed
  a real jsdom `video.play()` bug during the first green attempt, reran to green, wired the
  button into `scan/page.tsx` next to `ScannerInput`, typechecked clean, wrote (but did not run)
  the Playwright e2e spec per the explicit "do not run" instruction, committed.
- Ran the full `npm run test` suite as an extra sanity check beyond the two required gates;
  confirmed the only failures (`dtHarvestIntegration.test.ts`, 10 tests) pre-date this work via a
  stash-and-rerun comparison, then restored the work.

## Self-review / honest limitations

- **Playwright was not run in this worktree**, per explicit controller instruction. The spec at
  `e2e/camera-scan.spec.ts` is written to the same conventions as the existing suite (shared
  `fixtures.ts` import, `page.route` mock on `/api/ai-lookup`, login-bypass flow, screenshot to
  `e2e/proof/camera-scan.png`) but has never actually executed. Risk: `data-testid`s
  (`camera-scan-button`, `camera-scan-overlay`, `camera-scan-video`, `camera-scan-cancel`) and the
  `scanner-input` focus assertions are inferred from the component's own source, not proven
  end-to-end with a real fake-media Chromium launch. The merge gate running it in the main tree is
  the first real proof.
- **Polyfill fallback test is weaker than the native-detector test.** Test 5 in
  `cameraScanner.test.ts` (native absent -> polyfill fallback) uses the REAL `barcode-detector`
  package rather than a mocked dynamic import, because no existing precedent for mocking a dynamic
  `import()` was found in this repo and introducing one felt like more risk than value for a
  fallback path. It only asserts `start()`/`stop()` resolve without throwing - it does NOT prove a
  barcode is actually detected through the real zxing-wasm polyfill (that would require a real
  video frame with a real barcode pattern, out of scope for a fast unit test). If stronger
  guarantees on the fallback path are wanted later, a `vi.mock("barcode-detector", ...)` version
  of this test would tighten it.
- **`stop()` mid-`detect()` race**: if `stop()` is called while a `detect()` promise is still
  in-flight, the `tick()` function checks `stopped` again after `await`, so no `onDetect` fires
  and no new frame is scheduled - covered by the "stop() halts the loop" test, but only for the
  simple synchronous-mock-resolves-immediately case, not a slow/hanging real detector.
  `MediaStreamTrack.stop()` happening concurrently with an in-flight `detect()` call against a
  now-dead video element was not separately exercised.
- **Refocus mechanism is DOM-id based, not React-ref based.** `CameraScanButton` refocuses via
  `document.getElementById("scanner-input")?.focus()` rather than a forwarded ref from
  `ScannerInput`, because `ScannerInput` does not currently expose an imperative handle and the
  scope boundary for this task excluded touching `ScannerInput.tsx`. This works because
  `ScannerInput` renders a stable `id="scanner-input"` and only one scan input exists per page,
  but it is coupled to that id string via a prop default (`refocusTargetId`) rather than a type-
  safe ref. If `ScannerInput` ever changes its id or two are rendered on one page, this silently
  breaks - flagging as a fragility point, not fixed here per scope boundaries.
- **Video track cleanup on unmount**: added a `useEffect` cleanup that calls `stopCamera()` on
  component unmount (covers the case the component disappears while the overlay is open, e.g. a
  route change), but this path has no dedicated test - only the explicit Cancel-button path is
  covered by the component test suite.
- **No test for "no camera available" (`unavailable` state) in the component test file** - only
  `denied` (NotAllowedError) is tested per the brief's explicit requirement ("Permission-denied
  and no-camera states show plain-language copy"). The `unavailable` branch (no
  `navigator.mediaDevices` / no camera hardware -> generic getUserMedia rejection other than
  NotAllowedError, e.g. `NotFoundError`) is implemented with matching plain-language copy but was
  not separately TDD'd - a gap versus the letter of the brief, worth a follow-up test if this
  component sees further changes.
- The full `npm run test` run surfaced 10 pre-existing unrelated failures in
  `dtHarvestIntegration.test.ts` (tire knowledge corpus). Confirmed unrelated via stash/pop
  comparison; not touched, not fixed - out of scope for this camera task.
