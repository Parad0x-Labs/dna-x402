/**
 * Face ID passkey — shared library for the dark_secp256r1_vault flow.
 *
 * The crypto path here uses WebCrypto (crypto.subtle), which is identical in the
 * browser and in Node 22+. That means the exact ceremony the website runs can be
 * validated on devnet from Node (see 02-devnet-faceid-webcrypto.mjs) without a
 * browser or wallet extension. The instruction byte layout matches what the
 * Agave secp256r1 precompile + dark_secp256r1_vault accept (proven on devnet).
 */

import {
  PublicKey, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";

export const SECP256R1_PROGRAM_ID = new PublicKey("Secp256r1SigVerify1111111111111111111111111");

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF = P256_N >> 1n;

const subtle = (globalThis.crypto ?? (await import("node:crypto")).webcrypto).subtle;

/** Normalize an ECDSA signature (raw r||s, 64 bytes) to low-S, as Agave requires. */
export function lowS(sig64) {
  const buf = Buffer.from(sig64);
  let s = BigInt("0x" + buf.subarray(32, 64).toString("hex"));
  if (s > P256_HALF) {
    s = P256_N - s;
    const sb = Buffer.from(s.toString(16).padStart(64, "0"), "hex");
    return Buffer.concat([buf.subarray(0, 32), sb]);
  }
  return buf;
}

/**
 * Generate a P-256 passkey via WebCrypto. In the browser, gate the returned
 * private key behind a biometric (WebAuthn user-verification) before signing.
 * Returns the keypair plus the compressed pubkey and X/Y the vault expects.
 */
export async function generateP256Passkey() {
  const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", keyPair.publicKey);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const compressed = Buffer.concat([Buffer.from([(y[31] & 1) === 0 ? 0x02 : 0x03]), x]);
  return { keyPair, jwk, x, y, compressed };
}

/** Import a P-256 private key from a JWK (e.g. persisted/biometric-wrapped). */
export async function importP256PrivateKey(jwk) {
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * Sign a 32-byte challenge with the P-256 private key. WebCrypto applies SHA-256
 * and returns raw r||s (IEEE P1363); we normalize to low-S. This is exactly what
 * the secp256r1 precompile verifies.
 */
export async function signChallenge(privateKey, challenge32) {
  const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge32));
  return lowS(raw);
}

/** Build the self-contained secp256r1 precompile instruction (one signature). */
export function secp256r1Ix({ pubkeyCompressed, signature64, message, ixIndex = 0 }) {
  const pkOff = 16, sigOff = 49, msgOff = 113;
  const data = Buffer.alloc(msgOff + message.length);
  data.writeUInt8(1, 0);
  data.writeUInt8(0, 1);
  let o = 2;
  data.writeUInt16LE(sigOff, o);          o += 2;
  data.writeUInt16LE(ixIndex, o);         o += 2;
  data.writeUInt16LE(pkOff, o);           o += 2;
  data.writeUInt16LE(ixIndex, o);         o += 2;
  data.writeUInt16LE(msgOff, o);          o += 2;
  data.writeUInt16LE(message.length, o);  o += 2;
  data.writeUInt16LE(ixIndex, o);         o += 2;
  Buffer.from(pubkeyCompressed).copy(data, pkOff);
  Buffer.from(signature64).copy(data, sigOff);
  Buffer.from(message).copy(data, msgOff);
  return new TransactionInstruction({ programId: SECP256R1_PROGRAM_ID, keys: [], data });
}

export function deriveVaultPda(programId, walletOwner, credIdHash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("passkey-vault"), walletOwner.toBuffer(), Buffer.from(credIdHash)],
    programId,
  )[0];
}

/** RegisterPasskeyVault (0x01) instruction. */
export function registerIx({ programId, vaultPda, walletOwner, agent, credIdHash, challenge, x, y }) {
  const data = Buffer.concat([Buffer.from([0x01]), Buffer.from(agent), Buffer.from(credIdHash), Buffer.from(challenge), Buffer.from(x), Buffer.from(y)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: walletOwner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** VerifyPasskeySignal (0x02) instruction (recurring sign-in). */
export function verifySignalIx({ programId, vaultPda, walletOwner, challenge, newChallenge }) {
  const data = Buffer.concat([Buffer.from([0x02]), Buffer.from(challenge), Buffer.from(newChallenge)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: walletOwner, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}
