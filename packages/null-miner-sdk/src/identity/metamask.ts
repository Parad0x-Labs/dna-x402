/**
 * null-miner-sdk — MetaMask / secp256k1 Agent Authorization
 *
 * Ethereum users can authorize Solana agents without Phantom.
 * An ETH wallet signs a canonical message → we recover the ETH address →
 * derive a deterministic Solana agent PDA from that address.
 *
 * On-chain verification uses the secp256k1 precompile (genesis, always live).
 * The Rust program `dark_secp256k1_auth` stores the ETH→Agent binding.
 *
 * No ETH RPC needed. All offline — sign in MetaMask, submit to Solana.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash, randomBytes } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EthAgentAuthMessage {
  domain: string;
  agentPubkey: string;
  ethAddress: string;
  vaultId: string;
  version: string;
  nonce: string;
}

export interface EthSignatureComponents {
  r: Uint8Array;
  s: Uint8Array;
  v: number;
  recoveryId: number;
}

export interface AgentAuthPda {
  ethAddress: string;
  agentPubkey: string;
  domain: string;
  pdaSeed: string;
  authHash: string;
}

// ── Message construction ──────────────────────────────────────────────────────

/**
 * Create an EthAgentAuthMessage struct. Generates a random nonce if not provided.
 */
export function createEthAgentAuthMessage(opts: {
  domain: string;
  agentPubkey: string;
  vaultId: string;
  nonce?: string;
}): EthAgentAuthMessage {
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  // Derive a placeholder ethAddress; the real address comes from the signature recovery.
  // For the struct we use a zero address — actual binding happens in recoverEthAddress.
  return {
    domain: opts.domain,
    agentPubkey: opts.agentPubkey,
    ethAddress: "0x0000000000000000000000000000000000000000",
    vaultId: opts.vaultId,
    version: "eth-agent-auth-v1",
    nonce,
  };
}

/**
 * Format the human-readable message body for MetaMask `personal_sign`.
 * MetaMask prepends the Ethereum personal sign prefix automatically.
 */
export function formatEthPersonalSignMessage(msg: EthAgentAuthMessage): string {
  return [
    "Solana Agent Authorization v1",
    `Domain: ${msg.domain}`,
    `Agent: ${msg.agentPubkey}`,
    `Vault: ${msg.vaultId}`,
    `Nonce: ${msg.nonce}`,
    "Warning: This authorizes a Solana agent key",
  ].join("\n");
}

/**
 * Hash the message with the Ethereum personal sign prefix.
 * keccak256("\x19Ethereum Signed Message:\n" + length + message)
 */
export function ethPersonalSignHash(message: string): Uint8Array {
  const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
  const data = Buffer.concat([
    Buffer.from(prefix, "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  return keccak_256(data);
}

// ── Signature parsing ─────────────────────────────────────────────────────────

/**
 * Parse a 65-byte Ethereum signature (0x-prefixed optional).
 * Format: r[32] || s[32] || v[1] where v = 27 or 28.
 */
export function parseEthSignature(sigHex: string): EthSignatureComponents {
  const hex = sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;
  if (hex.length !== 130) {
    throw new Error(`Expected 65-byte signature (130 hex chars), got ${hex.length}`);
  }
  const bytes = Buffer.from(hex, "hex");
  const r = bytes.subarray(0, 32);
  const s = bytes.subarray(32, 64);
  const v = bytes[64]!;
  const recoveryId = v - 27;
  if (recoveryId !== 0 && recoveryId !== 1) {
    throw new Error(`Invalid recovery id: v=${v}, expected 27 or 28`);
  }
  return {
    r: Uint8Array.from(r),
    s: Uint8Array.from(s),
    v,
    recoveryId,
  };
}

// ── Address recovery ──────────────────────────────────────────────────────────

/**
 * Recover the Ethereum address that signed the given EthAgentAuthMessage.
 * Returns a 0x-prefixed lowercase hex address.
 */
export function recoverEthAddress(message: EthAgentAuthMessage, sigHex: string): string {
  const msgStr = formatEthPersonalSignMessage(message);
  const msgHash = ethPersonalSignHash(msgStr);
  const components = parseEthSignature(sigHex);

  const sig = secp256k1.Signature.fromCompact(
    Buffer.concat([components.r, components.s])
  ).addRecoveryBit(components.recoveryId);

  const pubkey = sig.recoverPublicKey(msgHash);
  // Uncompressed public key: 65 bytes with 04 prefix; drop the prefix
  const pubkeyBytes = pubkey.toRawBytes(false); // uncompressed, 65 bytes
  const pubkeyNoPrefix = pubkeyBytes.subarray(1); // 64 bytes

  const addrBytes = keccak_256(pubkeyNoPrefix);
  const addrHex = Buffer.from(addrBytes.subarray(12)).toString("hex"); // last 20 bytes
  return `0x${addrHex}`;
}

// ── PDA derivation ────────────────────────────────────────────────────────────

/**
 * Derive the on-chain PDA seed and auth commitment for an ETH→Agent binding.
 * pdaSeed  = SHA-256("eth-agent-auth-v1" || ethAddress || agentPubkey || domain)
 * authHash = SHA-256(pdaSeed || "commitment")
 */
export function deriveAgentAuthPda(
  ethAddress: string,
  agentPubkey: string,
  domain: string
): AgentAuthPda {
  const pdaSeed = sha256Buf(
    Buffer.from("eth-agent-auth-v1"),
    Buffer.from(ethAddress),
    Buffer.from(agentPubkey),
    Buffer.from(domain)
  );
  const authHash = sha256Buf(
    pdaSeed,
    Buffer.from("commitment")
  );
  return {
    ethAddress,
    agentPubkey,
    domain,
    pdaSeed: pdaSeed.toString("hex"),
    authHash: authHash.toString("hex"),
  };
}

// ── Instruction builder ───────────────────────────────────────────────────────

/**
 * Build the 200-byte instruction data for the `dark_secp256k1_auth` program.
 *
 * Layout:
 *   [0x01]         discriminant: RegisterEthAgent
 *   r[32]          signature r
 *   s[32]          signature s
 *   [recoveryId:1] v bit
 *   msgHash[32]    message hash
 *   pdaSeed[32]    PDA seed
 *   authHash[32]   auth commitment
 *   [0..0][37]     zero padding (future use)
 */
export function buildSecp256k1AuthInstruction(
  auth: AgentAuthPda,
  sigComponents: EthSignatureComponents,
  msgHash: Uint8Array
): Uint8Array {
  const buf = new Uint8Array(200);
  let offset = 0;

  // discriminant
  buf[offset++] = 0x01;

  // r (32 bytes)
  buf.set(sigComponents.r, offset);
  offset += 32;

  // s (32 bytes)
  buf.set(sigComponents.s, offset);
  offset += 32;

  // recoveryId (1 byte)
  buf[offset++] = sigComponents.recoveryId;

  // msgHash (32 bytes)
  buf.set(msgHash.subarray(0, 32), offset);
  offset += 32;

  // pdaSeed (32 bytes)
  const pdaSeedBytes = Buffer.from(auth.pdaSeed, "hex");
  buf.set(pdaSeedBytes, offset);
  offset += 32;

  // authHash (32 bytes)
  const authHashBytes = Buffer.from(auth.authHash, "hex");
  buf.set(authHashBytes, offset);
  // offset += 32; // offset = 162, remaining 38 bytes stay zero-padded → total 200

  return buf;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256Buf(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
