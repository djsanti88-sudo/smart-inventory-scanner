# Data Processing Addendum (Draft, Short-Form Skeleton)

> DRAFT - AI-generated from standard templates 2026-07-29. NOT legal advice. Professional legal review REQUIRED before charging real customers or publishing.

**Product:** Scanbin (working name, trademark clearance pending)
**Effective date:** [DATE] (not yet effective; placeholder only)
**Last updated:** 2026-07-29

## 1. Purpose

This Data Processing Addendum ("DPA") supplements the Scanbin Terms of Service and describes how Scanbin processes personal and business data on behalf of a Customer in connection with the Service. This is a short-form skeleton intended to be expanded and finalized by qualified legal counsel before use in any binding agreement.

## 2. Roles of the Parties

- **Customer** acts as the **data controller** (or "business") with respect to the personal and business data it submits to the Service, including employee/contact data, inventory data, and any personal data embedded in product notes.
- **Scanbin** acts as the **data processor** (or "service provider," depending on applicable law) and processes such data solely on Customer's documented instructions, as set out in this DPA and the Terms of Service.

[PLACEHOLDER: Confirm correct terminology and role allocation under the specific data protection regime that applies (e.g., GDPR controller/processor, CCPA business/service provider) once the target customer jurisdictions are known.]

## 3. Scope and Nature of Processing

- **Subject matter:** Provision of the Scanbin inventory scanning Service.
- **Duration:** For the term of the subscription, plus any post-termination retention period described in Section 7.
- **Nature and purpose of processing:** Scanning, matching, counting, storing, and syncing inventory data; AI-assisted decode/lookup for unresolved product codes; account authentication and tenant isolation.
- **Categories of data:** Account contact information, business inventory records, scan event data, and any personal data Customer chooses to include in product notes or fields.
- **Categories of data subjects:** Customer's authorized users (employees/contractors) and, incidentally, any individuals referenced in Customer-entered notes.

## 4. Sub-Processors

Scanbin uses the sub-processors listed in the Privacy Policy (Section 4), including hosting (Vercel), authentication/database (Google Firebase), catalog cache (Turso), AI decode/lookup (OpenAI), and payment processing (Stripe, when enabled). Scanbin will:

- Maintain the current sub-processor list referenced from the Privacy Policy.
- Provide notice of new sub-processors through the Privacy Policy or direct communication, consistent with the Terms of Service.
- Ensure sub-processors are bound by data protection obligations materially equivalent to those in this DPA.

[PLACEHOLDER: Add a defined objection/notice mechanism and timeline if required by the applicable data protection framework.]

## 5. Security Measures Summary

Scanbin implements the following categories of technical and organizational measures:

- **Tenant isolation:** Business data is scoped and separated by a `businessId` path/identifier within the data store, preventing cross-tenant access in normal operation.
- **Server-side key handling:** API keys and provider credentials are stored and used server-side only; they are never exposed in client-side code or bundles.
- **Data minimization to AI providers:** A deterministic sanitizer masks phone numbers, emails, personal names, and price/cost/margin data before any data is sent to an AI provider; only sanitized technical product fields are transmitted.
- **Access control:** Production data access is limited to personnel with an operational need.

[PLACEHOLDER: Expand with a full technical and organizational measures (TOM) annex, including encryption at rest/in transit specifics, backup and disaster recovery, incident response procedures, and employee confidentiality obligations, once formalized.]

## 6. Breach Notification

In the event Scanbin becomes aware of a confirmed breach involving Customer Data, Scanbin will notify Customer without undue delay after becoming aware, and will provide reasonably available information to help Customer meet its own notification obligations.

[PLACEHOLDER: Define a specific notification timeframe (e.g., "within 72 hours" or another period consistent with applicable law and negotiated terms) and the required content of breach notices once finalized by counsel.]

## 7. Data Return and Deletion on Termination

- Upon termination of the subscription, Customer may export Customer Data as described in the Terms of Service.
- Following termination, Scanbin will delete or anonymize Customer Data within a defined post-termination window, except where retention is required by law or for legitimate business purposes (such as billing records).

[PLACEHOLDER: Define the exact post-termination retention/deletion window (e.g., 30, 60, or 90 days) and any exceptions once decided by the business and reviewed by counsel.]

## 8. Customer Obligations

Customer is responsible for:

- Ensuring it has a lawful basis to submit any personal data (including data about its own employees or customers) into the Service.
- Not entering special categories of sensitive personal data into free-text fields unless specifically agreed in writing.
- Promptly notifying Scanbin of any known unauthorized access originating from Customer's own accounts or credentials.

## 9. Relationship to Other Documents

This DPA should be read together with the Terms of Service and Privacy Policy. In the event of a conflict specific to data processing terms, this DPA controls for the data protection subject matter it covers, subject to final legal review.

---

*This document is an intentionally short skeleton, not a complete DPA. It omits standard contractual clause references, international transfer mechanisms, audit rights detail, and liability allocation specific to data protection claims. It must be completed and reviewed by qualified legal counsel before being offered to customers, especially any customer requiring GDPR-level guarantees.*
