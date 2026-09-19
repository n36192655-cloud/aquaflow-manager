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


## 5. Household consumption and tariff gate

- Household size is a required production input for domestic-customer tariff and per-capita indicators.
- WHO service-level references are used as health/service benchmarks, not represented as a legal maximum or a WHO-mandated price.
- The production billing formula is database-owned; browser calculations are explanatory only.
- Tariff tiers are progressive and normalized by litres/person/day so household size changes the consumption threshold rather than unfairly applying the same household volume threshold to every family.
- A bill is rejected when the project has no active tariff instead of silently issuing a zero-value or guessed bill.
- Tariff configuration changes are tenant-scoped and manager-authorized.
- Consumption classification must distinguish low use from successful conservation: low consumption can indicate unreliable access or a reading problem and therefore requires verification.
- A household example of 10 people consuming 10 m³ in a 30-day month is 33.3 L/person/day; it is inside the 20–50 L/person/day reference band and must not be mislabeled as excessive use.
- Dashboard monthly indicators use approved/verified data only and retain unavailable states when required source data is missing.

## 6. Sustainability dashboard gate

The project dashboard should expose, with a consistent monthly window:
- system input / approved production,
- approved customer consumption,
- water-use efficiency,
- NRW by volume and percentage,
- collection rate based on approved payments,
- operational reading approval rate,
- represented population and average litres/person/day,
- workflow backlog (pending/rejected),
- data-quality warnings,
- month-over-month trend for water and financial indicators.

NRW follows the water-balance concept: system input less authorized consumption, with the distinction between apparent and real losses documented separately when the required source data exists. The dashboard must not label the entire difference as physical leakage when apparent/unbilled components have not been measured.
