# Privacy Policy (Draft)

> DRAFT - AI-generated from standard templates 2026-07-29. NOT legal advice. Professional legal review REQUIRED before charging real customers or publishing.

**Product:** Scanbin (working name, trademark clearance pending)
**Effective date:** [DATE] (not yet effective; placeholder only)
**Last updated:** 2026-07-29

## 1. Overview

This Privacy Policy describes how Scanbin ("we," "us," "our") collects, uses, discloses, and protects information when you use the Scanbin inventory scanning application (the "Service"). This policy applies to business customers and their authorized users.

## 2. Information We Collect

| Category | Examples |
|---|---|
| Account information | Account email address, business name, role, login credentials |
| Business inventory data | Product records, SKUs, aliases, product identifications, notes, counts |
| Scan events | Raw scanned codes, timestamps, scan outcomes (known, unknown, suggested, needs review), device identifiers associated with a scan session |
| Device and usage data | Browser/app type, IP address, approximate location derived from IP, pages/features used, error and performance logs |
| Payment information | Billing contact details and subscription status (payment card data is handled by our payment processor, not stored by us; see Sub-Processors) |

We do not intentionally collect sensitive personal data (such as government ID numbers, health data, or precise geolocation) through normal use of the Service. Customers should avoid entering such data into product notes or fields.

## 3. How We Use Information

We use collected information to:

- Provide, operate, and maintain the Service, including scanning, counting, syncing, and inventory management features.
- Resolve unknown product codes through free catalog/cache lookups and AI-assisted lookup where enabled.
- Authenticate accounts and enforce tenant (business) data separation.
- Monitor, secure, and improve the Service, including debugging and abuse prevention.
- Communicate with you about your account, billing, and material changes to the Service.
- Comply with legal obligations.

We do not use Customer Data to train general-purpose AI models outside of the specific decode/lookup request being served, except as separately disclosed and consented to.

## 4. Sub-Processors

We use the following categories of sub-processors to operate the Service. This list may be updated as the Service evolves; material changes will be reflected here.

| Sub-processor | Purpose | Data involved | Notes |
|---|---|---|---|
| Vercel | Application hosting and deployment | Request logs, application data in transit | US-based hosting infrastructure |
| Google Firebase | Authentication and database (Firestore) | Account credentials, business inventory data | Primary data store for accounts and tenant data |
| Turso | Catalog and decode cache (libsql) | Product catalog lookups, decode cache entries | Does not store customer-identifying data |
| OpenAI | AI-assisted product decode/lookup | Sanitized technical product fields only (see below) | Provider-stated retention approximately 30 days; used only for unresolved/unknown code enrichment |
| Stripe | Payment processing (when billing is enabled) | Billing contact details, payment transaction data | Stripe handles and stores payment card data directly; we do not store full card numbers |

**Sanitization before AI calls.** Before any data is sent to OpenAI, a deterministic sanitizer removes or masks phone numbers, email addresses, obvious personal names, and cost/price/margin patterns. Only technical product identification fields (such as barcode values, brand, size, and model text) are sent. OpenAI is never sent full customer records, pricing, or contact information as part of the decode process.

## 5. Data Retention

- Account and inventory data is retained for as long as your account is active, plus a reasonable period after termination to allow for data export, dispute resolution, and legal compliance, as further described in the Data Processing Addendum.
- Scan events and decode cache entries may be retained to improve matching accuracy and reduce repeat AI lookups.
- AI provider sub-processors retain the limited sanitized data they receive per their own stated retention windows (approximately 30 days), independent of our systems.
- You may request earlier deletion; see Section 7.

## 6. How We Protect Information

- Business data is scoped and isolated by business identifier (tenant) within our database.
- API keys and provider credentials are stored server-side only and are never exposed to client applications.
- Sensitive fields are masked or stripped before being sent to any third-party AI provider.
- Access to production data is limited to personnel who need it to operate and support the Service.

No system is completely secure; we cannot guarantee absolute security of information transmitted to or from the Service.

## 7. Your Rights and Choices

- **Access and export:** You may export your business inventory data from within the app at any time during an active subscription.
- **Deletion:** You may delete your account and associated data through in-app account settings, or by contacting us. Some information may be retained where required for legal, accounting, or fraud-prevention purposes.
- **Correction:** You may correct inaccurate account or business information directly in the app or by contacting us.
- We do not sell your personal information or business data to third parties, and we do not share it for third-party advertising purposes.

## 8. Cookies and Similar Technologies

The Service uses minimal cookies and local storage, primarily to maintain your login session and to store scan session state locally on your device for offline resilience. We do not use third-party advertising trackers.

## 9. International Users and GDPR Note

The Service is currently designed and operated with a US focus. [PLACEHOLDER: If customers or users in the European Economic Area, United Kingdom, or other jurisdictions with comprehensive data protection law (e.g., GDPR) are or will be served, this section requires expansion to address legal basis for processing, international transfer mechanisms, and EU/UK representative requirements. Professional review required before serving such users.]

## 10. Children's Privacy

The Service is intended for business use by adults and is not directed to children. We do not knowingly collect personal information from children.

## 11. Changes to This Policy

We may update this Privacy Policy from time to time. Material changes will be communicated through the app or by email before they take effect.

## 12. Contact

Questions about this Privacy Policy may be directed to [CONTACT EMAIL].

---

*This document is a draft template. It has not been reviewed by a licensed attorney or privacy professional and must not be relied on as a final, compliant privacy policy until professional review is complete.*
