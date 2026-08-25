/**
 * openclaw-x402-gate — charge other agents for your skill/API with x402.
 *
 * Registers two tools:
 *   - x402_challenge: mint an HTTP 402 challenge to send to an unpaid caller.
 *   - x402_verify:    verify a submitted X-Payment header (optionally on-chain).
 *
 * Trust model (v1.0.0):
 *   - NO CUSTODY. `recipientAddress` is YOUR public wallet; funds settle straight
 *     to it on-chain. This skill holds no keys and signs nothing.
 *   - Stateless. Both tools reconstruct the same requirement from config +
 *     resource, so receipt hashes match the paying side with no shared state.
 *   - Revenue-grade gating: set requireOnChain=true so a payment is accepted only
 *     after the transaction is confirmed on Solana (not just a well-formed header).
 *
 * Status: Public Beta. Non-custodial, unaudited (no external audit completed or scheduled).
 */

// Type-only: resolved from the host OpenClaw runtime at load time.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Connection } from "@solana/web3.js";

import { DEFAULT_RPC, type SolanaNetwork } from "./constants";
import { makeChallenge, verifyPaymentStructure } from "./gate";
import { confirmOnChain } from "./onchain";
import { InMemoryReplayStore, type ReplayStore } from "./replay";

export * from "./constants";
export * from "./types";
export * from "./gate";
export * from "./onchain";
export * from "./replay";

interface GateConfig {
  recipientAddress: string;
  priceUsdc: number;
  network: SolanaNetwork;
  requireOnChain: boolean;
  rpcUrl?: string;
  /** Durable replay store. The in-memory default is lost on restart, which
   *  allows replay of captured X-Payment headers — inject a durable store in
   *  production (Redis, database, ...). */
  replayStore?: ReplayStore;
}

function readConfig(raw: Record<string, unknown> | undefined): GateConfig {
  const c = raw ?? {};
  return {
    recipientAddress: typeof c.recipientAddress === "string" ? c.recipientAddress : "",
    priceUsdc: typeof c.priceUsdc === "number" ? c.priceUsdc : 0.01,
    network: c.network === "solana-mainnet" ? "solana-mainnet" : "solana-devnet",
    // Secure default: require on-chain confirmation unless explicitly disabled.
    requireOnChain: c.requireOnChain !== false,
    rpcUrl: typeof c.rpcUrl === "string" ? c.rpcUrl : undefined,
    replayStore: c.replayStore instanceof Object && typeof (c.replayStore as ReplayStore).has === "function"
      ? (c.replayStore as ReplayStore)
      : undefined,
  };
}

export default definePluginEntry({
  id: "x402-gate",
  name: "x402 Gate",
  description:
    "Charge other agents for your skill or API with x402 micropayments on Solana. " +
    "Mint a 402 challenge, verify the payment (optionally confirmed on-chain), then " +
    "serve. Funds go to your own wallet address — the skill holds no keys.",
  register(api: {
    registerTool: (tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      handler: (params: Record<string, unknown>) => Promise<unknown>;
    }) => void;
    config?: Record<string, unknown>;
  }) {
    const config = readConfig(api.config);
    // In-memory default: lost on restart. Production must inject a durable
    // ReplayStore via plugin config (`replayStore`).
    const replayStore = config.replayStore ?? new InMemoryReplayStore();

    api.registerTool({
      name: "x402_challenge",
      description:
        "Build an HTTP 402 Payment Required challenge for a resource. Return its " +
        "`body` to an unpaid caller so they know how much to pay and to which address.",
      parameters: {
        resource: { type: "string", description: "The resource id/path being charged for" },
        priceUsdc: { type: "number", description: "Override the default price (USDC)" },
        description: { type: "string", description: "Human-readable description" },
      },
      async handler(params: Record<string, unknown>) {
        if (!config.recipientAddress) {
          return { error: "gate not configured: set recipientAddress (your wallet) in plugin config" };
        }
        const resource = String(params.resource ?? "");
        if (!resource) return { error: "resource is required" };
        try {
          const { status, body } = makeChallenge({
            priceUsdc: typeof params.priceUsdc === "number" ? params.priceUsdc : config.priceUsdc,
            recipientAddress: config.recipientAddress,
            resource,
            description: params.description ? String(params.description) : undefined,
            network: config.network,
          });
          return { status, body };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    api.registerTool({
      name: "x402_verify",
      description:
        "Verify a submitted X-Payment header for a resource. Returns whether the " +
        "payment is valid and the receipt hash. With requireOnChain=true the " +
        "payment must also be confirmed settled on Solana before it is accepted.",
      parameters: {
        header: { type: "string", description: "The base64 X-Payment header the caller sent" },
        resource: { type: "string", description: "The resource being accessed (must match the challenge)" },
        priceUsdc: { type: "number", description: "Override the default price (USDC)" },
      },
      async handler(params: Record<string, unknown>) {
        if (!config.recipientAddress) {
          return { valid: false, error: "gate not configured: set recipientAddress in plugin config" };
        }
        const resource = String(params.resource ?? "");
        const header = params.header == null ? null : String(params.header);

        const { requirement } = makeChallenge({
          priceUsdc: typeof params.priceUsdc === "number" ? params.priceUsdc : config.priceUsdc,
          recipientAddress: config.recipientAddress,
          resource,
          network: config.network,
        });

        const structural = verifyPaymentStructure(header, requirement, { replayStore });
        if (!structural.valid) return structural;

        if (!config.requireOnChain) {
          if (!structural.signatureVerified) {
            // The signature could not be verified offline (e.g. it is a raw
            // Solana tx signature). Accepting it without on-chain confirmation
            // would let any well-formed header through.
            console.warn(
              "[x402-gate] SECURITY: requireOnChain=false with a non-verifiable " +
                "payment signature — rejecting. Set requireOnChain=true or have the " +
                "payer submit an ed25519-signed proof.",
            );
            return { valid: false, error: "proof signature is not offline-verifiable; on-chain confirmation is required" };
          }
          return structural;
        }

        // Revenue-grade: confirm the payment actually settled.
        const rpcUrl = config.rpcUrl ?? DEFAULT_RPC[config.network];
        const connection = new Connection(rpcUrl, "confirmed");
        const chain = await confirmOnChain(connection, structural.signature, {
          receiptHash: structural.receiptHash,
          recipient: requirement.payTo,
        });
        if (!chain.confirmed) {
          return { valid: false, error: `on-chain confirmation failed: ${chain.reason}` };
        }
        // Consume the replay key only after full confirmation for
        // chain-verified proofs (offline-verified ones were marked earlier).
        replayStore.markUsed(`${structural.receiptHash}:${structural.signature}`);
        return { ...structural, onChainVerified: true };
      },
    });
  },
});
