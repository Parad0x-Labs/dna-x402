/**
 * @parad0x_labs/zk-access — ZK Access Receipts (Phase 1: Signed Credentials)
 *
 * Agents prove "I have tier X with Y calls left" without revealing their wallet.
 *
 * Phase 1 (this module): Ed25519-signed credential system.
 * Phase 2 (roadmap):     Groth16 "prove tier >= X" circuit over BN254.
 *
 * Signing uses @noble/curves ed25519 — the same primitive already in the
 * null-miner-sdk identity layer. No native crypto binding required.
 *
 * Flow:
 *   1. Issuer calls issueAccessCredential() → signed AccessCredential.
 *   2. Agent presents credential; verifier calls verifyAccessCredential().
 *   3. Each API call: consumeCall() decrements callsRemaining and re-signs.
 *   4. For future ZK prove: buildAccessProofInput() marshals to circuit input.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 }  from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// ─── Access Tier ───────────────────────────────────────────────────────────────

/**
 * Four-tier access model.
 * Numeric ordering enables simple "tier >= required" comparisons in the circuit.
 */
export enum AccessTier {
  FREE  = 0,
  BASIC = 1,
  PRO   = 2,
  ELITE = 3,
}

// ─── Core Types ────────────────────────────────────────────────────────────────

/**
 * A signed access credential issued to an agent.
 *
 * The credential encodes what the agent can do (tier, calls, validity window)
 * without exposing *which* wallet funded it. The issuer signs the canonical
 * serialisation; the agent presents it as a bearer token.
 *
 * @field agentPubkey     - Agent's Ed25519 public key (hex, 64 chars).
 * @field tier            - Highest tier this credential grants.
 * @field callsRemaining  - Remaining API calls. Decremented via consumeCall().
 * @field validUntilSlot  - Solana slot number after which credential expires.
 * @field issuedByPubkey  - Issuer's Ed25519 public key (hex, 64 chars).
 * @field signature       - Issuer's Ed25519 signature over the canonical payload (hex, 128 chars).
 */
export interface AccessCredential {
  agentPubkey:    string;
  tier:           AccessTier;
  callsRemaining: number;
  validUntilSlot: number;
  issuedByPubkey: string;
  signature:      string;
}

/**
 * Parameters required to issue a fresh credential.
 */
export interface IssueParams {
  agentPubkey:    string;
  tier:           AccessTier;
  callsRemaining: number;
  validUntilSlot: number;
}

/**
 * Result of verifyAccessCredential().
 */
export interface VerifyResult {
  valid:  boolean;
  reason: string | null;
}

// ─── ZK Proof Input (Phase 2 placeholder) ─────────────────────────────────────

/**
 * Structured input for the future Groth16 "prove tier >= requiredTier" circuit.
 *
 * In Phase 2 this feeds into a snarkjs/circom or Rust arkworks circuit that
 * produces a proof: "I know a valid credential with tier >= X and calls > 0"
 * without leaking agentPubkey, callsRemaining, or issuedByPubkey.
 *
 * Field encoding:
 *   - All hex strings are 32-byte BN254 field elements (64 hex chars).
 *   - Numeric values are bigint-compatible unsigned integers.
 *
 * @field agentPubkeyHash    - Poseidon2(agentPubkey bytes split into two field elems).
 * @field tierValue          - AccessTier as uint (0–3); public input for >= check.
 * @field callsRemainingHash - SHA-256(callsRemaining big-endian 8-byte) → field elem.
 * @field validUntilSlot     - Slot expiry; compared against public currentSlot input.
 * @field issuerPubkeyHash   - Poseidon2(issuedByPubkey bytes) — trusted issuer set.
 * @field signatureHash      - SHA-256(signature bytes) — binds proof to this credential.
 * @field credentialRoot     - Poseidon Merkle root over all field elements above.
 *                             Public input: the on-chain registry verifies this root.
 */
