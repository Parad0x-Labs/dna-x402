import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFileCommerceRepositories } from "../../src/db/repositories.js";
import { backupSnapshot } from "./backup.js";
import { restoreSnapshot } from "./restore.js";

async function runBackupRestoreTest(): Promise<void> {
  const dir = path.join(process.cwd(), ".tmp", `dna-x402-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = path.join(dir, "commerce-state.json");
  const backupDir = path.join(dir, "backups");

  const repos = createFileCommerceRepositories(snapshot);
  await repos.seller_profiles.put("seller-1", { sellerProfileId: "seller-1", status: "ACTIVE" });
  await repos.marketplace_listings.put("listing-1", { listingId: "listing-1", disabled: false });
  await repos.policy_decisions.append("decision-1", { decisionId: "decision-1", state: "ALLOW" });
  await repos.receipts.append("receipt-1", { receiptId: "receipt-1", receiptHash: "hash-1" });
  await repos.policy_appeals.put("appeal-1", { appealId: "appeal-1", status: "OPEN" });
  await repos.emergency_pause_state.put("global", { quotePaused: true, reason: "backup drill" });

  const backupPath = backupSnapshot(snapshot, backupDir);
  fs.writeFileSync(snapshot, "{}\n");
  restoreSnapshot(backupPath, snapshot);

  const restored = createFileCommerceRepositories(snapshot);
  assert.equal((await restored.seller_profiles.get("seller-1"))?.payload && true, true);
  assert.equal((await restored.marketplace_listings.get("listing-1"))?.payload && true, true);
  assert.equal((await restored.policy_decisions.get("decision-1"))?.payload && true, true);
  assert.equal((await restored.receipts.get("receipt-1"))?.payload && true, true);
  assert.equal((await restored.policy_appeals.get("appeal-1"))?.payload && true, true);
  assert.equal((await restored.emergency_pause_state.get("global"))?.payload && true, true);

  console.log(JSON.stringify({
    ok: true,
    backupPath,
    restoredTables: [
      "seller_profiles",
      "marketplace_listings",
      "policy_decisions",
      "receipts",
      "policy_appeals",
      "emergency_pause_state",
    ],
  }, null, 2));
}

await runBackupRestoreTest();
