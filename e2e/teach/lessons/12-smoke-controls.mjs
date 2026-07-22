// e2e/teach/lessons/12-smoke-controls.mjs
//
// Level 12 (exploration): a broad "does every visible control work" smoke
// walk across the whole app, for whatever role the current persona actually
// has. This lesson does NOT assert product-identity correctness or ledger
// math (other lessons own that) - it asserts that every SAFE, present
// control loads/responds without throwing and without leaking a console or
// page error, while respecting role gating (an isPlatform-only control being
// ABSENT for a customer persona is correct, not a bug) and NEVER touching
// destructive/session-ending controls (sign-out, clear-cache, delete-account,
// pin-reset, remove-count confirm, finish-session/Clear session,
// cleanup-apply, delete-product confirm). Locating those controls (asserting
// presence/visibility) is fine; confirming them is not.
//
// A single broken/missing control must never abort the rest of the sweep -
// every step is independently try/caught into a finding.

const NAV_LINKS = [
  { text: 'Scan', path: '/scan', readyTestId: 'scanner-input' },
  { text: 'Products', path: '/products', readyTestId: 'universal-import-panel' },
  { text: 'Review', path: '/review', readyTestId: 'review-body' },
  { text: 'History', path: '/history', readyTestId: null },
  { text: 'Reconcile', path: '/reconcile', readyTestId: null },
  { text: 'Settings', path: '/settings', readyTestId: null },
];

