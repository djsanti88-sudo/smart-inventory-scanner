# Final ladder + Discount-Tire-harvest session PDF report (ladder plan Task 20 Step 3).
# Offline synthesis only - no live calls made to produce this report.
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, ListFlowable, ListItem
)

styles = getSampleStyleSheet()
h1 = ParagraphStyle("h1x", parent=styles["Title"], fontSize=19, spaceAfter=6)
h2 = ParagraphStyle("h2x", parent=styles["Heading2"], textColor=colors.HexColor("#1a4d8f"), spaceBefore=13)
h3 = ParagraphStyle("h3x", parent=styles["Heading3"], textColor=colors.HexColor("#1a4d8f"), spaceBefore=8, fontSize=11)
body = ParagraphStyle("bodyx", parent=styles["Normal"], fontSize=10, leading=14)
small = ParagraphStyle("smallx", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=colors.HexColor("#555555"))
verd = ParagraphStyle("verdx", parent=styles["Normal"], fontSize=12, leading=16, textColor=colors.HexColor("#0a6b2d"))
warn = ParagraphStyle("warnx", parent=styles["Normal"], fontSize=10, leading=14, textColor=colors.HexColor("#8f2a1a"))
mono = ParagraphStyle("monox", parent=styles["Normal"], fontSize=8.5, leading=11, fontName="Courier")


def tbl(rows_, widths):
    t = Table(rows_, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f8fc")]),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a4d8f")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def bullets(items, style=body):
    return ListFlowable(
        [ListItem(Paragraph(i, style), leftIndent=6) for i in items],
        bulletType="bullet", start="circle", leftIndent=14,
    )


story = []

# ---------------------------------------------------------------------------
# COVER / EXEC SUMMARY
# ---------------------------------------------------------------------------
story.append(Paragraph("Decode Ladder + Discount Tire Harvest: Session Proof Report", h1))
story.append(Paragraph(
    "Branch feat/decode-ladder-goupc - Ladder plan Task 20 Step 3 - Generated 2026-07-09. "
    "Offline synthesis of all proof artifacts produced this session; no live provider calls were made "
    "to produce this report.", small))
story.append(Spacer(1, 10))

story.append(Paragraph(
    "<b>Verdict: SHIPPED.</b> The decode ladder (corpus -&gt; Go-UPC -&gt; Fetch V2 -&gt; GPT-5.5) is now "
    "reachable in production for the first time (it was structurally dead for public barcodes before "
    "this session's fix). The one severe safety defect the live proof surfaced - a 4-digit vendor part "
    "number auto-verified with a fabricated identity - was found, root-caused, fixed, and reverified: "
    "auto-count precision moved from 96.9% to 100% on the exact 60-code run that exposed it. In parallel, "
    "the Discount Tire harvest pipeline ran its full catalog and grew the tire corpus by 2,029 new GTINs "
    "at $0 spend. The binding qa:revision gate (tsc, eslint, build, full Playwright E2E, Firebase tests, "
    "12/12 QA bots) is GREEN on the final tree. Nothing has been pushed or deployed; that remains the "
    "owner's call.", verd))
story.append(Spacer(1, 6))

story.append(Paragraph("What shipped, in one table", h2))
story.append(tbl([
    ["Item", "Before this session", "After this session"],
    ["Decode ladder reachability", "Go-UPC/FetchV2/GPT structurally unreachable for public barcodes (Plan D always terminal)", "Reachable end to end; T8b fix verified live + adversarially reviewed"],
    ["Auto-count precision (60-code live run)", "96.9% (31/32 correct)", "100% (25/25 correct) after the 1225 fix"],
    ["Wrong auto-counts in the run", "1 (code 1225, fabricated Hungarian cranberry product for a Moen faucet cartridge)", "0 - all 7 gpt_self_report codes now demote to needs_review"],
    ["Tire corpus size", "76,173 rows (pre-harvest)", "+2,029 new GTINs merged (5,553 cross-source dupes kept as-is), DB rebuilt"],
    ["Binding qa:revision gate", "n/a (mid-session, red at points - see Section 2/3)", "GREEN: tsc + eslint + build + full Playwright E2E + Firebase tests + 12/12 QA bots"],
], [2.3 * inch, 2.3 * inch, 2.3 * inch]))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# SECTION 2: THE DECODE LADDER
# ---------------------------------------------------------------------------
story.append(Paragraph("2. The Decode Ladder", h1))

