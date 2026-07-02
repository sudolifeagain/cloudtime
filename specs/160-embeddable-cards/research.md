# Research: Embeddable Stat Cards

**Branch**: `spec/160-embeddable-cards` | **Date**: 2026-06-18

Sources consulted (2026-06-18):

- GitHub Docs: Basic writing and formatting syntax - image embeds in Markdown
  (`docs.github.com/.../basic-writing-and-formatting-syntax`)
- GitHub Docs: About anonymized URLs - remote image cache behavior and Camo
  cache purge guidance
- GitHub Docs: Working with non-code files - GitHub image/SVG display support
- Cloudflare Docs: Workers Cache API - cache headers respected by `cache.put`
  and per-data-center cache behavior
- Cloudflare Docs: Origin Cache Control - `Cache-Control` directives define
  cache lifetime for intermediaries
- MDN: SVG as an image - image-context restrictions and direct-view caveat
- OpenAPI Specification 3.1 - media type content and binary/text response
  description

Additional sources consulted (2026-07-03) for the GitHub profile README card
extension:

- GitHub Docs: Managing your profile README - profile README repository
  requirements
- GitHub Docs: Basic writing and formatting syntax - Markdown image syntax
- GitHub Docs: About anonymized URLs - Camo proxy behavior, content type
  checks, `Cache-Control` guidance, and rare cache purge fallback
- Cloudflare Docs: Workers Cache API - cacheable response headers and
  conditional request behavior
- Cloudflare Docs: ETag headers - `304 Not Modified` validation behavior
- MDN: SVG `<script>` and `SVGScriptElement.href` - active SVG scripting and
  external script risk
- W3C SVG Security - scripts and external-resource references in SVG

## D-1: Public URL shape and authentication

**Decision**: Use
`GET /api/v1/users/{username}/cards/{card_type}.svg` with `security: []`.
`username` is a non-secret stable identifier; `card_type` is one of
`heatmap`, `summary`, or `languages`. Optional query parameters select
`range`, `theme`, `template_id`, and `v` cache-busting.

**Why**: GitHub Markdown supports online image URLs, and a README image cannot
send CloudTime API keys or session cookies. A username path keeps the URL stable
for single-user mode while preserving the future multi-user route shape. The
`.svg` suffix makes the image media type obvious to GitHub, browsers, and
humans inspecting the embed.

**Alternatives considered**: `/cards/{type}.svg` without a user identifier was
rejected because it bakes in single-user addressing and would need a breaking
URL later. `api_key` query parameters were rejected because FR-009 forbids
secrets in embed URLs and README pages are public.

**2026-07-03 update**: Add `streak` as a fourth built-in card type. The public
URL shape remains unchanged:
`GET /api/v1/users/{username}/cards/streak.svg`. The card is intended for
GitHub profile READMEs, but remains a generic public image URL usable anywhere
remote images are displayed.

## D-2: Visibility default and disabled behavior

**Decision**: Per-user embed visibility defaults to OFF. When OFF, the public
card endpoint returns `404 Not Found` before cache lookup, rate-limit budget,
or any data read.

