import { createPostgresClientFromEnv } from "../../src/db/connection.js";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";

const db = createPostgresClientFromEnv();
try {
  const repos = createPostgresCommerceRepositories(db);
  await repos.seller_profiles.put("seller-sandbox", { sellerProfileId: "seller-sandbox", status: "ACTIVE" });
  await repos.marketplace_listings.put("listing-sandbox", { listingId: "listing-sandbox", status: "ACTIVE" });
  await repos.listing_manifest_versions.append("listing-sandbox:v1", { listingId: "listing-sandbox", version: 1, manifestHash: "sandbox-manifest" });
  await repos.policy_decisions.append("decision-sandbox", { decisionId: "decision-sandbox", state: "ALLOW" });
  await repos.receipts.append("receipt-sandbox", { receiptId: "receipt-sandbox", receiptHash: "receipt-hash-sandbox" });
  await repos.emergency_pause_state.put("global", { quotePaused: false, finalizePaused: false });
  console.log(JSON.stringify({ ok: true, seeded: true }, null, 2));
} finally {
  await db.close?.();
}
