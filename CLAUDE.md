# CLAUDE.md

@AGENTS.md
@GUARDRAILS.md

`AGENTS.md` is the project guide for every agent, including Claude Code. Global rules:
`~/.claude/CLAUDE.md`. Owner instructions override everything.

Claude Code specifics for the workflow in `AGENTS.md`: step 1 (trace) uses
`feature-dev:feature-dev` (`code-explorer` / `code-architect`); step 6 (simplify) uses
`code-simplifier:code-simplifier` on the changed code only; heavy multi-file orchestration only via
the `big-plan` skill, opt-in.
