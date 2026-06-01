/**
 * @parad0x_labs/stream-income
 *
 * Passive income streaming: agents earn from x402 calls, proceeds auto-stream
 * to NULL stakers / vault addresses via Solana SPL token transfers and
 * Streamflow schedules.
 *
 * Architecture:
 *   1. Agent processes x402 calls — each call earns ratePerCall atomic USDC.
 *   2. recordEarning() accumulates earnings in a StreamIncomeSession.
 *   3. shouldStream() fires when pendingAmount >= minStreamAmount AND the
 *      stream interval has elapsed.
 *   4. buildStreamInstruction() builds a Solana SPL token transfer from the
 *      agent wallet to the beneficiary (NULL staker / vault).
 *   5. buildStreamflowSchedule() produces a Streamflow-compatible config for
 *      fully automated on-chain streaming.
 *   6. buildPassiveIncomeReceipt() anchors the period summary — sessionId,
 *      totals, beneficiary — as a tamper-evident PassiveIncomeReceipt.
 *
 * Three contracts, zero wiring (TDL #14):
 *   - receipt_anchor (Solana): anchors PassiveIncomeReceipt hashes on-chain.
 *   - SPL Token program: executes the USDC stream transfers.
 *   - Streamflow program: manages auto-streaming schedules.
 *
 * Privacy / trust model:
 *   - Agent wallet is the fee payer for all stream transactions.
 *   - Beneficiary is a NULL staker vault — no custodian in the middle.
 *   - receiptHash in PassiveIncomeReceipt ties each period to its x402 receipts.
 */

import { createHash } from "crypto";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// SPL Token program IDs (stable across clusters)
// ---------------------------------------------------------------------------

const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// ---------------------------------------------------------------------------
// StreamIncomeConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a streaming income session.
 *
 * Ties together:
 *   - which agent is earning (agentPubkey)
 *   - who receives the proceeds (beneficiary — a NULL staker or vault address)
 *   - the per-call rate and streaming cadence
 */
export interface StreamIncomeConfig {
  /** Solana base58 public key of the earning agent. */
  agentPubkey: string;

  /**
   * Solana base58 public key of the beneficiary.
   * Typically the NULL staker's wallet or a shared vault PDA.
   */
  beneficiary: string;

  /**
   * Earnings per x402 call, expressed in atomic units of the chosen currency.
   * e.g. 1000 = 0.001 USDC (USDC has 6 decimals).
   */
  ratePerCall: number;

  /**
   * Minimum seconds between stream disbursements.
   * Prevents spammy micro-transfers — wait this long before streaming again
   * even if pendingAmount crosses minStreamAmount.
   */
  streamIntervalSeconds: number;

  /**
   * Minimum atomic amount that must accumulate before a stream is sent.
   * e.g. 500_000 = 0.50 USDC — don't stream dust.
   */
  minStreamAmount: number;

  /** Currency being streamed. USDC = 6 decimals; SOL = 9 decimals. */
  currency: "USDC" | "SOL";
}

// ---------------------------------------------------------------------------
// StreamIncomeSession
// ---------------------------------------------------------------------------

/**
 * Live state of an active streaming income session.
 *
 * Created once per agent / beneficiary pairing and updated on every x402 call
 * and every stream disbursement.
 */
export interface StreamIncomeSession {
  /** UUID-style identifier for this session. */
  sessionId: string;

  /** The config that governs this session. */
  config: StreamIncomeConfig;

  /** Total atomic units earned since the session started. */
  totalEarned: bigint;

  /** Total atomic units already disbursed to the beneficiary this session. */
  totalStreamed: bigint;

  /**
   * Earned but not yet streamed.
   * Invariant: pendingAmount === totalEarned - totalStreamed
   */
  pendingAmount: bigint;

  /** Total number of x402 calls recorded this session. */
  callCount: number;

  /** Unix timestamp (seconds) of the last successful stream disbursement. */
  lastStreamAt: number;

  /** Solana transaction signatures for each stream payment made this session. */
  streamTxs: string[];
}

// ---------------------------------------------------------------------------
// 3. recordEarning
// ---------------------------------------------------------------------------

/**
 * Record a single x402 call earning into the session.
 *
 * Increments callCount, adds amountAtomic to totalEarned and pendingAmount.
 * receiptHash is accepted for future audit trails but not stored in-session
 * (callers should persist it to their own receipt store).
 *
 * Returns a new session object — sessions are treated as immutable value types.
 *
 * @param session       The current session state.
 * @param amountAtomic  Atomic units earned for this call (usually config.ratePerCall).
 * @param receiptHash   SHA-256 hex hash of the x402 receipt (for audit).
 * @returns             Updated session with pending earnings incremented.
 */