story.append(Paragraph("2.1 Rung order and each rung's literal decision rule", h2))
story.append(Paragraph(
    "Spec v6 (owner-approved, commit c957423): local corpus -&gt; Go-UPC -&gt; Fetch V2 -&gt; GPT-5.5, "
    "sequential, first-settle stops the ladder. Gemini is permanently out of the decode path. Each rung's "
    "actual, as-built behavior (not the aspirational plan text):", body))
story.append(tbl([
    ["Rung", "Trigger / query", "Decision rule as built"],
    ["1. Local corpus ($0)", "SQLite exact-barcode lookup against knowledge.generated.db (tires + retail tables)", "resolveExactBarcode short-circuits with zero network calls on any exact hit. This is the ONLY free rung and it runs first for every code."],
    ["Plan D (pre-ladder, public barcodes only)", "For upc_a/ean_13/gtin_14 codes: parallel floor + UPCitemdb consensus + Firecrawl search/scrape tiebreaker", "resolveUnknownFast is DELIBERATELY TERMINAL for public-barcode-shaped codes by design (\"we must ALWAYS be terminal here\", parallelResolve.ts). This was found to make Go-UPC/FetchV2/GPT unreachable for ~all real barcodes until fixed (T8b, commit 6a800c4)."],
    ["2. Go-UPC (<= 15 lookups/proof phase; 40/mo cap)", "isGtinShaped(code) && isValidCheckDigit(code) gates entry; live paid lookup", "Exact GTIN hit -> verified/auto-count; miss -> negative-cached, falls through. Monthly quota tracked in Turso (goupc_usage), atomic in-SQL increment."],
    ["3. Fetch V2 (Brave + Firecrawl web)", "Search + cheap-scrape discovery over the web for the literal code string", "Resolution only if the exact code is found in real evidence (EvidenceVerifier strength grading); known defect class: search-result-title noise can leak through as a low-confidence suggestion (never auto-counted)."],
    ["4. GPT-5.5 (probe parity, ~$0.39/call worst case, $3/day cap)", "Raw code in, model self-reports exactCodeFound + confidence, no hints/no wrapper rules (owner order 2026-07-06)", "corroborationPath=\"gpt_self_report\" + status=verified + confidence>=0.8 previously auto-counted with NO code-shape check (the 1225 hole - see Section 3). Fixed: now requires codeType in [upc_a, ean_13, gtin_14] before trusting a bare self-report."],
], [1.7 * inch, 2.5 * inch, 2.7 * inch]))

story.append(Paragraph("2.2 Task 20 waterfall - settled-by-stage per group (60 live codes, real .env.local keys)", h2))
story.append(Paragraph(
    "Group A = 20 tire barcodes freshly sampled from the corpus at run time. Groups B/C = 40 codes "
    "hand-selected from e2e/fixtures/dryrun-codes.json, reconfirmed absent from BOTH corpora at "
    "selection time AND at run time (zero corpus growth in between).", body))
story.append(tbl([
    ["Group", "n", "Settled-by breakdown", "Status breakdown"],
    ["A - corpus tires", "20", "corpus_exact_barcode 20", "verified 20"],
    ["B - retail, absent from corpora", "20", "goupc 7, single_source 4, fetchv2 2, none 7", "verified 5, suggested 2, needs_review 13"],
    ["C - hard tail, absent from corpora", "20", "gpt 9, none 6, goupc 3, corpus_exact_part_number 1, parallel_floor 1", "verified 7, suggested 3, needs_review 10"],
], [1.6 * inch, 0.5 * inch, 2.7 * inch, 2.1 * inch]))

story.append(Paragraph("2.3 Per-rung verdict: WORKING / NOT / REMOVE / IMPROVE / ADD", h2))

