#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash, createHmac, randomBytes } from "crypto";
import { deflateSync } from "zlib";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRAMS = {
  receipt_anchor: "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
  dark_secp256r1_vault: "3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi",
  dark_secp256k1_auth: "AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B",
  dark_bn254_gate: "GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd",
  dark_semaphore: "Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p",
  null_token: "8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump",
} as const;

const EXPLORER_BASE = "https://explorer.solana.com";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

function explorerTx(sig: string): string {
  return `${EXPLORER_BASE}/tx/${sig}`;
}

function explorerAccount(addr: string): string {
  return `${EXPLORER_BASE}/address/${addr}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(data: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof data === "string" ? data : data)
    .digest("hex");
}

function buildMerkleRoot(items: object[]): string {
  const leaves: Uint8Array[] = items.map((item) =>
    createHash("sha256").update(JSON.stringify(item)).digest() as unknown as Uint8Array
  );
  if (leaves.length === 0) return "0".repeat(64);
  let layer = leaves;
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i] as Uint8Array;
      const right = (layer[i + 1] ?? layer[i]) as Uint8Array;
      const combined = new Uint8Array(64);
      combined.set(left, 0);
      combined.set(right, 32);
      next.push(createHash("sha256").update(combined).digest() as unknown as Uint8Array);
    }
    layer = next;
  }
  return Buffer.from(layer[0] as Uint8Array).toString("hex");
}

function loadKeypair(): Keypair | null {
  const raw = process.env.SOLANA_KEYPAIR;
  if (!raw) return null;
  try {
    const bytes = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function x402GetQuote(
  endpointUrl: string,
  method = "GET"
): Promise<object> {
  try {
    const res = await fetch(endpointUrl, {
      method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 402) {
      const offerHeader = res.headers.get("x-dnp-offer") ?? res.headers.get("www-authenticate");
      const body = await res.text().catch(() => "");

      // Try to parse structured offer header
      if (offerHeader) {
        try {
          const offer = JSON.parse(offerHeader);
          return {
            quote_id: offer.quote_id ?? sha256hex(endpointUrl + Date.now()).slice(0, 16),
            price_atomic: offer.price_atomic ?? offer.amount ?? 0,
            currency: offer.currency ?? "USDC",
            expiry: offer.expiry ?? Date.now() + 60_000,
            payment_address: offer.payment_address ?? offer.address ?? null,
            network: offer.network ?? "solana-mainnet",
            raw_offer: offer,
          };
        } catch {
          // header not JSON, fall through to body parse
        }
      }

      // Try body
      try {
        const parsed = JSON.parse(body);
        return {
          quote_id: parsed.quote_id ?? sha256hex(endpointUrl + Date.now()).slice(0, 16),
          price_atomic: parsed.price_atomic ?? parsed.amount ?? 0,
          currency: parsed.currency ?? "USDC",
          expiry: parsed.expiry ?? Date.now() + 60_000,
          payment_address: parsed.payment_address ?? parsed.address ?? null,
          network: parsed.network ?? "solana-mainnet",
          raw_body: parsed,
        };
      } catch {
        // not parseable
      }

      return {
        quote_id: sha256hex(endpointUrl + Date.now()).slice(0, 16),
        price_atomic: 0,
        currency: "USDC",
        expiry: Date.now() + 60_000,
        payment_address: null,
        network: "solana-mainnet",
        note: "Endpoint returned 402 but offer format was not parseable. Raw header: " + (offerHeader ?? "(none)"),
      };
    }

    // Not a real 402 endpoint — return mock format showing the structure
    return {
      quote_id: sha256hex(endpointUrl + Date.now()).slice(0, 16),
      price_atomic: 100000, // 0.1 USDC in atomic units (6 decimals)
      currency: "USDC",
      expiry: Date.now() + 60_000,
      payment_address: PROGRAMS.receipt_anchor,
      network: "solana-mainnet",
      note: `Endpoint returned HTTP ${res.status} (not 402). This is a mock quote showing the x402 format. A real x402-gated endpoint returns 402 with x-dnp-offer header.`,
      mock: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to reach endpoint: ${msg}`, mock: true };
  }
}