export function recordEarning(
  session: StreamIncomeSession,
  amountAtomic: bigint,
  receiptHash: string
): StreamIncomeSession {
  // receiptHash is unused here — callers store it in their own receipt log.
  // We validate its format so callers catch mistakes early.
  if (!/^[0-9a-f]{64}$/i.test(receiptHash)) {
    throw new Error(
      `recordEarning: receiptHash must be a 64-char hex string, got "${receiptHash.slice(0, 20)}…"`
    );
  }

  return {
    ...session,
    totalEarned:   session.totalEarned   + amountAtomic,
    pendingAmount: session.pendingAmount + amountAtomic,
    callCount:     session.callCount     + 1,
  };
}

// ---------------------------------------------------------------------------
// 4. shouldStream
// ---------------------------------------------------------------------------

/**
 * Decide whether a stream disbursement should be triggered now.
 *
 * Returns true when BOTH conditions hold:
 *   1. pendingAmount >= config.minStreamAmount   (enough to be worth sending)
 *   2. (now - lastStreamAt) >= config.streamIntervalSeconds  (cooldown elapsed)
 *
 * @param session  Current session state.
 * @returns        true if a stream should be sent now.
 */
export function shouldStream(session: StreamIncomeSession): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const enoughPending =
    session.pendingAmount >= BigInt(session.config.minStreamAmount);
  const cooldownElapsed =
    nowSec - session.lastStreamAt >= session.config.streamIntervalSeconds;

  return enoughPending && cooldownElapsed;
}

// ---------------------------------------------------------------------------
// 5. buildStreamInstruction
// ---------------------------------------------------------------------------

/**
 * Build a Solana SPL token transfer instruction that sends pendingAmount from
 * the agent's associated token account to the beneficiary's associated token
 * account.
 *
 * This is a Phase-1 helper — it constructs the instruction data in the SPL
 * Transfer format (discriminator 3 + u64 LE amount).  Callers are responsible
 * for:
 *   - Resolving the correct ATAs for agent and beneficiary.
 *   - Signing and submitting the transaction.
 *   - Updating session.totalStreamed, session.pendingAmount, and
 *     session.lastStreamAt after confirmation.
 *
 * @param session     Current session (provides config + pendingAmount).
 * @param connection  Live Solana RPC connection (used to look up ATAs).
 * @returns           { ix: TransactionInstruction, amount: bigint }
 */
export async function buildStreamInstruction(
  session: StreamIncomeSession,
  connection: Connection
): Promise<{ ix: TransactionInstruction; amount: bigint }> {
  const { agentPubkey, beneficiary } = session.config;
  const amount = session.pendingAmount;

  if (amount <= 0n) {
    throw new Error("buildStreamInstruction: pendingAmount is 0 — nothing to stream");
  }

  const agentKey      = new PublicKey(agentPubkey);
  const beneficiaryKey = new PublicKey(beneficiary);

  // Derive associated token accounts (ATA) using standard seeds.
  // ATA = PDA([owner, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM)
  // For SPL we use findProgramAddress with the well-known seeds.
  const USDC_MINT_MAINNET = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bSo"
  );

  const [agentAta] = PublicKey.findProgramAddressSync(
    [agentKey.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), USDC_MINT_MAINNET.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  const [beneficiaryAta] = PublicKey.findProgramAddressSync(
    [beneficiaryKey.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), USDC_MINT_MAINNET.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  );

  // SPL Token Transfer instruction layout:
  //   [0]      = discriminator 3 (Transfer)
  //   [1..8]   = amount as u64 LE
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);

  const ix = new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: agentAta,       isSigner: false, isWritable: true  }, // source
      { pubkey: beneficiaryAta, isSigner: false, isWritable: true  }, // destination
      { pubkey: agentKey,       isSigner: true,  isWritable: false }, // authority
    ],
    data,
  });

  return { ix, amount };
}

// ---------------------------------------------------------------------------
// 6. buildStreamflowSchedule
// ---------------------------------------------------------------------------

/**
 * Build a Streamflow-compatible stream schedule object.
 *
 * Streamflow (https://streamflow.finance) is the leading Solana stream
 * payments protocol.  This helper returns a plain object matching the
 * CreateStreamParams shape expected by the Streamflow SDK so callers can
 * pass it directly to `streamClient.create(schedule)`.
 *
 * The schedule is calibrated around an estimated call rate.  Callers should
 * tune estimatedCallsPerDay based on their observed throughput.
 *
 * @param config               StreamIncomeConfig for this session.
 * @param estimatedCallsPerDay Expected number of x402 calls per day (default 10_000).
 * @returns                    Streamflow CreateStreamParams-compatible object.
 */
