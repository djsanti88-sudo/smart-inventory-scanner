import { describe, it, expect } from 'vitest';
import { buildMessage, sendReport } from '../email-report.mjs';

describe('email-report', () => {
  it('builds a message with pdf attachment and inline html', () => {
    const msg = buildMessage({ to: 'djsanti88@gmail.com', date: '2026-06-24', html: '<h1>hi</h1>', pdfPath: '/tmp/report.pdf' });
    expect(msg.to).toBe('djsanti88@gmail.com');
    expect(msg.subject).toContain('2026-06-24');
    expect(msg.html).toContain('<h1>hi</h1>');
    expect(msg.attachments[0].path).toBe('/tmp/report.pdf');
  });

  it('skips gracefully when credentials are missing', async () => {
    const res = await sendReport({ to: 'x@y.com', date: '2026-06-24', html: '<p>x</p>', pdfPath: '/tmp/x.pdf' }, {});
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no-credentials');
  });
});
