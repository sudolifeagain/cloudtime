# Compatibility Research

This document records high-level feature categories from the public
coding-activity analytics ecosystem and maps them to CloudTime's own product
direction. It is not a feature-parity checklist, price comparison, or legal
opinion.

CloudTime implements original product behavior on top of its own OpenAPI schema,
database model, UI, and documentation. Compatibility work is limited to
documented wire-protocol behavior needed by WakaTime-compatible editor clients.

## Source Boundaries

Allowed research inputs:

- Public API documentation needed for interoperability.
- Public product pages used only to identify broad feature categories.
- Public web standards, platform documentation, and protocol RFCs.
- CloudTime's own OpenAPI schema, issues, specs, tests, and database schema.
- Behavior observed from CloudTime itself or from user-owned test data.

Disallowed research inputs:

- Third-party service source code for product features CloudTime is rebuilding.
- Third-party private documentation, internal docs, paid-only implementation
  details, screenshots, visual assets, copy, layout, or brand materials.
- Any material that would make CloudTime UI, docs, card images, or branding look
  like another product.

## Individual Feature Categories

These are individual-user features worth covering before team functionality.
They are described as CloudTime product capabilities, not as copies of any
specific paid plan.

| Area | CloudTime status | Recommended direction |
|---|---|---|
| Long-range personal history | Mostly covered by retained D1 data and summaries | Improve dashboard range controls and cached long-range summaries |
| Goals | Implemented | Surface goal progress in the dashboard, reports, and profile cards |
| Public profile cards | Implemented | Add small badges, composite cards, and richer theme/query options |
| Data export | Implemented with R2-backed dumps | Add dashboard controls and clearer export lifecycle states |
| Commit stats | Implemented for stored commit records | Strengthen GitHub commit and pull-request association |
| Personal insights | Partially implemented | Add trend, focus, switching, and goal adherence insights |
| Daily and weekly reports | Not implemented | Generate owner-only email reports from CloudTime summaries |
| Invoice export | Not implemented | Add billable project settings, hourly rates, and exportable invoice artifacts |
| External duration import | API implemented | Add provider import jobs for calendars after the manual API is stable |
| AI coding analytics | Partially modeled by categories/fields | Define CloudTime-specific AI source, agent, and review metrics |

## Personal-First Roadmap

1. Profile card and badge expansion.
2. Daily and weekly personal reports.
3. Invoice export for billable project work.
4. Commit and pull-request analytics.
5. Deeper personal insights.
6. Calendar import and other external-duration connectors.
7. AI coding analytics.

Team dashboards, private leaderboards, organization access controls, SSO, and
SCIM remain future multi-user work. They should not block the individual-user
feature track.

## Implementation Notes

- New API contracts still start in `schemas/openapi.yaml`.
- Generated types still come from `npm run generate`; never hand-edit
  `src/types/generated.ts`.
- Public sharing features must use non-secret URLs or revocable tokens and must
  never require an API key in a README, website, or client-side script.
- Profile card UI, SVGs, badge styles, text, and documentation must be original
  CloudTime work.
- If a feature needs interoperability with WakaTime-compatible clients, document
  the protocol fact being matched and keep the surrounding product experience
  CloudTime-specific.
