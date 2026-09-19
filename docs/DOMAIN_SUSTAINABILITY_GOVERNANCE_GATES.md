# Mizan Domain, Sustainability & Governance Quality Gates

This document adds water-service, sustainable-development, and governance review gates to the multidisciplinary Mizan engineering team.

## 1. Water-service domain gate

A water-service workflow is accepted only when its behavior is traceable to the underlying field reality and meter specification.

Required checks:
- Meter type is represented explicitly when reading semantics differ.
- Integer and fractional display zones are not treated as equivalent digits when the meter specification says otherwise.
- Mechanical/dial/multicolor meter readings must preserve the documented reading interpretation.
- A reading must belong to the authenticated tenant and the intended meter/subscriber relationship.
- Previous-reading comparisons must reject impossible regressions unless an explicit rollover/replacement workflow exists.
- OCR is evidence, not authority: OCR output must not silently override a field reading.
- Photos and OCR metadata must not be trusted for authorization.
- Offline retries must be idempotent; reconnecting must not create duplicate financial or consumption events.
- Field evidence must remain private and use short-lived access URLs.

## 2. Sustainable-development gate

Mizan must distinguish measured facts from derived indicators and from interpretations.

Required checks:
- Water-consumption indicators use recorded readings and documented calculation rules.
- Financial indicators distinguish billed amounts from cash actually collected.
- Loss/water-efficiency indicators identify their source data and calculation window.
- Dashboards must not manufacture missing data to make an indicator appear complete.
- Sustainability claims must be traceable to measurable data, assumptions, and time period.
- Tenant dashboards must never mix data from another tenant.

## 3. Governance and internal-controls gate

Critical mutations must preserve accountability and separation of duties.

Required checks:
- Authentication, authorization, tenant isolation, and role mapping are enforced server-side/database-side.
- A collector cannot approve their own payment where the workflow requires independent approval.
- Reading approval/rejection and payment approval/rejection are explicit state transitions.
- Administrative provisioning requires a privileged actor and an active project tenant.
- Audit records must identify actor, target, tenant, action, and timestamp where the schema supports it.
- Duplicate role assignment for a project is prevented by database constraints, not only UI logic.
- Browser-controlled device fingerprints, local storage, and UI state are never authorization boundaries.
- Exceptional paths fail closed and do not expose secrets or internal stack details.

## 4. Evidence gate

For every production-bound change:
1. source review on the controlled branch,
2. database/RLS/privilege review,
3. negative-path and tenant-isolation review,
4. build/deployment verification,
5. runtime error verification,
6. rollback reference,
7. documentation of any unresolved evidence gap.

No claim of perfect security, efficiency, or availability is made without evidence. The target is continuous, measurable hardening with zero intentional reliance on guesses.