story.append(Paragraph("Rung 1 - Local corpus", h3))
story.append(bullets([
    "<b>WORKING:</b> 39/40 resolved in the rung-1 micro-proof (p50 260ms wall-clock incl. HTTP overhead); Group A 20/20 in the full T20 run. Zero cost, zero network calls for tire hits.",
    "<b>NOT WORKING:</b> one genuine gap - an EAN-8 code (52454615) sits IN the corpus but codeType does not qualify it for the free-tier resolver, so it fell through to an all-skipped ladder instead of resolving free.",
    "<b>TO ADD:</b> extend isPublicBarcode's free-tier gate to include ean_8, or give the corpus rung its own code-shape-agnostic lookup path so any exact hit resolves free regardless of shape.",
]))

story.append(Paragraph("Rung 1.5 - Plan D (pre-ladder terminal resolver for public barcodes)", h3))
story.append(bullets([
    "<b>WORKING (as intended):</b> for genuinely unresolved public barcodes, Plan D's free-tier consensus (UPCitemdb + local retail DB + occasional Firecrawl tiebreaker) answers most retail codes before any paid rung runs.",
    "<b>NOT WORKING (found and now fixed):</b> Plan D's terminal design meant Go-UPC/FetchV2/GPT were structurally unreachable for the ENTIRE public-barcode class (upc_a/ean_13/gtin_14) - only 8-digit EAN-8-shaped codes could ever reach the paid ladder. This was the T19 headline finding, closed by T8b (commit 6a800c4, adversarially reviewed, revert-RED proven).",
    "<b>TO IMPROVE:</b> the non-verified Plan D outcome is now stashed and yielded to the ladder rather than returned terminally - reviewed and confirmed correct in the final whole-branch review (Seam 1).",
]))

story.append(Paragraph("Rung 2 - Go-UPC", h3))
story.append(bullets([
    "<b>WORKING:</b> live-proven post-fix - 9 verified + 1 suggested of 10 known-good GTIN codes, counter delta matched exactly (0-&gt;2, then cumulative to 14 across the full T20 dispatch). Non-GTIN (ASIN-shaped) codes correctly gated out before ever reaching the paid client - this is the quota-protection proof the plan required, and it holds.",
    "<b>TAIL-RUNG ACCURACY:</b> 10/10 correct identity or outcome across the T20 run (7 in Group B, 3 in Group C) - the single most reliable paid rung in this session's data.",
    "<b>TO IMPROVE:</b> none found this session; Go-UPC's exact-match behavior and quota gating both held under live load.",
]))

story.append(Paragraph("Rung 3 - Fetch V2", h3))
story.append(bullets([
    "<b>WORKING (live, phase 2):</b> 20/20 resolved on a rung-isolated sample (Go-UPC and OpenAI keys blanked) vs a 17.6% historical baseline - but see the honesty note below.",
    "<b>NOT WORKING / MEASUREMENT CAVEAT:</b> that 20/20 was a CORPUS result, not a Fetch V2 result - every sampled code actually settled via corpus_exact_barcode in 7-30ms because the \"61 double-miss\" input set had been fully absorbed into the tire corpus since it was recorded. Fetch V2 itself settled 0 codes and spent 0 Firecrawl credits in that isolated run. A genuine live Fetch V2 proof needs a fresh hard set reconfirmed absent from the corpus at run time.",
    "<b>NOT WORKING (known defect class, T20):</b> search-result-title noise can leak through as a low-confidence suggestion - e.g. a Home Depot bucket code returned \"Ryobi stick vacuum clearance deal found - Facebook\" via fetchv2 with status:suggested. Never auto-counted, but pollutes Needs Review.",
    "<b>TO IMPROVE:</b> title-relevance filtering / re-ranking before a scraped page title is offered as a suggestion (repeat of a known 2026-07-08 issue, not newly introduced this session).",
]))

