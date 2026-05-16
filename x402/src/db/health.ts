import { DbClient } from "./connection.js";

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function checkDbHealth(db: DbClient): Promise<DbHealth> {
  const started = Date.now();
  try {
    await db.query("select 1 as ok");
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
