import { generateApiKey } from "./crypto";

export async function rotateApiKey(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  const user = await db.prepare("SELECT api_key_hash FROM users WHERE id = ?")
    .bind(userId)
    .first<{ api_key_hash: string }>();

  if (!user) return null;

  const { plaintext, hash } = await generateApiKey();

  await kv.delete(`apikey:${user.api_key_hash}`);

  await db.prepare("UPDATE users SET api_key_hash = ?, modified_at = datetime('now') WHERE id = ?")
    .bind(hash, userId)
    .run();

  return plaintext;
}
