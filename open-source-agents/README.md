# Open-Source Agents (local model fleet)

Quota-free local sub-agents running on Ollama (RTX 5060 8GB + 32GB RAM).
$0 per call, fully offline, nothing leaves the machine. Owner-approved 2026-07-22;
migrated LM Studio -> Ollama 2026-07-25 (lighter CLI runtime; llama.cpp was ruled
out - Smart App Control blocks its unsigned binaries, and SAC stays ON).

## Layout
- `local-run.py` - the runner. Auto-starts `ollama serve`, loads the right model
  with efficiency caps (8k/16k context per role, 30-min keep_alive auto-unload),
  applies the role persona + optional lens/doctrine/RAG layers, calls the native
  `/api/chat` on :11434, prints the answer. Default role is `chore` (small model
  first; the 20B analyst loads only when explicitly requested).
- `rag-index.py` - builds/queries the project-law knowledge index via
  `nomic-embed-text` (`/api/embed`). Run it once before any `--rag` round.
- HEAVY CLOUD ROUTE: for big analysis with zero local load, dispatch the
  `agy:runner` agent (gpt-oss-120b, open-source, hosted on the Antigravity
  subscription) instead of the local analyst.
- `personas/` - role system prompts: `analyst` (gpt-oss-20b, reasoning critic),
  `coder` (Qwen3-Coder-30B, diffs only), `chore` (Qwen3-8B, fast triage).
- `personas/lenses/` - single-angle overlays for perspective diversity: skeptic,
  data-integrity, security-tenancy, simplicity-scope, failure-modes, and
  process-critic (reviews the AI orchestrator's own execution).
- `ROADMAP.md` - rounds, owner decisions, queued RAG + scoring work.

## Usage
```bash
python open-source-agents/local-run.py --role analyst --lens skeptic \
  --context src/foo.ts "Review this change for real defects"
```
Claude Code dispatch: the `local-analyst`, `local-coder`, `local-chore` agents
(defined in `~/.claude/agents/`, thin relays) point at this folder. The second
wiring is `codex exec --oss --local-provider lmstudio` (same models, Codex harness).

## Rules
- Local output is a SUGGESTION; the orchestrator verifies before anything lands.
- Never wire local models into the production decode ladder (no evidence source).
- One model resident at a time; serial dispatch (8GB VRAM is shared).
