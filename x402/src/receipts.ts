import crypto from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SignedReceipt, ReceiptPayload } from "./types.js";

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function encodeReceiptForHash(prevHash: string, payload: ReceiptPayload): string {
  // Canonical key ordering ensures deterministic hashes across runtimes.
  return JSON.stringify({ prevHash, payload });
}

function encodeDetachedPayload(payload: unknown): string {
  return JSON.stringify(payload);
}

export function normalizeCommitment32B(value: string): string {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("payerCommitment32B must be 32-byte hex (64 chars)");
  }
  return normalized.toLowerCase();
}

export class ReceiptSigner {
  private previousHash = "0".repeat(64);

  constructor(private readonly secretKey: Uint8Array, readonly signerPublicKey: string) {
    if (secretKey.length !== 64) {
      throw new Error("ed25519 signing key must be 64 bytes");
    }
  }

  static fromBase58Secret(secret: string): ReceiptSigner {
    const decoded = bs58.decode(secret);
    if (decoded.length !== 64) {
      throw new Error("RECEIPT_SIGNING_SECRET must be base58-encoded 64-byte ed25519 secret key");
    }
    const publicKey = bs58.encode(decoded.slice(32));
    return new ReceiptSigner(decoded, publicKey);
  }

  static generate(): ReceiptSigner {
    const kp = nacl.sign.keyPair();
    const joined = new Uint8Array([...kp.secretKey]);
    return new ReceiptSigner(joined, bs58.encode(kp.publicKey));
  }

  sign(payload: ReceiptPayload): SignedReceipt {
    const prevHash = this.previousHash;
    const raw = encodeReceiptForHash(prevHash, payload);
    const receiptHash = hashHex(raw);
    const sig = nacl.sign.detached(Buffer.from(receiptHash, "hex"), this.secretKey);
    const signed: SignedReceipt = {
      payload,
      prevHash,
      receiptHash,
      signerPublicKey: this.signerPublicKey,
      signature: bs58.encode(sig),
    };

    this.previousHash = receiptHash;
    return signed;
  }

  signDetached(payload: unknown): { payloadHash: string; signerPublicKey: string; signature: string } {
    const payloadHash = hashHex(encodeDetachedPayload(payload));
    const sig = nacl.sign.detached(Buffer.from(payloadHash, "hex"), this.secretKey);
    return {
      payloadHash,
      signerPublicKey: this.signerPublicKey,
      signature: bs58.encode(sig),
    };
  }
}

export function verifySignedReceipt(receipt: SignedReceipt): boolean {
  const raw = encodeReceiptForHash(receipt.prevHash, receipt.payload);
  const computedHash = hashHex(raw);
  if (computedHash !== receipt.receiptHash) {
    return false;
  }

  const signature = bs58.decode(receipt.signature);
  const publicKey = bs58.decode(receipt.signerPublicKey);
  return nacl.sign.detached.verify(Buffer.from(receipt.receiptHash, "hex"), signature, publicKey);
}

export function verifyDetachedSignature(payload: unknown, signature: string, signerPublicKey: string): boolean {
  const payloadHash = hashHex(encodeDetachedPayload(payload));
  const sig = bs58.decode(signature);
  const pub = bs58.decode(signerPublicKey);
  return nacl.sign.detached.verify(Buffer.from(payloadHash, "hex"), sig, pub);
}