story.append(Paragraph("Rung 4 - GPT-5.5 (probe parity)", h3))
story.append(bullets([
    "<b>WORKING:</b> 9/9 attempted in the T20 hard tail; 6/9 correct identity, all non-auto-counting hallucinations correctly firewalled by the existing status gate (stayed suggested, never verified).",
    "<b>NOT WORKING (the severe finding, now fixed - see Section 3):</b> a bare self-report on a non-public-barcode-shaped code (4-digit part number \"1225\") auto-verified a completely fabricated product. All 7 gpt_self_report rows in the run shared the identical ungated path; 6 happened to be correct, 1 was not.",
    "<b>NOT WORKING (separate, smaller defects, correctly non-auto-counted):</b> two checksum-valid-but-unassigned UPC-A canaries did not cleanly refuse - one returned a generic \"Unidentified item\" placeholder after a 23.7s timeout (UX/latency nit), the other fabricated \"M23 Signal panel connector housing\" (a real hallucination, but stayed suggested). A Pirelli tire code returned \"Mediterranean Style Meatloaf Mix\" via gpt (suggested, total identity-family swap).",
    "<b>TO REMOVE / TO IMPROVE:</b> the prompt clause driving \"never leave productName empty\" produces junk suggestions on codes with zero real evidence; a build-time decision (keep / allow-empty / category-flag) is recorded in the spec but not yet implemented. The rung-4 budget math in the original plan was also found arithmetically inconsistent (10-code sample x $0.39 worst case = $3.90 &gt; the $1.50 sub-cap) - resolved by switching to actuals-based check-before-spend using the route's own gptLadder.spentTodayUsd telemetry.",
    "<b>TO ADD (owner-decision item, not yet built):</b> an EvidenceVerifier-equivalent check that the exact code string appears in fetched source content before trusting ANY GPT verified tier, even for public barcodes where the shape gate does not apply. See Section 6(a).",
]))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# SECTION 3: THE 1225 DEFECT
# ---------------------------------------------------------------------------
story.append(Paragraph("3. The 1225 Defect: Found, Root-Caused, Fixed, Reverified", h1))

story.append(Paragraph("3.1 What happened", h2))
story.append(Paragraph(
    "During the Task 20 live 60-code run, code <b>1225</b> - a 4-digit Moen vendor part number "
    "(\"Moen One-Handle Faucet Replacement Cartridge\") with no public barcode structure at all - was "
    "auto-verified (status:\"verified\", corroborationPath:\"gpt_self_report\") with a completely "
    "fabricated identity: <i>\"Spitz Vorosafonya 50%-os gyumolcskeszitmeny 5kg\"</i>, a Hungarian cranberry "
    "fruit preparation. This is the single worst outcome the ladder can produce - a wrong-identity "
    "auto-count permanently and silently mis-teaches an alias.", body))

story.append(Paragraph("3.2 Root cause", h2))
story.append(Paragraph(
    "src/stores/scanStore.ts's <font face='Courier'>gptTrusted</font> branch (present in both "
    "liveDecode and its duplicate in backgroundVerifyDeep) auto-counted any decode with "
    "corroborationPath === \"gpt_self_report\" + status === \"verified\" + confidence &gt;= 0.8 + a "
    "usable product name - with <b>no check on the scanned code's shape whatsoever</b>. A GPT "
    "self-report is only theoretically falsifiable for a real public barcode (the model claims to have "
    "found the exact code on a real page); a 4-digit vendor part number has no public page to have been "
    "\"found\" on, so trusting a bare self-report there is unverifiable by construction. This was a "
    "pre-existing design gap (the \"GPT LADDER TRUST TIER\" owner rule from 2026-07-06), not something "
    "newly introduced this session - the earlier T8b reachability fix widened how many codes could reach "
    "the already-vulnerable gate, but did not create the gate itself.", body))
story.append(Paragraph(
    "Two independent gates both had to be absent for this to be unsafe, and neither was present: the "
    "store's gptTrusted branch (no shape check) and evidenceScoring.ts's decideAutoVerification "
    "(\"TRUST-THE-AI\" gate, which only blocks codeType===\"vendor_label\", never numeric_sku/alpha_sku).", body))

story.append(Paragraph("3.3 The fix", h2))
story.append(Paragraph(
    "Commit <b>5d810d46b7b3a8957851b4c0c2860430b54c7aa6</b>, reviewed and confirmed applied correctly. "
    "Adds <font face='Courier'>isPublicBarcodeShapeForGptTrust = codeType in [upc_a, ean_13, gtin_14]</font> "
    "as the first, required conjunct of gptTrusted in both liveDecode and backgroundVerifyDeep. The "
    "existing decodeCorroborated() conjunction (the legitimate app-verified evidence path for corpus/"
    "Go-UPC/FetchV2 hits) was NOT touched. TDD evidence: 12/12 tests green including a red-before/"
    "green-after pair for exactly code 1225, plus a regression guard proving legitimate upc_a "
    "self-report auto-counts are unaffected. Full suite: 1594 pass / 0 fail, tsc clean, eslint clean.", body))

