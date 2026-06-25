import { describe, it, expect } from 'vitest';
import { computePublishGap, gapToHtml } from '../lib/publish-gap.mjs';

describe('computePublishGap', () => {
  it('flags uncommitted + unpushed + score drift', () => {
    const gap = computePublishGap({
      gitStatus: ' M src/app/page.tsx\n?? scripts/new.mjs\n',
      gitUnpushed: 'a1b2c3 wip: tweak scanner\n',
      localScores: { overall: 90, scanner_flow: 88 },
      liveScores: { overall: 78, scanner_flow: 70 },
    });
    expect(gap.dirty).toBe(true);
    expect(gap.items.some((i) => i.kind === 'uncommitted')).toBe(true);
    expect(gap.items.some((i) => i.kind === 'unpushed')).toBe(true);
    expect(gap.items.some((i) => i.kind === 'score_drift' && i.detail.includes('scanner_flow'))).toBe(true);
  });

  it('is clean when nothing differs', () => {
    const gap = computePublishGap({ gitStatus: '', gitUnpushed: '', localScores: { overall: 80 }, liveScores: { overall: 80 } });
    expect(gap.dirty).toBe(false);
    expect(gap.items).toHaveLength(0);
    expect(gapToHtml(gap)).toContain('No drift');
  });
});
