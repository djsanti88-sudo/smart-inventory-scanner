// Local-vs-live drift detector: surfaces uncommitted/unpushed work and score divergence.
const DRIFT_THRESHOLD = 8; // points

export function computePublishGap({ gitStatus = '', gitUnpushed = '', localScores = {}, liveScores = {} }) {
  const items = [];
  const changed = gitStatus.split('\n').map((s) => s.trim()).filter(Boolean);
  if (changed.length) {
    items.push({ kind: 'uncommitted', severity: 'high', detail: `${changed.length} uncommitted file(s): ${changed.slice(0, 8).join(', ')}` });
  }
  const commits = gitUnpushed.split('\n').map((s) => s.trim()).filter(Boolean);
  if (commits.length) {
    items.push({ kind: 'unpushed', severity: 'high', detail: `${commits.length} commit(s) not pushed: ${commits.slice(0, 5).join(' | ')}` });
  }
  for (const dim of Object.keys(localScores)) {
    if (dim in liveScores) {
      const d = localScores[dim] - liveScores[dim];
      if (Math.abs(d) >= DRIFT_THRESHOLD) {
        items.push({
          kind: 'score_drift',
          severity: Math.abs(d) >= 20 ? 'high' : 'medium',
          detail: `${dim}: local ${localScores[dim]} vs live ${liveScores[dim]} (delta ${d > 0 ? '+' : ''}${d})`,
        });
      }
    }
  }
  return { dirty: items.length > 0, items };
}

export function gapToHtml(gap) {
  if (!gap.dirty) {
    return `<section style="padding:12px 16px;border-radius:8px;background:#0f5132;color:#d1e7dd;font-family:system-ui">Publish-Gap: No drift. Local and live agree, working tree clean.</section>`;
  }
  const rows = gap.items.map((i) => `<li><strong>${i.kind}</strong> (${i.severity}): ${i.detail}</li>`).join('');
  return `<section style="padding:12px 16px;border-radius:8px;background:#842029;color:#f8d7da;font-family:system-ui"><h3 style="margin:0 0 6px">Publish-Gap: drift detected</h3><ul style="margin:0;padding-left:18px">${rows}</ul></section>`;
}
