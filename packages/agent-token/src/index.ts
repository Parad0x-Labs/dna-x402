/**
 * @parad0x_labs/agent-token
 *
 * PumpFun token per registered agent.
 * Every agent on the MCP server can optionally launch a bonding-curve token.
 * Market cap drives discovery and leaderboard ranking.
 * 90% of trading fees go back to the agent creator.
 *
 * Mechanic lifted from Atelier AI's working token-per-agent model.
 *
 * Agent Token Flywheel:
 * Agent does good work → more x402 receipts → higher receipt score
 * → more discovery → more token buyers → higher market cap
 * → higher leaderboard rank → more work → more receipts
 * Creator earns 90% of trading fees passively.
 */

// ---------------------------------------------------------------------------
// Core token record
// ---------------------------------------------------------------------------

/**
 * AgentToken is the canonical record for a launched agent token.
 * Stored off-chain (e.g. in a registry DB) and referenced by agentId.
 */
export interface AgentToken {
  /** Unique agent identifier — matches the MCP server registration ID. */
  agentId: string;

  /** Human-readable agent name shown on the leaderboard and PumpFun page. */
  agentName: string;

  /** Solana SPL token mint address (base58). */
  mintAddress: string;

  /**
   * PumpFun bonding curve program account (base58).
   * Populated after the PumpFun `create` instruction succeeds.
   */
  pumpfunBondingCurve?: string;

  /** Wallet pubkey of the agent creator who receives 90% of trading fees. */
  creatorPubkey: string;

  /** Unix timestamp (seconds) when the token was launched. */
  launchedAt: number;

  /**
   * Current market cap in USDC, denominated in whole dollars.
   * Refreshed externally via PumpFun API / on-chain oracle.
   */
  marketCapUsdc?: number;

  /**
   * Total token supply as a bigint (supports PumpFun's 1 billion default
   * with 6 decimals = 1_000_000_000_000_000n lamports).
   */
  totalSupply: bigint;

  /** Short description surfaced in token metadata and leaderboard entries. */
  description: string;

  /** IPFS / Arweave URI for the token image (agent avatar). */
  imageUri?: string;

  /**
   * PDA of the agent's Dark NULL Passport (dark_secp256k1_auth or
   * dark_secp256r1_vault).  Links the token to a verified on-chain identity.
   * Optional — agents without a passport can still launch a token.
   */
  x402PassportPda?: string;
}

// ---------------------------------------------------------------------------
// Metaplex token metadata
// ---------------------------------------------------------------------------

/**
 * AgentTokenMetadata is the off-chain JSON blob uploaded to IPFS/Arweave
 * and referenced by the Metaplex token-metadata account URI field.
 * Conforms to the Metaplex Fungible Token standard so wallets render it.
 */
export interface AgentTokenMetadata {
  /** "AGENT: {agentName}" — prefixed for instant recognition in wallet UIs. */
  name: string;

  /**
   * Ticker symbol derived from the first 6 characters of agentId, uppercased.
   * E.g. agentId "oracle_prime_v2" → symbol "ORACLE".
   */
  symbol: string;

  /** Agent description copied from AgentToken.description. */
  description: string;

  /** Direct image URI (IPFS gateway URL or Arweave txid URL). */
  image: string;

  /**
   * On-chain attribute array surfaced in explorers and marketplaces.
   * Encodes capability and passport status so buyers can filter.
   */
  attributes: [
    { trait_type: "agent_type"; value: string },
    { trait_type: "capabilities"; value: string },
    { trait_type: "passport_verified"; value: "true" | "false" },
    { trait_type: "receipt_count"; value: string }
  ];
}

// ---------------------------------------------------------------------------
// PumpFun launch params builder
// ---------------------------------------------------------------------------

/**
 * Options for buildAgentTokenLaunchParams.
 */
export interface AgentTokenLaunchOpts {
  /** Agent type label, e.g. "coding", "trading", "research". */
  agentType?: string;

  /** Comma-separated capability tags, e.g. "solana,x402,mcp". */
  capabilities?: string;

  /** Number of x402 receipts the agent has already earned (for metadata). */
  receiptCount?: number;