story.append(Paragraph("3.4 Graded proof the defect is closed", h2))
story.append(Paragraph(
    "All 7 codes in the run with corroborationPath \"gpt_self_report\" reached verified/auto-count "
    "status through the identical ungated path - 1225 was simply the one case where the self-report "
    "happened to be wrong instead of accidentally correct:", body))
story.append(tbl([
    ["Code", "codeType shape", "Pre-fix status", "This run's identity", "Post-fix outcome"],
    ["28034300", "numeric_sku (8-digit)", "verified (auto-count)", "correct (Falken Wildpeak A/T3W)", "needs_review"],
    ["DCB205", "alpha_sku", "verified (auto-count)", "correct (DeWalt battery)", "needs_review"],
    ["BL1850B", "alpha_sku", "verified (auto-count)", "correct (Makita battery)", "needs_review"],
    ["PH7317", "alpha_sku", "verified (auto-count)", "correct (FRAM oil filter)", "needs_review"],
    ["K060841", "alpha_sku", "verified (auto-count)", "correct (Gates belt)", "needs_review"],
    ["1225", "numeric_sku", "verified (auto-count)", "WRONG (fabricated Hungarian cranberry product)", "needs_review"],
    ["GP1043211", "alpha_sku", "verified (auto-count)", "correct (Kohler sprayhead)", "needs_review"],
], [0.9 * inch, 1.1 * inch, 1.1 * inch, 2.1 * inch, 1.1 * inch]))
story.append(Spacer(1, 6))
story.append(Paragraph(
    "6 of 7 \"got lucky\" this run (correct answer despite an unverifiable, ungated trust path); 1225 "
    "proves the path was never actually safe. The fix demotes all 7 uniformly - a deliberate, symmetric "
    "trade of a small recall cost (6 previously-correct auto-counts become suggestions requiring human "
    "approval) for closing the entire hallucination-auto-count hole for this code-shape class, matching "
    "CLAUDE.md's resolver-trust rule: \"Unknown is ACCEPTABLE. Prefer Needs Review over a wrong guess.\"", body))

story.append(Paragraph("Auto-count precision - the headline safety number", h2))
story.append(tbl([
    ["", "Total auto-counted (status=verified)", "Correct", "Wrong", "Precision"],
    ["Pre-fix", "32", "31", "1 (code 1225)", "96.9%"],
    ["Post-fix", "25", "25", "0", "100%"],
], [1.6 * inch, 1.9 * inch, 0.9 * inch, 1.2 * inch, 0.9 * inch]))
story.append(Spacer(1, 4))
story.append(Paragraph(
    "(32 pre-fix = 20 Group A corpus hits + 5 Group B single-source/Go-UPC exact hits + 7 Group C "
    "gpt_self_report hits. Post-fix, all 7 gpt_self_report hits demote to needs_review, leaving 25 "
    "auto-counts, all correct. Graded offline by claude-sonnet-5 directly, per owner order that "
    "mechanical grading be done by a lower-tier model with no escalation to opus.)", small))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# SECTION 4: DISCOUNT TIRE HARVEST
# ---------------------------------------------------------------------------
story.append(Paragraph("4. Discount Tire Harvest", h1))

story.append(Paragraph("4.1 Pipeline", h2))
story.append(bullets([
    "Sitemap discovery: sitemaps.discounttire.com/sitemap_full_product.xml -&gt; one .gz child, 18,950 URLs, of which 7,886 are tire product pages (product URLs are /buy-tires/&lt;slug&gt;/p/&lt;digits&gt;).",
    "Deterministic JSON-LD tire parser, with the finding that DT's JSON-LD Product block has NO GTIN - the barcode and full specs arrive via the page's own webapi/discounttire.graph?op=productByCode response, captured from natural page traffic (no extra requests needed).",
    "Poison guard: check-digit validation + brand-prefix firewall rejects any row whose \"gtin\" field is actually DT's internal article code (not a real GS1 barcode) rather than a genuine barcode.",
    "Playwright fetcher with a rolling block-rate stop: sequential fetches, 2000-4000ms randomized delay, realistic Chrome-on-Windows context, per-worker 30% block-rate hard stop, host allowlist www.discounttire.com.",
    "Cross-source-safe merge: new GTINs are added; codes already present from another source are left as-is (no overwrite of existing corpus provenance).",
]))

