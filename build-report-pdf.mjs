// Renders competitor-analysis.html -> a single tall, graphical PDF.
// Usage: node build-report-pdf.mjs [outputPath]
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = path.resolve('competitor-analysis.html');
const out = process.argv[2] || path.resolve('competitor-analysis.pdf');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  // keep the dark "screen" theme in the PDF (not the print stylesheet)
  await page.emulateMedia({ media: 'screen' });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });

  // Force every scroll-reveal section visible, open all competitor dossiers,
  // fill the price bars, freeze the sweep animation, keep exact colors.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('print-color-adjust', 'exact');
    document.documentElement.style.setProperty('-webkit-print-color-adjust', 'exact');
    document.querySelectorAll('.reveal').forEach(e => e.classList.add('in'));
    document.querySelectorAll('.fill').forEach(f => { if (f.dataset.w) f.style.width = f.dataset.w + '%'; });
    document.querySelectorAll('details.cc').forEach(d => d.setAttribute('open', ''));
    document.querySelectorAll('.scanline').forEach(s => s.style.display = 'none');
    // hide the sticky nav so it doesn't overlap content in a single long page
    const nav = document.querySelector('nav'); if (nav) nav.style.position = 'static';
  });

  await page.waitForTimeout(800); // let fonts settle + details expand
  const height = await page.evaluate(() => Math.ceil(document.body.scrollHeight) + 40);

  // also emit a full-page PNG (visual proof + reusable email preview image)
  const pngOut = out.replace(/\.pdf$/i, '.png');
  await page.screenshot({ path: pngOut, fullPage: true });
  console.log('PNG_WRITTEN:' + pngOut);

  await page.pdf({
    path: out,
    width: '1300px',
    height: `${height}px`,
    printBackground: true,
    pageRanges: '1',
  });
  console.log('PDF_WRITTEN:' + out + ' height=' + height);
} finally {
  await browser.close();
}
