import { buildFeeWaterfallV2 } from "dna-x402";

export function buildBuilderFeeWaterfall() {
  return buildFeeWaterfallV2({
    quoteId: "quote-builder-demo",
    grossAmount: "100000000",
    token: "USDC",
    decimals: 6,
    providerRecipient: "seller-treasury",
    platformRecipient: "dna-treasury",
    platformFeeBps: 10,
    platformMode: "seller_accrual",
    builderProfile: {
      builderId: process.env.BUILDER_ID ?? "builder_demo",
      displayName: "Demo Builder",
      slug: "demo-builder",
      ownerWallet: "builder-owner",
      treasuryWallet: process.env.BUILDER_TREASURY ?? "builder-treasury",
      verifiedStatus: "UNVERIFIED",
      allowedFeeBpsMax: 500,
      defaultFeeBps: 50,
      status: "ACTIVE",
      policyStrikeCount: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    builderFee: {
      builderId: process.env.BUILDER_ID ?? "builder_demo",
      enabled: true,
      feeBps: Number(process.env.BUILDER_FEE_BPS ?? "50"),
      recipient: process.env.BUILDER_TREASURY ?? "builder-treasury",
      token: "USDC",
      mode: "builder_accrual",
      refundBehavior: "REFUND_PRO_RATA",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    directSplitEnabled: false,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const waterfall = buildBuilderFeeWaterfall();
  console.log("builder-agent: fee waterfall prepared", waterfall.feeWaterfallHash);
  console.log("builder-agent: DNA platform fee protected", waterfall.lines.some((line) => line.kind === "DNA_PLATFORM_FEE"));
  console.log("builder-agent: builder fee visible", waterfall.lines.some((line) => line.kind === "BUILDER_FEE" && line.visibleToBuyer));
}
