/**
 * null-miner-sdk — MetaMask / secp256k1 Agent Authorization
 *
 * Ethereum users can authorize Solana agents without Phantom. The ETH wallet
 * `personal_sign`s a canonical binding message that names the
 * `dark_secp256k1_auth` program id, the Solana agent key, the ETH address,
 * domain_hash and auth_hash. The program rebuilds that message on-chain from the
 * transaction (program id, agent signer, pda_seed, domain_hash, auth_hash) and
 * requires the secp256k1 precompile to have verified exactly it, so a signature
 * made for one agent cannot bind the ETH address to another agent.
 *
 * Message body (lines joined by "\n", no trailing newline):
 *   dark-secp256k1-auth v1: bind ETH address to Solana agent
 *   program: <base58 program id>
 *   agent: <base58 agent pubkey>
 *   eth: 0x<40 lowercase hex>
 *   domain: <domain_hash hex>
 *   auth: <auth_hash hex>
 *
 * Mirrors programs/dark_secp256k1_auth/src/binding.rs.
 * No ETH RPC needed. All offline — sign in MetaMask, submit to Solana.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "crypto";

export const ETH_AGENT_BINDING_VERSION = "dark-secp256k1-auth v1";
export const ETH_AGENT_BINDING_TAG = `${ETH_AGENT_BINDING_VERSION}: bind ETH address to Solana agent`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EthAgentAuthMessage {
  /** dark_secp256k1_auth program id (base58). */
  programId: string;
  /** Solana agent key being bound (base58, as printed by web3.js). */
  agentPubkey: string;
  /** ETH address that signs (0x-prefixed, lowercase). */
  ethAddress: string;
  /** Domain string; domainHash = SHA-256(domain). */
  domain: string;
  /** hex SHA-256(domain). */
  domainHash: string;
  /** hex SHA-256(pdaSeed || "commitment"). */
  authHash: string;
  version: string;
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
  /** hex: 12 zero bytes || 20-byte ETH address (the program reads pda_seed[12..32]). */
  pdaSeed: string;
  /** hex SHA-256(pdaSeed || "commitment"). */
  authHash: string;
  /** hex SHA-256(domain). */
  domainHash: string;
}

// ── Message construction ──────────────────────────────────────────────────────

function normalizeEthAddress(addr: string): string {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`Expected a 20-byte ETH address, got ${addr}`);
  }
  return `0x${hex}`;
}

/**
 * Build the binding message for `ethAddress` -> `agentPubkey` under `programId`.
 */
export function createEthAgentAuthMessage(opts: {
  programId: string;
  agentPubkey: string;
  ethAddress: string;
  domain: string;
}): EthAgentAuthMessage {
  const ethAddress = normalizeEthAddress(opts.ethAddress);
  const pda = deriveAgentAuthPda(ethAddress, opts.agentPubkey, opts.domain);
  return {
    programId: opts.programId,
    agentPubkey: opts.agentPubkey,
    ethAddress,
    domain: opts.domain,
    domainHash: pda.domainHash,
    authHash: pda.authHash,
    version: ETH_AGENT_BINDING_VERSION,
  };
}

/**
 * The text to pass to MetaMask `personal_sign` (MetaMask adds the EIP-191 prefix).
 */
export function formatEthPersonalSignMessage(msg: EthAgentAuthMessage): string {
  return [
    ETH_AGENT_BINDING_TAG,
    `program: ${msg.programId}`,
    `agent: ${msg.agentPubkey}`,
    `eth: ${normalizeEthAddress(msg.ethAddress)}`,
    `domain: ${msg.domainHash.toLowerCase()}`,
    `auth: ${msg.authHash.toLowerCase()}`,
  ].join("\n");
}

/**
 * EIP-191 message bytes: "\x19Ethereum Signed Message:\n" + byteLength + message.
 * These are the bytes the secp256k1 precompile instruction must carry.
 */
export function ethPersonalSignMessageBytes(message: string): Uint8Array {
  const body = Buffer.from(message, "utf8");
  return Uint8Array.from(Buffer.concat([
    Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, "utf8"),
    body,
  ]));
}

/**
 * keccak256 of the EIP-191 message bytes (the digest MetaMask signs, and
 * RegisterEthAgent's msg_hash).
 */
