import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";
import { validateCustomRules } from "../utils/custom-rule-input";
import { invalidateRules } from "../utils/custom-rules";

type CustomRule = components["schemas"]["CustomRule"];

interface CustomRuleRow {
  id: string;
  action: string;
  source: string;
  operation: string;
  source_value: string;
  destination: string;
  destination_value: string;
  priority: number;
  created_at: string;
}

const SELECT_COLUMNS =
  "id, action, source, operation, source_value, destination, destination_value, priority, created_at";

function rowToCustomRule(row: CustomRuleRow): CustomRule {
  return {
    id: row.id,
    action: row.action as CustomRule["action"],
    source: row.source as CustomRule["source"],
    operation: row.operation as CustomRule["operation"],
    source_value: row.source_value,
    destination: row.destination as CustomRule["destination"],
    destination_value: row.destination_value,
    priority: row.priority,
    created_at: normalizeDateTime(row.created_at),
  };
}

async function listRules(db: D1Database, userId: string): Promise<CustomRule[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM custom_rules
        WHERE user_id = ? ORDER BY priority ASC, created_at ASC`,
    )
    .bind(userId)
    .all<CustomRuleRow>();
  return results.map(rowToCustomRule);
}

const customRules = new Hono<AuthEnv>();

customRules.use("/custom_rules", authMiddleware);
customRules.use("/custom_rules/*", authMiddleware);

customRules.get("/custom_rules", async (c) => {
  const userId = c.get("userId");
  try {
    return c.json({ data: await listRules(c.env.DB, userId) });
  } catch (err) {
    console.error("GET /custom_rules error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

customRules.put("/custom_rules", async (c) => {
  const userId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateCustomRules(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  try {
    // Atomic full-replace: clear the user's rules, then insert the new set.
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare("DELETE FROM custom_rules WHERE user_id = ?").bind(userId),
    ];
    for (const r of parsed.value) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO custom_rules
             (id, user_id, action, source, operation, source_value,
              destination, destination_value, priority, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).bind(
          crypto.randomUUID(),
          userId,
          r.action,
          r.source,
          r.operation,
          r.source_value,
          r.destination,
          r.destination_value,
          r.priority,
        ),
      );
    }
    await c.env.DB.batch(stmts);
    await invalidateRules(c.env, userId);

    return c.json({ data: await listRules(c.env.DB, userId) });
  } catch (err) {
    console.error("PUT /custom_rules error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

customRules.delete("/custom_rules/:rule_id", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("rule_id");

  try {
    const res = await c.env.DB.prepare(
      "DELETE FROM custom_rules WHERE id = ? AND user_id = ?",
    )
      .bind(ruleId, userId)
      .run();

    if (res.meta.changes === 0) {
      return c.json({ error: "Not found" }, 404);
    }
    await invalidateRules(c.env, userId);
    return c.body(null, 204);
  } catch (err) {
    console.error("DELETE /custom_rules/:rule_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default customRules;
