/**
 * Write-input length caps (Issue #158, specs/158-input-maxlength/).
 *
 * Single source of truth for the values declared as maxLength/maxItems in
 * the OpenAPI schemas (schemas/components/schemas/HeartbeatInput.yaml,
 * CommitInput.yaml, ExternalDurationInput.yaml, CustomRuleInput.yaml).
 * openapi-typescript does not surface these constraints in generated types,
 * so the four validators import from here and a pinning unit test
 * (tests/security/input-limits.test.ts) holds spec<->validator parity
 * (FR-007, research R-6). Caps are inclusive and count UTF-16 code units.
 */
export const INPUT_LIMITS = {
  // HeartbeatInput / ExternalDurationInput shared dimensions
  entity: 4096, // Linux PATH_MAX; also covers url/domain entities
  name: 255, // project, branch, language, editor, operating_system, machine
  userAgent: 512,
  dependenciesString: 8192, // comma-separated form, pre-split
  dependenciesItems: 100,
  dependencyName: 255,
  // CommitInput
  commitHash: 64, // SHA-256 hex width
  commitMessage: 4096,
  email: 254, // RFC 5321 maximum address length
  url: 2048,
  // ExternalDurationInput
  externalId: 255,
  meta: 8192,
  // CustomRuleInput
  ruleValue: 1024, // entity-prefix rules may carry long path prefixes
} as const;

/** Inclusive cap check: true when the value exceeds the cap. */
export function tooLong(value: string, cap: number): boolean {
  return value.length > cap;
}

/** Truncate an ambient (header-derived) value to its cap (research R-5). */
export function truncateTo(value: string, cap: number): string {
  return value.length > cap ? value.slice(0, cap) : value;
}
