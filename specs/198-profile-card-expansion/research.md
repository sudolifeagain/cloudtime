# Research: Profile Badge and Composite Card Expansion

**Research Date**: 2026-07-05
**Feature**: Profile badge and composite card expansion

## Sources Consulted

- GitHub Docs - Basic writing and formatting syntax:
  `https://docs.github.com/github/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax`
- GitHub Docs - Managing your profile README:
  `https://docs.github.com/en/account-and-profile/how-tos/profile-customization/managing-your-profile-readme`
- W3C WAI - Informative Images:
  `https://www.w3.org/WAI/tutorials/images/informative/`
- W3C WAI - Alt Decision Tree:
  `https://www.w3.org/WAI/tutorials/images/decision-tree/`
- MDN - ARIA `img` role:
  `https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/img_role`
- MDN - `aria-label`:
  `https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-label`
- MDN - Cache-Control:
  `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control`
- MDN - ETag:
  `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag`
- Cloudflare Workers Docs - Cache:
  `https://developers.cloudflare.com/workers/runtime-apis/cache/`
- Cloudflare Cache Docs - ETag headers:
  `https://developers.cloudflare.com/cache/reference/etag-headers/`

No third-party product source code, visual assets, screenshots, or product copy
were consulted.

## Decision 1: Use standard Markdown image snippets

**Decision**: Dashboard snippets should continue to use standard Markdown image
syntax: `![alt text](public image URL)`.

**Rationale**: GitHub Docs document Markdown image syntax and require alt text
as the short text equivalent of the image. Profile READMEs are normal README
files rendered by GitHub. The current CloudTime snippet approach already matches
this shape.

**Alternatives considered**:

- HTML `<img>` snippets with width attributes. Rejected for PR1 because it is
  less portable across Markdown surfaces and unnecessary for fixed-size SVGs.

## Decision 2: Badges get a new route

**Decision**: Add `GET /users/{username}/badges/{badge_type}.svg` for small
one-metric badges.

**Rationale**: Badges differ from cards in dimensions, layout, metric focus, and
query options. A separate route keeps the existing card route clear and avoids
overloading `card_type` with visually different assets.

**Alternatives considered**:

- Add badges as more `card_type` values. Rejected because badge-specific options
  such as `label` and `style` would clutter the card contract.

## Decision 3: Composite profile card extends existing cards

**Decision**: Add `profile` to the existing `card_type` enum.

**Rationale**: The profile composite is still a card-sized image, shares
existing card visibility/cache/template behavior, and belongs with the existing
README card snippets.

**Alternatives considered**:

- Create `/profile.svg`. Rejected because it would duplicate card visibility
  and cache rules without adding a useful distinction.

## Decision 4: Keep metric selection constrained

**Decision**: `profile.svg` accepts a comma-separated `metrics` query with a
small enum and max item count. Unknown or duplicate metrics return `400`.

**Rationale**: GitHub image URLs are easiest to copy when options remain compact.
An enum keeps the route typeable and protects PR2 from arbitrary dynamic layout
work.

**Alternatives considered**:

- Free-form JSON config in the query string. Rejected due to URL length,
  readability, cache-key complexity, and validation surface.

## Decision 5: Reuse existing public embed visibility

**Decision**: Badges and the `profile` card reuse existing `embed_settings`.

**Rationale**: The privacy model should remain one switch: public images are
either enabled or disabled for the user. Adding a second switch would create
ambiguous states and more UI work without improving privacy.

**Alternatives considered**:

- Separate badge visibility. Deferred until users need independent controls.

## Decision 6: Preserve explicit cache headers and ETags

**Decision**: Badges and profile cards must include `Cache-Control` and `ETag`
headers, and `v` remains a cache-key-only busting parameter.

**Rationale**: MDN documents `Cache-Control` as the response mechanism for cache
directives and `ETag` as an entity version identifier useful for efficient
revalidation. Cloudflare's docs note cache behavior and ETag support in the
platform. Existing cards already expose this behavior.

**Alternatives considered**:

- No-cache dynamic images. Rejected because profile README traffic can become
  repetitive and should not force D1 reads per view.

## Decision 7: Accessible SVG names are part of the contract

**Decision**: Generated SVGs must include `role="img"` and a non-empty
accessible name, and snippets must use meaningful alt text.

**Rationale**: W3C WAI guidance for informative images says text alternatives
should convey the displayed meaning. MDN documents the ARIA `img` role and
`aria-label` as ways to give grouped visual content an accessible name.

**Alternatives considered**:

- Rely only on visible SVG text. Rejected because the image may be consumed as a
  single remote image in Markdown, and the accessible name should be explicit.

## Decision 8: Keep PR1 implementation-free

**Decision**: PR1 includes only SpecKit artifacts, OpenAPI changes, and
generated types.

**Rationale**: The project uses the two-PR SpecKit workflow. The implementation
will be easier to review after the badge/profile contract is agreed.

## Open Questions

- Should PR2 expose a `goal_id` picker in the settings UI immediately, or start
  with deterministic first-goal behavior and document the optional URL
  parameter?
- Should `all_time` badge values include external durations, heartbeat coding
  time only, or both with labels? PR1 leaves the label as CloudTime coding time;
  PR2 should align with existing all-time stats semantics.
