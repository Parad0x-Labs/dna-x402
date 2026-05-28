/**
 * NULL Miner SDK — Next.js Adapter
 *
 * Drop-in x402 content gate for Next.js API routes and App Router handlers.
 * Gate any endpoint behind a USDC micropayment in 3 lines.
 *
 * Usage (App Router):
 *   import { nullMinerMiddleware } from "null-miner-sdk/nextjs";
 *
 *   export const GET = nullMinerMiddleware({
 *     priceUsdc: 0.10,
 *     recipientAddress: "YOUR_WALLET",
 *     platformWallet: "PLATFORM_WALLET",
 *   })(async (req) => {
 *     return Response.json({ content: "premium stuff" });
 *   });
 *
 * Usage (Pages Router):
 *   export default nullMinerPages({ priceUsdc: 0.05, recipientAddress: "..." })(handler);
 */

import type { ContentGateOptions, PlatformFeeConfig } from "../core/types.js";
import {
  createPaymentRequirement,
  verifyPaymentHeader,
  X402_VERSION,
} from "../x402/index.js";
import type { SolanaNetwork } from "../x402/index.js";

// ── App Router Middleware ─────────────────────────────────────────────────────

type AppRouterHandler = (req: Request, ctx?: unknown) => Promise<Response>;
type GateOptions = ContentGateOptions & PlatformFeeConfig;

/**
 * Wraps an App Router handler with x402 content gating.
 * Returns HTTP 402 with payment requirements if unpaid.
 * Passes through to handler if valid payment is present.
 */
export function nullMinerMiddleware(opts: GateOptions, network?: SolanaNetwork) {
  return (handler: AppRouterHandler): AppRouterHandler => {
    return async (req: Request, ctx?: unknown): Promise<Response> => {
      const resource     = new URL(req.url).pathname;
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

      const paymentHeader = req.headers.get("X-Payment");
      const verify        = verifyPaymentHeader(paymentHeader, requirements);

      if (!verify.valid) {
        return new Response(
          JSON.stringify({
            error:       "Payment Required",
            details:     verify.error,
            x402Version: X402_VERSION,
            accepts:     [requirements],
          }),
          {
            status:  402,
            headers: {
              "Content-Type":      "application/json",
              "X-Payment-Scheme":  "x402",
              "X-Payment-Network": requirements.network,
            },
          }
        );
      }

      // Payment valid — attach receipt info to request
      const enrichedReq = new Request(req, {
        headers: new Headers({
          ...Object.fromEntries(req.headers.entries()),
          "X-Payer":        verify.payerAddress ?? "",
          "X-Receipt-Hash": verify.receiptHash  ?? "",
          "X-Amount-Usdc":  String(verify.amountUsdc ?? 0),
        }),
      });

      return handler(enrichedReq, ctx);
    };
  };
}

/**
 * Simpler convenience: wrap with price only (uses process.env for wallets).
 */
export function gateContent(priceUsdc: number) {
  return nullMinerMiddleware({
    priceUsdc,
    recipientAddress: process.env["NULL_MINER_RECIPIENT"]      ?? "",
    platformWallet:   process.env["NULL_MINER_PLATFORM_WALLET"] ?? "",
    platformFeePct:   0.10,
  });
}
