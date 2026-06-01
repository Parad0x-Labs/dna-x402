/**
 * @parad0x_labs/agent-reputation
 *
 * Reputation = ZK proof over receipt history.
 * Agent proves stats without revealing every buyer or every receipt.
 * Anchored commitment on Solana via receipt_anchor.
 * Phase 2: Groth16 circuit over the witness.
 *
 * Architecture:
 *   1. Agent accumulates receipts off-chain (from x402 payments / task completions).
 *   2. Agent hashes a ReputationClaim struct -> commitment.
 *   3. Commitment is anchored on Solana (receipt_anchor program).
 *   4. Verifier fetches the on-chain commitment and checks it matches the claim.
 *   5. Phase 2: ZKReputationWitness feeds a Groth16 circuit so the agent proves
 *      stats (successRate, avgLatencyMs, etc.) without revealing receiptHashes
 *      or agentSecret to the verifier.
 *
 * Privacy model:
 *   - agentPassportPda ties reputation to a Dark NULL identity (secp256k1 or secp256r1 vault).
 *   - No buyer addresses, no receipt payloads are revealed in the claim.
 *   - The ZK witness keeps individual outcomes private; only aggregates are proven.
 */

import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Core claim — what an agent can prove about itself
// ---------------------------------------------------------------------------

/**
 * ReputationClaim is the public statement an agent makes about its track record.
 * It is bound to an Agent Passport PDA (from dark_secp256k1_auth or
 * dark_secp256r1_vault) so identity stays pseudonymous but verifiable.
 */
export interface ReputationClaim {
  /** PDA of the agent's passport (dark_secp256k1_auth or dark_secp256r1_vault). */
  agentPassportPda: string;

  /** Total number of tasks / x402 payments completed. */
  totalDeliveries: number;

  /** Fraction of deliveries accepted without dispute, scaled 0–100. */
  successRate: number;

  /** Mean round-trip latency in milliseconds across sampled deliveries. */
  avgLatencyMs: number;

  /** Number of receipts included in the aggregated stats (proof of sample size). */
  sampleSize: number;

  /** Most recent Solana slot at which the agent was observed active. */
  lastActiveSlot: number;

  /**
   * True if no custody violations (e.g., fund misrouting, timeout slashing)
   * have been recorded against this passport on-chain.
   */
  noCustodyViolations: boolean;
}

// ---------------------------------------------------------------------------
// On-chain commitment
// ---------------------------------------------------------------------------

/**
 * Produce the SHA-256 commitment for a ReputationClaim.
 *
 * The commitment is a deterministic 32-byte digest of the canonically
 * serialised claim.  This is what gets anchored on Solana so that any
 * verifier can re-derive and check it without seeing private receipt data.
 *
 * Canonicalisation: fields are sorted alphabetically so that field-order
 * differences in the caller's object do not produce different hashes.
 */
export function buildReputationCommitment(claim: ReputationClaim): string {
  const canonical = JSON.stringify(claim, Object.keys(claim).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// On-chain verification
// ---------------------------------------------------------------------------

/**
 * Verify that a ReputationClaim commitment is anchored on Solana.
 *
 * Looks up the receipt_anchor account at `anchorTx` and checks that the
 * commitment stored in its data matches buildReputationCommitment(claim).
 *
 * This is a Phase-1 verification (hash match against on-chain data).
 * Phase 2 will replace this with a Groth16 proof verification instruction.
 *
 * @param claim      The claim to verify.
 * @param anchorTx   Public key (base58) of the on-chain receipt_anchor account
 *                   that is expected to hold the commitment.
 * @param connection A live Solana RPC connection.
 * @returns          true if the commitment matches; false otherwise.
 */
export async function verifyReputationClaim(
  claim: ReputationClaim,
  anchorTx: string,
  connection: Connection
): Promise<boolean> {
  const expected = buildReputationCommitment(claim);

  let accountInfo;
  try {
    accountInfo = await connection.getAccountInfo(new PublicKey(anchorTx));
  } catch {
    return false;
  }

  if (!accountInfo || !accountInfo.data || accountInfo.data.length < 32) {
    return false;
  }

  // The receipt_anchor program stores the raw 32-byte commitment at offset 0
  // (after any Anchor discriminator — skip the first 8 bytes if present).
  const DISCRIMINATOR_LEN = 8;
  const commitmentBytes = accountInfo.data.slice(
    DISCRIMINATOR_LEN,
    DISCRIMINATOR_LEN + 32
  );
  const onChainHex = Buffer.from(commitmentBytes).toString("hex");

  return onChainHex === expected;
}

// ---------------------------------------------------------------------------
// ZK-ready witness (Phase 2 placeholder)
// ---------------------------------------------------------------------------

/**
 * ZKReputationWitness holds the private inputs for the future Groth16 circuit.
 *
 * In Phase 2 the prover will:
 *   1. Load all receiptHashes and outcomeScores from local storage.
 *   2. Derive agentSecret from their Agent Passport keypair.
 *   3. Feed this witness into the Groth16 prover (snarkjs / bellman / halo2).
 *   4. Publish the proof + public inputs (the ReputationClaim fields) on-chain.
 *   5. Any verifier can check the proof without seeing receiptHashes or agentSecret.
 *
 * The circuit will enforce:
 *   - len(receiptHashes) == sampleSize
 *   - mean(outcomeScores) >= successRate threshold
 *   - Merkle root of receiptHashes matches on-chain commitment root
 *   - agentSecret binds the witness to a specific Agent Passport PDA
 */
export interface ZKReputationWitness {
  /**
   * Ordered list of SHA-256 hashes of individual x402 receipts.
   * Private — never revealed to the verifier.
   */
  receiptHashes: string[];

  /**
   * Per-receipt outcome scores in [0, 100].
   * Aggregated into successRate in the public claim.
   * Private — individual scores are not disclosed.
   */
  outcomeScores: number[];

  /**
   * Secret scalar derived from the agent's identity keypair.
   * Binds the witness to the Agent Passport PDA without revealing the key.
   * Private — zero-knowledge with respect to the verifier.
   */
  agentSecret: string;
}
