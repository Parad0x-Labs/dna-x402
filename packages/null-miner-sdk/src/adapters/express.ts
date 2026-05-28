/**
 * NULL Miner SDK — Express / Generic REST Adapter
 *
 * Drop-in x402 middleware for Express.js, Fastify, or any Node.js HTTP server.
 *
 * Usage (Express):
 *   import { nullMinerGate } from "null-miner-sdk/express";
 *
 *   app.use("/premium", nullMinerGate({
 *     priceUsdc: 0.10,
 *     recipientAddress: "YOUR_WALLET",
 *     platformWallet:   "PLATFORM_WALLET",
 *   }));
 *
 *   app.get("/premium/content", (req, res) => {
 *     res.json({ content: "paid", payer: req.nullMinerPayer });
 *   });
 */

import type { ContentGateOptions, PlatformFeeConfig } from "../core/types.js";
import {
  createPaymentRequirement,
  verifyPaymentHeader,
  X402_VERSION,
} from "../x402/index.js";
import type { SolanaNetwork } from "../x402/index.js";

type Req = {
  url?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  nullMinerPayer?: string;
  nullMinerReceiptHash?: string;
  nullMinerAmountUsdc?: number;
};
type Res = {
  status: (code: number) => Res;
  json:   (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};
type Next = () => void;

/**
 * Express middleware that gates routes behind x402 USDC micropayments.
 */
export function nullMinerGate(
  opts: ContentGateOptions & PlatformFeeConfig,
  network: SolanaNetwork = "solana-devnet",
) {
  return (req: Req, res: Res, next: Next): void => {
    const resource    = req.path ?? req.url ?? "/";
    const requirements = createPaymentRequirement({
      priceUsdc:        opts.priceUsdc,
      recipientAddress: opts.recipientAddress,
      resource,
      description:      opts.description,
      platformWallet:   opts.platformWallet,
      platformFeePct:   opts.platformFeePct,
      anchorReceipt:    opts.anchorReceipt,
      network,
    });

    const paymentHdr = req.headers["x-payment"];
    const headerStr  = Array.isArray(paymentHdr) ? paymentHdr[0] : paymentHdr;
    const verify     = verifyPaymentHeader(headerStr, requirements);

    if (!verify.valid) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Payment-Scheme", "x402");
      res.status(402).json({
        error:       "Payment Required",
        details:     verify.error,
        x402Version: X402_VERSION,
        accepts:     [requirements],
      });
      return;
    }

    // Attach verified payment info to request
    req.nullMinerPayer       = verify.payerAddress;
    req.nullMinerAmountUsdc  = verify.amountUsdc;
    req.nullMinerReceiptHash = verify.receiptHash;

    next();
  };
}

/**
 * Standalone payment verifier — use if you handle the HTTP layer yourself.
 */
export function verifyPayment(
  paymentHeader: string,
  priceUsdc: number,
  resource: string,
): { valid: boolean; payerAddress?: string; receiptHash?: string; error?: string } {
  const reqs = createPaymentRequirement({
    priceUsdc,
    recipientAddress: "",
    resource,
  });
  const result = verifyPaymentHeader(paymentHeader, reqs);
  if (!result.valid) return { valid: false, error: result.error };
  return {
    valid:        true,
    payerAddress: result.payerAddress,
    receiptHash:  result.receiptHash,
  };
}
