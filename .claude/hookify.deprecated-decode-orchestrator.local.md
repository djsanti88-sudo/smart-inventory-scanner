---
name: warn-deprecated-decode-orchestrator
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: services[\\/]+ai[\\/]+decodeOrchestrator
---

**Deprecated file.** `services/ai/decodeOrchestrator.ts` is DEPRECATED (types only). The REAL decode orchestrator is `src/server/decode/pipeline.ts` (`runDecodePipeline`), fronted by `app/api/ai-lookup/route.ts`. Do not add logic here; put decode changes in the pipeline.