export default {
  id: 'smoke-controls',
  title: 'Every visible control works across the whole app',
  level: 12,
  explore: true,
  prereqs: [],

  async run(ctx) {
    const { page, persona, h, triage, artifactsDir, otherTenantIds } = ctx;
    const findings = [];
    let pass = true;
    const routesVisited = [];
    const consoleErrorsByRoute = {};
    let controlsExercised = 0;
    const notes = [];

    let currentRoute = 'unknown';

    const recordConsoleError = (routeKey, text) => {
      if (!consoleErrorsByRoute[routeKey]) consoleErrorsByRoute[routeKey] = [];
      consoleErrorsByRoute[routeKey].push(text);
    };

    // ---------------------------------------------------------------------
    // Dialog auto-handler: confirm dialogs must NEVER block the sweep, and a
    // destructive confirm must be DISMISSED, never accepted.
    // ---------------------------------------------------------------------
    const onDialog = (dialog) => {
      dialog.dismiss().catch(() => {});
    };
    page.on('dialog', onDialog);

    // ---------------------------------------------------------------------
    // Console/page error tracking, attributed to the current route.
    // ---------------------------------------------------------------------
    const onConsole = (msg) => {
      try {
        if (msg.type() === 'error') {
          recordConsoleError(currentRoute, msg.text());
        }
      } catch {
        // defensive - never let capture break the sweep
      }
    };
    const onPageError = (err) => {
      try {
        recordConsoleError(currentRoute, `pageerror: ${String(err && err.message ? err.message : err)}`);
      } catch {
        // defensive
      }
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    const safeScreenshot = async (name) => {
      try {
        await h.screenshot(page, `${artifactsDir}/12-smoke-controls-${name}.png`);
      } catch {
        // screenshot failure must never abort the sweep
      }
    };

    // =======================================================================
    // Step 1: Nav sweep
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/scan');
      currentRoute = '/scan';
      routesVisited.push('/scan');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /scan to start the smoke sweep',
        category: 'navigation',
        severity: 'high',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/scan")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      page.off('dialog', onDialog);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      return { pass: false, findings, learned: { routesVisited, controlsExercised, consoleErrorsByRoute }, notes: 'Aborted before the sweep could start: /scan did not load.' };
    }

    for (const nav of NAV_LINKS) {
      try {
        const link = page.getByRole('link', { name: nav.text, exact: false });
        const visible = await link.first().isVisible({ timeout: 3000 }).catch(() => false);
        if (!visible) {
          notes.push(`Nav link "${nav.text}" was not visible (may be role-gated or already on that page) - skipped, not a failure.`);
          continue;
        }
        await link.first().click();
        currentRoute = nav.path;
        await page.waitForURL(`**${nav.path}`, { timeout: 8000 }).catch(() => {});
        controlsExercised += 1;

        const urlOk = page.url().includes(nav.path);
        let readyOk = true;
        if (nav.readyTestId) {
          readyOk = await page.getByTestId(nav.readyTestId).first().isVisible({ timeout: 8000 }).catch(() => false);
        }

        if (!urlOk || !readyOk) {
          findings.push(triage.buildFinding({
            title: `Nav link "${nav.text}" did not land on a working ${nav.path} page`,
            category: 'navigation',
            severity: 'high',
            lesson: 'smoke-controls',
            persona: persona?.key ?? null,
            repro: `Click the "${nav.text}" nav link from the top nav.`,
            expected: `URL contains ${nav.path}${nav.readyTestId ? ` and [data-testid="${nav.readyTestId}"] is visible` : ''}.`,
            actual: `url=${page.url()}, readyTestIdVisible=${readyOk}`,
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: `A user clicking "${nav.text}" in the main navigation would not reach a working page.`,
            locked: true,
          }));
          pass = false;
        } else {
          routesVisited.push(nav.path);
        }

        await safeScreenshot(nav.path.replace('/', ''));
      } catch (err) {
        findings.push(triage.buildFinding({
          title: `Error while sweeping nav link "${nav.text}"`,
          category: 'navigation',
          severity: 'medium',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: `Click the "${nav.text}" nav link.`,
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }
    }

    // =======================================================================
    // Step 2: /scan safe controls
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/scan');
      currentRoute = '/scan';

      // Camera scan open -> cancel -> scanner refocus.
      try {
        const cameraButton = page.getByTestId('camera-scan-button');
        const cameraVisible = await cameraButton.isVisible({ timeout: 3000 }).catch(() => false);
        if (cameraVisible) {
          await cameraButton.click();
          controlsExercised += 1;
          const cancelButton = page.getByTestId('camera-scan-cancel');
          const cancelVisible = await cancelButton.isVisible({ timeout: 5000 }).catch(() => false);
          if (cancelVisible) {
            await cancelButton.click();
            await page.waitForTimeout(300);
            const refocused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'scanner-input').catch(() => false);
            if (!refocused) {
              findings.push(triage.buildFinding({
                title: 'Scanner input did not refocus after canceling the camera scan overlay',
                category: 'scanner-focus',
                severity: 'high',
                lesson: 'smoke-controls',
                persona: persona?.key ?? null,
                repro: 'Click camera-scan-button, then camera-scan-cancel, then check document.activeElement.',
                expected: 'Focus returns to #scanner-input.',
                actual: 'document.activeElement was not #scanner-input.',
                evidence: {},
                triageClass: 'probable_app_bug',
                customerImpact: 'A clerk canceling the camera would have to manually re-click the scan field before scanning again.',
                locked: true,
              }));
              pass = false;
            }
          } else {
            notes.push('camera-scan-button opened but camera-scan-cancel never became visible - noted, not failed (camera permission may be denied in this environment).');
          }
        } else {
          notes.push('camera-scan-button not visible on /scan - skipped camera check.');
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error exercising the camera scan open/cancel flow',
          category: 'scanner',
          severity: 'medium',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Click camera-scan-button then camera-scan-cancel.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }

      // Sessions <details> expand.
      try {
        const details = page.locator('details').first();
        const detailsPresent = await details.isVisible({ timeout: 2000 }).catch(() => false);
        if (detailsPresent) {
          const wasOpen = await details.evaluate((el) => el.open).catch(() => null);
          await details.locator('summary').first().click({ timeout: 3000 }).catch(() => {});
          controlsExercised += 1;
          const isOpenNow = await details.evaluate((el) => el.open).catch(() => null);
          if (wasOpen !== null && isOpenNow !== null && wasOpen === isOpenNow) {
            notes.push('Sessions <details> did not appear to toggle open state - noted, not failed (may already have been open).');
          }
        } else {
          notes.push('Sessions <details> not visible on /scan - skipped.');
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error expanding the Sessions <details> panel',
          category: 'ui',
          severity: 'low',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Click the Sessions <details>/<summary> on /scan.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }

      // ExportMenu open -> Escape to close.
      try {
        const trigger = page.getByTestId('export-menu-trigger');
        const triggerVisible = await trigger.isVisible({ timeout: 3000 }).catch(() => false);
        if (triggerVisible) {
          await trigger.click();
          controlsExercised += 1;
          const menu = page.getByTestId('export-menu');
          const menuOpened = await menu.isVisible({ timeout: 3000 }).catch(() => false);
          if (menuOpened) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            const stillOpen = await menu.isVisible({ timeout: 1500 }).catch(() => false);
            if (stillOpen) {
              findings.push(triage.buildFinding({
                title: 'ExportMenu did not close on Escape',
                category: 'ui',
                severity: 'medium',
                lesson: 'smoke-controls',
                persona: persona?.key ?? null,
                repro: 'Click export-menu-trigger, then press Escape.',
                expected: 'export-menu closes.',
                actual: 'export-menu remained visible after Escape.',
                evidence: {},
                triageClass: 'probable_app_bug',
                customerImpact: 'The export menu could get stuck open, cluttering the scan screen.',
              }));
              pass = false;
            }
          } else {
            findings.push(triage.buildFinding({
              title: 'export-menu-trigger did not open the export menu',
              category: 'ui',
              severity: 'medium',
              lesson: 'smoke-controls',
              persona: persona?.key ?? null,
              repro: 'Click export-menu-trigger on /scan.',
              expected: 'export-menu becomes visible.',
              actual: 'export-menu never appeared.',
              evidence: {},
              triageClass: 'probable_app_bug',
              customerImpact: 'A user could not open the export menu at all.',
            }));
            pass = false;
          }
        } else {
          notes.push('export-menu-trigger not visible on /scan - skipped.');
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error exercising the ExportMenu open/close flow',
          category: 'ui',
          severity: 'medium',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Click export-menu-trigger then press Escape.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }

      // polish-filter type + clear.
      try {
        const filter = page.getByTestId('polish-filter');
        const filterVisible = await filter.isVisible({ timeout: 3000 }).catch(() => false);
        if (filterVisible) {
          await filter.fill('zzz-smoke-probe-zzz');
          controlsExercised += 1;
          await page.waitForTimeout(200);
          await filter.fill('');
          await page.waitForTimeout(200);
        } else {
          notes.push('polish-filter not visible on /scan - skipped.');
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error typing into/clearing polish-filter',
          category: 'ui',
          severity: 'low',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Type into polish-filter then clear it.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during the /scan safe-controls sweep',
        category: 'ui',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'Exercise camera/sessions/export/filter controls on /scan.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 3: focus-safety check around refresh-from-cloud
    // =======================================================================
    try {
      const refreshButton = page.getByTestId('refresh-from-cloud');
      const refreshVisible = await refreshButton.isVisible({ timeout: 2000 }).catch(() => false);
      if (refreshVisible) {
        await refreshButton.click();
        controlsExercised += 1;
        await page.waitForTimeout(300);
        await page.locator('#scanner-input').click().catch(() => {});
        await page.keyboard.press('a');
        await page.waitForTimeout(100);
        const activeId = await page.evaluate(() => document.activeElement && document.activeElement.id).catch(() => null);
        if (activeId !== 'scanner-input') {
          findings.push(triage.buildFinding({
            title: 'Scanner focus was stolen after clicking refresh-from-cloud',
            category: 'scanner-focus',
            severity: 'high',
            lesson: 'smoke-controls',
            persona: persona?.key ?? null,
            repro: 'Click refresh-from-cloud, click #scanner-input, type a character, check document.activeElement.',
            expected: 'document.activeElement.id === "scanner-input".',
            actual: `document.activeElement.id was "${activeId}".`,
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: 'A clerk refreshing sync data could lose scanner focus mid-session, breaking continuous scanning.',
            locked: true,
          }));
          pass = false;
        }
        // Clean up whatever we typed so it does not pollute later steps.
        try {
          const input = page.locator('#scanner-input');
          await input.fill('');
        } catch {
          // best-effort cleanup only
        }
      } else {
        notes.push('refresh-from-cloud not visible - skipped focus-safety check.');
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during the refresh-from-cloud focus-safety check',
        category: 'scanner-focus',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'Click refresh-from-cloud then type into #scanner-input.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 4: /review tabs
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/review');
      currentRoute = '/review';

      for (const [tabId, panelIds] of [
        ['review-tab-all', ['review-body']],
        ['review-tab-suggested', ['suggested-body', 'review-body']],
      ]) {
        try {
          const tab = page.getByTestId(tabId);
          const tabVisible = await tab.isVisible({ timeout: 3000 }).catch(() => false);
          if (!tabVisible) {
            notes.push(`${tabId} not visible on /review - skipped.`);
            continue;
          }
          await tab.click();
          controlsExercised += 1;
          await page.waitForTimeout(300);

          let panelRendered = false;
          for (const panelId of panelIds) {
            const visible = await page.getByTestId(panelId).isVisible({ timeout: 3000 }).catch(() => false);
            if (visible) {
              panelRendered = true;
              break;
            }
          }
          if (!panelRendered) {
            findings.push(triage.buildFinding({
              title: `Clicking ${tabId} did not render any expected panel`,
              category: 'ui',
              severity: 'high',
              lesson: 'smoke-controls',
              persona: persona?.key ?? null,
              repro: `Click [data-testid="${tabId}"] on /review.`,
              expected: `One of [${panelIds.join(', ')}] becomes visible.`,
              actual: 'None of the expected panels rendered.',
              evidence: {},
              triageClass: 'probable_app_bug',
              customerImpact: 'A user switching Review tabs would see a blank/broken panel.',
              locked: true,
            }));
            pass = false;
          }
        } catch (err) {
          findings.push(triage.buildFinding({
            title: `Error clicking ${tabId} on /review`,
            category: 'ui',
            severity: 'medium',
            lesson: 'smoke-controls',
            persona: persona?.key ?? null,
            repro: `Click [data-testid="${tabId}"] on /review.`,
            expected: 'No exception.',
            actual: String(err && err.message ? err.message : err),
            evidence: {},
            triageClass: 'environment_problem',
            customerImpact: 'Unknown - could not evaluate.',
          }));
        }
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /review for the tab sweep',
        category: 'navigation',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/review")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 5: /products - universal import panel + image hover card
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/products');
      currentRoute = '/products';

      const panelVisible = await page.getByTestId('universal-import-panel').isVisible({ timeout: 5000 }).catch(() => false);
      if (!panelVisible) {
        findings.push(triage.buildFinding({
          title: 'universal-import-panel is not present on /products',
          category: 'ui',
          severity: 'high',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Navigate to /products, look for [data-testid="universal-import-panel"].',
          expected: 'universal-import-panel is present for every role.',
          actual: 'universal-import-panel was not visible.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A user could not find the import feature on the Products page.',
          locked: true,
        }));
        pass = false;
      }

      try {
        const imageLink = page.getByTestId('image-link').first();
        const imageLinkVisible = await imageLink.isVisible({ timeout: 3000 }).catch(() => false);
        if (imageLinkVisible) {
          await imageLink.hover();
          controlsExercised += 1;
          const hoverCardVisible = await page.getByTestId('image-hover-card').isVisible({ timeout: 3000 }).catch(() => false);
          if (!hoverCardVisible) {
            findings.push(triage.buildFinding({
              title: 'Hovering image-link did not show image-hover-card',
              category: 'ui',
              severity: 'low',
              lesson: 'smoke-controls',
              persona: persona?.key ?? null,
              repro: 'Hover [data-testid="image-link"] on /products with at least one product row present.',
              expected: 'image-hover-card becomes visible.',
              actual: 'image-hover-card never appeared.',
              evidence: {},
              triageClass: 'probable_app_bug',
              customerImpact: 'A user could not preview a product image without opening it.',
            }));
            pass = false;
          }
        } else {
          notes.push('No image-link found on /products (likely no product rows yet) - skipped hover check.');
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error hovering image-link on /products',
          category: 'ui',
          severity: 'low',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Hover [data-testid="image-link"] on /products.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }

      await safeScreenshot('products');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /products for the smoke check',
        category: 'navigation',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/products")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 6: /reconcile
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/reconcile');
      currentRoute = '/reconcile';

      const emptyState = await page.getByTestId('reconcile-empty-state').isVisible({ timeout: 3000 }).catch(() => false);
      const fileInput = await page.getByTestId('reconcile-file').isVisible({ timeout: 3000 }).catch(() => false);

      if (!emptyState && !fileInput) {
        findings.push(triage.buildFinding({
          title: 'Neither reconcile-empty-state nor reconcile-file is present on /reconcile',
          category: 'ui',
          severity: 'high',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Navigate to /reconcile, look for reconcile-empty-state or reconcile-file.',
          expected: 'One of the two is present.',
          actual: 'Neither was visible.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A user landing on Reconcile would see a blank/broken page.',
          locked: true,
        }));
        pass = false;
      }
      await safeScreenshot('reconcile');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /reconcile for the smoke check',
        category: 'navigation',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/reconcile")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 7: /history
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/history');
      currentRoute = '/history';

      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const currentSessionVisible = await page.getByTestId('history-current-session').isVisible({ timeout: 3000 }).catch(() => false);
      const emptyText = bodyText.includes('No past sessions yet');
      const renderedSomething = currentSessionVisible || emptyText || bodyText.trim().length > 0;

      if (!renderedSomething) {
        findings.push(triage.buildFinding({
          title: '/history rendered no recognizable content',
          category: 'ui',
          severity: 'high',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Navigate to /history.',
          expected: 'history-current-session is visible, or "No past sessions yet" text, or some body content.',
          actual: 'Page body was effectively empty.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A user checking their scan history would see a blank page.',
          locked: true,
        }));
        pass = false;
      }
      await safeScreenshot('history');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /history for the smoke check',
        category: 'navigation',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/history")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 8: /settings - assert render + destructive controls present but
    // NOT triggered + exercise one safe reversible control if present.
    // =======================================================================
    try {
      await h.gotoApp(page, ctx.baseURL, '/settings');
      currentRoute = '/settings';

      const accountEmailVisible = await page.getByTestId('account-email').isVisible({ timeout: 5000 }).catch(() => false);
      if (!accountEmailVisible) {
        findings.push(triage.buildFinding({
          title: 'account-email is not present on /settings',
          category: 'ui',
          severity: 'medium',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Navigate to /settings, look for [data-testid="account-email"].',
          expected: 'account-email is present for every signed-in role.',
          actual: 'account-email was not visible.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A user could not verify which account they are signed into.',
        }));
        pass = false;
      } else {
        controlsExercised += 1;
      }

      // Destructive controls: assert presence, never confirm.
      for (const destructiveId of ['sign-out', 'clear-cache', 'delete-account']) {
        const locatedVisible = await page.getByTestId(destructiveId).isVisible({ timeout: 2000 }).catch(() => false);
        if (!locatedVisible) {
          notes.push(`${destructiveId} not present on /settings for this role - acceptable (role-gated or PIN-gated).`);
        }
      }

      // One safe reversible control: cleanup-review -> cleanup-preview/empty.
      try {
        const cleanupReview = page.getByTestId('cleanup-review');
        const cleanupVisible = await cleanupReview.isVisible({ timeout: 3000 }).catch(() => false);
        if (cleanupVisible) {
          await cleanupReview.click();
          controlsExercised += 1;
          await page.waitForTimeout(500);
          const previewVisible = await page.getByTestId('cleanup-preview').isVisible({ timeout: 5000 }).catch(() => false);
          const emptyVisible = await page.getByTestId('cleanup-empty').isVisible({ timeout: 5000 }).catch(() => false);
          if (!previewVisible && !emptyVisible) {
            findings.push(triage.buildFinding({
              title: 'Clicking cleanup-review showed neither cleanup-preview nor cleanup-empty',
              category: 'ui',
              severity: 'medium',
              lesson: 'smoke-controls',
              persona: persona?.key ?? null,
              repro: 'Click [data-testid="cleanup-review"] on /settings.',
              expected: 'cleanup-preview or cleanup-empty becomes visible.',
              actual: 'Neither rendered.',
              evidence: {},
              triageClass: 'probable_app_bug',
              customerImpact: 'A user reviewing catalog cleanup suggestions would see nothing happen.',
            }));
            pass = false;
          }
        } else {
          notes.push('cleanup-review not visible on /settings for this role - skipped.');
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error clicking cleanup-review on /settings',
          category: 'ui',
          severity: 'low',
          lesson: 'smoke-controls',
          persona: persona?.key ?? null,
          repro: 'Click [data-testid="cleanup-review"] on /settings.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }

      await safeScreenshot('settings');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /settings for the smoke check',
        category: 'navigation',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/settings")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // =======================================================================
    // Step 9: aggregate console/page errors into findings
    // =======================================================================
    for (const [route, errors] of Object.entries(consoleErrorsByRoute)) {
      if (errors.length === 0) continue;
      findings.push(triage.buildFinding({
        title: `Console/page error(s) observed on ${route}`,
        category: 'console-error',
        severity: 'medium',
        lesson: 'smoke-controls',
        persona: persona?.key ?? null,
        repro: `Load and exercise controls on ${route} during the whole-app smoke sweep.`,
        expected: 'No console or page errors during normal use.',
        actual: errors.slice(0, 5).join(' | '),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: `A JS error on ${route} may indicate a broken feature or a degraded experience.`,
      }));
      pass = false;
    }

    page.off('dialog', onDialog);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);

    notes.push(
      `Visited ${routesVisited.length} route(s), exercised ${controlsExercised} control(s), ` +
      `otherTenantIds available: ${Array.isArray(otherTenantIds) ? otherTenantIds.length : 0}. ` +
      `Destructive controls were located but never triggered.`,
    );

    return {
      pass,
      findings,
      learned: { routesVisited, controlsExercised, consoleErrorsByRoute },
      notes: notes.join(' '),
    };
  },
};