export function ethPersonalSignHash(message: string): Uint8Array {
  return keccak_256(ethPersonalSignMessageBytes(message));
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
 * Derive the on-chain fields for an ETH -> Agent binding.
 *   pdaSeed    = 12 zero bytes || ethAddress (record PDA seeds: ["eth-agent", ethAddress])
 *   authHash   = SHA-256(pdaSeed || "commitment")
 *   domainHash = SHA-256(domain)
 */
export function deriveAgentAuthPda(
  ethAddress: string,
  agentPubkey: string,
  domain: string
): AgentAuthPda {
  const eth = normalizeEthAddress(ethAddress);
  const pdaSeed = Buffer.concat([Buffer.alloc(12), Buffer.from(eth.slice(2), "hex")]);
  const authHash = sha256Buf(pdaSeed, Buffer.from("commitment"));
  const domainHash = sha256Buf(Buffer.from(domain, "utf8"));
  return {
    ethAddress: eth,
    agentPubkey,
    domain,
    pdaSeed: pdaSeed.toString("hex"),
    authHash: authHash.toString("hex"),
    domainHash: domainHash.toString("hex"),
  };
}

// ── Instruction builders ──────────────────────────────────────────────────────

/**
 * RegisterEthAgent instruction data (194 bytes) for `dark_secp256k1_auth`.
 *
 * Layout:
 *   [0x01]          discriminant: RegisterEthAgent
 *   r[32]           signature r
 *   s[32]           signature s
 *   [recoveryId:1]  0 or 1
 *   msgHash[32]     ethPersonalSignHash(formatEthPersonalSignMessage(msg))
 *   pdaSeed[32]     12 zero bytes || ETH address
 *   authHash[32]    auth commitment
 *   domainHash[32]  SHA-256(domain)
 *
 * Accounts: [record PDA (w), agent (signer, w), system program, instructions sysvar];
 * the secp256k1 precompile instruction (buildSecp256k1PrecompileData) must be at
 * transaction index 0.
 */
export function buildSecp256k1AuthInstruction(
  auth: AgentAuthPda,
  sigComponents: EthSignatureComponents,
  msgHash: Uint8Array
): Uint8Array {
  const buf = new Uint8Array(194);
  let offset = 0;
  buf[offset++] = 0x01;
  buf.set(sigComponents.r, offset); offset += 32;
  buf.set(sigComponents.s, offset); offset += 32;
  buf[offset++] = sigComponents.recoveryId;
  buf.set(msgHash.subarray(0, 32), offset); offset += 32;
  buf.set(Buffer.from(auth.pdaSeed, "hex"), offset); offset += 32;
  buf.set(Buffer.from(auth.authHash, "hex"), offset); offset += 32;
  buf.set(Buffer.from(auth.domainHash, "hex"), offset);
  return buf;
}

/**
 * Data of the secp256k1 precompile instruction (program
 * KeccakSecp256k11111111111111111111111111111) carrying one signature over the
 * EIP-191 bytes of `message` (the personal_sign text).
 */
export function buildSecp256k1PrecompileData(
  ethAddress: string,
  sigComponents: EthSignatureComponents,
  message: string,
  instructionIndex = 0
): Uint8Array {
  const msg = ethPersonalSignMessageBytes(message);
  const sigOff = 12, addrOff = sigOff + 65, msgOff = addrOff + 20;
  const data = Buffer.alloc(msgOff + msg.length);
  data[0] = 1;
  data.writeUInt16LE(sigOff, 1);
  data[3] = instructionIndex;
  data.writeUInt16LE(addrOff, 4);
  data[6] = instructionIndex;
  data.writeUInt16LE(msgOff, 7);
  data.writeUInt16LE(msg.length, 9);
  data[11] = instructionIndex;
  data.set(sigComponents.r, sigOff);
  data.set(sigComponents.s, sigOff + 32);
  data[sigOff + 64] = sigComponents.recoveryId;
  data.set(Buffer.from(normalizeEthAddress(ethAddress).slice(2), "hex"), addrOff);
  data.set(msg, msgOff);
  return Uint8Array.from(data);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256Buf(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
