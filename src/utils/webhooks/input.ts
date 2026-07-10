/**
 * Validation for the webhook-registration CRUD request bodies (Issue #146,
 * specs/146-git-webhook-adapter/). Pure: turns an untrusted parsed JSON value
 * into a normalised create/update value or a 400-worthy error. No D1, no I/O —
 * mirrors the `commit-input.ts` / `ai/pricing.ts` split (pure validation here,
 * D1 persistence + encryption in `store.ts`).
 *
 * Caps mirror the OpenAPI `WebhookEndpointInput` constraints
 * (schemas/components/schemas/WebhookEndpointInput.yaml: repo/project/secret
 * `minLength: 1`, `maxLength: 255`). openapi-typescript does not surface these,
 * so they are enforced here at the write boundary.
 */

import { isSupportedProvider, type Provider } from "./providers";

/** Inclusive UTF-16 length cap shared by repo, project, and secret (OpenAPI maxLength). */
const MAX_FIELD = 255;

export interface CreateEndpointValue {
  provider: Provider;
  repo: string;
  project: string;
  secret: string;
  is_enabled: boolean;
}

export interface UpdateEndpointValue {
  projectProvided: boolean;
  project?: string;
  secretProvided: boolean;
  secret?: string;
  isEnabledProvided: boolean;
  isEnabled?: boolean;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** A required, non-empty, ≤255 string field. */
function checkRequiredField(v: unknown, name: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v !== "string" || v.length === 0) {
    return fail(`${name} is required and must be a non-empty string`);
  }
  if (v.length > MAX_FIELD) {
    return fail(`${name} must be at most ${MAX_FIELD} characters`);
  }
  return { ok: true, value: v };
}

/** Validate a `POST /users/current/webhooks` body → a create value. */
export function validateCreateEndpoint(body: unknown): ValidationResult<CreateEndpointValue> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  if (!isSupportedProvider(r.provider)) {
    return fail("provider is required and must be one of: github, gitlab");
  }
  const repo = checkRequiredField(r.repo, "repo");
  if (!repo.ok) return repo;
  const project = checkRequiredField(r.project, "project");
  if (!project.ok) return project;
  const secret = checkRequiredField(r.secret, "secret");
  if (!secret.ok) return secret;

  let isEnabled = true;
  if (r.is_enabled !== undefined) {
    if (typeof r.is_enabled !== "boolean") return fail("is_enabled must be a boolean");
    isEnabled = r.is_enabled;
  }

  return {
    ok: true,
    value: { provider: r.provider, repo: repo.value, project: project.value, secret: secret.value, is_enabled: isEnabled },
  };
}

/**
 * Validate a `PATCH /users/current/webhooks/{id}` body → an update value.
 * `provider`/`repo` are the immutable natural key: their presence in the body is
 * a 400 (enforced here, not by the schema, matching the /ai/prices precedent —
 * the PATCH body schema does not set `additionalProperties: false`). `project`,
 * `secret`, and `is_enabled` are mutable; an empty patch is a 400.
 */
export function validateUpdateEndpoint(body: unknown): ValidationResult<UpdateEndpointValue> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  if ("provider" in r) return fail("provider is immutable and cannot be updated");
  if ("repo" in r) return fail("repo is immutable and cannot be updated");

  const value: UpdateEndpointValue = {
    projectProvided: false,
    secretProvided: false,
    isEnabledProvided: false,
  };

  if (r.project !== undefined) {
    const project = checkRequiredField(r.project, "project");
    if (!project.ok) return project;
    value.projectProvided = true;
    value.project = project.value;
  }
  if (r.secret !== undefined) {
    const secret = checkRequiredField(r.secret, "secret");
    if (!secret.ok) return secret;
    value.secretProvided = true;
    value.secret = secret.value;
  }
  if (r.is_enabled !== undefined) {
    if (typeof r.is_enabled !== "boolean") return fail("is_enabled must be a boolean");
    value.isEnabledProvided = true;
    value.isEnabled = r.is_enabled;
  }

  if (!value.projectProvided && !value.secretProvided && !value.isEnabledProvided) {
    return fail("Request body must set at least one of: project, secret, is_enabled");
  }
  return { ok: true, value };
}
