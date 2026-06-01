/**
 * @parad0x_labs/x402-circuit — ZK Access Proof for x402 payment gating
 *
 * Proves "agent is authorized for tier X" without revealing:
 *   - the agent's wallet address
 *   - the agent's actual balance
 *   - the secret binding agent identity to the commitment
 *
 * Circuit: circuits/x402_access.circom (Circom + snarkjs, Groth16 BN254)
 * On-chain verifier: dark_bn254_gate (Solana mainnet, ~150k CU via alt_bn128_pairing)
 *
 * Proof system: Groth16 over BN254 (alt_bn128)
 * Public inputs: commitment, threshold, nullifier
 * Private inputs: secret, agent_id, balance, nonce
 *
 * Circuit relation:
 *   Poseidon(secret, agent_id) == commitment  [binding]
 *   Poseidon(secret, nonce)    == nullifier   [anti-replay]
 *   balance >= threshold                       [tier gate]
 *
 * Noir path: documented in docs/NOIR_X402_CIRCUIT.md (Sunspot toolchain, unaudited)
 * Circom path: working today with existing snarkjs + dark_bn254_gate infrastructure
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// ─── Public types ──────────────────────────────────────────────────────────────

/**
 * A Groth16 access proof that can be attached to an x402 payment header.
 *
 * All field values are hex-encoded 32-byte BN254 scalar field elements
 * (64 hex characters each). The `proof` field is the 256-byte Groth16 proof
 * encoded as a hex string (512 hex characters: A:G1 + B:G2 + C:G1).
 *
 * Attach to x402 requests in the `X-ZK-ACCESS` header as JSON.
 */
export interface AccessProof {
  /** Poseidon(secret, agent_id) — public binding (32 bytes hex) */
  commitment: string;
  /** Minimum balance threshold for the requested tier (32 bytes hex) */
  threshold: string;
  /** Poseidon(secret, nonce) — single-use anti-replay token (32 bytes hex) */
  nullifier: string;
  /** 256-byte Groth16 proof: A (G1, 64B) + B (G2, 128B) + C (G1, 64B), hex */
  proof: string;
  /** Public inputs array, ordered [commitment, threshold, nullifier] */
  publicInputs: string[];
}

/**
 * Raw input for the x402_access circuit (input.json for snarkjs fullprove).
 *
 * All field values are decimal strings (circom convention).
 * Pass directly to `snarkjs groth16 fullprove` or the `buildAccessProofInput`
 * helper to construct this from native JS types.
 */
export interface AccessProofInput {
  /** Public: Poseidon(secret, agent_id) as decimal string */
  commitment: string;
  /** Public: minimum balance threshold as decimal string */
  threshold: string;
  /** Public: Poseidon(secret, nonce) as decimal string */
  nullifier: string;
  /** Private: 32-byte random secret as decimal string (BN254 field element) */
  secret: string;
  /** Private: agent identity field element as decimal string */
  agent_id: string;
  /** Private: actual balance as decimal string */
  balance: string;
  /** Private: per-request nonce as decimal string (e.g. current Solana slot) */
  nonce: string;
}

/**
 * Result of an off-chain proof verification attempt.
 */
export interface VerifyResult {
  /** Whether the proof is structurally valid and public inputs are consistent */
  valid: boolean;
  /** Human-readable reason if invalid, null if valid */
  reason: string | null;
}

// ─── BN254 field arithmetic helpers ──────────────────────────────────────────

/**
 * BN254 scalar field order (r).
 * All field elements must be < r.
 */
const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Reduce a BigInt modulo the BN254 scalar field order.
 */
function fieldMod(n: bigint): bigint {
  return ((n % BN254_R) + BN254_R) % BN254_R;
}

/**
 * Convert a Uint8Array to a BN254 field element (BigInt, reduced mod r).
 */
function bytesToField(bytes: Uint8Array): bigint {
  let val = 0n;
  for (const b of bytes) {
    val = (val << 8n) | BigInt(b);
  }
  return fieldMod(val);
}

