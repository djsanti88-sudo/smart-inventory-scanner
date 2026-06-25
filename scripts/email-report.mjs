// Sends the weekly report via Gmail SMTP (free app password). Degrades gracefully with no creds.
// Usage: node scripts/email-report.mjs <date> <html-file> <pdf-file>
import nodemailer from 'nodemailer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildMessage({ to, date, html, pdfPath }) {
  return {
    to,
    subject: `Smart Inventory weekly intel - ${date}`,
    html,
    attachments: pdfPath ? [{ filename: `smart-inventory-intel-${date}.pdf`, path: pdfPath }] : [],
  };
}

export async function sendReport(opts, env = process.env) {
  const user = env.GMAIL_USER;
  const pass = env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return { sent: false, reason: 'no-credentials' };
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  const msg = buildMessage(opts);
  await transport.sendMail({ from: user, ...msg });
  return { sent: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs');
  const { loadEnvLocal } = await import('./lib/load-env.mjs');
  loadEnvLocal(); // pick up GMAIL_USER / GMAIL_APP_PASSWORD from .env.local
  const [, , date, htmlFile, pdfFile] = process.argv;
  const html = fs.readFileSync(htmlFile, 'utf8');
  const res = await sendReport({ to: 'djsanti88@gmail.com', date, html, pdfPath: pdfFile ? path.resolve(pdfFile) : undefined });
  console.log('EMAIL ' + JSON.stringify(res));
}
