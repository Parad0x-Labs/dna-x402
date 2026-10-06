/**
 * dark_secp256k1_auth client helpers: the canonical ETH -> Solana agent binding
 * message and the RegisterEthAgent transaction (secp256k1 precompile at index 0).
 *
 * The ETH key signs, with EIP-191 personal_sign, a message that names the
 * program id, the Solana agent key, the ETH address, domain_hash and auth_hash:
 *
 *   dark-secp256k1-auth v1: bind ETH address to Solana agent
 *   program: <base58>
 *   agent: <base58>
 *   eth: 0x<40 hex>
 *   domain: <64 hex>
 *   auth: <64 hex>
 *
 * The program rebuilds this text on-chain and requires the precompile-verified
 * message to be exactly "\x19Ethereum Signed Message:\n" + len + text, so a
 * signature made for one agent cannot bind the ETH address to another agent.
 * MetaMask: `personal_sign(bindingBody(...), ethAddress)` produces the signature.
 *
 * Mirrors programs/dark_secp256k1_auth/src/binding.rs.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js"; // @noble/curves 2.x (repo pin)
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  PublicKey, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";

export const SECP256K1_PRECOMPILE = new PublicKey("KeccakSecp256k11111111111111111111111111111");
export const BINDING_DOMAIN_TAG = "dark-secp256k1-auth v1: bind ETH address to Solana agent";

const hex = (b) => Buffer.from(b).toString("hex");

/** 20-byte ETH address of a secp256k1 private key. */
export function ethAddress(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1);
  return Buffer.from(keccak_256(pub).slice(12));
}

/** The text the ETH key signs (personal_sign input). */
export function bindingBody({ programId, agent, ethAddr, domainHash, authHash }) {
  return [
    BINDING_DOMAIN_TAG,
    `program: ${new PublicKey(programId).toBase58()}`,
    `agent: ${new PublicKey(agent).toBase58()}`,
    `eth: 0x${hex(ethAddr)}`,
    `domain: ${hex(domainHash)}`,
    `auth: ${hex(authHash)}`,
  ].join("\n");
}

/** EIP-191 message bytes: the precompile verifies keccak256 of these. */
export function eip191(body) {
  const b = Buffer.from(body, "utf8");
  return Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${b.length}`, "utf8"), b]);
}

export function bindingMessage(fields) {
  return eip191(bindingBody(fields));
}

/** Sign a 32-byte digest (no prehash) and find the recovery id (noble 2.x). */
export function signRecoverable(digest, priv) {
  const sig64 = secp256k1.sign(digest, priv, { prehash: false });
  const pub = Buffer.from(secp256k1.getPublicKey(priv, false));
  for (const bit of [0, 1]) {
    try {
      const rec = secp256k1.Signature.fromBytes(sig64, "compact").addRecoveryBit(bit).recoverPublicKey(digest);
      if (Buffer.from(rec.toBytes(false)).equals(pub)) {
        return { r: Buffer.from(sig64.slice(0, 32)), s: Buffer.from(sig64.slice(32, 64)), sig64: Buffer.from(sig64), recovId: bit };
      }
    } catch { /* try next */ }
  }
  throw new Error("recovery id not found");
}

/** Self-contained secp256k1 precompile instruction (one signature, any message length). */
export function secp256k1PrecompileIx({ ethAddr, sig64, recovId, message, ixIndex = 0 }) {
  const sigOff = 12, addrOff = sigOff + 65, msgOff = addrOff + 20;
  const data = Buffer.alloc(msgOff + message.length);
  data[0] = 1;
  let o = 1;
  data.writeUInt16LE(sigOff, o); o += 2;
  data[o++] = ixIndex & 0xff;
  data.writeUInt16LE(addrOff, o); o += 2;
  data[o++] = ixIndex & 0xff;
  data.writeUInt16LE(msgOff, o); o += 2;
  data.writeUInt16LE(message.length, o); o += 2;
  data[o++] = ixIndex & 0xff;
  Buffer.from(sig64).copy(data, sigOff);
  data[sigOff + 64] = recovId & 0xff;
  Buffer.from(ethAddr).copy(data, addrOff);
  Buffer.from(message).copy(data, msgOff);
  return new TransactionInstruction({ programId: SECP256K1_PRECOMPILE, keys: [], data });
}

export function ethAgentPda(programId, ethAddr) {
  return PublicKey.findProgramAddressSync([Buffer.from("eth-agent"), Buffer.from(ethAddr)], new PublicKey(programId))[0];
}

/** RegisterEthAgent (0x01): 194 bytes of data, accounts [pda, agent, system, instructions sysvar]. */
export function registerIx({ programId, agent, claimedEthAddr, r, s, recovId, msgHash, authHash, domainHash }) {
  const pdaSeed = Buffer.concat([Buffer.alloc(12), Buffer.from(claimedEthAddr)]);
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: ethAgentPda(programId, claimedEthAddr), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(agent), isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([0x01]), Buffer.from(r), Buffer.from(s), Buffer.from([recovId]),
      Buffer.from(msgHash), pdaSeed, Buffer.from(authHash), Buffer.from(domainHash),
    ]),
  });
}

/**
 * ETH key `ethPriv` authorizes Solana `agent` under `programId`. Returns the
 * precompile ix and the signed fields; registerIx({...signed, agent}) builds the
 * program instruction (the agent must sign the transaction).
 */
export function signBinding({ programId, agent, ethPriv, domainHash, authHash }) {
  const ethAddr = ethAddress(ethPriv);
  const message = bindingMessage({ programId, agent, ethAddr, domainHash, authHash });
  const msgHash = Buffer.from(keccak_256(message));
  const { r, s, sig64, recovId } = signRecoverable(msgHash, ethPriv);
  return {
    programId, ethAddr, message, msgHash, r, s, sig64, recovId, domainHash, authHash,
    claimedEthAddr: ethAddr,
    preIx: secp256k1PrecompileIx({ ethAddr, sig64, recovId, message }),
  };
}
