import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileBackedDnaGuardLedger, loadDnaGuardSnapshot } from "../src/guard/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("DNA Guard storage", () => {
  it("persists ledger state to disk and restores it on restart", () => {
    const dir = makeTempDir("dna-guard-store-");
    const snapshotPath = path.join(dir, "guard.json");

    const first = createFileBackedDnaGuardLedger({ snapshotPath });
    first.commitSpend({ buyerId: "buyer-1" }, "70", new Date("2026-03-11T10:00:00.000Z"));
    first.recordDelivery({
      providerId: "provider-a",
      endpointId: "inference",
      latencyMs: 320,
      statusCode: 200,
      receiptId: "receipt-1",
      qualityAccepted: true,
    });
    first.recordReceiptVerification({
      providerId: "provider-a",
      endpointId: "inference",
      receiptId: "receipt-1",
      valid: true,
    }, new Date("2026-03-11T10:00:01.000Z"));

    const snapshot = loadDnaGuardSnapshot(snapshotPath);
    expect(snapshot?.providerStats).toHaveLength(2);
    expect(snapshot?.receiptStatuses).toHaveLength(1);

    const restored = createFileBackedDnaGuardLedger({
      snapshotPath,
      now: () => new Date("2026-03-11T10:00:10.000Z"),
    });

    expect(restored.spendSnapshot({ buyerId: "buyer-1" })).toEqual({ buyer: "70" });
    expect(restored.providerSnapshot("provider-a").totals.fulfilled).toBe(1);
    expect(restored.receiptStatus("receipt-1")).toMatchObject({
      verification: { valid: true },
    });
  });

  it("drops expired spend samples when loading a snapshot", () => {
    const dir = makeTempDir("dna-guard-store-expired-");
    const snapshotPath = path.join(dir, "guard.json");

    const ledger = createFileBackedDnaGuardLedger({
      snapshotPath,
      windowMs: 1_000,
    });
    ledger.commitSpend({ buyerId: "buyer-1" }, "50", new Date("2026-03-11T10:00:00.000Z"));

    const restored = createFileBackedDnaGuardLedger({
      snapshotPath,
      windowMs: 1_000,
      now: () => new Date("2026-03-11T10:00:05.000Z"),
    });

    expect(restored.spendSnapshot({ buyerId: "buyer-1" })).toEqual({ buyer: "0" });
  });
});