/**
 * Encode a BigInt field element as a 32-byte big-endian hex string (64 chars).
 */
function fieldToHex(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

// ─── Poseidon stub ────────────────────────────────────────────────────────────
// Production note: replace with a real Poseidon BN254 implementation
// (e.g. @iden3/js-crypto or babyjubjub-poseidon) before wiring to a live circuit.
// This stub uses SHA-256 with domain separation for deterministic test vectors.
// The on-chain circuit uses the real Poseidon, so off-chain inputs MUST use the
// same Poseidon implementation as the circuit or proof generation will fail.
//
// Compatible real implementations:
//   - circomlibjs: https://github.com/iden3/circomlibjs
//   - @noir-lang/barretenberg (for Noir path)

function poseidon2Stub(a: bigint, b: bigint): bigint {
  // Domain-separated SHA-256 used as a stub. Replace with real Poseidon for prod.
  const buf = new Uint8Array(65);
  buf[0] = 0xd0; // domain: x402-access
  const aBuf = hexToBytes(fieldToHex(a));
  const bBuf = hexToBytes(fieldToHex(b));
  buf.set(aBuf, 1);
  buf.set(bBuf, 33);
  return bytesToField(sha256(buf));
}

// ─── Input builder ────────────────────────────────────────────────────────────

/**
 * Build circuit input from native JS types.
 *
 * IMPORTANT: The `commitment` and `nullifier` values in the returned struct are
 * computed using a SHA-256 stub (not real Poseidon). For actual proof generation
 * with snarkjs, you MUST compute commitment and nullifier using the same Poseidon
 * implementation as the circom circuit (e.g. circomlibjs buildPoseidon()).
 *
 * This function is primarily useful for:
 *   1. Generating deterministic test vectors
 *   2. Constructing the full input shape before substituting real Poseidon values
 *
 * @param secret    32-byte random secret (Uint8Array or hex string)
 * @param agentId   Agent identity bytes (Uint8Array or hex string)
 * @param balance   Actual credit balance (number or bigint)
 * @param threshold Minimum balance for requested tier (number or bigint)
 * @param nonce     Per-request nonce, e.g. current Solana slot (number or bigint)
 * @returns         AccessProofInput ready for snarkjs fullprove (after real Poseidon substitution)
 */
export function buildAccessProofInput(
  secret: Uint8Array | string,
  agentId: Uint8Array | string,
  balance: number | bigint,
  threshold: number | bigint,
  nonce: number | bigint,
): AccessProofInput {
  const secretBytes = typeof secret === "string" ? hexToBytes(secret) : secret;
  const agentBytes  = typeof agentId === "string" ? hexToBytes(agentId) : agentId;

  const secretField = bytesToField(secretBytes);
  const agentField  = bytesToField(agentBytes);
  const nonceField  = fieldMod(BigInt(nonce));
  const balanceBig  = BigInt(balance);
  const threshBig   = BigInt(threshold);

  if (balanceBig < 0n || balanceBig >= 2n ** 64n) {
    throw new Error(`balance must be in [0, 2^64): got ${balanceBig}`);
  }
  if (threshBig < 0n || threshBig >= 2n ** 64n) {
    throw new Error(`threshold must be in [0, 2^64): got ${threshBig}`);
  }

  // Stub Poseidon — replace with circomlibjs buildPoseidon() for real proofs
  const commitment = poseidon2Stub(secretField, agentField);
  const nullifier  = poseidon2Stub(secretField, nonceField);

  return {
    commitment: commitment.toString(),
    threshold:  threshBig.toString(),
    nullifier:  nullifier.toString(),
    secret:     secretField.toString(),
    agent_id:   agentField.toString(),
    balance:    balanceBig.toString(),
    nonce:      nonceField.toString(),
  };
}

// ─── Proof encoding ───────────────────────────────────────────────────────────

/**
 * Encode a snarkjs Groth16 proof JSON (from proof.json + public.json) as an
 * AccessProof for use in x402 headers.
 *
 * The proof.json / public.json come from:
 *   snarkjs groth16 fullprove ... proof.json public.json
 *
 * @param proofJson   Parsed proof.json from snarkjs
 * @param publicJson  Parsed public.json from snarkjs (array of decimal strings)
 * @returns           AccessProof ready for X-ZK-ACCESS header
 */
export function encodeAccessProof(
  proofJson: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: string;
    curve: string;
  },
  publicJson: string[],
): AccessProof {
  if (publicJson.length < 3) {
    throw new Error(
      `Expected 3 public inputs [commitment, threshold, nullifier], got ${publicJson.length}`,
    );
  }

  // Encode proof points as big-endian 32-byte hex (matching dark_bn254_gate layout)
  function g1ToHex(point: [string, string, string]): string {
    const x = BigInt(point[0]).toString(16).padStart(64, "0");
    const y = BigInt(point[1]).toString(16).padStart(64, "0");
    return x + y; // 128 hex chars = 64 bytes
  }
  function g2ToHex(point: [[string, string], [string, string], [string, string]]): string {
    // G2 point: x = (x_imag, x_real), y = (y_imag, y_real)
    // Solana alt_bn128_pairing expects: x_imag || x_real || y_imag || y_real
    const xImag = BigInt(point[0][1]).toString(16).padStart(64, "0");
    const xReal = BigInt(point[0][0]).toString(16).padStart(64, "0");
    const yImag = BigInt(point[1][1]).toString(16).padStart(64, "0");
    const yReal = BigInt(point[1][0]).toString(16).padStart(64, "0");
    return xImag + xReal + yImag + yReal; // 256 hex chars = 128 bytes
  }

  const proofHex = g1ToHex(proofJson.pi_a) + g2ToHex(proofJson.pi_b) + g1ToHex(proofJson.pi_c);
  // proofHex: 128 + 256 + 128 = 512 hex chars = 256 bytes

  const commitmentHex = BigInt(publicJson[0]).toString(16).padStart(64, "0");
  const thresholdHex  = BigInt(publicJson[1]).toString(16).padStart(64, "0");
  const nullifierHex  = BigInt(publicJson[2]).toString(16).padStart(64, "0");

  return {
    commitment:   commitmentHex,
    threshold:    thresholdHex,
    nullifier:    nullifierHex,
    proof:        proofHex,
    publicInputs: publicJson.slice(0, 3),
  };
}

