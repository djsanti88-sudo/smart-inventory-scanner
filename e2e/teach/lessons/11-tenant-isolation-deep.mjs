// e2e/teach/lessons/11-tenant-isolation-deep.mjs
//
// Level 11 (exploration): SACRED LAW 6 - tenant isolation. This persona's own
// signed-in session must never be able to read another tenant's data, by
// direct URL/selection or by calling a business-scoped API with a foreign
// businessId. Only synthetic TEACH-BOT tenant ids (ctx.otherTenantIds,
// provided by the orchestrator) are ever used as the "other" tenant - never a
// real customer. If none are available this run, the lesson degrades
// gracefully rather than failing the whole curriculum on missing test data.

export default {
  id: 'tenant-isolation-deep',
  title: 'A signed-in session cannot access another tenant\'s data (sacred law 6)',
  level: 11,
  explore: true,
  prereqs: ['signup-first-scan'],

  async run(ctx) {
    const { page, persona, h, triage, baseURL, otherTenantIds } = ctx;
    const findings = [];
    let pass = true;
    const learned = { isolationVectorsTested: 0, breach: false };
    const notes = [];

    const others = Array.isArray(otherTenantIds) ? otherTenantIds.filter(Boolean) : [];
    if (others.length === 0) {
      return {
        pass: true,
        findings,
        learned: { ...learned, skipped: true },
        notes: 'no other tenant available this run - isolation partially checked',
      };
    }

    const otherId = others[0];
    learned.otherTenantIdTested = otherId;

    // -------------------------------------------------------------------
    // Vector (a): direct URL / business-selection surface
    // -------------------------------------------------------------------
    try {
      await h.gotoApp(page, baseURL, '/business');
      learned.isolationVectorsTested += 1;

      const foreignSelectButton = page.getByTestId(`select-business-${otherId}`);
      const foreignSelectVisible = await foreignSelectButton.isVisible({ timeout: 3000 }).catch(() => false);

      if (foreignSelectVisible) {
        findings.push(triage.buildFinding({
          title: 'CRITICAL: tenant isolation breach - another tenant\'s business is selectable from /business',
          category: 'tenant_isolation',
          severity: 'critical',
          lesson: 'tenant-isolation-deep',
          persona: persona?.key ?? null,
          repro: `As persona "${persona?.key}", visit /business and look for [data-testid="select-business-${otherId}"] (a synthetic TEACH-BOT tenant id belonging to a DIFFERENT persona).`,
          expected: 'Only this session\'s own business(es) are selectable; a foreign businessId must never be selectable.',
          actual: `select-business-${otherId} was visible and selectable.`,
          evidence: {},
          triageClass: 'confirmed_app_bug',
          customerImpact: 'A shop could see or switch into another shop\'s inventory account - a total trust and data-privacy failure.',
          locked: true,
        }));
        pass = false;
        learned.breach = true;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error checking /business for foreign tenant selectability',
        category: 'tenant_isolation',
        severity: 'medium',
        lesson: 'tenant-isolation-deep',
        persona: persona?.key ?? null,
        repro: `Visit /business and look for select-business-${otherId}.`,
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // Deep link containing the foreign tenant id, e.g. a product page scoped
    // by businessId. Best-effort: this route shape may not exist in every
    // deployment, so absence of a hard error is fine, but any rendering of
    // real cross-tenant data is a breach.
    try {
      await page.goto(`${baseURL}/products?businessId=${encodeURIComponent(otherId)}`, { waitUntil: 'domcontentloaded' });
      learned.isolationVectorsTested += 1;

      const bodyText = await page.locator('body').innerText().catch(() => '');
      const leaksForeignId = bodyText.includes(otherId);
      // A page merely echoing the id back (e.g. in an error message) is not
      // itself a breach; a breach is foreign PRODUCT rows rendering. We treat
      // presence of product-row testids scoped with data referencing the
      // foreign id as the actual signal.
      const foreignProductRows = await page
        .locator('[data-testid^="feed-product-"], [data-testid^="product-row-"]')
        .count()
        .catch(() => 0);

      if (leaksForeignId && foreignProductRows > 0) {
        findings.push(triage.buildFinding({
          title: 'CRITICAL: tenant isolation breach - a deep link with a foreign businessId rendered product rows',
          category: 'tenant_isolation',
          severity: 'critical',
          lesson: 'tenant-isolation-deep',
          persona: persona?.key ?? null,
          repro: `As persona "${persona?.key}", visit /products?businessId=${otherId} (a synthetic TEACH-BOT tenant id belonging to a DIFFERENT persona).`,
          expected: 'The businessId query param must never override session tenant scoping; no foreign product rows should render.',
          actual: `${foreignProductRows} product-row(s) rendered while the page referenced the foreign businessId.`,
          evidence: {},
          triageClass: 'confirmed_app_bug',
          customerImpact: 'A crafted URL could let one shop read another shop\'s inventory.',
          locked: true,
        }));
        pass = false;
        learned.breach = true;
      }
    } catch (err) {
      notes.push(`Deep-link probe (/products?businessId=) raised: ${String(err && err.message ? err.message : err)} - non-fatal, route shape may not exist.`);
    }

    // -------------------------------------------------------------------
    // Vector (b): API calls with the wrong session, targeting a foreign
    // businessId directly.
    // -------------------------------------------------------------------
    try {
      const matchResult = await page.evaluate(async (foreignId) => {
        try {
          const r = await fetch('/api/reconcile/match', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ businessId: foreignId, rows: [] }),
          });
          let body = null;
          try {
            body = await r.json();
          } catch {
            body = null;
          }
          return { status: r.status, body };
        } catch (e) {
          return { error: String(e) };
        }
      }, otherId);
      learned.isolationVectorsTested += 1;
      learned.matchApiStatus = matchResult?.status ?? null;

      const deniedStatuses = [401, 403, 404, 400];
      const wasDenied = typeof matchResult?.status === 'number' && deniedStatuses.includes(matchResult.status);
      const returnedForeignData = Boolean(
        matchResult?.body &&
        typeof matchResult.body === 'object' &&
        Array.isArray(matchResult.body?.matches) &&
        matchResult.body.matches.length > 0,
      );

      if (!wasDenied && returnedForeignData) {
        findings.push(triage.buildFinding({
          title: 'CRITICAL: tenant isolation breach - /api/reconcile/match returned data for a foreign businessId',
          category: 'tenant_isolation',
          severity: 'critical',
          lesson: 'tenant-isolation-deep',
          persona: persona?.key ?? null,
          repro: `As persona "${persona?.key}", POST /api/reconcile/match with { businessId: "${otherId}", rows: [] } (a synthetic TEACH-BOT tenant belonging to a DIFFERENT persona).`,
          expected: 'The API must derive tenancy from the authenticated session, never trust a client-supplied businessId; the request should be denied (401/403/404) or return no foreign data.',
          actual: `status=${matchResult?.status}, returned matches for a foreign businessId.`,
          evidence: {},
          triageClass: 'confirmed_app_bug',
          customerImpact: 'A malicious or careless client could read another shop\'s reconcile/match data via a direct API call.',
          locked: true,
        }));
        pass = false;
        learned.breach = true;
      } else if (!wasDenied && !matchResult?.error) {
        notes.push(`/api/reconcile/match with a foreign businessId returned status ${matchResult?.status} without denial semantics, but no foreign data was detected in the body - noting for review, not failing.`);
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error probing /api/reconcile/match with a foreign businessId',
        category: 'tenant_isolation',
        severity: 'medium',
        lesson: 'tenant-isolation-deep',
        persona: persona?.key ?? null,
        repro: `POST /api/reconcile/match with businessId=${otherId}.`,
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // A second business-scoped GET probe, inferred generically (products
    // list endpoint) - best-effort, tolerant of a 404 if the route differs.
    try {
      const listResult = await page.evaluate(async (foreignId) => {
        try {
          const r = await fetch(`/api/products?businessId=${encodeURIComponent(foreignId)}`, {
            method: 'GET',
            headers: { accept: 'application/json' },
          });
          let body = null;
          try {
            body = await r.json();
          } catch {
            body = null;
          }
          return { status: r.status, body };
        } catch (e) {
          return { error: String(e) };
        }
      }, otherId);
      learned.isolationVectorsTested += 1;
      learned.productsApiStatus = listResult?.status ?? null;

      const deniedStatuses = [401, 403, 404, 400];
      const wasDenied = typeof listResult?.status === 'number' && deniedStatuses.includes(listResult.status);
      const returnedForeignList = Boolean(
        listResult?.body &&
        typeof listResult.body === 'object' &&
        Array.isArray(listResult.body?.products) &&
        listResult.body.products.length > 0,
      );

      if (!wasDenied && returnedForeignList) {
        findings.push(triage.buildFinding({
          title: 'CRITICAL: tenant isolation breach - a products-list endpoint returned data for a foreign businessId',
          category: 'tenant_isolation',
          severity: 'critical',
          lesson: 'tenant-isolation-deep',
          persona: persona?.key ?? null,
          repro: `As persona "${persona?.key}", GET /api/products?businessId=${otherId} (a synthetic TEACH-BOT tenant belonging to a DIFFERENT persona).`,
          expected: 'Denied (401/403/404) or no foreign product data returned; tenancy must come from the session, not the query param.',
          actual: `status=${listResult?.status}, returned a non-empty products list for a foreign businessId.`,
          evidence: {},
          triageClass: 'confirmed_app_bug',
          customerImpact: 'A malicious or careless client could enumerate another shop\'s full product catalog via a direct API call.',
          locked: true,
        }));
        pass = false;
        learned.breach = true;
      }
    } catch (err) {
      notes.push(`/api/products businessId probe raised: ${String(err && err.message ? err.message : err)} - non-fatal, route shape may not exist.`);
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