story.append(Paragraph("4.2 Pilot (100 pages, 2026-07-08) - PASS", h2))
story.append(tbl([
    ["Metric", "Gate", "Result"],
    ["Block rate", "<= 30%", "0.0% (0 blocked / 100)"],
    ["Valid-GTIN rows", ">= 60", "96"],
    ["Errors / parse misses", "-", "0 / 0"],
    ["Guard rejections", "-", "4 (all correct - DT internal article codes, not real GTINs)"],
    ["Throughput", "-", "~733 pages/hour (8m11s wall)"],
], [1.8 * inch, 1.2 * inch, 3.4 * inch]))

story.append(Paragraph("4.3 Fleet - final numbers (full catalog)", h2))
story.append(tbl([
    ["Metric", "Value"],
    ["Guarded rows harvested", "7,486 across the full catalog"],
    ["Blocks across the entire run", "0"],
    ["Poison-guard rejects", "221"],
    ["New tire GTINs merged into corpus", "+2,029 (5,553 cross-source dupes kept as-is)"],
    ["Corpus DB", "rebuilt (342 MB); corpus JSON committed, .db and .bak gitignored"],
    ["Spot-check proof", "20/20 PASS"],
    ["Integration proof", "10/10 new DT GTINs resolved via resolveExactBarcode (rung-1 function) -> corpus_exact_barcode, no AI call, correct brand"],
    ["Resilience", "Detached worker fleet (Start-Process, separate PIDs) survived 2 EPERM crashes mid-run (Windows Defender file-lock race on telemetry writes) via atomic-write-retry + resume-from-checkpoint; 0 rows lost"],
], [2.6 * inch, 3.8 * inch]))

story.append(Paragraph("4.4 Spend", h2))
story.append(Paragraph(
    "<b>$0.</b> The harvest is compute-only (Playwright against DT's own public pages plus natural page "
    "traffic already returned by the site) - no paid API calls of any kind.", body))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# SECTION 5: SPEND RECONCILIATION
# ---------------------------------------------------------------------------
story.append(Paragraph("5. Spend Reconciliation (Cost-Truth Rule)", h1))
story.append(Paragraph(
    "Per the owner's Paid API Cost Truth rule: every figure below is a <b>computed floor</b> from "
    "response metadata and route-recorded/file-backed actuals. True spend must be reconciled against "
    "each provider's own billing console before being quoted as final.", body))
story.append(tbl([
    ["Provider", "This session's computed floor", "Cap", "Notes"],
    ["Go-UPC", "14 lookups total (Turso goupc_usage counter, month 2026-07: 0 -> 14)", "40/month phase cap", "Atomic in-SQL increment (used = used + 1 RETURNING used); no double-charge across Plan D vs ladder (Plan D never touches Go-UPC)."],
    ["GPT-5.5", "$1.1309 total, 13 calls (file-backed .gpt-ladder-usage.json, date 2026-07-09)", "$3.00/day, route-enforced", "checkGptLadderBudget() gates before every call; recordGptLadderSpend() fires on every call including abort. One GPT call max per compute."],
    ["Firecrawl", "<= ~112 credits worst-case reserved across all proof runs today (12 from rung-2 Plan-D tiebreakers + up to 100 reserved for the final T20 clean run, most never actually charged)", "300-400 credits per phase, never exceeded", "No per-call credit metering is exposed by the route; figures are conservative reservation ceilings, not confirmed charges."],
    ["Discount Tire harvest", "$0", "n/a", "Compute-only; no paid API calls."],
    ["Grading pass (this report's source data)", "$0", "n/a", "Offline grading over already-recorded JSON; no live provider calls."],
], [1.3 * inch, 3.3 * inch, 1.1 * inch, 1.7 * inch]))
story.append(Spacer(1, 6))
story.append(Paragraph(
    "<b>Wallet line: computed floor - Go-UPC 14 lookups, GPT $1.13 (persisted file actuals), Firecrawl "
    "&lt;= ~112 credits worst-case reserved; DT harvest $0. True spend = provider consoles (Go-UPC / "
    "OpenAI / Firecrawl). No run was stopped early by a spend cap in the final clean attempt.</b>", warn))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# SECTION 6: OPEN ITEMS / OWNER DECISIONS
