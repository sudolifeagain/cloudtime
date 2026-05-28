/**
 * Validation for the `PUT /custom_rules` payload (specs/101-custom-rules-crud/).
 *
 * Pure: turns an untrusted parsed JSON value into a normalised list of rows
 * ready to persist, or a 400-worthy error. `change` rules require a
 * destination; `hide` rules ignore it (stored as empty strings).
 */
import {
  RULE_ACTIONS,
  RULE_FIELDS,
  RULE_OPERATIONS,
  type RuleAction,
  type RuleField,
  type RuleOperation,
} from "./custom-rules";

export const MAX_RULES = 50;

export interface ValidatedRule {
  action: RuleAction;
  source: RuleField;
  operation: RuleOperation;
  source_value: string;
  destination: RuleField | "";
  destination_value: string;
  priority: number;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ACTIONS = new Set<string>(RULE_ACTIONS);
const FIELDS = new Set<string>(RULE_FIELDS);
const OPERATIONS = new Set<string>(RULE_OPERATIONS);

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Validate a full-replace rule array. Returns the normalised rows (priority
 * defaulted to array index when omitted) or a 400 error message.
 */
export function validateCustomRules(body: unknown): ValidationResult<ValidatedRule[]> {
  if (!Array.isArray(body)) {
    return fail("Request body must be an array of rules");
  }
  if (body.length > MAX_RULES) {
    return fail(`At most ${MAX_RULES} rules are allowed`);
  }

  const out: ValidatedRule[] = [];
  for (let i = 0; i < body.length; i++) {
    const raw = body[i];
    const at = `rule[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fail(`${at} must be an object`);
    }
    const r = raw as Record<string, unknown>;

    if (!ACTIONS.has(r.action as string)) {
      return fail(`${at}.action must be one of ${RULE_ACTIONS.join(", ")}`);
    }
    if (!FIELDS.has(r.source as string)) {
      return fail(`${at}.source must be one of ${RULE_FIELDS.join(", ")}`);
    }
    if (!OPERATIONS.has(r.operation as string)) {
      return fail(`${at}.operation must be one of ${RULE_OPERATIONS.join(", ")}`);
    }
    if (typeof r.source_value !== "string" || r.source_value.length === 0) {
      return fail(`${at}.source_value must be a non-empty string`);
    }

    const action = r.action as RuleAction;
    let destination: RuleField | "" = "";
    let destinationValue = "";
    if (action === "change") {
      if (!FIELDS.has(r.destination as string)) {
        return fail(`${at}.destination must be one of ${RULE_FIELDS.join(", ")} for a change rule`);
      }
      if (typeof r.destination_value !== "string" || r.destination_value.length === 0) {
        return fail(`${at}.destination_value must be a non-empty string for a change rule`);
      }
      destination = r.destination as RuleField;
      destinationValue = r.destination_value;
    }

    let priority = i;
    if (r.priority !== undefined) {
      if (typeof r.priority !== "number" || !Number.isInteger(r.priority)) {
        return fail(`${at}.priority must be an integer`);
      }
      priority = r.priority;
    }

    out.push({
      action,
      source: r.source as RuleField,
      operation: r.operation as RuleOperation,
      source_value: r.source_value,
      destination,
      destination_value: destinationValue,
      priority,
    });
  }

  return { ok: true, value: out };
}
