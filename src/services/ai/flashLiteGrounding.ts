const MODEL = process.env.GEMINI_GROUND_MODEL || "gemini-flash-lite-latest";
export async function groundIdentify(code: string, opts?: { url?: string; apiKey?: string; fetch?: typeof fetch }): Promise<{ text: string; grounded: boolean } | null> {
  const key = opts?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) return null;
  const f = opts?.fetch ?? fetch;
  const tool = opts?.url ? { url_context: {} } : { google_search: {} };
  const prompt = opts?.url
    ? `From ${opts.url}, what product has UPC barcode ${code}? Reply only the brand and product name.`
    : `What product has UPC barcode ${code}? Reply only the brand and product name.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [tool] });
  let res: Response;
  try { res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join(" ").trim();
  if (!text) return null;
  return { text, grounded: !opts?.url };
}
