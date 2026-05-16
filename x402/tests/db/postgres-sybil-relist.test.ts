import { describe, expect, it } from "vitest";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";
import { evaluateSellerRelistRisk, SellerPolicyStrikeRecord, SellerRiskProfile } from "../../src/identity/sybil.js";
import { createLivePostgres, postgresAvailable, resetAndMigrateLivePostgres, withLivePostgresTestLock } from "./postgres-test-helpers.js";

describe.skipIf(!postgresAvailable)("live Postgres persistent Sybil relist proof", () => {
  it("does not let seller risk reset through slug change, linked wallet, and relist after restart", async () => {
    await withLivePostgresTestLock(async () => {
      const db = createLivePostgres();
      try {
        await resetAndMigrateLivePostgres(db);
        let repos = createPostgresCommerceRepositories(db);

        await repos.seller_profiles.put("seller-profile-1", {
          sellerProfileId: "seller-profile-1",
          primaryWallet: "wallet-alpha",
          linkedWallets: ["wallet-alpha"],
          slugs: ["sharp-api"],
          domains: ["sharp.example"],
          receiptGraphIds: ["receipt-graph-alpha"],
          disputeCount: 0,
          refundCount: 0,
          governanceActionIds: ["gov-strike-1"],
        });
        await repos.seller_policy_strikes.put("seller-profile-1:strikes", {
          sellerProfileId: "seller-profile-1",
          count: 1,
          reasonCodes: ["FAILED_FULFILLMENT"],
        });

        await db.close();
        const reopened = createLivePostgres();
        repos = createPostgresCommerceRepositories(reopened);
        try {
          const profileRecord = await repos.seller_profiles.get("seller-profile-1");
          const strikeRecord = await repos.seller_policy_strikes.get("seller-profile-1:strikes");
          expect(profileRecord).toBeTruthy();
          expect(strikeRecord).toBeTruthy();

          await repos.marketplace_listings.put("listing-relist", {
            listingId: "listing-relist",
            sellerProfileId: "seller-profile-1",
            slug: "sharp-api-v2",
            wallet: "wallet-beta",
            capabilityTags: ["data_feed"],
          });

          const risk = evaluateSellerRelistRisk({
            profiles: [profileRecord!.payload as SellerRiskProfile],
            strikes: [strikeRecord!.payload as SellerPolicyStrikeRecord],
            candidate: {
              wallet: "wallet-beta",
              linkedWallets: ["wallet-beta", "wallet-alpha"],
              slug: "sharp-api-v2",
              domain: "sharp.example",
              receiptGraphIds: ["receipt-graph-alpha"],
            },
          });

          expect(risk.sellerProfileId).toBe("seller-profile-1");
          expect(risk.matchedSignals).toEqual(expect.arrayContaining(["linked_wallet", "domain", "receipt_graph"]));
          expect(risk.policyStrikes).toBe(1);
          expect(risk.clusteredRisk).toBe(true);
          expect(risk.cleanTrustAllowed).toBe(false);
        } finally {
          await reopened.close();
        }
      } catch (error) {
        try {
          await db.close();
        } catch {
          // Ignore secondary cleanup failure.
        }
        throw error;
      }
    });
  }, 60_000);
});