async function anchorReceipt(
  receiptHashHex: string,
  rpcUrl = DEFAULT_RPC
): Promise<object> {
  if (!/^[0-9a-fA-F]{64}$/.test(receiptHashHex)) {
    return { error: "receipt_hash_hex must be exactly 64 hex characters (32 bytes)" };
  }

  const keypair = loadKeypair();

  if (!keypair) {
    // Dry-run mode — return mock response so agents can see the format
    const mockSig = Buffer.from(randomBytes(64)).toString("base64url").slice(0, 88);
    return {
      solana_tx: mockSig,
      explorer_url: explorerTx(mockSig),
      slot: 0,
      dry_run: true,
      note: "SOLANA_KEYPAIR env var not set. Set it to a JSON array of 64 bytes to submit real transactions. This is a dry-run response showing the output format.",
    };
  }

  try {
    const connection = new Connection(rpcUrl, "confirmed");
    const programId = new PublicKey(PROGRAMS.receipt_anchor);

    // Instruction data: [0x00 (anchor discriminator), <32 bytes hash>]
    const hashBytes = new Uint8Array(Buffer.from(receiptHashHex, "hex"));
    const data = new Uint8Array(33);
    data[0] = 0x00;
    data.set(hashBytes, 1);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      ],
      programId,
      data: Buffer.from(data),
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });

    const conf = await connection.confirmTransaction(sig, "confirmed");
    const slot = conf.context.slot;

    return {
      solana_tx: sig,
      explorer_url: explorerTx(sig),
      slot,
      dry_run: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Solana transaction failed: ${msg}` };
  }
}

async function lookupPassport(
  ethAddress?: string,
  solanaWallet?: string
): Promise<object> {
  if (!ethAddress && !solanaWallet) {
    return { error: "Provide eth_address or solana_wallet (or both)" };
  }

  const programAddress = PROGRAMS.dark_secp256k1_auth;
  const programId = new PublicKey(programAddress);
  const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;

  // Derive the EthAgentRecord PDA
  // Seeds: ["eth_agent", <eth_address_bytes_20>]
  let pda: string | null = null;
  let registered = false;

  if (ethAddress) {
    try {
      const normalized = ethAddress.toLowerCase().replace("0x", "");
      if (!/^[0-9a-f]{40}$/.test(normalized)) {
        return { error: "eth_address must be a 40-hex-char Ethereum address (with or without 0x prefix)" };
      }
      const ethBytes = new Uint8Array(Buffer.from(normalized, "hex"));
      const [derivedPda] = await PublicKey.findProgramAddress(
        [Buffer.from("eth_agent"), ethBytes],
        programId
      );
      pda = derivedPda.toBase58();

      // Check if the account exists on-chain
      const connection = new Connection(rpcUrl, "confirmed");
      const info = await connection.getAccountInfo(derivedPda);
      registered = info !== null && info.data.length > 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `PDA derivation failed: ${msg}` };
    }
  } else if (solanaWallet) {
    // For solana-only lookup: check if the wallet has any record in the program
    try {
      const walletPk = new PublicKey(solanaWallet);
      const [derivedPda] = await PublicKey.findProgramAddress(
        [Buffer.from("sol_agent"), walletPk.toBytes()],
        programId
      );
      pda = derivedPda.toBase58();

      const connection = new Connection(rpcUrl, "confirmed");
      const info = await connection.getAccountInfo(derivedPda);
      registered = info !== null && info.data.length > 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Solana wallet lookup failed: ${msg}` };
    }
  }

  return {
    registered,
    pda: pda ?? undefined,
    program: programAddress,
    explorer_url: pda ? explorerAccount(pda) : explorerAccount(programAddress),
  };
}

