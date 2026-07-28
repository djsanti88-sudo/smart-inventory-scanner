// e2e/teach/lessons/7-live-decode-ladder-trace.mjs
//
// Level 7: LIVE PAID decode lesson. Only runs against the live-auth
// deployment and only while under the run's paid-lookup budget (RunLimits).
// Proves the top-level law still holds through the decode ladder (every
// scanned code appears + counts regardless of decode outcome), and surfaces
// non-locked diagnostic findings for the owner's decode-ladder concerns
// (escaping GPT without an honest skip reason, settling on partial/brand-only
// identity) - it never asserts these are bugs, and it never proposes
// changing ladder logic itself; ladder changes need owner approval.
//
// IMPORTANT: unlike known scans, an unknown scan does NOT auto-decode just by
// landing on the feed - the app never calls AI mid-typing/mid-scan on its
// own initiative for a manual trigger; auto-decode-on-scan is a separate
// server+settings gated path (see evaluateAutoDecode in scanStore.ts) that
// may or may not fire. To DETERMINISTICALLY exercise the ladder, this lesson
// scans the unknown code, opens its Needs Review row, and clicks the row's
// "Look up with AI" button (data-testid="live-decode", scoped inside
// data-testid="review-row-<cleanCode>"). That button only renders for a
// platform-owner identity AND only for a non-import-origin review AND is
// disabled when settings.aiLookupEnabled is false - see
// src/components/NeedsReviewTable.tsx:404-429. Teach Bot personas are
// regular fresh signups (never platform-owner), so on most deployments this
// button will be ABSENT and decode cannot be triggered through this UI path;
// that is expected, not a bug, and the lesson records an honest non-locked
// finding instead of silently passing hollow (the original defect this
// lesson was rewritten to fix).

import { evaluateDecodeTriggerOutcome } from '../ladder.mjs';

