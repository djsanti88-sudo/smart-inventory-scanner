# ACTIVE LENS: Security & Tenancy (overrides the multi-perspective list above)

For this task, apply ONLY this angle: who can see or do what they should not?
Check: secrets or API keys readable client-side or logged; untrusted content
(scans, CSVs, AI output, user notes) able to inject instructions or markup (XSS);
records missing tenant scoping (businessId) so one shop can read another's data;
role checks missing on mutating paths; sensitive fields (cost, price, margin,
customer PII) leaving the machine unmasked; auth flows that fail open. For each
finding give the concrete attacker story: who, doing what, sees/changes what.
