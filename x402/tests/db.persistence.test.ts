import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSnapshotRepository } from "../src/db/adapters/fileRepository.js";
import { PostgresJsonRepository } from "../src/db/adapters/postgresRepository.js";
import { RecordingDbClient } from "../src/db/connection.js";
import { createFileCommerceRepositories } from "../src/db/repositories.js";
import { EmergencyPauseController } from "../src/emergency/state.js";

describe("durable repository adapters", () => {
  function tempPath(prefix: string): string {
    const dir = path.join(process.cwd(), ".tmp", `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("critical state survives repository restart with file adapter", async () => {
    const dir = tempPath("dna-x402-db");
    const snapshot = path.join(dir, "state.json");

    const first = createFileCommerceRepositories(snapshot);
    await first.policy_decisions.put("decision-1", { state: "BLOCK" });
    await first.seller_policy_strikes.put("strike-1", { sellerProfileId: "seller-1", count: 3 });
    await first.seller_profiles.put("seller-1", { suspendedAt: "2026-05-15T00:00:00.000Z" });
    await first.denylist_entries.append("deny-1", { subjectType: "LISTING", evidenceRefs: ["e1"] });
    await first.policy_appeals.put("appeal-1", { status: "OPEN" });
    await first.seller_tax_aggregates.put("tax-1", { grossPayments: "1000" });
    await first.webhook_replay_keys.append("webhook-1", { idempotencyKey: "wh-1" });
    await first.agent_spend_usage.put("agent-1:2026-05-15", { spentAtomic: "500" });
    await first.fee_waterfalls.append("fee-waterfall-1", { noDoubleChargeKey: "fee-key-1", quoteId: "quote-1" });
    await first.fee_accruals.append("fee-accrual-1", { receiptId: "receipt-1", amount: "10", recipient: "builder-treasury" });
    await first.receipts.append("receipt-1", { receiptId: "receipt-1" });
    await first.emergency_pause_state.put("global", { quotePaused: true });
    await first.marketplace_listings.put("listing-1", { disabled: true });

    const reopened = createFileCommerceRepositories(snapshot);
    await expect(reopened.policy_decisions.get("decision-1")).resolves.toMatchObject({ payload: { state: "BLOCK" } });
    await expect(reopened.seller_policy_strikes.get("strike-1")).resolves.toMatchObject({ payload: { count: 3 } });
    await expect(reopened.seller_profiles.get("seller-1")).resolves.toMatchObject({ payload: { suspendedAt: "2026-05-15T00:00:00.000Z" } });
    await expect(reopened.denylist_entries.get("deny-1")).resolves.toMatchObject({ payload: { subjectType: "LISTING" } });
    await expect(reopened.policy_appeals.get("appeal-1")).resolves.toMatchObject({ payload: { status: "OPEN" } });
    await expect(reopened.seller_tax_aggregates.get("tax-1")).resolves.toMatchObject({ payload: { grossPayments: "1000" } });
    await expect(reopened.webhook_replay_keys.get("webhook-1")).resolves.toMatchObject({ payload: { idempotencyKey: "wh-1" } });
    await expect(reopened.agent_spend_usage.get("agent-1:2026-05-15")).resolves.toMatchObject({ payload: { spentAtomic: "500" } });
    await expect(reopened.fee_waterfalls.get("fee-waterfall-1")).resolves.toMatchObject({ payload: { noDoubleChargeKey: "fee-key-1" } });
    await expect(reopened.fee_accruals.get("fee-accrual-1")).resolves.toMatchObject({ payload: { amount: "10", recipient: "builder-treasury" } });
    await expect(reopened.receipts.get("receipt-1")).resolves.toMatchObject({ payload: { receiptId: "receipt-1" } });
    await expect(reopened.emergency_pause_state.get("global")).resolves.toMatchObject({ payload: { quotePaused: true } });
    await expect(reopened.marketplace_listings.get("listing-1")).resolves.toMatchObject({ payload: { disabled: true } });
  });

  it("immutable append records cannot be overwritten by file adapter", async () => {
    const dir = tempPath("dna-x402-db");
    const repo = new FileSnapshotRepository(path.join(dir, "state.json"), "receipts");
    await repo.append("receipt-1", { receiptId: "receipt-1" });
    await expect(repo.append("receipt-1", { receiptId: "receipt-1b" })).rejects.toThrow(/immutable record/);
  });

  it("postgres adapter emits parameterized upsert and append statements", async () => {
    const db = new RecordingDbClient();
    const repo = new PostgresJsonRepository(db, "policy_decisions");
    await repo.get("decision-1");
    await repo.list();
    await repo.put("decision-1", { state: "ALLOW" });
    await repo.append("decision-2", { state: "BLOCK" });
    expect(db.statements.map((statement) => statement.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("where id = $1"),
      expect.stringContaining("order by created_at asc"),
      expect.stringContaining("on conflict (id) do update"),
      expect.stringContaining("returning id, version, payload"),
    ]));
    expect(db.statements.every((statement) => !statement.sql.includes("decision-1"))).toBe(true);
  });

  it("emergency pause controller survives repository restart", async () => {
    const dir = tempPath("dna-x402-db");
    const snapshot = path.join(dir, "state.json");
    const firstRepos = createFileCommerceRepositories(snapshot);
    const first = new EmergencyPauseController(
      firstRepos.emergency_pause_state as any,
      firstRepos.listing_state_events as any,
      () => new Date("2026-05-15T00:00:00.000Z"),
    );
    await first.setFlag({
      flag: "quotePaused",
      enabled: true,
      reason: "incident drill",
      actorId: "sls_0x",
    });

    const reopenedRepos = createFileCommerceRepositories(snapshot);
    const reopened = new EmergencyPauseController(
      reopenedRepos.emergency_pause_state as any,
      reopenedRepos.listing_state_events as any,
      () => new Date("2026-05-15T00:01:00.000Z"),
    );
    await reopened.load();

    expect(reopened.snapshot()).toMatchObject({
      quotePaused: true,
      reason: "incident drill",
      actorId: "sls_0x",
    });
  });
});