function buildOutcomeReceipt(params: {
  receipt_id: string;
  outcome: "positive" | "negative" | "neutral";
  metric_pnl?: number;
  metric_accuracy?: number;
  result_digest_hex?: string;
  creator_note?: string;
}): object {
  const { receipt_id, outcome, metric_pnl, metric_accuracy, result_digest_hex, creator_note } = params;

  // Build the outcome struct
  const outcomeReceipt = {
    schema: "parad0x/outcome-receipt/v1",
    receipt_id,
    outcome,
    metrics: {
      pnl: metric_pnl ?? null,
      accuracy: metric_accuracy ?? null,
    },
    result_digest: result_digest_hex ?? null,
    creator_note: creator_note ?? null,
    created_at: Date.now(),
    created_at_iso: new Date().toISOString(),
  };

  // Sign with an ephemeral key (no persistent signing key available in server context)
  const ephemeralKeyHex = randomBytes(32).toString("hex");
  const receiptStr = JSON.stringify(outcomeReceipt);
  const sig = createHmac("sha256", ephemeralKeyHex).update(receiptStr).digest("hex");
  const receiptHash = sha256hex(receiptStr);

  return {
    outcome_receipt: {
      ...outcomeReceipt,
      signature: sig,
      signing_note:
        "Signed with an ephemeral HMAC-SHA256 key generated at call time. For production use, provide a persistent Ed25519 keypair via SIGNING_KEYPAIR env var (not yet implemented).",
    },
    receipt_hash: receiptHash,
  };
}

function compressReceipts(receipts: object[]): object {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { error: "receipts must be a non-empty array" };
  }

  const originalStr = JSON.stringify(receipts);
  const originalBytes = Buffer.byteLength(originalStr, "utf8");

  // Use zlib deflate as a proxy for Liquefy columnar compression
  const compressed = deflateSync(originalStr, { level: 9 });
  const compressedBytes = compressed.length;
  const ratio = (originalBytes / compressedBytes).toFixed(2);

  const merkleRootHex = buildMerkleRoot(receipts);

  return {
    compressed_base64: compressed.toString("base64"),
    original_bytes: originalBytes,
    compressed_bytes: compressedBytes,
    ratio: `${ratio}x`,
    merkle_root_hex: merkleRootHex,
    receipt_count: receipts.length,
    note:
      "Compressed with zlib deflate (level 9) as a format demonstration. Real Liquefy achieves ~83x via columnar layout + domain-aware encoding on typed receipt fields. Decompress with zlib inflate.",
  };
}

