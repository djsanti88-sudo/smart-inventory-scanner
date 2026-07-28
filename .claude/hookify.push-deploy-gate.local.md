---
name: warn-push-deploy-gate
enabled: true
event: bash
pattern: git\s+push|vercel\s+(deploy|--prod|promote)|firebase\s+deploy
---

**Owner gate.** Push, deploy, and production promotion are ALWAYS owner-gated in this project (hard rule). Only proceed if the owner explicitly approved THIS push/deploy in THIS conversation. Approval for a previous one does not carry over.
