// Renders a self-contained report.html -> report.pdf (+ a full-page report.png preview).
// Usage: node scripts/render-report-pdf.mjs <in.html> [out.pdf]
import { chromium } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function renderReport(htmlPath, outPdfPath) {
  const abs = path.resolve(htmlPath);
  const out = path.resolve(outPdfPath);
  const pngOut = out.replace(/\.pdf$/i, '.png');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    await page.emulateMedia({ media: 'screen' });
    await page.goto(pathToFileURL(abs).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.documentElement.style.setProperty('print-color-adjust', 'exact');
      document.documentElement.style.setProperty('-webkit-print-color-adjust', 'exact');
    });
    await page.waitForTimeout(400);
    const height = await page.evaluate(() => Math.ceil(document.body.scrollHeight) + 40);
    await page.screenshot({ path: pngOut, fullPage: true });
    await page.pdf({ path: out, width: '1300px', height: `${height}px`, printBackground: true, pageRanges: '1' });
    return { pdf: out, png: pngOut };
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , inHtml, outPdf] = process.argv;
  renderReport(inHtml, outPdf || inHtml.replace(/\.html?$/i, '.pdf'))
    .then((r) => console.log('RENDERED ' + JSON.stringify(r)))
    .catch((e) => { console.error(e); process.exit(1); });
}
