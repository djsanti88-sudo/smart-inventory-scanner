// Two-currency cost ledger for the weekly report.
// Currency 1: Claude subscription usage (zero out-of-pocket CASH; estimated agent/token usage).
// Currency 2: third-party out-of-pocket cash (Gemini, OpenAI, Firecrawl, web search, ...).
// Pure functions (no fs) to match the scripts/lib pattern. Scripts read/write cost.json themselves.

export function emptyLedger(mode = 'lean') {
  return {
    mode,
    capUsd: mode === 'deep' ? 2 : 0.5,
    thirdParty: [], // [{ provider, detail, calls, usd }]
    claude: { agents: 0, estTokens: 0, note: 'Covered by Claude subscription. Zero out-of-pocket cash.' },
    skipped: [], // strings: caps hit, missing artifacts/server/creds, owner gate not approved
  };
}

// Roll a raw cost.json into totals + flags used by the renderer.
export function aggregateCost(cost = {}) {
  const thirdParty = Array.isArray(cost.thirdParty) ? cost.thirdParty : [];
  const byProvider = {};
  let thirdPartyTotalUsd = 0;
  for (const e of thirdParty) {
    const usd = Number(e.usd) || 0;
    const calls = Number(e.calls) || 0;
    thirdPartyTotalUsd += usd;
    if (!byProvider[e.provider]) byProvider[e.provider] = { provider: e.provider, calls: 0, usd: 0, details: [] };
    byProvider[e.provider].calls += calls;
    byProvider[e.provider].usd += usd;
    if (e.detail) byProvider[e.provider].details.push(e.detail);
  }
  const capUsd = Number(cost.capUsd) || (cost.mode === 'deep' ? 2 : 0.5);
  return {
    mode: cost.mode || 'lean',
    capUsd,
    thirdPartyTotalUsd: round2(thirdPartyTotalUsd),
    overCap: thirdPartyTotalUsd > capUsd + 1e-9,
    capHeadroomUsd: round2(Math.max(0, capUsd - thirdPartyTotalUsd)),
    byProvider: Object.values(byProvider).map((p) => ({ ...p, usd: round2(p.usd) })),
    claude: cost.claude || { agents: 0, estTokens: 0, note: 'Covered by Claude subscription. Zero out-of-pocket cash.' },
    skipped: Array.isArray(cost.skipped) ? cost.skipped : [],
  };
}

// Self-contained HTML section. No em or en dashes in any copy. Neutral professional palette.
export function costToHtml(cost) {
  const a = aggregateCost(cost);
  const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const tokens = (n) => (Number(n) || 0).toLocaleString('en-US');

  const providerRows = a.byProvider.length
    ? a.byProvider
        .map(
          (p) =>
            `<tr><td>${esc(p.provider)}</td><td style="text-align:right">${p.calls}</td><td style="text-align:right">${money(p.usd)}</td><td>${esc(p.details.join('; '))}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="4" style="color:#6b7280">No third-party (cash) calls were made.</td></tr>`;

  const capColor = a.overCap ? '#842029' : '#0f5132';
  const capBg = a.overCap ? '#f8d7da' : '#d1e7dd';
  const capLine = a.overCap
    ? `OVER the ${money(a.capUsd)} hard cap. Run stopped third-party spend.`
    : `Within the ${money(a.capUsd)} hard cap (${money(a.capHeadroomUsd)} headroom).`;

  const skippedHtml = a.skipped.length
    ? `<p style="margin:8px 0 0;color:#92400e"><strong>Skipped this run:</strong> ${a.skipped.map(esc).join('; ')}</p>`
    : '';

  return `
<section style="margin-top:28px;padding:16px 18px;border:1px solid #e5e7eb;border-radius:10px;font-family:system-ui,-apple-system,sans-serif">
  <h2 style="margin:0 0 4px;font-size:18px">What this report cost</h2>
  <p style="margin:0 0 14px;color:#6b7280;font-size:13px">Two separate currencies. The Claude agent fleet is covered by your subscription (no cash). Only the third-party APIs cost real money.</p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div style="padding:12px 14px;border-radius:8px;background:#eef2ff">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#4338ca">Claude fleet (subscription)</div>
      <div style="font-size:24px;font-weight:700;margin:4px 0;color:#3730a3">$0.00 cash</div>
      <div style="font-size:13px;color:#3730a3">~${a.claude.agents || 0} agent runs, ~${tokens(a.claude.estTokens)} tokens (estimated)</div>
      <div style="font-size:12px;color:#6366f1;margin-top:4px">${esc(a.claude.note)}</div>
    </div>
    <div style="padding:12px 14px;border-radius:8px;background:${capBg}">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:${capColor}">Third-party (out of pocket)</div>
      <div style="font-size:24px;font-weight:700;margin:4px 0;color:${capColor}">${money(a.thirdPartyTotalUsd)}</div>
      <div style="font-size:13px;color:${capColor}">${capLine}</div>
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px">
    <thead><tr style="text-align:left;border-bottom:2px solid #e5e7eb"><th>Provider</th><th style="text-align:right">Calls</th><th style="text-align:right">Cash</th><th>Detail</th></tr></thead>
    <tbody>${providerRows}</tbody>
  </table>
  ${skippedHtml}
</section>`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
