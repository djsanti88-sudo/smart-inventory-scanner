---
name: block-vercel-prod-gate
enabled: true
event: bash
pattern: vercel\s+(deploy\s+.*--prod\b|deploy\s+.*--prebuilt\s+.*--prod\b|--prod\b|promote\b|rollback\b|alias\s+set\b)
action: block
---

**BLOCKED: production deploy/promote is owner-gated.** This command matches a production-flipping
Vercel pattern (`vercel --prod`, `vercel deploy --prod`, `vercel promote`, `vercel rollback`, or
`vercel alias set` pointing a domain at a deployment) - the exact class of action that flipped
production without approval before (owner order, 2026-07-22: "we need to make sure that doesn't
happen again").

Per this project's No-Deploy Rule (`CLAUDE.md`) and the global Engineering Doctrine, production
deploy/promote/rollback/alias changes always require the owner's EXPLICIT approval in THIS
conversation - approval from a prior session or a different command does not carry over.

**Do not run this command.** Stop and ask the owner to explicitly approve this exact production
action before proceeding. Plain preview commands (`vercel deploy` with no `--prod`, `vercel ls`,
`vercel inspect`, `vercel env ls`, `vercel logs`) are NOT affected by this rule and remain allowed
for local verification.