# ---------------------------------------------------------------------------
story.append(Paragraph("6. Open Items / Owner Decisions", h1))
story.append(Paragraph(
    "Five items require an explicit owner decision or are flagged as known, deliberately-unfixed gaps. "
    "None are blocking; all are surfaced per the doctrine's no-partial-completion rule.", body))

story.append(Paragraph("(a) EvidenceVerifier on public-barcode GPT self-reports", h3))
story.append(Paragraph(
    "The 1225 fix closes the hole for non-public-shaped codes (vendor/SKU/part numbers), but a real "
    "public UPC/EAN/GTIN GPT self-report can still be a hallucination with a fabricated source URL - the "
    "shape gate only blocks vendor/short codes, not a wrong-product claim on a VALID public barcode. "
    "Adding an independent EvidenceVerifier-style check (confirming the exact code string appears in "
    "fetched source content) would close this, but would contradict the owner's 2026-07-06 "
    "\"probe parity / no app-side questioning\" order (raw code in, answer taken as returned). Current "
    "posture - trust a GPT self-report on a real public barcode at confidence &gt;= 0.8 - is the "
    "owner-approved default. This is a deliberate, owner-approved trade-off being resurfaced for "
    "revisit, not treated as a defect.", body))

story.append(Paragraph("(b) FetchV2/GPT raw-archive module never built", h3))
story.append(Paragraph(
    "The plan's Task 2 \"raw decode archive\" for Fetch V2 and GPT-5.5 raw responses does not exist as a "
    "standalone module. Only the Go-UPC rung's appendArchive call is wired today (backed by the Turso "
    "decode_archive table, 1-in-200 hit sampling by design). The T20 run recorded 0 archive entries "
    "total, which is the CORRECT designed outcome given only 10 Go-UPC hits occurred (below the "
    "200-hit sampling threshold) - but it means Fetch V2 and GPT raw responses are not currently "
    "captured anywhere for later audit.", body))

story.append(Paragraph("(c) All repo hard-set test pools are now corpus-absorbed", h3))
story.append(Paragraph(
    "Every pre-existing \"known-miss\" hard-set pool in the repo (tmp-atrisk-codes.json, all 10 "
    "tmp-loop*-codes.txt files, tmp-goupc-200-misses.txt, tmp-fetchv2-misses.txt - 74 + 61 codes) was "
    "checked during this session and found 100% absorbed into one of the two local corpora (mostly via "
    "the DT harvest and prior corpus growth). Future live-ladder proofs cannot reuse these lists to "
    "exercise the paid rungs - they need freshly synthesized codes verified absent from both corpora at "
    "run time, as this session's Group B/C did.", body))

story.append(Paragraph("(d) FetchV2 junk-title suggestion class", h3))
story.append(Paragraph(
    "Fetch V2 can surface an irrelevant scraped page title as a low-confidence suggestion (e.g. "
    "\"Ryobi stick vacuum clearance deal found - Facebook\" for a Home Depot bucket code). Never "
    "auto-counted, but it pollutes the Needs Review queue with noise. A repeat of a known 2026-07-08 "
    "issue, not newly introduced. No fix built this session; flagged for a future title-relevance pass.", body))