  /** Link to the agent's Dark NULL Passport PDA if already registered. */
  x402PassportPda?: string;

  /** IPFS/Arweave URI for the agent avatar image. */
  imageUri?: string;

  /** Agent description (defaults to a generated string). */
  description?: string;
}

/**
 * Result of buildAgentTokenLaunchParams — everything needed to submit a
 * PumpFun `create` transaction and mint the Metaplex metadata account.
 */
export interface AgentTokenLaunchParams {
  metadata: AgentTokenMetadata;

  /**
   * Parameters to pass directly to the PumpFun `create` instruction.
   * Matches the PumpFun SDK CreateTokenInput shape so callers can
   * spread this into their SDK call without transformation.
   *
   * PumpFun standard reserves:
   *   virtualSolReserves  = 30 SOL  (30_000_000_000 lamports)
   *   virtualTokenReserves = 1,073,000,191 tokens (PumpFun default)
   *   initialBuyLamports  = 0 (no initial buy from launcher)
   */
  pumpfunCreateParams: {
    name: string;
    symbol: string;
    description: string;
    imageUri: string;
    twitter?: string;
    telegram?: string;
    website?: string;
    initialBuyLamports: number;
    virtualSolReserves: number;
    virtualTokenReserves: number;
    /** Metadata URI after IPFS upload — caller fills this post-upload. */
    metadataUri: string;
  };

  /**
   * Estimated SOL cost to launch on PumpFun.
   * Breakdown: ~0.01 SOL mint creation + ~0.01 SOL metadata rent = ~0.02 SOL.
   * Does NOT include any initial buy the creator may choose to add.
   */
  estimatedCostSol: number;
}

/**
 * Build all parameters required to launch an agent's PumpFun token.
 *
 * @param agentId       MCP-registered agent identifier.
 * @param agentName     Human-readable agent name.
 * @param creatorPubkey Creator's Solana wallet pubkey (base58).
 * @param opts          Optional overrides for metadata fields.
 * @returns             Metadata, PumpFun create params, and cost estimate.
 */
