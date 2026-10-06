import crypto from "node:crypto";
import type { DbClient } from "../db/connection.js";

export interface ReplayKeyInput {
  shopId: string;
  txSig: string;
  amountAtomic: string;
  recipient: string;
  mint: string;
}

export function createReplayKey(input: ReplayKeyInput): string {
  return crypto
    .createHash("sha256")
    .update(`${input.shopId}|${input.txSig}|${input.amountAtomic}|${input.recipient}|${input.mint}`)
    .digest("hex");
}

const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A replay-key store that outlives the process. `claim` must be atomic across
 * every process that shares the store: exactly one caller may claim a key until
 * it expires.
 */
export interface DurableReplayBackend {
  /** Short name reported by status endpoints and startup logs, e.g. "postgres". */
  readonly kind: string;
  /** Record `key` until `expiresAtMs`. Returns false when an unexpired record already exists. */
  claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  /** True when an unexpired record exists for `key`. */
  has(key: string, nowMs: number): Promise<boolean>;
  close?(): Promise<void>;
}

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Postgres-backed replay keys. Uses the x402 database layer (`DbClient`) and
 * creates its own table on first use, so it works with or without
 * `npm run db:migrate`. The insert is a single statement with a primary-key
 * conflict check, so concurrent claims from several server instances admit
 * exactly one.
 */
export class PostgresReplayBackend implements DurableReplayBackend {
  readonly kind = "postgres";
  private ready?: Promise<void>;

  constructor(
    private readonly db: DbClient,
    private readonly table = "x402_payment_replay_keys",
  ) {
    if (!TABLE_NAME_RE.test(table)) {
      throw new Error(`PostgresReplayBackend: invalid table name ${JSON.stringify(table)}`);
    }
  }

  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = this.db
        .query(
          `create table if not exists ${this.table} (
             replay_key text primary key,
             expires_at timestamptz not null,
             claimed_at timestamptz not null
           )`,
        )
        .then(
          () => undefined,
          (error: unknown) => {
            // Two processes creating the table at the same moment can race on the
            // catalog; the loser sees a duplicate error and the table exists.
            const code = (error as { code?: string }).code;
            if (code === "23505" || code === "42P07") {
              return undefined;
            }
            this.ready = undefined;
            throw error;
          },
        );
    }
    return this.ready;
  }

  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.db.query<{ replay_key: string }>(
      `insert into ${this.table} (replay_key, expires_at, claimed_at)
       values ($1, to_timestamp($2::double precision / 1000), to_timestamp($3::double precision / 1000))
       on conflict (replay_key) do update
         set expires_at = excluded.expires_at,
             claimed_at = excluded.claimed_at
         where ${this.table}.expires_at <= excluded.claimed_at
       returning replay_key`,
      [key, expiresAtMs, nowMs],
    );
    return result.rows.length === 1;
  }

  async has(key: string, nowMs: number): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.db.query<{ hit: number }>(
      `select 1 as hit from ${this.table}
       where replay_key = $1 and expires_at > to_timestamp($2::double precision / 1000)
       limit 1`,
      [key, nowMs],
    );
    return result.rows.length > 0;
  }

  async close(): Promise<void> {
    await this.db.close?.();
  }
}

export interface ReplayStoreOptions {
  ttlMs?: number;
  /** Durable store. Without one, replay keys live in this process only. */
  backend?: DurableReplayBackend;
  /** Environment used for the production check (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export const IN_MEMORY_REPLAY_WARNING =
  "WARNING: x402 ReplayStore is in-memory. A payment proof can be replayed after a restart or against another instance. Set X402_DATABASE_URL or DATABASE_URL to persist replay keys in Postgres.";

/**
 * Replay protection for payment proofs.
 *
 * With a durable backend (Postgres when X402_DATABASE_URL or DATABASE_URL is
 * set on the server), every claim is written to the database before the
 * request is served, so a proof used once is refused after a restart and by
 * other instances that share the database. Without a backend the keys live in
 * an in-process Map; production mode refuses to start that way.
 */
export class ReplayStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  readonly backend?: DurableReplayBackend;

  constructor(options: number | ReplayStoreOptions = {}) {
    const opts: ReplayStoreOptions = typeof options === "number" ? { ttlMs: options } : options;
    this.ttlMs = opts.ttlMs ?? DEFAULT_REPLAY_TTL_MS;
    this.backend = opts.backend;
    const env = opts.env ?? process.env;
    if (!this.backend) {
      if (env.NODE_ENV === "production") {
        throw new Error(
          "ReplayStore: durable replay protection is required in production. Set X402_DATABASE_URL or DATABASE_URL so replay keys are stored in Postgres. An in-memory store accepts the same payment proof again after a restart.",
        );
      }
      console.warn(IN_MEMORY_REPLAY_WARNING);
    }
  }

  /** "memory" or the backend kind, e.g. "postgres". */
  get kind(): string {
    return this.backend?.kind ?? "memory";
  }

  get durable(): boolean {
    return Boolean(this.backend);
  }

  /**
   * Claim `key`. Resolves true for the first use and false for a replay. With a
   * durable backend the claim is recorded there before this resolves.
   */
  async claim(key: string, nowMs = Date.now()): Promise<boolean> {
    this.cleanup(nowMs);
    if (this.seen.has(key)) {
      return false;
    }
    if (!this.backend) {
      // Check and set happen before any await, so concurrent requests in this
      // process cannot both claim the same key.
      this.seen.set(key, nowMs + this.ttlMs);
      return true;
    }
    const claimed = await this.backend.claim(key, nowMs + this.ttlMs, nowMs);
    // Either way the key is now used; cache it so repeats skip the database.
    this.seen.set(key, nowMs + this.ttlMs);
    return claimed;
  }

  /** True when `key` has been claimed and has not expired. */
  async isClaimed(key: string, nowMs = Date.now()): Promise<boolean> {
    this.cleanup(nowMs);
    if (this.seen.has(key)) {
      return true;
    }
    if (!this.backend) {
      return false;
    }
    return this.backend.has(key, nowMs);
  }

  /**
   * Synchronous in-memory claim. Refused when a durable backend is configured,
   * because it would bypass the database; use `claim` instead.
   */
  consume(key: string, nowMs = Date.now()): boolean {
    this.assertMemoryOnly("consume");
    this.cleanup(nowMs);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }

  /** Synchronous in-memory lookup. Refused with a durable backend; use `isClaimed`. */
  has(key: string, nowMs = Date.now()): boolean {
    this.assertMemoryOnly("has");
    this.cleanup(nowMs);
    return this.seen.has(key);
  }

  /** Keys held in this process (the local cache when a durable backend is configured). */
  size(nowMs = Date.now()): number {
    this.cleanup(nowMs);
    return this.seen.size;
  }

  async close(): Promise<void> {
    await this.backend?.close?.();
  }

  private assertMemoryOnly(method: string): void {
    if (this.backend) {
      throw new Error(`ReplayStore.${method} is in-memory only; use the async ${method === "has" ? "isClaimed" : "claim"} with a ${this.backend.kind} backend`);
    }
  }

  private cleanup(nowMs: number): void {
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= nowMs) {
        this.seen.delete(key);
      }
    }
  }
}
