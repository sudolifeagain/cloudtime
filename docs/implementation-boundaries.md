# Implementation Boundaries

CloudTime is an independent project. This document defines engineering
boundaries for third-party compatibility and public-facing feature work. It is
development policy, not legal advice.

## Goals

- Keep CloudTime usable with WakaTime-compatible editor clients where documented
  wire-protocol compatibility matters.
- Build CloudTime's product experience, UI, SVG cards, reports, and docs as
  original work.
- Make public-repository contributions easy to review for brand, source, and
  implementation hygiene.

## Naming And Branding

- Use `CloudTime` for product names, UI labels, generated images, emails,
  reports, docs headings, and examples.
- Use `WakaTime-compatible` only in documentation when describing editor-client
  interoperability.
- Do not use third-party names in code identifiers, file names, route names,
  branch names, card labels, report titles, or branding.
- Do not use third-party logos, screenshots, artwork, colors, visual layouts, or
  marketing copy.
- Do not imply endorsement, sponsorship, affiliation, or replacement of another
  service.

## Clean Implementation Rules

Allowed:

- Implementing CloudTime features from CloudTime issues, specs, schema, tests,
  and user stories.
- Reading public protocol documentation when a WakaTime-compatible client needs
  a specific request or response shape.
- Using public standards and official platform documentation, such as HTTP,
  OAuth, OpenAPI, Cloudflare Workers, GitHub, SVG, and accessibility docs.
- Observing CloudTime's own behavior and user-owned test data.

Not allowed:

- Reading or referencing third-party service source code to rebuild product
  features.
- Copying documentation text, UI text, SVG/card designs, page layouts, email
  templates, screenshots, logos, or visual assets from another service.
- Recreating paid-plan boundaries as product positioning. CloudTime features
  should be described by user value, not as a plan-by-plan replica.
- Publishing API keys, session tokens, OAuth tokens, or secret query parameters
  in public embed snippets.

## Documentation Rules

- Public docs should explain CloudTime behavior from CloudTime's own schema and
  implementation.
- Compatibility notes should be narrow and factual: describe the protocol
  behavior needed by editor clients, then link back to CloudTime's contract.
- Do not quote long third-party passages. Paraphrase only the small protocol or
  feature fact needed for implementation decisions.
- Keep feature research neutral. Prefer `compatibility`, `interoperability`, or
  `personal analytics` terminology over named competitor comparisons.

## Feature Design Rules

- Start every API behavior change in `schemas/openapi.yaml`.
- Keep visual surfaces CloudTime-specific: cards, dashboards, reports, and
  badges should use original layouts and copy.
- Prefer individual-user value first: personal reports, profile cards, exports,
  invoices, commit analytics, and insights.
- Defer team dashboards, private leaderboards, organization controls, SSO, and
  SCIM until the multi-user design is ready.
- Public embeds must be opt-in, revocable where practical, cache-aware, and
  safe to paste into GitHub profile READMEs.

## Review Checklist

Before merging a feature inspired by the coding-activity analytics ecosystem,
reviewers should confirm:

- The feature is specified in CloudTime terms.
- No third-party source code, assets, screenshots, or copy were used.
- Third-party names appear only as `WakaTime-compatible` documentation wording
  where interoperability requires it.
- Public URLs do not expose secrets.
- Tests cover the CloudTime behavior being introduced.