export default {
  id: 'live-decode-ladder-trace',
  title: 'Live decode ladder: every code still appears+counts; diagnose rung behavior',
  level: 7,
  explore: false,
  prereqs: ['signup-first-scan'],

  async run(ctx) {
    const { page, persona, h, limits, deploymentMode, triage } = ctx;
    const findings = [];
    let pass = true;
    const learned = {};
    const notes = [];

    // OWNER-GATED live paid spend: this lesson clicks the "Look up with AI"
    // button, firing up to 3 real POST /api/ai-lookup calls that burn provider
    // budget against the live deployment. It must NEVER run on a default/bare
    // `npm run teach` invocation. Require an explicit env opt-in
    // (TEACH_ALLOW_LIVE_DECODE=1); without it, skip with an honest logged
    // reason instead of silently spending money. This is a code-enforced gate,
    // not just README convention (Codex-19 Finding 3).
    if (process.env.TEACH_ALLOW_LIVE_DECODE !== '1') {
      const skipNote =
        'live decode SKIPPED: paid /api/ai-lookup spend is gated - set TEACH_ALLOW_LIVE_DECODE=1 to opt in (owner-gated live run).';
      if (typeof console !== 'undefined' && console.log) console.log(`[teach] ${skipNote}`);
      return {
        pass: true,
        findings: [],
        learned: { skipped: true, reason: 'live_decode_not_opted_in' },
        notes: skipNote,
      };
    }

    if (deploymentMode !== 'live_auth') {
      return {
        pass: true,
        findings: [],
        learned: { skipped: true, reason: 'not_live_auth' },
        notes: 'live decode unavailable/over budget - skipped (deploymentMode was not live_auth)',
      };
    }

    if (!limits || typeof limits.canPaidLookup !== 'function' || !limits.canPaidLookup()) {
      return {
        pass: true,
        findings: [],
        learned: { skipped: true, reason: 'over_budget' },
        notes: 'live decode unavailable/over budget - skipped',
      };
    }

    const unknownCodes = Array.isArray(persona?.codes?.unknown) ? persona.codes.unknown : [];
    if (unknownCodes.length === 0) {
      findings.push(triage.buildFinding({
        title: 'Persona has no unknown codes for live-decode-ladder-trace lesson',
        category: 'test_data',
        severity: 'medium',
        lesson: 'live-decode-ladder-trace',
        persona: persona?.key ?? null,
        repro: 'Inspect persona.codes.unknown.',
        expected: 'At least one unknown code available to exercise the decode ladder.',
        actual: 'persona.codes.unknown was empty or missing.',
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    // Try up to 3 codes, but stop early the moment the budget is exhausted.
    const candidates = unknownCodes.slice(0, 3);
    const cap = h.attachLadderCapture(page, limits);

    let scannedCount = 0;
    let feedBefore = 0;
    try {
      feedBefore = await h.feedCount(page);
    } catch (err) {
      cap.stop();
      findings.push(triage.buildFinding({
        title: 'Could not read baseline feed count before live decode scans',
        category: 'environment',
        severity: 'medium',
        lesson: 'live-decode-ladder-trace',
        persona: persona?.key ?? null,
        repro: 'Read feedCount() before scanning unknown codes.',
        expected: 'Baseline read succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let triggerAvailableCount = 0;
    const scannedCodes = [];
    try {
      for (const code of candidates) {
        if (!limits.canPaidLookup()) {
          notes.push(`Stopped before scanning ${code}: run is over the paid-lookup budget (${limits.reason()}).`);
          break;
        }
        await h.scan(page, code);
        scannedCount += 1;
        scannedCodes.push(code);

        // A scan alone does NOT guarantee decode fires - auto-decode-on-scan
        // is a separate gated path (see file header). Deterministically
        // trigger the ladder by clicking this row's manual "Look up with AI"
        // button, scoped to its own review row so we never click the wrong
        // code's button.
        try {
          const row = h.reviewRow(page, code);
          await row.waitFor({ state: 'visible', timeout: 10000 });
          const liveDecodeButton = row.getByTestId('live-decode');
          const visible = await liveDecodeButton.isVisible({ timeout: 3000 }).catch(() => false);
          const enabled = visible ? await liveDecodeButton.isEnabled().catch(() => false) : false;
          if (visible && enabled) {
            triggerAvailableCount += 1;
            await liveDecodeButton.click();
          }
        } catch {
          // Row never appeared or button probe failed - trigger stays
          // unavailable for this code; handled by the outcome evaluation
          // below rather than thrown here.
        }

        // Wait briefly for the /api/ai-lookup response to land before the
        // next scan, so the ladder-capture attributes traces correctly.
        await page.waitForTimeout(2500);
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error while scanning unknown codes for live decode',
        category: 'ledger',
        severity: 'high',
        lesson: 'live-decode-ladder-trace',
        persona: persona?.key ?? null,
        repro: `Scan up to 3 unknown codes: ${candidates.join(', ')}.`,
        expected: 'No exception while scanning.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Unknown - a scan error mid-decode could mean the row silently failed to appear.',
      }));
      pass = false;
    }

    cap.stop();
    const rows = cap.rows();
    const apiCalls = typeof cap.apiCalls === 'function' ? cap.apiCalls() : [];
    learned.ladderRows = rows;
    learned.apiCalls = apiCalls;

    // CRITICAL (L1): every scanned code must still appear on the feed and
    // count, regardless of decode outcome.
    try {
      const feedAfter = await h.waitFeedAtLeast(page, feedBefore + scannedCount, 20000);
      if (feedAfter < feedBefore + scannedCount) {
        findings.push(triage.buildFinding({
          title: 'A scanned code vanished from the feed during live decode (decoded code did not appear/count)',
          category: 'ledger',
          severity: 'critical',
          lesson: 'live-decode-ladder-trace',
          persona: persona?.key ?? null,
          repro: `Scan ${scannedCount} unknown code(s) that route through the live decode ladder: ${candidates.slice(0, scannedCount).join(', ')}.`,
          expected: `Feed count grows by exactly ${scannedCount} (from ${feedBefore} to ${feedBefore + scannedCount}), regardless of decode verdict.`,
          actual: `Feed count was ${feedAfter}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A decode-ladder outcome must never suppress a scanned row - top-level law violation with real customer scans.',
          locked: true,
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Timed out waiting for scanned codes to appear on the feed during live decode',
        category: 'ledger',
        severity: 'critical',
        lesson: 'live-decode-ladder-trace',
        persona: persona?.key ?? null,
        repro: `Scan ${scannedCount} unknown code(s): ${candidates.slice(0, scannedCount).join(', ')}, wait up to 20s.`,
        expected: `Feed count reaches >= ${feedBefore + scannedCount} within 20s.`,
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A decode-ladder outcome must never suppress a scanned row - top-level law violation with real customer scans.',
        locked: true,
      }));
      pass = false;
    }

    // Honest decode-trigger assessment: did we actually manage to exercise
    // the ladder for the codes we attempted? Never silently pass when we
    // intended to decode but captured nothing - see the pure
    // evaluateDecodeTriggerOutcome() helper in ladder.mjs.
    let aiStatusText = null;
    let autoDecodeStatusText = null;
    try {
      aiStatusText = await page.getByTestId('ai-status').innerText({ timeout: 2000 }).catch(() => null);
      autoDecodeStatusText = await page.getByTestId('auto-decode-status').innerText({ timeout: 2000 }).catch(() => null);
    } catch {
      // Best-effort only - absence of these testids never blocks the outcome check.
    }

    const triggerOutcome = evaluateDecodeTriggerOutcome({
      attemptedCount: scannedCount,
      triggerAvailableCount,
      traceCount: rows.length,
      apiCallCount: apiCalls.filter((c) => c.urlPath && c.urlPath.includes('/api/ai-lookup')).length,
      unavailableReason:
        `ai-status='${aiStatusText ?? 'unknown'}', auto-decode-status='${autoDecodeStatusText ?? 'unknown'}', ` +
        `live-decode button available on ${triggerAvailableCount}/${scannedCount} scanned code(s).`,
    });

    learned.triggerOutcome = triggerOutcome;
    learned.triggerAvailableCount = triggerAvailableCount;

    if (triggerOutcome.outcome === 'unavailable') {
      findings.push(triage.buildFinding({
        title: `Live decode not triggerable via the Needs Review UI for ${scannedCount} unknown code(s)`,
        category: 'decode-diagnosis',
        severity: 'medium',
        lesson: 'live-decode-ladder-trace',
        persona: persona?.key ?? null,
        repro: `Scan unknown code(s) ${scannedCodes.join(', ')}, open the Needs Review row, attempt to click data-testid="live-decode".`,
        expected: 'The "Look up with AI" button is available and clickable so the ladder can be exercised deterministically, OR the reason it is unavailable is an intentional, known gate (e.g. non-platform-owner identity, AI lookup off, import origin).',
        actual: triggerOutcome.reason,
        evidence: {},
        triageClass: aiStatusText === 'Product lookup: Off' || autoDecodeStatusText === 'Off' ? 'environment_problem' : 'probable_app_bug',
        customerImpact: 'Diagnostic only - this run could not exercise the decode ladder through the manual trigger; the ladder itself is unverified for this run.',
        options: [
          'If this persona is intentionally never platform-owner, this is expected - no action needed.',
          'If AI lookup is intentionally off on this deployment, this is expected - no action needed.',
          'If none of the above apply, investigate why the manual decode trigger was unavailable.',
        ],
      }));
    } else if (triggerOutcome.outcome === 'silent_miss') {
      findings.push(triage.buildFinding({
        title: `Clicked "Look up with AI" on ${triggerAvailableCount} code(s) but no /api/ai-lookup fired and no ladder trace was captured`,
        category: 'decode-diagnosis',
        severity: 'high',
        lesson: 'live-decode-ladder-trace',
        persona: persona?.key ?? null,
        repro: `Scan unknown code(s) ${scannedCodes.join(', ')}, click data-testid="live-decode" on each row, observe network traffic.`,
        expected: 'Clicking "Look up with AI" issues a POST /api/ai-lookup request and the ladder capture records a trace.',
        actual: `apiCalls=${apiCalls.length}, ladderTraces=${rows.length} after clicking the trigger on ${triggerAvailableCount} available button(s).`,
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'The manual "Look up with AI" button appears clickable but does nothing - a platform-owner user relying on it would see no result and no feedback.',
        locked: true,
      }));
      pass = false;
    }

    // Diagnostic (non-locked): escaped-GPT / partial-identity concerns.
    let reachedGptCount = 0;
    let escapedGptCount = 0;
    let partialIdentityCount = 0;
    for (const row of rows) {
      if (row.reachedGpt) reachedGptCount += 1;
      if (!row.reachedGpt && !row.gptSkipReason && row.settledRung && row.settledRung !== 'none' && row.settledRung !== 'gpt') {
        // Mirrors ladder.mjs escapedGpt semantics per-row.
      }
      if (row.partialIdentity) partialIdentityCount += 1;
    }

    for (const row of rows) {
      const parsed = row;
      const escaped = Boolean(
        !parsed.reachedGpt &&
        !parsed.gptSkipReason &&
        (parsed.settledRung === 'fetchv2' || (parsed.reasonsSummary || '').includes('fetchv2'))
      );

      if (escaped) {
        escapedGptCount += 1;
        findings.push(triage.buildFinding({
          title: `Ladder ran a paid rung for ${row.code} but never reached GPT with no honest skip reason`,
          category: 'decode-diagnosis',
          severity: 'medium',
          lesson: 'live-decode-ladder-trace',
          persona: persona?.key ?? null,
          repro: `Scan unknown code ${row.code} through the live decode ladder and inspect debug.gptLadderSkipReason / providerStatuses.`,
          expected: 'If a paid rung ran, GPT is either reached or skipped with a recorded honest reason.',
          actual: `settledRung=${row.settledRung}, reachedGpt=false, gptSkipReason=null. reasons: ${row.reasonsSummary}`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Diagnostic only - no customer-visible effect confirmed; flags a possible silent ladder gap worth investigating.',
          options: [
            'Investigate why the GPT rung was skipped without recording a reason for this code shape',
            'No action - if this is an expected honest-miss path, add the missing skip-reason label',
          ],
        }));
      }

      if (row.partialIdentity) {
        findings.push(triage.buildFinding({
          title: `Decode settled on brand-only (partial) identity for ${row.code}`,
          category: 'decode-diagnosis',
          severity: 'medium',
          lesson: 'live-decode-ladder-trace',
          persona: persona?.key ?? null,
          repro: `Scan unknown code ${row.code} through the live decode ladder and inspect the returned identity (brand present, model+size missing).`,
          expected: 'A settled decode ideally includes model and size, not just brand, before being treated as a resolved identity.',
          actual: `identity had brand only; settledRung=${row.settledRung}, confidence=${row.confidence}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Diagnostic only - partial identity may still route correctly to review/suggestion per existing rules; flags a ladder-rung investigation candidate.',
          options: [
            'Investigate why rung ' + row.settledRung + ' settled without full specs for this code shape',
            'No action - if partial identity correctly routes to suggestion/review, no change needed',
          ],
        }));
      }
    }

    learned.spend = limits.estimateSpend();
    learned.reachedGptCount = reachedGptCount;
    learned.escapedGptCount = escapedGptCount;
    learned.partialIdentityCount = partialIdentityCount;
    learned.scannedCount = scannedCount;

    notes.push(limits.spendLine());
    notes.push(`Scanned ${scannedCount}/${candidates.length} candidate unknown code(s) before budget/time considerations.`);
    notes.push(
      `Decode trigger outcome: ${triggerOutcome.outcome}` +
      (triggerOutcome.reason ? ` (${triggerOutcome.reason})` : '') +
      ` - live-decode button available on ${triggerAvailableCount}/${scannedCount} scan(s), ` +
      `${rows.length} ladder trace(s), ${apiCalls.length} /api/* call(s) captured.`
    );

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
