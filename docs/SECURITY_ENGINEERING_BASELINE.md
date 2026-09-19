# Mizan Security & Engineering Baseline

## Engineering authority
This branch is the controlled engineering branch for Mizan field-readiness work:
- Repository: `n36192655-cloud/aquaflow-manager`
- Branch: `feat/mizan-field-readiness-2026-09-11`
- Production/main branches are not modified by this work.

## Multidisciplinary engineering team
The working team is organized as role-based review gates:
1. **Project owner / product authority** — protects Mizan's operational goals, data ownership, tenant isolation, and field usability.
2. **Project manager / release manager** — controls scope, sequencing, rollback readiness, and release evidence.
3. **Security architect / application security engineer** — threat modeling, OWASP ASVS, OWASP Top 10, secure headers, secrets, authentication, authorization, abuse controls.
4. **Database/security engineer** — PostgreSQL privilege model, RLS, SECURITY DEFINER functions, constraints, indexes, auditability, tenant isolation and migration safety.
5. **Backend engineer** — server functions, Supabase integration, transactional behavior, validation, idempotency and error handling.
6. **Frontend/field engineer** — field workflows, offline/low-connectivity behavior, safe input handling, upload constraints and usability.
7. **QA/reliability engineer** — regression, negative testing, authorization tests, deployment verification and failure-path testing.
8. **DevSecOps/release engineer** — dependency/supply-chain controls, environment separation, deployment verification and operational monitoring.

9. **Water-services domain expert** — validates meter-reading semantics, meter technologies (mechanical/dial/multicolor), consumption calculations, field procedures, water-loss signals, and operational correctness in Yemeni water-service contexts.
10. **Sustainable-development expert** — aligns operational and analytical features with water-service continuity, resource efficiency, financial sustainability, service equity, and measurable sustainability indicators; prevents dashboards from presenting unsupported sustainability claims.
11. **Governance / internal-controls expert** — reviews segregation of duties, approval workflows, accountability, audit evidence, data ownership, policy enforcement, exception handling, and governance controls across tenants and central administration.

## Security baseline
Mizan development follows:
- OWASP ASVS 5.0.0 as the application verification baseline.
- OWASP Top 10:2025 as the application-risk baseline.
- NIST CSF 2.0 for risk governance and continuous improvement.
- Least privilege at database and application layers.
- RLS as a tenant-isolation boundary; server-only secret keys are never shipped to browser code.
- No plaintext passwords, access tokens, recovery tokens, or secret keys in source, database business tables, logs, or client responses.
- Authentication and abuse controls must be server-enforced where appropriate.
- Sensitive dynamic HTML/JSON responses must not be publicly cached.
- Security-sensitive mutations must be validated and authorized server-side.
- Storage objects containing field evidence must remain private and use short-lived signed URLs.

## Current hardening implemented on this branch
- HTTP security response headers and no-store handling for dynamic HTML/JSON.
- Modern Supabase secret-key server client path.
- Removal of unsafe browser table privileges through a migration.
- Meter-reading image validation, 5 MiB client-side size ceiling, MIME allow-list, and correct file extension preservation.
- Private meter-reading storage with tenant/user scoped storage policies.
- Existing authentication reauthentication, database-backed rate limiting, tenant-role uniqueness and server-side tenant provisioning remain part of the baseline.

## Quality gate
No change is considered complete merely because it compiles. A release must have:
1. source review,
2. authorization/tenant-isolation review,
3. database/migration review,
4. negative-path review,
5. deployment/build verification,
6. runtime error review,
7. rollback path.

## Important assurance boundary
“100% efficiency/security” is treated as a target, not a claim of mathematical perfection. The engineering objective is evidence-backed continuous hardening with no unverified assumptions.