/**
 * Serialize an AccessProof to the 352-byte instruction payload expected by
 * dark_bn254_gate on Solana.
 *
 * Layout (matches shielded_withdraw instruction format):
 *   bytes   0–255: 256-byte Groth16 proof (A:G1 + B:G2 + C:G1)
 *   bytes 256–287: commitment (32 bytes)
 *   bytes 288–319: threshold  (32 bytes)
 *   bytes 320–351: nullifier  (32 bytes)
 *
 * @returns 352-byte Uint8Array for use as Solana instruction data
 */
export function serializeAccessProof(ap: AccessProof): Uint8Array {
  const proofBytes      = hexToBytes(ap.proof);
  const commitmentBytes = hexToBytes(ap.commitment.padStart(64, "0"));
  const thresholdBytes  = hexToBytes(ap.threshold.padStart(64, "0"));
  const nullifierBytes  = hexToBytes(ap.nullifier.padStart(64, "0"));

  if (proofBytes.length !== 256) {
    throw new Error(`proof must be 256 bytes, got ${proofBytes.length}`);
  }

  const payload = new Uint8Array(352);
  payload.set(proofBytes,      0);
  payload.set(commitmentBytes, 256);
  payload.set(thresholdBytes,  288);
  payload.set(nullifierBytes,  320);
  return payload;
}

// ─── Off-chain verification ───────────────────────────────────────────────────

