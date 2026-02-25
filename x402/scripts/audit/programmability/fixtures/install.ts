import crypto from "node:crypto";
import express from "express";
import { calculateFeeAtomic, calculateTotalAtomic, parseAtomic, toAtomicString } from "../../../../src/feePolicy.js";
import { verifySignedReceipt } from "../../../../src/receipts.js";
import { X402AppContext } from "../../../../src/server.js";
import { PaymentRequirements, Quote, SignedReceipt } from "../../../../src/types.js";
import { PROGRAMMABILITY_FIXTURES } from "./primitives.js";
import { PrimitiveDefinition } from "./types.js";

interface InstallOptions {
  now?: () => Date;
}

interface PaymentResolution {
  commitId: string;
  quote: Quote;
  receipt: SignedReceipt;
}

function endpointIdFromPath(pathname: string): string {
  return pathname.replace(/^\//, "").replace(/[^a-zA-Z0-9_-]+/g, "-") || "root";
}

function inferBaseUrl(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function inferNetwork(rpcUrl: string): "solana-devnet" | "solana-mainnet" {
  return rpcUrl.includes("devnet") ? "solana-devnet" : "solana-mainnet";
}

function toPaymentRequirements(quote: Quote, baseUrl: string, recommendedMode: Quote["settlement"][number], rpcUrl: string): PaymentRequirements {
  return {
    version: "x402-dnp-v1",
    quote: {
      quoteId: quote.quoteId,
      amount: quote.amountAtomic,
      feeAtomic: quote.feeAtomic,
      totalAtomic: quote.totalAtomic,
      mint: quote.mint,
      recipient: quote.recipient,
      expiresAt: quote.expiresAt,
      settlement: quote.settlement,
      memoHash: quote.memoHash,
    },
    accepts: quote.settlement.map((mode) => ({
      scheme: "solana-spl",
      network: inferNetwork(rpcUrl),
      mint: quote.mint,
      maxAmount: quote.totalAtomic,
      recipient: quote.recipient,
      mode,
    })),
    recommendedMode,
    commitEndpoint: `${baseUrl}/commit`,
    finalizeEndpoint: `${baseUrl}/finalize`,
    receiptEndpoint: `${baseUrl}/receipt/:receiptId`,
  };
}

function resolvePaidRequest(context: X402AppContext, commitId: string | undefined, expectedResource: string): PaymentResolution | undefined {
  if (!commitId) {
    return undefined;
  }
  const commit = context.commits.get(commitId);
  if (!commit || commit.status !== "finalized" || !commit.receiptId) {
    return undefined;
  }
  const quote = context.quotes.get(commit.quoteId);
  const receipt = context.receipts.get(commit.receiptId);
  if (!quote || !receipt || quote.resource !== expectedResource) {
    return undefined;
  }
  return {
    commitId,
    quote,
    receipt,
  };
}

function createQuoteForFixture(
  context: X402AppContext,
  fixture: PrimitiveDefinition,
  amountAtomic: string,
  settlementModes: Quote["settlement"],
  now: Date,
): Quote {
  const quoteId = crypto.randomUUID();
  const amount = parseAtomic(amountAtomic);
  const feeAtomic = calculateFeeAtomic(context.config.feePolicy, amount);
  const totalAtomic = calculateTotalAtomic(context.config.feePolicy, amount);
  const expiresAt = new Date(now.getTime() + context.config.quoteTtlSeconds * 1000).toISOString();
  const memoHash = crypto.createHash("sha256")
    .update(`${quoteId}:${fixture.resourcePath}:${toAtomicString(totalAtomic)}:${expiresAt}`)
    .digest("hex");

  const quote: Quote = {
    quoteId,
    resource: fixture.resourcePath,
    amountAtomic: toAtomicString(amount),
    feeAtomic: toAtomicString(feeAtomic),
    totalAtomic: toAtomicString(totalAtomic),
    mint: context.config.usdcMint,
    recipient: context.config.paymentRecipient,
    expiresAt,
    settlement: settlementModes,
    memoHash,
  };

  context.quotes.set(quoteId, quote);
  context.market.recordEvent({
    type: "QUOTE_ISSUED",
    shopId: `programmable-${fixture.id}`,
    endpointId: endpointIdFromPath(fixture.resourcePath),
    capabilityTags: fixture.capabilityTags,
    priceAmount: quote.totalAtomic,
    mint: quote.mint,
  });

  return quote;
}

export function installProgrammabilityFixtures(
  app: express.Express,
  context: X402AppContext,
  options: InstallOptions = {},
): {
  fixtures: PrimitiveDefinition[];
} {
  const nowFn = options.now ?? (() => new Date());
  const states = new Map<string, unknown>();
  const paymentEventsIssued = new Set<string>();

  for (const fixture of PROGRAMMABILITY_FIXTURES) {
    states.set(fixture.id, fixture.createState(nowFn().getTime()));

    app.get(fixture.resourcePath, (req, res) => {
      const now = nowFn();
      const state = states.get(fixture.id);
      if (!state) {
        res.status(500).json({ ok: false, error: "fixture_state_missing" });
        return;
      }

      const paid = resolvePaidRequest(context, req.header("x-dnp-commit-id"), fixture.resourcePath);
      if (!paid) {
        const quoteView = fixture.quoteForRequest(state, req, now.getTime());
        const quote = createQuoteForFixture(context, fixture, quoteView.amountAtomic, quoteView.settlementModes, now);
        const paymentRequirements = toPaymentRequirements(
          quote,
          inferBaseUrl(req),
          quoteView.recommendedMode,
          context.config.solanaRpcUrl,
        );

        res.status(402).json({
          error: "payment_required",
          fixtureId: fixture.id,
          seller_defined: true,
          verifiable: {
            receipt: true,
            anchored: false,
          },
          pricingModel: quoteView.pricingLabel,
          paymentRequirements,
        });
        return;
      }

      const anchored = context.anchoringQueue?.isAnchored(paid.receipt.payload.receiptId) ?? false;
      const commit = context.commits.get(paid.commitId);
      const execution = fixture.executePaidRequest(state, req, now.getTime());

      if (!paymentEventsIssued.has(paid.receipt.payload.receiptId)) {
        paymentEventsIssued.add(paid.receipt.payload.receiptId);
        context.market.recordEvent({
          type: "PAYMENT_VERIFIED",
          shopId: `programmable-${fixture.id}`,
          endpointId: endpointIdFromPath(fixture.resourcePath),
          capabilityTags: fixture.capabilityTags,
          priceAmount: paid.quote.totalAtomic,
          mint: paid.quote.mint,
          settlementMode: commit?.settlementMode,
          receiptId: paid.receipt.payload.receiptId,
          anchor32: paid.receipt.payload.payerCommitment32B,
          anchored,
          verificationTier: anchored ? "VERIFIED" : "FAST",
          receiptValid: verifySignedReceipt(paid.receipt),
        });
      }

      context.market.recordEvent({
        type: "REQUEST_FULFILLED",
        shopId: `programmable-${fixture.id}`,
        endpointId: endpointIdFromPath(fixture.resourcePath),
        capabilityTags: fixture.capabilityTags,
        priceAmount: paid.quote.totalAtomic,
        mint: paid.quote.mint,
        settlementMode: commit?.settlementMode,
        latencyMs: 1,
        statusCode: 200,
        receiptId: paid.receipt.payload.receiptId,
        anchor32: paid.receipt.payload.payerCommitment32B,
        anchored,
        verificationTier: anchored ? "VERIFIED" : "FAST",
        receiptValid: verifySignedReceipt(paid.receipt),
      });

      res.json({
        ok: true,
        fixtureId: fixture.id,
        title: fixture.title,
        seller_defined: true,
        verifiable: {
          receipt: true,
          anchored,
        },
        receiptId: paid.receipt.payload.receiptId,
        note: execution.note,
        output: execution.output,
      });
    });
  }

  app.get("/programmability/fixtures", (_req, res) => {
    res.json({
      fixtures: PROGRAMMABILITY_FIXTURES.map((fixture) => ({
        id: fixture.id,
        title: fixture.title,
        category: fixture.category,
        description: fixture.description,
        capabilityTags: fixture.capabilityTags,
        resourcePath: fixture.resourcePath,
        seller_defined: true,
        verifiable: {
          receipt: true,
          anchored: "depends_on_receipt_anchor_confirmation",
        },
      })),
    });
  });

  return {
    fixtures: PROGRAMMABILITY_FIXTURES,
  };
}
