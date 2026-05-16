import { describe, expect, it } from "vitest";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";
import { MODULAR_COMMERCE_TABLES } from "../../src/db/schema/tables.js";
import { createLivePostgres, migrateLivePostgres, postgresAvailable, resetAndMigrateLivePostgres, withLivePostgresTestLock } from "./postgres-test-helpers.js";

describe.skipIf(!postgresAvailable)("live Postgres migrations and repositories", () => {
  it("runs migrations, verifies schema, and round-trips repository records", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      let dbClosed = false;
      try {
        await resetAndMigrateLivePostgres(db);

        const tables = await db.query<{ table_name: string }>(
          "select table_name from information_schema.tables where table_schema = 'public'",
        );
        const tableNames = new Set(tables.rows.map((row) => row.table_name));
        for (const table of MODULAR_COMMERCE_TABLES) {
          expect(tableNames.has(table)).toBe(true);
        }

        const indexes = await db.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public'");
        const indexNames = new Set(indexes.rows.map((row) => row.indexname));
        expect(indexNames.has("receipts_payload_receipt_hash_unique")).toBe(true);
        expect(indexNames.has("webhook_replay_keys_payload_key_unique")).toBe(true);
        expect(indexNames.has("denylist_entries_active_subject_unique")).toBe(true);
        expect(indexNames.has("listing_manifest_versions_listing_version_unique")).toBe(true);
        expect(indexNames.has("fee_accruals_payload_receipt_idx")).toBe(true);
        expect(indexNames.has("fee_accruals_payload_recipient_idx")).toBe(true);
        expect(indexNames.has("agent_wallets_payload_agent_idx")).toBe(true);
        expect(indexNames.has("agent_wallets_payload_owner_wallet_idx")).toBe(true);
        expect(indexNames.has("copy_settings_payload_source_idx")).toBe(true);
        expect(indexNames.has("copy_settings_payload_follower_idx")).toBe(true);
        expect(indexNames.has("copied_lots_payload_status_idx")).toBe(true);
        expect(indexNames.has("alpha_fee_accruals_payload_lot_idx")).toBe(true);
        expect(indexNames.has("agent_action_ledgers_payload_lot_idx")).toBe(true);

        const constraints = await db.query<{ table_name: string; constraint_type: string }>(
          "select table_name, constraint_type from information_schema.table_constraints where table_schema = 'public'",
        );
        for (const table of MODULAR_COMMERCE_TABLES) {
          expect(constraints.rows.some((row) => row.table_name === table && row.constraint_type === "PRIMARY KEY")).toBe(true);
        }

        const repos = createPostgresCommerceRepositories(db);
        const written = await repos.policy_decisions.put("decision-live", { state: "ALLOW", nested: { ok: true } }, { actorId: "sls_0x" });
        expect(written.version).toBe(1);
        expect(written.createdAt).toBeTruthy();
        const read = await repos.policy_decisions.get("decision-live");
        expect(read?.payload).toMatchObject({ state: "ALLOW", nested: { ok: true } });
        const updated = await repos.policy_decisions.put("decision-live", { state: "BLOCK" });
        expect(updated.version).toBe(2);
        expect(updated.updatedAt).toBeTruthy();
        await repos.fee_waterfalls.append("builder-waterfall-live", {
          noDoubleChargeKey: "builder-fee-key-live",
          quoteId: "quote-builder-live",
          feeWaterfallHash: "builder-waterfall-live",
        });
        await repos.fee_accruals.append("builder-accrual-live", {
          receiptId: "receipt-builder-live",
          quoteId: "quote-builder-live",
          feeKind: "BUILDER_FEE",
          amount: "50",
          recipient: "builder-treasury-live",
          status: "ACCRUED_NOT_COLLECTED",
        });
        await db.close();
        dbClosed = true;
        const reopened = createLivePostgres();
        try {
          const reopenedRepos = createPostgresCommerceRepositories(reopened);
          await expect(reopenedRepos.fee_accruals.get("builder-accrual-live")).resolves.toMatchObject({
            payload: {
              feeKind: "BUILDER_FEE",
              amount: "50",
              recipient: "builder-treasury-live",
            },
          });
        } finally {
          await reopened.close();
        }

        const rerunDb = createLivePostgres();
        const secondRun = await migrateLivePostgres(rerunDb);
        await rerunDb.close();
        expect(secondRun).toEqual([]);
      } finally {
        if (!dbClosed) {
          await db.close();
        }
      }
    });
  }, 60_000);
});