/**
 * Verify an AccessProof off-chain (structural check only — does NOT call Solana).
 *
 * This is a lightweight check for:
 *   1. Correct byte lengths on proof and public inputs
 *   2. All public inputs are valid BN254 field elements (< r)
 *   3. Proof bytes are non-zero (liveness check)
 *
 * For real soundness verification, call `verifyAccessProof()` which submits
 * to the dark_bn254_gate program on Solana.
 *
 * @param ap  AccessProof to check
 * @returns   VerifyResult
 */
export function checkAccessProofShape(ap: AccessProof): VerifyResult {
  try {
    if (ap.proof.length !== 512) {
      return { valid: false, reason: `proof must be 512 hex chars (256 bytes), got ${ap.proof.length}` };
    }
    if (ap.commitment.replace(/^0+/, "").length === 0 || ap.nullifier.replace(/^0+/, "").length === 0) {
      return { valid: false, reason: "commitment or nullifier is zero — likely uninitialized" };
    }
    const commitmentBig = BigInt("0x" + ap.commitment.padStart(64, "0"));
    const thresholdBig  = BigInt("0x" + ap.threshold.padStart(64, "0"));
    const nullifierBig  = BigInt("0x" + ap.nullifier.padStart(64, "0"));
    if (commitmentBig >= BN254_R) {
      return { valid: false, reason: "commitment >= BN254 scalar field order" };
    }
    if (thresholdBig >= BN254_R) {
      return { valid: false, reason: "threshold >= BN254 scalar field order" };
    }
    if (nullifierBig >= BN254_R) {
      return { valid: false, reason: "nullifier >= BN254 scalar field order" };
    }
    if (ap.publicInputs.length < 3) {
      return { valid: false, reason: `expected 3 public inputs, got ${ap.publicInputs.length}` };
    }
    // Liveness: proof bytes must not be all zeros
    const proofBytes = hexToBytes(ap.proof);
    const nonZero = proofBytes.some((b) => b !== 0);
    if (!nonZero) {
      return { valid: false, reason: "proof bytes are all zero — not a real proof" };
    }
    return { valid: true, reason: null };
  } catch (err) {
    return { valid: false, reason: `parse error: ${(err as Error).message}` };
  }
}

/**
 * Verify an AccessProof by submitting to the dark_bn254_gate program on Solana.
 *
 * Builds the 352-byte instruction payload and calls the verifier program.
 * Returns true if the pairing check passes (proof is valid for the public inputs).
 *
 * Note: This function requires @solana/web3.js and a connection to a Solana RPC.
 * The `verifierPubkey` should be the deployed dark_bn254_gate program ID.
 *
 * For an end-to-end demo, see scripts/zk/07-noir-x402-demo.mjs.
 *
 * @param ap              AccessProof (from encodeAccessProof or X-ZK-ACCESS header)
 * @param verifierPubkey  Solana program address of dark_bn254_gate (base58)
 * @param rpcEndpoint     Solana RPC endpoint URL
 * @param payerKeypair    Payer keypair for transaction fee
 * @returns               true if proof verified on-chain, false otherwise
 */
export async function verifyAccessProof(
  ap: AccessProof,
  verifierPubkey: string,
  rpcEndpoint: string,
  payerKeypair: Uint8Array,
): Promise<boolean> {
  // Shape check first — fast fail before RPC call
  const shapeCheck = checkAccessProofShape(ap);
  if (!shapeCheck.valid) {
    throw new Error(`AccessProof shape invalid: ${shapeCheck.reason}`);
  }

  // Dynamic import of @solana/web3.js to keep this package tree-shakable
  // and avoid hard dependency for consumers that only use the type layer.
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } =
    await import("@solana/web3.js");

  const connection  = new Connection(rpcEndpoint, "confirmed");
  const payer       = Keypair.fromSecretKey(payerKeypair);
  const programId   = new PublicKey(verifierPubkey);
  const instructionData = serializeAccessProof(ap);

  const ix = new TransactionInstruction({
    programId,
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(instructionData),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(payer);

  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    const result = await connection.confirmTransaction(sig, "confirmed");
    return result.value.err === null;
  } catch {
    return false;
  }
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { bytesToHex, hexToBytes } from "@noble/hashes/utils";
