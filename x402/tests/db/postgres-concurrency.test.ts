import { describe, expect, it } from "vitest";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";
import { createLivePostgres, postgresAvailable, resetAndMigrateLivePostgres, withLivePostgresTestLock } from "./postgres-test-helpers.js";

async function settle<T>(tasks: Array<Promise<T>>) {
  return Promise.allSettled(tasks);
}

describe.skipIf(!postgresAvailable)("live Postgres concurrency gates", () => {
  it("deduplicates receipts and webhook replay keys under concurrent inserts", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      try {
        await resetAndMigrateLivePostgres(db);
        const repos = createPostgresCommerceRepositories(db);

        const receiptWrites = await settle(Array.from({ length: 50 }, (_, index) => repos.receipts.append(`receipt-race-${index}`, {
          receiptId: `receipt-race-${index}`,
          receiptHash: "same-receipt-hash",
        })));
        expect(receiptWrites.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect((await repos.receipts.list()).filter((row) => (row.payload as any).receiptHash === "same-receipt-hash")).toHaveLength(1);

        const webhookWrites = await settle(Array.from({ length: 50 }, (_, index) => repos.webhook_replay_keys.append(`webhook-race-${index}`, {
          idempotencyKey: "same-webhook-key",
        })));
        expect(webhookWrites.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect((await repos.webhook_replay_keys.list()).filter((row) => (row.payload as any).idempotencyKey === "same-webhook-key")).toHaveLength(1);
      } finally {
        await db.close();
      }
    });
  }, 60_000);

  it("keeps agent daily spend under limit with transactional updates", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      try {
        await resetAndMigrateLivePostgres(db);
        const max = 100;
        const amount = 3;
        const attempts = await settle(Array.from({ length: 50 }, async () => db.transaction!(async (tx) => {
          const result = await tx.query<{ payload: { spentAtomic: string } }>(
            `insert into agent_spend_usage (id, version, payload, created_at)
             values ('agent-1:2026-05-15', 1, jsonb_build_object('spentAtomic', $1::text), now())
             on conflict (id) do update
             set payload = jsonb_build_object(
               'spentAtomic',
               (((agent_spend_usage.payload->>'spentAtomic')::integer + $1::integer)::text)
             ),
             version = agent_spend_usage.version + 1
             where ((agent_spend_usage.payload->>'spentAtomic')::integer + $1::integer) <= $2::integer
             returning payload`,
            [amount, max],
          );
          if (result.rows.length === 0) {
            throw new Error("daily spend limit exceeded");
          }
          return result.rows[0].payload;
        })));

        const accepted = attempts.filter((item) => item.status === "fulfilled").length;
        const rejected = attempts.filter((item) => item.status === "rejected").length;
        expect(accepted).toBeGreaterThan(0);
        expect(rejected).toBeGreaterThan(0);
        const row = await db.query<{ spent: number }>("select (payload->>'spentAtomic')::integer as spent from agent_spend_usage where id = 'agent-1:2026-05-15'");
        expect(row.rows[0].spent).toBeLessThanOrEqual(max);
      } finally {
        await db.close();
      }
    });
  }, 60_000);

  it("serializes emergency pause, strikes, denylist entries, and manifest versions", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      try {
        await resetAndMigrateLivePostgres(db);
        const repos = createPostgresCommerceRepositories(db);

        await Promise.all(Array.from({ length: 10 }, (_, index) => repos.emergency_pause_state.put("global", {
          quotePaused: true,
          actorId: `operator-${index}`,
        })));
        expect((await repos.emergency_pause_state.get("global"))?.payload).toMatchObject({ quotePaused: true });

        await Promise.all(Array.from({ length: 25 }, () => db.transaction!(async (tx) => {
          await tx.query(
            `insert into seller_policy_strikes (id, version, payload, created_at)
             values ('seller-1:strikes', 1, jsonb_build_object('count', '1'), now())
             on conflict (id) do update
             set payload = jsonb_build_object('count', (((seller_policy_strikes.payload->>'count')::integer + 1)::text)),
                 version = seller_policy_strikes.version + 1`,
          );
        })));
        const strike = await repos.seller_policy_strikes.get("seller-1:strikes");
        expect(Number((strike?.payload as any).count)).toBe(25);

        const denylist = await settle(Array.from({ length: 10 }, (_, index) => repos.denylist_entries.append(`deny-${index}`, {
          subjectType: "LISTING",
          subjectValue: "same-listing",
          status: "ACTIVE",
          evidenceRefs: [`ticket-${index}`],
        })));
        expect(denylist.filter((item) => item.status === "fulfilled")).toHaveLength(1);

        async function appendVersion(): Promise<number> {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
              return await db.transaction!(async (tx) => {
                const next = await tx.query<{ version: number }>(
                  `select coalesce(max((payload->>'version')::integer), 0) + 1 as version
                   from listing_manifest_versions
                   where payload->>'listingId' = 'listing-race'`,
                );
                const version = next.rows[0].version;
                await tx.query(
                  `insert into listing_manifest_versions (id, version, payload, created_at)
                   values ($1, 1, jsonb_build_object('listingId', 'listing-race', 'version', $2::text), now())`,
                  [`listing-race:v${version}`, version],
                );
                return version;
              });
            } catch {
              // Unique index lost a race; retry with the new max version.
            }
          }
          throw new Error("manifest version append failed after retries");
        }

        const versions = await Promise.all(Array.from({ length: 10 }, () => appendVersion()));
        expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      } finally {
        await db.close();
      }
    });
  }, 60_000);
});
