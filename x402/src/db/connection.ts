import pg from "pg";

export interface DbQueryResult<T = unknown> {
  rows: T[];
  rowCount?: number | null;
}

export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>>;
  close?(): Promise<void>;
  transaction?<T>(fn: (db: DbClient) => Promise<T>): Promise<T>;
}

export interface DbConnectionConfig {
  connectionString?: string;
  ssl?: boolean;
}

export function assertDbConfigured(config: DbConnectionConfig): void {
  if (!config.connectionString) {
    throw new Error("X402_DATABASE_URL or DATABASE_URL is required for production database mode");
  }
}

export class PostgresDbClient implements DbClient {
  private readonly pool: pg.Pool;

  constructor(config: DbConnectionConfig) {
    assertDbConfigured(config);
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    });
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<DbQueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: DbClient = {
      query: async <R = unknown>(sql: string, params: unknown[] = []) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    };
    try {
      await client.query("begin");
      const result = await fn(tx);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.X402_DATABASE_URL ?? env.DATABASE_URL;
}

export function createPostgresClientFromEnv(env: NodeJS.ProcessEnv = process.env): PostgresDbClient {
  return new PostgresDbClient({
    connectionString: databaseUrlFromEnv(env),
    ssl: env.X402_DATABASE_SSL === "1" || env.DATABASE_SSL === "1",
  });
}

export class RecordingDbClient implements DbClient {
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<DbQueryResult<T>> {
    this.statements.push({ sql, params });
    if (/returning id, version, payload/i.test(sql)) {
      return {
        rows: [{
          id: params[0],
          version: 1,
          payload: typeof params[1] === "string" ? JSON.parse(params[1] as string) : params[1],
          actor_id: params[2],
          created_at: params[3] ?? new Date(),
          updated_at: null,
        } as T],
        rowCount: 1,
      };
    }
    return { rows: [] };
  }
}
