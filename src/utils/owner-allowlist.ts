/**
 * Owner allowlist matching rule (Issue #157, specs/157-owner-allowlist/).
 *
 * Pure so the security-relevant comparison is unit-testable without an
 * OAuth harness. Returns true when the configured allowlist REJECTS the
 * candidate:
 * - an unset or blank (empty / whitespace-only) configuration never rejects
 *   — the gate is inactive and current behavior is preserved;
 * - otherwise trimmed, case-insensitive equality is required, and a missing
 *   provider-verified email counts as a rejection (fail closed).
 */
export function ownerAllowlistRejects(
  allowedRaw: string | undefined,
  providerEmail: string | null,
): boolean {
  const allowed = allowedRaw?.trim().toLowerCase() ?? "";
  if (allowed === "") return false;
  if (!providerEmail) return true;
  return providerEmail.trim().toLowerCase() !== allowed;
}
