# OpenAPI Contract Diff: Embeddable Stat Cards

**Branch**: `spec/160-embeddable-cards`
**Files**:

- `schemas/openapi.yaml`
- `schemas/paths/cards/public-card.yaml`
- `schemas/paths/cards/embed-settings.yaml`
- `schemas/paths/cards/embed-templates.yaml`
- `schemas/paths/cards/embed-template.yaml`
- `schemas/components/schemas/EmbedSettings.yaml`
- `schemas/components/schemas/EmbedSettingsUpdate.yaml`
- `schemas/components/schemas/EmbedTemplate.yaml`
- `schemas/components/schemas/EmbedTemplateInput.yaml`

Additive only. No existing endpoint, parameter, schema, or response is changed.

## 1. `schemas/openapi.yaml`

- Add tag:

  ```yaml
  - name: embeddable_cards
    description: Public SVG stat cards and authenticated embed configuration
  ```

- Add paths:

  ```yaml
  /users/{username}/cards/{card_type}.svg:
    $ref: paths/cards/public-card.yaml
  /users/current/embed_settings:
    $ref: paths/cards/embed-settings.yaml
  /users/current/embed_templates:
    $ref: paths/cards/embed-templates.yaml
  /users/current/embed_templates/{template_id}:
    $ref: paths/cards/embed-template.yaml
  ```

## 2. Public card image

`GET /users/{username}/cards/{card_type}.svg`

- `security: []`
- Path parameters:
  - `username` string
  - `card_type` enum: `heatmap`, `summary`, `languages`, `streak`
- Query parameters:
  - `range` string (optional)
  - `theme` string (optional)
  - `template_id` string UUID (optional)
  - `v` string cache-busting value (optional)
- Responses:
  - `200 image/svg+xml` string with `Cache-Control` and `ETag` headers
  - `400` BadRequest for malformed options such as an invalid UUID
  - `404` NotFound for disabled embeds, unknown user, unknown card type, or unavailable template
  - `429` TooManyRequests for configured public-card rate limiting

Contract notes:

- The URL contains no API key and accepts no credentials.
- Visibility OFF returns `404` before serving cached SVG.
- `v` changes cache keys only; it does not select data.

## 3. Embed settings

`GET /users/current/embed_settings`

- Authenticated through the global security schemes.
- Response `200`:

  ```yaml
  data:
    $ref: ../../components/schemas/EmbedSettings.yaml
  ```

`PATCH /users/current/embed_settings`

- Request:

  ```yaml
  $ref: ../../components/schemas/EmbedSettingsUpdate.yaml
  ```

- Responses:
  - `200` updated `EmbedSettings`
  - `400` BadRequest
  - `401` Unauthorized

## 4. Embed templates

`GET /users/current/embed_templates`

- Response `200` list of `EmbedTemplate`.

`POST /users/current/embed_templates`

- Request `EmbedTemplateInput`.
- Response `201` created `EmbedTemplate`.
- Validation failures return `400`.

`GET /users/current/embed_templates/{template_id}`

- Response `200` `EmbedTemplate`.
- Missing/cross-user template returns `404`.

`PATCH /users/current/embed_templates/{template_id}`

- Request object with partial `name` and/or `template_svg` fields.
- Response `200` updated `EmbedTemplate`.
- Validation failures return `400`.

`DELETE /users/current/embed_templates/{template_id}`

- Response `204`.
- Missing/cross-user template returns `404`.

## 5. Generated types impact

`src/types/generated.ts` gains:

- `paths["/users/{username}/cards/{card_type}.svg"]`
- `paths["/users/current/embed_settings"]`
- `paths["/users/current/embed_templates"]`
- `paths["/users/current/embed_templates/{template_id}"]`
- `components["schemas"]["EmbedSettings"]`
- `components["schemas"]["EmbedSettingsUpdate"]`
- `components["schemas"]["EmbedTemplate"]`
- `components["schemas"]["EmbedTemplateInput"]`

No existing generated member is removed or renamed.

## 6. GitHub profile card extension (#186)

Additive follow-up to the original spec 160 contract:

- `card_type` enum adds `streak`.
- `streak.svg` uses the same public visibility, cache, ETag, `theme`, `range`,
  `template_id`, and `v` behavior as other card types.
- The card reports CloudTime tracked-activity streaks, not GitHub
  contribution streaks.