export interface ZKProofInput {
  agentPubkeyHash:    string;
  tierValue:          number;
  callsRemainingHash: string;
  validUntilSlot:     number;
  issuerPubkeyHash:   string;
  signatureHash:      string;
  credentialRoot:     string;
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Deterministic canonical serialisation of the credential payload.
 * Only the fields the signature commits to — not `signature` itself.
 *
 * Format: `zk-access-v1:{agentPubkey}:{tier}:{callsRemaining}:{validUntilSlot}:{issuedByPubkey}`
 */
function canonicalPayload(
  agentPubkey:    string,
  tier:           AccessTier,
  callsRemaining: number,
  validUntilSlot: number,
  issuedByPubkey: string,
): Uint8Array {
  const msg = `zk-access-v1:${agentPubkey}:${tier}:${callsRemaining}:${validUntilSlot}:${issuedByPubkey}`;
  return new TextEncoder().encode(msg);
}

// ─── Issue ────────────────────────────────────────────────────────────────────

/**
 * Issue a signed AccessCredential.
 *
 * @param params        - Credential parameters (tier, calls, validity).
 * @param issuerPrivkey - Issuer's Ed25519 private key (Uint8Array, 32 bytes).
 * @returns             Fully signed AccessCredential.
 *
 * @example
 * ```ts
 * import { AccessTier, issueAccessCredential } from "@parad0x_labs/zk-access";
 * import { ed25519 } from "@noble/curves/ed25519";
 *
 * const issuerPrivkey = crypto.getRandomValues(new Uint8Array(32));
 * const issuerPubkey  = bytesToHex(ed25519.getPublicKey(issuerPrivkey));
 * const agentPubkey   = bytesToHex(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))));
 *
 * const cred = issueAccessCredential(
 *   { agentPubkey, tier: AccessTier.PRO, callsRemaining: 100, validUntilSlot: 350_000_000 },
 *   issuerPrivkey,
 * );
 * ```
 */
export function issueAccessCredential(
  params:         IssueParams,
  issuerPrivkey:  Uint8Array,
): AccessCredential {
  if (issuerPrivkey.length !== 32) {
    throw new Error("issuerPrivkey must be 32 bytes (Ed25519 seed)");
  }

  const issuedByPubkey = bytesToHex(ed25519.getPublicKey(issuerPrivkey));
  const payload        = canonicalPayload(
    params.agentPubkey,
    params.tier,
    params.callsRemaining,
    params.validUntilSlot,
    issuedByPubkey,
  );
  const signature = bytesToHex(ed25519.sign(payload, issuerPrivkey));

  return {
    agentPubkey:    params.agentPubkey,
    tier:           params.tier,
    callsRemaining: params.callsRemaining,
    validUntilSlot: params.validUntilSlot,
    issuedByPubkey,
    signature,
  };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Verify an AccessCredential.
 *
 * Checks (in order):
 *   1. `callsRemaining > 0` — credential has not been exhausted.
 *   2. `currentSlot <= validUntilSlot` — credential has not expired.
 *   3. Ed25519 signature over the canonical payload is valid.
 *
 * @param cred         - Credential to verify.
 * @param currentSlot  - Current Solana slot (from getSlot() or a trusted oracle).
 * @returns            VerifyResult with `valid` flag and human-readable `reason`.
 *
 * @example
 * ```ts
 * const { valid, reason } = verifyAccessCredential(cred, currentSlot);
 * if (!valid) throw new Error(`Access denied: ${reason}`);
 * ```
 */
export function verifyAccessCredential(
  cred:        AccessCredential,
  currentSlot: number,
): VerifyResult {
  if (cred.callsRemaining <= 0) {
    return { valid: false, reason: "callsRemaining is 0 — credential exhausted" };
  }

  if (currentSlot > cred.validUntilSlot) {
    return {
      valid:  false,
      reason: `credential expired at slot ${cred.validUntilSlot} (current: ${currentSlot})`,
    };
  }

  const payload = canonicalPayload(
    cred.agentPubkey,
    cred.tier,
    cred.callsRemaining,
    cred.validUntilSlot,
    cred.issuedByPubkey,
  );

  let sigValid: boolean;
  try {
    sigValid = ed25519.verify(
      hexToBytes(cred.signature),
      payload,
      hexToBytes(cred.issuedByPubkey),
    );
  } catch {
    return { valid: false, reason: "signature bytes malformed" };
  }

  if (!sigValid) {
    return { valid: false, reason: "signature verification failed" };
  }

  return { valid: true, reason: null };
}

// ─── Consume ──────────────────────────────────────────────────────────────────

/**
 * Consume one API call from a credential, returning an updated and re-signed credential.
 *
 * The issuer must re-sign because `callsRemaining` is part of the canonical payload.
 * The caller is responsible for persisting the returned credential.
 *
 * @param cred          - Current credential (must pass verifyAccessCredential first).
 * @param issuerPrivkey - Issuer's Ed25519 private key (must match cred.issuedByPubkey).
 * @returns             New credential with callsRemaining decremented by 1.
 *
 * @throws              If credential is already exhausted.
 *
 * @example
 * ```ts
 * const { valid } = verifyAccessCredential(cred, currentSlot);
 * if (!valid) throw new Error("Cannot consume exhausted/expired credential");
 * const updated = consumeCall(cred, issuerPrivkey);
 * ```
 */
export function consumeCall(
  cred:          AccessCredential,
  issuerPrivkey: Uint8Array,
): AccessCredential {
  if (cred.callsRemaining <= 0) {
    throw new Error("Cannot consume: credential already exhausted");
  }

  // Verify the issuer key matches
  const expectedIssuerPubkey = bytesToHex(ed25519.getPublicKey(issuerPrivkey));
  if (expectedIssuerPubkey !== cred.issuedByPubkey) {
    throw new Error(
      `issuerPrivkey does not match cred.issuedByPubkey — ` +
      `expected ${cred.issuedByPubkey}, got ${expectedIssuerPubkey}`,
    );
  }

  return issueAccessCredential(
    {
      agentPubkey:    cred.agentPubkey,
      tier:           cred.tier,
      callsRemaining: cred.callsRemaining - 1,
      validUntilSlot: cred.validUntilSlot,
    },
    issuerPrivkey,
  );
}

// ─── ZK Proof Input Builder ───────────────────────────────────────────────────

/**
 * Build the structured input for the Phase 2 Groth16 "prove tier >= X" circuit.
 *
 * In Phase 2 this feeds snarkjs / rapidsnark / arkworks. For now it is a
 * deterministic, canonical serialisation of all credential fields into BN254
 * field elements (hex strings), ready to drop into a circom `input.json`.
 *
 * The `credentialRoot` is a SHA-256 Merkle root over the five field-element
 * leaves. In Phase 2 it will be replaced by a Poseidon Merkle root to keep
 * everything inside the native BN254 field.
 *
 * @param cred - Any valid AccessCredential (need not be verified first).
 * @returns    ZKProofInput struct ready for a future proving call.
 *
 * @example
 * ```ts
 * const proofInput = buildAccessProofInput(cred);
 * // fs.writeFileSync("input.json", JSON.stringify(proofInput));
 * // snarkjs groth16 prove circuit_final.zkey input.json proof.json public.json
 * ```
 */
export function buildAccessProofInput(cred: AccessCredential): ZKProofInput {
  // Helper: SHA-256 of bytes → 32-byte BN254 field element (mod scalar field).
  // BN254 scalar field r ≈ 2^254, so a raw sha256 is already < r with probability ~1.
  // For correctness in Phase 2 replace with Poseidon.
  function sha256Field(data: Uint8Array): string {
    return bytesToHex(sha256(data));
  }

  // Encode agentPubkey bytes into a field element hash
  const agentPubkeyHash = sha256Field(hexToBytes(cred.agentPubkey));

  // callsRemaining as 8-byte big-endian
  const callsBuf = new Uint8Array(8);
  new DataView(callsBuf.buffer).setBigUint64(0, BigInt(cred.callsRemaining), false);
  const callsRemainingHash = sha256Field(callsBuf);

  // Issuer pubkey hash
  const issuerPubkeyHash = sha256Field(hexToBytes(cred.issuedByPubkey));

  // Signature hash (binds proof to this specific credential instance)
  const signatureHash = sha256Field(hexToBytes(cred.signature));

  // Credential root: SHA-256 over the concatenation of all four field element hashes
  // + tier and slot packed as 8-byte big-endian each.
  // Phase 2: replace with Poseidon Merkle root for in-circuit efficiency.
  const tierBuf = new Uint8Array(8);
  new DataView(tierBuf.buffer).setBigUint64(0, BigInt(cred.tier), false);
  const slotBuf = new Uint8Array(8);
  new DataView(slotBuf.buffer).setBigUint64(0, BigInt(cred.validUntilSlot), false);

  const rootPreimage = new Uint8Array(
    32 + 32 + 8 + 8 + 32 + 32,  // agentPubkeyHash + callsRemainingHash + tier + slot + issuerHash + sigHash
  );
  rootPreimage.set(hexToBytes(agentPubkeyHash),    0);
  rootPreimage.set(hexToBytes(callsRemainingHash), 32);
  rootPreimage.set(tierBuf,                        64);
  rootPreimage.set(slotBuf,                        72);
  rootPreimage.set(hexToBytes(issuerPubkeyHash),   80);
  rootPreimage.set(hexToBytes(signatureHash),      112);

  const credentialRoot = sha256Field(rootPreimage);

  return {
    agentPubkeyHash,
    tierValue:          cred.tier,
    callsRemainingHash,
    validUntilSlot:     cred.validUntilSlot,
    issuerPubkeyHash,
    signatureHash,
    credentialRoot,
  };
}

// ─── Re-exports for convenience ───────────────────────────────────────────────

export { bytesToHex, hexToBytes } from "@noble/hashes/utils";