story.append(Paragraph("(e) Prefix-floor placeholder-name collision on OLD pre-field persisted reviews", h3))
story.append(Paragraph(
    "Found in the final adversarial whole-branch review (Important, low likelihood). After a customer "
    "reload strips identifier fields, the reload-resilient fallback re-identifies a scan's own "
    "placeholder by name. A prefix-floor placeholder name is brand-only, not code-specific (\"&lt;Brand&gt; "
    "/ product unconfirmed\") - if a customer scans two different unresolved codes that share a GS1 "
    "prefix-derived brand, both placeholders get the identical name, and a reload can cause the wrong "
    "one to be matched on resolve. Net total count is preserved (no double-count or lost count), but "
    "attribution can be wrong and a stale row can survive. New records (post the STABLE-ID fix, commit "
    "ba3e187, which added a provisionalProductId field) are immune - id-based matching is tried first, "
    "and the name-fallback only applies to pre-field persisted reviews from before that fix landed. "
    "Recommended fix: scope the name fallback to at most one candidate, or skip it entirely when more "
    "than one counted product shares that exact name. Not a merge blocker; should land before multi-code "
    "prefix-floor scans become common.", body))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# SECTION 7: KNOWN LIMITATIONS / DEFERRED FOLLOW-UPS
# ---------------------------------------------------------------------------
story.append(Paragraph("7. Known Limitations / Deferred Follow-ups", h1))
story.append(bullets([
    "<b>Rung 3 (Fetch V2) has no fresh live proof</b> against a genuinely corpus-absent hard set - the phase-2 rung isolation run resolved 20/20 via the corpus short-circuit, not via Fetch V2 itself (0 Fetch V2 settles, 0 Firecrawl credits actually spent in that run). A real live Fetch V2 proof needs a newly synthesized hard set.",
    "<b>evidenceScoring.ts's vendorCodeNoAlias gate</b> only fires for codeType===\"vendor_label\", not numeric_sku/alpha_sku/messy. Currently non-exploitable because it is always ANDed with evidenceGatePassed in the only production call sites (both traced and confirmed) - but it is under-inclusive defense-in-depth. Left unfixed this session as explicitly out of scope for the minimal 1225 fix; flagged as a follow-up.",
    "<b>debug.aiCalled is true whenever the GPT rung merely ran</b>, not only when it actually contributed the winning answer - a pre-existing diagnostic looseness, no behavior impact, noted in both the T8b and final whole-branch reviews.",
    "<b>Turso decode_archive schema divergence and month-row accumulation</b> - accepted in a prior review; the archive is write-only/inert today and does not affect correctness.",
    "<b>No stable provisionalProductId on pre-fix persisted reviews</b> (see Section 6e) - the deferred \"stable provisional product id\" follow-up would close both the identifier-strip fragility and the prefix-floor name collision cleanly for all records if implemented as a backfill/migration.",
    "<b>Session required real repair loops to complete cleanly</b> - the Task 20 full-ladder run took 4 attempts (server-boot timeout, an exhausted daily call-volume test guard, and a mid-run dev-server crash) before producing a clean 60/60 result with 0 skipped rows. None of these touched real provider spend; all are documented in scripts/proof-ladder-report.md and fixed in the committed proof script (scripts/proof-full-ladder.mjs, consecutive-fetch-failure circuit breaker added) for future reruns.",
    "<b>Binding qa:revision gate reached GREEN only after two earlier partial runs</b> - an earlier attempt showed 8/12 QA bots failing (4 real failures traced to shared decode-cache/Turso state polluted by concurrent live proof runs on the same branch, not a regression in the session's own code changes); the final clean run (after the harvest fleet quieted the machine) passed 12/12.",
    "<b>Not pushed, not deployed.</b> All work in this report lives on feat/decode-ladder-goupc, 128 commits ahead of master, unpushed. Merge/PR strategy remains an explicit owner decision (finishing-a-development-branch options pending presentation).",
])
)

story.append(Spacer(1, 14))
story.append(Paragraph(
    "Source artifacts synthesized into this report: scripts/proof-ladder-report.md, "
    "scripts/proof-full-ladder-graded.json, scripts/proof-full-ladder-results.json, "
    ".superpowers/sdd/task-T20GRADE-report.md, .superpowers/sdd/task-1225-report.md, "
    ".superpowers/sdd/task-1225-fix-report.md, .superpowers/sdd/task-FINALREVIEW-report.md, "
    "scripts/dt-harvest/PILOT-2026-07-08.md, .superpowers/sdd/progress.md.", small))

SimpleDocTemplate(
    "reports/ladder-dt-session-2026-07-09.pdf",
    pagesize=letter,
    topMargin=0.7 * inch,
    bottomMargin=0.7 * inch,
).build(story)
print("PDF written: reports/ladder-dt-session-2026-07-09.pdf")