export function buildAgentTokenLaunchParams(
  agentId: string,
  agentName: string,
  creatorPubkey: string,
  opts: AgentTokenLaunchOpts = {}
): AgentTokenLaunchParams {
  // Derive symbol: first 6 chars of agentId, uppercase, strip non-alphanum
  const symbol = agentId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 6)
    .toUpperCase();

  const agentType = opts.agentType ?? "general";
  const capabilities = opts.capabilities ?? "x402,mcp";
  const receiptCount = opts.receiptCount ?? 0;
  const passportVerified: "true" | "false" = opts.x402PassportPda
    ? "true"
    : "false";
  const imageUri = opts.imageUri ?? "";
  const description =
    opts.description ??
    `${agentName} — autonomous agent on the DNA x402 network. Earn ${symbol} to access this agent's services.`;

  const metadata: AgentTokenMetadata = {
    name: `AGENT: ${agentName}`,
    symbol,
    description,
    image: imageUri,
    attributes: [
      { trait_type: "agent_type", value: agentType },
      { trait_type: "capabilities", value: capabilities },
      { trait_type: "passport_verified", value: passportVerified },
      { trait_type: "receipt_count", value: String(receiptCount) },
    ],
  };

  const pumpfunCreateParams = {
    name: `AGENT: ${agentName}`,
    symbol,
    description,
    imageUri,
    // Optional social links — caller can override after receiving the object
    twitter: undefined as string | undefined,
    telegram: undefined as string | undefined,
    website: opts.x402PassportPda
      ? `https://dna.parad0x.io/agents/${agentId}`
      : `https://dna.parad0x.io/agents/${agentId}`,
    // No initial buy from launcher by default — keeps launch fair
    initialBuyLamports: 0,
    // PumpFun standard virtual reserves at launch
    virtualSolReserves: 30_000_000_000, // 30 SOL in lamports
    virtualTokenReserves: 1_073_000_191, // PumpFun default token reserve
    // Caller must upload metadata JSON to IPFS and fill this field
    metadataUri: `https://dna.parad0x.io/metadata/${agentId}.json`,
  };

  return {
    metadata,
    pumpfunCreateParams,
    // ~0.01 SOL mint + ~0.01 SOL Metaplex metadata rent
    estimatedCostSol: 0.02,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard entry
// ---------------------------------------------------------------------------

/**
 * LeaderboardEntry is the shape returned by the discovery/ranking endpoint.
 * Rank is populated by the caller after sorting the full set by marketCapUsdc.
 *
 * Score formula:
 *   score = 0.6 * normalized_mcap + 0.4 * normalized_receipts
 *
 * Both inputs are normalized to [0, 1] against the full leaderboard set
 * before the composite score is computed.  This means a high-receipt-count
 * agent with modest market cap can still rank well — work quality matters.
 */
export interface LeaderboardEntry {
  /** Position on the leaderboard, 1-indexed. Populated externally. */
  rank: number;

  /** MCP-registered agent identifier. */
  agentId: string;

  /** Ticker symbol derived from agentId. */
  symbol: string;

  /** Current market cap in USDC whole dollars. */
  marketCapUsdc: number;

  /** Total x402 receipts earned by this agent across all tasks. */
  receiptCount: number;

  /** Total USDC earned by this agent via x402 receipts. */
  totalEarned: number;

  /**
   * Composite score in [0, 1].
   * 0.6 * normalized_mcap + 0.4 * normalized_receipts.
   * Higher is better.
   */
  score: number;
}

/**
 * Build a leaderboard entry for an agent token.
 *
 * Normalization is relative: pass maxMarketCap and maxReceiptCount from the
 * full leaderboard set so scores are comparable across agents.
 *
 * @param token           The AgentToken record.
 * @param receiptCount    How many x402 receipts this agent has earned.
 * @param totalEarned     Total USDC earned via x402 receipts.
 * @param maxMarketCap    Highest marketCapUsdc in the full leaderboard set (for normalization).
 * @param maxReceiptCount Highest receiptCount in the full leaderboard set (for normalization).
 * @returns               A LeaderboardEntry with rank set to 0 (caller fills rank after sort).
 */
export function buildLeaderboardEntry(
  token: AgentToken,
  receiptCount: number,
  totalEarned: number,
  maxMarketCap = 1,
  maxReceiptCount = 1
): LeaderboardEntry {
  const marketCapUsdc = token.marketCapUsdc ?? 0;

  const normalizedMcap =
    maxMarketCap > 0 ? Math.min(marketCapUsdc / maxMarketCap, 1) : 0;
  const normalizedReceipts =
    maxReceiptCount > 0 ? Math.min(receiptCount / maxReceiptCount, 1) : 0;

  const score =
    Math.round((0.6 * normalizedMcap + 0.4 * normalizedReceipts) * 1e6) / 1e6;

  const symbol = token.agentId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 6)
    .toUpperCase();

  return {
    rank: 0, // caller assigns rank after sorting the full leaderboard
    agentId: token.agentId,
    symbol,
    marketCapUsdc,
    receiptCount,
    totalEarned,
    score,
  };
}

// ---------------------------------------------------------------------------
// Creator fee share estimator
// ---------------------------------------------------------------------------

/**
 * Estimate daily passive income for an agent creator.
 *
 * PumpFun charges a 1% trading fee on every swap.  Creators receive
 * feePercent (default 90%) of that fee.
 *
 * Example at $10k daily volume:
 *   $10,000 * 0.01 fee * 0.9 creator share = $90 / day passive income.
 *
 * @param tradingVolumeUsdc  Total USDC trading volume in the period (usually 24 h).
 * @param feePercent         Creator's share of the 1% PumpFun fee, expressed as
 *                           a fraction in (0, 1].  Default: 0.9 (90%).
 * @returns                  Creator earnings in USDC for the period.
 */
export function estimateCreatorFeeShare(
  tradingVolumeUsdc: number,
  feePercent = 0.9
): number {
  const PUMPFUN_FEE_RATE = 0.01; // 1% PumpFun trading fee
  return tradingVolumeUsdc * PUMPFUN_FEE_RATE * feePercent;
}