**Why**: Public cards expose personal coding aggregates without authentication.
The existing public-stats opt-out design (#156) already uses `404` to avoid
confirming that a private endpoint exists. Reusing that privacy posture avoids
a new observable and prevents stale cached SVGs from leaking after a user turns
embeds OFF.

**Alternatives considered**: `403 Forbidden` was rejected because it confirms a
guarded resource exists. Returning a neutral SVG was rejected because a stale
or incorrectly cached image response would still be a data-shaped response and
would make OFF less auditable.

## D-3: Freshness and cache strategy

**Decision**: Card responses carry explicit `Cache-Control` derived from the
per-user freshness window (default 15 minutes) and an `ETag`. The Worker also
uses KV for rendered SVG cache entries keyed by normalized user/card/options
plus the optional `v` parameter. Changing `v` forces a new cache key but does
not affect authorization, visibility, or stats.

**Why**: GitHub documents that remote images may be served through an
anonymizing image proxy and that stale images should be diagnosed by checking
`Cache-Control`; Cloudflare documents that cache behavior is controlled by
response cache directives. A freshness window is therefore the right server
contract, while `v` gives users a practical escape hatch when an intermediate
proxy holds onto an older URL.

**Alternatives considered**: `Cache-Control: no-store` was rejected for normal
ON responses because popular README views would trigger D1/render work on every
view. Permanent immutable caching was rejected because it contradicts the core
"always-current" value. Purging Camo was rejected for routine operation because
GitHub documents purge as a sparing fallback, not a refresh mechanism.

## D-4: Current-day overlay

**Decision**: Renderers read existing `summaries`/`hourly_summaries` for the
requested range and compute only the current local day on demand from bounded
raw heartbeat data since the local day start (and the previous heartbeat needed
for timeout continuity). The rendered result is cached for the freshness
window.

**Why**: The cron aggregator is incremental and may not have processed today's
latest heartbeats yet, but the card must include today's activity. Recomputing
an entire range from raw heartbeats would violate the Workers CPU budget; a
current-day overlay keeps the miss path bounded and makes cache hits cheap.

**Alternatives considered**: Waiting for Cron was rejected because it violates
FR-002. Updating summaries inside a card request was rejected because public
GET image requests must be read-only and high-volume-safe.

## D-5: SVG template safety

**Decision**: User templates are accepted only as a safe static SVG subset.
Reject scripts, event-handler attributes, `foreignObject`, external
`href`/`xlink:href` references, remote fonts, data URLs, processing
instructions, and unknown placeholder tokens. Validate on write and revalidate
before render.

**Why**: MDN documents that SVGs used as images have restrictions, but those
restrictions do not apply when the same SVG is viewed directly or embedded as a
document. GitHub also notes limitations around SVG scripting/animation. The
server cannot rely on client or proxy sanitization; it must reject active
content itself.

**Alternatives considered**: Stripping unsafe nodes was rejected for PR2 because
it can silently change user art and is easier to get wrong. Rejecting with a
clear validation error is simpler and safer.

## D-6: OpenAPI representation for SVG images

**Decision**: Document SVG card responses under `content:
image/svg+xml` with a string schema. Authenticated settings and template
management use ordinary JSON schemas.

**Why**: OpenAPI 3.1 models responses by media type. SVG is XML text, so a
string schema under `image/svg+xml` describes the response without pretending it
is JSON. Generated TypeScript clients will still see the non-JSON content type
distinctly.

**Alternatives considered**: `application/json` wrappers were rejected because
README embeds need an actual image response. PNG output was rejected for first
version because SVG is lighter and easier to generate at the edge.

## D-7: Trademark and originality boundary

**Decision**: The user-facing docs may say "WakaTime-compatible" where needed,
but code identifiers, file names, card branding, and OpenAPI paths use only
CloudTime terms. No WakaTime source, visual assets, logos, or documentation
copy are used.

**Why**: This follows the repository's legal/trademark rule and keeps the
implementation original while still explaining compatibility context in docs.

## D-8: CloudTime streak semantics

**Decision**: A tracked day is a user-local calendar day with at least one
second of computed coding duration after applying the user's timeout rules.
`current_streak` counts consecutive tracked days ending today, or ending
yesterday when today has no tracked duration yet. `longest_streak` is the
maximum consecutive tracked-day run in the requested range.

**Why**: GitHub profile users recognize streak cards, but CloudTime should not
conflate GitHub contribution data with coding-time data. Counting days from
CloudTime durations keeps the metric explainable, reproducible, and derived
from data the system already owns. Allowing the current streak to end yesterday
avoids showing zero every morning before the user has started coding.

**Alternatives considered**: Using GitHub contribution events was rejected
because CloudTime does not ingest that data and the card should represent
CloudTime activity. Counting raw heartbeats was rejected because summaries and
duration builders already apply timeout rules and timezone bucketing.

## D-9: GitHub profile README UX

**Decision**: The authenticated dashboard should generate copyable Markdown
snippets for each available public card and render a preview using the same
public URL. Snippets use ordinary Markdown image syntax and never include API
keys or session tokens. A cache-busting `v` value may be offered as a manual
refresh helper, but the UI must describe it as a URL-change mechanism rather
than a guaranteed immediate GitHub Camo purge.

**Why**: GitHub supports online image embeds in Markdown and profile README
display depends on a public repository named after the GitHub username. Users
should not need to construct card URLs by hand, and the UI should make the
public-visibility state obvious before a snippet is copied.

**Alternatives considered**: Auto-editing a user's GitHub README was rejected
because it would require a new GitHub authorization flow and introduces
unnecessary write risk. A GitHub App is not needed for the first version.
