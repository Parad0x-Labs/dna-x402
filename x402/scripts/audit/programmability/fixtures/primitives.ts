import { Request } from "express";
import { PrimitiveDefinition } from "./types.js";

function parsePositiveInt(value: string | undefined, fallback: number, max = 1000): number {
  if (!value) {
    return fallback;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(max, n);
}

function parseSide(value: string | undefined): "yes" | "no" {
  return value === "no" ? "no" : "yes";
}

function toAtomic(n: bigint): string {
  if (n <= 0n) {
    return "1";
  }
  return n.toString(10);
}

function qs(req: Request): URLSearchParams {
  const at = req.originalUrl.indexOf("?");
  const query = at === -1 ? "" : req.originalUrl.slice(at + 1);
  return new URLSearchParams(query);
}

interface AuctionState {
  calls: number;
  currentAtomic: bigint;
}

interface DutchState {
  startedAtMs: number;
  fills: number;
}

interface SealedBidState {
  commits: number;
  reveals: number;
  phase: "commit" | "reveal";
}

interface PredictionState {
  yesShares: number;
  noShares: number;
}

interface ReverseAuctionState {
  bestAskAtomic: bigint;
  fills: number;
}

interface StreamGateState {
  sessions: number;
  fundedUntilMs: number;
}

interface BundleState {
  runs: number;
  cumulativeMarginAtomic: bigint;
}

export const PROGRAMMABILITY_FIXTURES: PrimitiveDefinition[] = [
  {
    id: "fixed_price_tool",
    title: "Fixed-Price Tool",
    category: "baseline",
    description: "Fixed price call where seller logic is deterministic but fully off-chain.",
    capabilityTags: ["primitive_fixed_price", "programmable"],
    resourcePath: "/programmability/fixed-price",
    createState: () => ({ calls: 0 }),
    quoteForRequest: () => ({
      amountAtomic: "1200",
      settlementModes: ["transfer", "netting"],
      recommendedMode: "transfer",
      pricingLabel: "flat:1200",
    }),
    executePaidRequest: (state) => {
      const mutable = state as { calls: number };
      mutable.calls += 1;
      return {
        output: {
          calls: mutable.calls,
          rule: "constant-price",
        },
        note: "Seller-defined fixed policy executed.",
      };
    },
  },
  {
    id: "usage_metered_tool",
    title: "Usage-Metered Tool",
    category: "metered",
    description: "Amount scales with user-provided units while settlement rails stay unchanged.",
    capabilityTags: ["primitive_metered", "programmable"],
    resourcePath: "/programmability/usage-metered",
    createState: () => ({ calls: 0, billedUnits: 0 }),
    quoteForRequest: (state, req) => {
      const mutable = state as { calls: number; billedUnits: number };
      const units = parsePositiveInt(qs(req).get("units") ?? undefined, 1, 50);
      mutable.billedUnits += units;
      return {
        amountAtomic: toAtomic(BigInt(units) * 350n),
        settlementModes: ["transfer", "netting"],
        recommendedMode: "transfer",
        pricingLabel: `metered:${units}x350`,
      };
    },
    executePaidRequest: (state, req) => {
      const mutable = state as { calls: number; billedUnits: number };
      mutable.calls += 1;
      const units = parsePositiveInt(qs(req).get("units") ?? undefined, 1, 50);
      return {
        output: {
          calls: mutable.calls,
          units,
          cumulativeUnits: mutable.billedUnits,
        },
        note: "Seller-defined metered pricing executed.",
      };
    },
  },
  {
    id: "surge_priced_tool",
    title: "Surge-Priced Tool",
    category: "surge",
    description: "Price follows seller-side load factor with bounded multiplier.",
    capabilityTags: ["primitive_surge", "programmable"],
    resourcePath: "/programmability/surge-priced",
    createState: () => ({ load: 0, calls: 0 }),
    quoteForRequest: (state) => {
      const mutable = state as { load: number; calls: number };
      mutable.load = Math.min(4, mutable.load + 1);
      const multiplier = 1n + BigInt(mutable.load);
      return {
        amountAtomic: toAtomic(700n * multiplier),
        settlementModes: ["transfer", "netting"],
        recommendedMode: "transfer",
        pricingLabel: `surge:x${multiplier.toString()}`,
      };
    },
    executePaidRequest: (state) => {
      const mutable = state as { load: number; calls: number };
      mutable.calls += 1;
      mutable.load = Math.max(0, mutable.load - 1);
      return {
        output: {
          calls: mutable.calls,
          loadAfterFill: mutable.load,
        },
        note: "Seller-defined surge state machine executed.",
      };
    },
  },
  {
    id: "english_auction",
    title: "English Auction",
    category: "auction",
    description: "Highest bid increases each successful paid execution.",
    capabilityTags: ["primitive_english_auction", "programmable"],
    resourcePath: "/programmability/english-auction",
    createState: () => ({ calls: 0, currentAtomic: 2000n } satisfies AuctionState),
    quoteForRequest: (state) => {
      const mutable = state as AuctionState;
      const nextBid = mutable.currentAtomic + 150n;
      return {
        amountAtomic: toAtomic(nextBid),
        settlementModes: ["transfer", "netting"],
        recommendedMode: "transfer",
        pricingLabel: `english-next:${nextBid.toString()}`,
      };
    },
    executePaidRequest: (state) => {
      const mutable = state as AuctionState;
      mutable.calls += 1;
      mutable.currentAtomic += 150n;
      return {
        output: {
          calls: mutable.calls,
          winningBidAtomic: mutable.currentAtomic.toString(),
        },
        note: "Seller-defined English auction progression executed.",
      };
    },
  },
  {
    id: "dutch_auction",
    title: "Dutch Auction",
    category: "auction",
    description: "Price decays over time; first valid paid execution takes current offer.",
    capabilityTags: ["primitive_dutch_auction", "programmable"],
    resourcePath: "/programmability/dutch-auction",
    createState: (nowMs) => ({ startedAtMs: nowMs, fills: 0 } satisfies DutchState),
    quoteForRequest: (state, _req, nowMs) => {
      const mutable = state as DutchState;
      const elapsedSeconds = BigInt(Math.floor((nowMs - mutable.startedAtMs) / 1000));
      const decay = elapsedSeconds * 90n;
      const price = 3000n > decay ? 3000n - decay : 400n;
      return {
        amountAtomic: toAtomic(price),
        settlementModes: ["transfer", "netting"],
        recommendedMode: "transfer",
        pricingLabel: `dutch:${price.toString()}`,
      };
    },
    executePaidRequest: (state) => {
      const mutable = state as DutchState;
      mutable.fills += 1;
      return {
        output: {
          fills: mutable.fills,
        },
        note: "Seller-defined Dutch auction execution accepted.",
      };
    },
  },
  {
    id: "sealed_bid_commit_reveal",
    title: "Sealed-Bid Commit/Reveal",
    category: "auction",
    description: "Commit phase and reveal phase are seller-defined state transitions.",
    capabilityTags: ["primitive_sealed_bid", "programmable"],
    resourcePath: "/programmability/sealed-bid",
    createState: () => ({ commits: 0, reveals: 0, phase: "commit" } satisfies SealedBidState),
    quoteForRequest: (state) => {
      const mutable = state as SealedBidState;
      const amount = mutable.phase === "commit" ? 900n : 450n;
      return {
        amountAtomic: toAtomic(amount),
        settlementModes: ["transfer", "netting"],
        recommendedMode: mutable.phase === "commit" ? "netting" : "transfer",
        pricingLabel: `sealed-${mutable.phase}:${amount.toString()}`,
      };
    },
    executePaidRequest: (state) => {
      const mutable = state as SealedBidState;
      if (mutable.phase === "commit") {
        mutable.commits += 1;
        if (mutable.commits >= 2) {
          mutable.phase = "reveal";
        }
      } else {
        mutable.reveals += 1;
      }
      return {
        output: {
          phase: mutable.phase,
          commits: mutable.commits,
          reveals: mutable.reveals,
        },
        note: "Seller-defined commit/reveal state machine executed.",
      };
    },
  },
  {
    id: "prediction_market_binary",
    title: "Prediction Market Binary Share",
    category: "market",
    description: "Binary YES/NO share pricing modeled as seller-defined off-chain ledger.",
    capabilityTags: ["primitive_prediction_market", "programmable"],
    resourcePath: "/programmability/prediction-binary",
    createState: () => ({ yesShares: 0, noShares: 0 } satisfies PredictionState),
    quoteForRequest: (state, req) => {
      const mutable = state as PredictionState;
      const side = parseSide(qs(req).get("side") ?? undefined);
      const imbalance = BigInt(Math.abs(mutable.yesShares - mutable.noShares));
      const base = 1100n + imbalance * 20n;
      return {
        amountAtomic: toAtomic(base + (side === "yes" ? 30n : 0n)),
        settlementModes: ["transfer", "netting"],
        recommendedMode: "netting",
        pricingLabel: `prediction-${side}`,
      };
    },
    executePaidRequest: (state, req) => {
      const mutable = state as PredictionState;
      const side = parseSide(qs(req).get("side") ?? undefined);
      if (side === "yes") {
        mutable.yesShares += 1;
      } else {
        mutable.noShares += 1;
      }
      return {
        output: {
          side,
          yesShares: mutable.yesShares,
          noShares: mutable.noShares,
        },
        note: "Seller-defined prediction share book executed.",
      };
    },
  },
  {
    id: "reverse_auction",
    title: "Reverse Auction",
    category: "auction",
    description: "Asks tighten down as executions happen; buyer gets best current ask.",
    capabilityTags: ["primitive_reverse_auction", "programmable"],
    resourcePath: "/programmability/reverse-auction",
    createState: () => ({ bestAskAtomic: 2600n, fills: 0 } satisfies ReverseAuctionState),
    quoteForRequest: (state) => {
      const mutable = state as ReverseAuctionState;
      return {
        amountAtomic: toAtomic(mutable.bestAskAtomic),
        settlementModes: ["transfer", "netting"],
        recommendedMode: "netting",
        pricingLabel: `reverse:${mutable.bestAskAtomic.toString()}`,
      };
    },
    executePaidRequest: (state) => {
      const mutable = state as ReverseAuctionState;
      mutable.fills += 1;
      mutable.bestAskAtomic = mutable.bestAskAtomic > 950n ? mutable.bestAskAtomic - 120n : 950n;
      return {
        output: {
          fills: mutable.fills,
          nextBestAskAtomic: mutable.bestAskAtomic.toString(),
        },
        note: "Seller-defined reverse auction update executed.",
      };
    },
  },
  {
    id: "subscription_stream_gate",
    title: "Subscription Stream Gate",
    category: "streaming",
    description: "Access gate modeled as seller-defined stream-funded window.",
    capabilityTags: ["primitive_stream_gate", "programmable"],
    resourcePath: "/programmability/subscription-stream",
    createState: (nowMs) => ({ sessions: 0, fundedUntilMs: nowMs } satisfies StreamGateState),
    quoteForRequest: (_state, req) => {
      const seconds = parsePositiveInt(qs(req).get("seconds") ?? undefined, 60, 3600);
      const rate = 9n;
      const topup = BigInt(seconds) * rate;
      return {
        amountAtomic: toAtomic(topup),
        settlementModes: ["stream", "transfer", "netting"],
        recommendedMode: "stream",
        pricingLabel: `stream:${seconds}s`,
      };
    },
    executePaidRequest: (state, req, nowMs) => {
      const mutable = state as StreamGateState;
      const seconds = parsePositiveInt(qs(req).get("seconds") ?? undefined, 60, 3600);
      mutable.sessions += 1;
      const base = mutable.fundedUntilMs > nowMs ? mutable.fundedUntilMs : nowMs;
      mutable.fundedUntilMs = base + seconds * 1000;
      return {
        output: {
          sessions: mutable.sessions,
          fundedUntilMs: mutable.fundedUntilMs,
        },
        note: "Seller-defined stream gate window extended.",
      };
    },
  },
  {
    id: "bundle_reseller_margin",
    title: "Bundle/Reseller Margin",
    category: "bundle",
    description: "Bundle sold as one SKU while seller tracks upstream costs and margin.",
    capabilityTags: ["primitive_bundle_margin", "programmable"],
    resourcePath: "/programmability/bundle-margin",
    createState: () => ({ runs: 0, cumulativeMarginAtomic: 0n } satisfies BundleState),
    quoteForRequest: () => {
      const upstream = 1800n;
      const margin = 360n;
      return {
        amountAtomic: toAtomic(upstream + margin),
        settlementModes: ["netting", "transfer"],
        recommendedMode: "netting",
        pricingLabel: `bundle:${upstream.toString()}+${margin.toString()}`,
      };
    },
    executePaidRequest: (state) => {
      const mutable = state as BundleState;
      const margin = 360n;
      mutable.runs += 1;
      mutable.cumulativeMarginAtomic += margin;
      return {
        output: {
          runs: mutable.runs,
          cumulativeMarginAtomic: mutable.cumulativeMarginAtomic.toString(),
        },
        note: "Seller-defined bundle margin ledger updated.",
      };
    },
  },
];