export function buildStreamflowSchedule(
  config: StreamIncomeConfig,
  estimatedCallsPerDay = 10_000
): object {
  const dailyAmountAtomic = config.ratePerCall * estimatedCallsPerDay;

  return {
    /** Streamflow field: receiving wallet / NULL staker vault */
    recipient: config.beneficiary,

    /** Amount to stream per `period` (one period = one day). */
    amount: dailyAmountAtomic,

    /**
     * Period in seconds.  86400 = 24 hours.
     * Streamflow will release `amount` tokens every `period` seconds.
     */
    period: 86400,

    /**
     * Cliff: 0 — start streaming immediately, no lock-up.
     * NULL stakers earn from block 0.
     */
    cliff: 0,

    /**
     * Cliff amount: 0 — no lump-sum cliff payment.
     */
    cliffAmount: 0,

    /** Token mint (USDC mainnet). */
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

    /** Stream starts immediately (Unix timestamp seconds). */
    start: Math.floor(Date.now() / 1000),

    /** Stream name for Streamflow UI. */
    name: `NULL staker passive income — ${config.agentPubkey.slice(0, 8)}`,

    /** Whether the stream can be cancelled by the sender (agent). */
    canTopup: true,

    /** Whether the stream is transferable by the recipient. */
    transferableBySender: false,
    transferableByRecipient: false,

    /** Streamflow metadata for protocol indexing. */
    partner: "parad0x_labs_dna_x402",
  };
}

// ---------------------------------------------------------------------------
// 7. PassiveIncomeReceipt
// ---------------------------------------------------------------------------

/**
 * Tamper-evident summary of a streaming income period.
 *
 * Built at the end of a session (or at regular checkpoints) and anchored on
 * Solana via the receipt_anchor program.  The receiptHash is the SHA-256 of
 * all other fields — any mutation of the record invalidates the hash.
 */
export interface PassiveIncomeReceipt {
  /** The session this receipt covers. */
  sessionId: string;

  /** Total atomic units earned across the period. */
  totalEarned: bigint;

  /** Total atomic units streamed to the beneficiary across the period. */
  totalStreamed: bigint;

  /** NULL staker / vault address that received the streams. */
  beneficiary: string;

  /** Unix timestamp (seconds) when the period started (session creation). */
  periodStart: number;

  /** Unix timestamp (seconds) when this receipt was built. */
  periodEnd: number;

  /**
   * SHA-256 hex digest of:
   *   sessionId + totalEarned + totalStreamed + beneficiary + periodStart + periodEnd
   * Anchored on Solana via receipt_anchor to prove the record is unmodified.
   */
  receiptHash: string;
}

// ---------------------------------------------------------------------------
// 8. buildPassiveIncomeReceipt
// ---------------------------------------------------------------------------

/**
 * Build a PassiveIncomeReceipt from the current session state.
 *
 * The receiptHash is computed over all other fields so that any later
 * modification of the receipt is detectable.  Anchor this hash on Solana
 * (via receipt_anchor) to create a permanent, verifiable record.
 *
 * @param session     Current session.
 * @param periodStart Unix timestamp (seconds) of the period start.
 * @returns           A complete, hash-sealed PassiveIncomeReceipt.
 */
export function buildPassiveIncomeReceipt(
  session: StreamIncomeSession,
  periodStart: number
): PassiveIncomeReceipt {
  const periodEnd = Math.floor(Date.now() / 1000);

  const preimage = [
    session.sessionId,
    session.totalEarned.toString(),
    session.totalStreamed.toString(),
    session.config.beneficiary,
    String(periodStart),
    String(periodEnd),
  ].join("|");

  const receiptHash = createHash("sha256").update(preimage, "utf8").digest("hex");

  return {
    sessionId:    session.sessionId,
    totalEarned:  session.totalEarned,
    totalStreamed: session.totalStreamed,
    beneficiary:  session.config.beneficiary,
    periodStart,
    periodEnd,
    receiptHash,
  };
}

// ---------------------------------------------------------------------------
// Session factory helper (convenience — not in spec but needed by demos)
// ---------------------------------------------------------------------------

/**
 * Create a fresh StreamIncomeSession from a config.
 *
 * @param config      StreamIncomeConfig governing this session.
 * @param sessionId   Optional pre-determined session ID (default: random hex).
 * @returns           A zeroed-out session ready for recordEarning() calls.
 */
export function createSession(
  config: StreamIncomeConfig,
  sessionId?: string
): StreamIncomeSession {
  const id = sessionId ?? createHash("sha256")
    .update(`${config.agentPubkey}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 32);

  return {
    sessionId:     id,
    config,
    totalEarned:   0n,
    totalStreamed:  0n,
    pendingAmount:  0n,
    callCount:      0,
    lastStreamAt:   Math.floor(Date.now() / 1000),
    streamTxs:      [],
  };
}