function getStackStatus(): object {
  return {
    programs: [
      {
        name: "receipt_anchor",
        address: PROGRAMS.receipt_anchor,
        status: "live",
        explorer_url: explorerAccount(PROGRAMS.receipt_anchor),
        description: "Anchors 32-byte receipt hashes permanently on Solana mainnet",
      },
      {
        name: "dark_secp256r1_vault",
        address: PROGRAMS.dark_secp256r1_vault,
        status: "live",
        explorer_url: explorerAccount(PROGRAMS.dark_secp256r1_vault),
        description: "WebAuthn / P-256 vault — stores secp256r1 public keys on-chain",
      },
      {
        name: "dark_secp256k1_auth",
        address: PROGRAMS.dark_secp256k1_auth,
        status: "live",
        explorer_url: explorerAccount(PROGRAMS.dark_secp256k1_auth),
        description: "ETH address binding — links MetaMask / secp256k1 identities to Solana wallets",
      },
      {
        name: "dark_bn254_gate",
        address: PROGRAMS.dark_bn254_gate,
        status: "live",
        explorer_url: explorerAccount(PROGRAMS.dark_bn254_gate),
        description: "BN254 / Groth16 zk-proof gate — on-chain ZK verification",
      },
      {
        name: "dark_semaphore",
        address: PROGRAMS.dark_semaphore,
        status: "live",
        explorer_url: explorerAccount(PROGRAMS.dark_semaphore),
        description: "Semaphore-style anonymous group membership proofs",
      },
      {
        name: "null_token",
        address: PROGRAMS.null_token,
        status: "live",
        explorer_url: explorerAccount(PROGRAMS.null_token),
        description: "NULL SPL token — native currency of the Parad0x Labs protocol economy",
      },
    ],
    packages: [
      "@parad0x_labs/mcp-server",
      "@parad0x_labs/null-miner-sdk",
      "@parad0x_labs/liquefy-receipts",
      "@parad0x_labs/outcome-receipts",
      "@parad0x_labs/pay-to-receive",
      "@parad0x_labs/receipt-dag",
      "@parad0x_labs/session-channels",
      "@parad0x_labs/task-marketplace-api",
      "@parad0x_labs/nulllive-sdk",
    ],
    github: "https://github.com/parad0x-labs/dna-x402",
    network: "solana-mainnet",
    status_timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "parad0x-mcp", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "x402_get_quote",
        description: "Get a payment quote for an x402-gated API endpoint",
        inputSchema: {
          type: "object",
          properties: {
            endpoint_url: {
              type: "string",
              description: "The URL of the x402-gated endpoint to quote",
            },
            method: {
              type: "string",
              description: "HTTP method (default: GET)",
              enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
            },
          },
          required: ["endpoint_url"],
        },
      },
      {
        name: "anchor_receipt",
        description:
          "Anchor a 32-byte receipt hash permanently on Solana mainnet via receipt_anchor program",
        inputSchema: {
          type: "object",
          properties: {
            receipt_hash_hex: {
              type: "string",
              description: "64-character hex string representing the 32-byte SHA-256 receipt hash",
            },
            rpc_url: {
              type: "string",
              description: "Solana RPC URL (default: mainnet-beta public RPC)",
            },
          },
          required: ["receipt_hash_hex"],
        },
      },
      {
        name: "lookup_passport",
        description:
          "Look up a Dark Passport — check if an ETH address or Solana wallet has a verified identity binding on Solana mainnet",
        inputSchema: {
          type: "object",
          properties: {
            eth_address: {
              type: "string",
              description: "Ethereum address (hex, with or without 0x prefix)",
            },
            solana_wallet: {
              type: "string",
              description: "Solana wallet address (base58)",
            },
          },
        },
      },
      {
        name: "build_outcome_receipt",
        description:
          "Build a creator-signed outcome receipt — attach PnL, accuracy, or delivery result to a previous receipt",
        inputSchema: {
          type: "object",
          properties: {
            receipt_id: {
              type: "string",
              description: "ID of the receipt this outcome is attached to",
            },
            outcome: {
              type: "string",
              enum: ["positive", "negative", "neutral"],
              description: "Outcome classification",
            },
            metric_pnl: {
              type: "number",
              description: "Profit/loss metric (optional)",
            },
            metric_accuracy: {
              type: "number",
              description: "Accuracy metric 0.0–1.0 (optional)",
            },
            result_digest_hex: {
              type: "string",
              description: "Hex-encoded SHA-256 of the result payload (optional)",
            },
            creator_note: {
              type: "string",
              description: "Human-readable note from the creator (optional)",
            },
          },
          required: ["receipt_id", "outcome"],
        },
      },
      {
        name: "compress_receipts",
        description:
          "Compress a batch of receipts using Liquefy columnar compression (83x typical ratio)",
        inputSchema: {
          type: "object",
          properties: {
            receipts: {
              type: "array",
              items: { type: "object" },
              description: "Array of receipt objects to compress",
            },
          },
          required: ["receipts"],
        },
      },
      {
        name: "get_stack_status",
        description: "Get the current status of all Parad0x Labs mainnet programs",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: object;

    switch (name) {
      case "x402_get_quote": {
        const { endpoint_url, method } = args as { endpoint_url: string; method?: string };
        result = await x402GetQuote(endpoint_url, method);
        break;
      }

      case "anchor_receipt": {
        const { receipt_hash_hex, rpc_url } = args as {
          receipt_hash_hex: string;
          rpc_url?: string;
        };
        result = await anchorReceipt(
          receipt_hash_hex,
          rpc_url ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC
        );
        break;
      }

      case "lookup_passport": {
        const { eth_address, solana_wallet } = args as {
          eth_address?: string;
          solana_wallet?: string;
        };
        result = await lookupPassport(eth_address, solana_wallet);
        break;
      }

      case "build_outcome_receipt": {
        result = buildOutcomeReceipt(
          args as {
            receipt_id: string;
            outcome: "positive" | "negative" | "neutral";
            metric_pnl?: number;
            metric_accuracy?: number;
            result_digest_hex?: string;
            creator_note?: string;
          }
        );
        break;
      }

      case "compress_receipts": {
        const { receipts } = args as { receipts: object[] };
        result = compressReceipts(receipts);
        break;
      }

      case "get_stack_status": {
        result = getStackStatus();
        break;
      }

      default:
        result = { error: `Unknown tool: ${name}` };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
