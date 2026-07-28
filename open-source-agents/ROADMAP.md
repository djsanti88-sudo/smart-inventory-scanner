# Local Model Fleet - Roadmap

Owner-approved 2026-07-22. Goal: unlimited quota-free local sub-agents, specialized
via skills/personas, orchestrated by Fable/Opus in long-running loops.

## Round 1 - Foundation (in progress 2026-07-22)
- [x] Verify: codex --oss --local-provider lmstudio native support (codex-cli 0.144.6)
- [x] Verify: LM Studio server API (/v1/chat/completions, JIT loading, port 1234)
- [ ] Download: gpt-oss-20b (12.1GB), Qwen3-Coder-30B, Qwen3-8B (~35GB, background)
- [x] Runner: local-run.py + personas (analyst / coder / chore)
- [x] Agents: local-analyst, local-coder, local-chore (~/.claude/agents/, haiku relays)
- [ ] Proof: one real codex --oss run + one custom-runner analyst run, output captured

## Round 2 - Knowledge base + scoring (QUEUED, owner-ordered)
1. **Baseline score FIRST**: a test set of ~20 project-law questions (scan-count law,
   resolver trust, idempotency, ladder charging, markWrong transfer semantics) +
   ~5 real past defects (from LESSONS_LEARNED / review barrages). Score the raw
   analyst model on it. This is the "before" number.
2. **RAG index**: chunk + embed CLAUDE.md, docs/ARCHITECTURE.md, LESSONS_LEARNED.md,
   DECISIONS.md, docs/PLAN_EXECUTION.md, review reports. Embedding model already
   downloaded: text-embedding-nomic-embed-text-v1.5 (via LM Studio /v1/embeddings).
   Store: simple local vector file (no external service).
3. **Re-score** the analyst with retrieval attached. Before/after delta = the teach
   proof. Owner sees the score, then we "teach it all it needs to know".
4. Iterate retrieval (chunking, k, reranking) only if the delta is weak.

## Round 3 - Fleet loops (FUTURE, after round 2 proof)
- Long-running loops: Fable/Opus orchestrator dispatches local agents on grind
  queues (triage backlogs, doc sweeps, review passes) until a goal completes.
- Wire local-analyst as a standing extra voice in review barrages.
- Big-plan fallback ladder: Codex quota dead -> codex --oss local -> Sonnet.

## Owner decisions (2026-07-22, round 1)
- Lens mode: orchestrator picks 2-3 fitting lenses per task (not full barrage).
- Process-critic fires: (a) end of every substantive work round on the
  orchestrator's own execution, and (b) during bug hunts / broad tasks needing
  multiple viewpoints.
- Efficiency defaults: context 16384, TTL 1800s auto-unload, reasoning effort
  per role (analyst=high, coder=medium, chore=low), serial dispatch only.
- Lenses built: skeptic, data-integrity, security-tenancy, simplicity-scope,
  failure-modes, process-critic (personas/lenses/, one angle per call).
- Stress test queued: real daily task = review the live feat/teach-bot diff
  (scratchpad/stress-diff.patch) + ground-truth case = pre-fix deleteProduct
  count-loss region (scratchpad/stress-groundtruth-prefix.ts, from a142eb1~1);
  score hits vs false positives against known truth.

## Hard rules
- Local models NEVER touch the production decode ladder (no evidence source =
  hallucinated identities; violates resolver trust rules).
- Local output is a SUGGESTION; the orchestrator verifies before anything lands.
- All of this is $0 and offline; no data leaves the machine.
