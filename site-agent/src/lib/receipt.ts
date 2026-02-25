import bs58 from "bs58";
import nacl from "tweetnacl";
import { SignedReceipt } from "./types";

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function encodeReceiptForHash(receipt: SignedReceipt): string {
  return JSON.stringify({
    prevHash: receipt.prevHash,
    payload: receipt.payload,
  });
}

export async function verifySignedReceipt(receipt: SignedReceipt): Promise<boolean> {
  const computedHash = await sha256Hex(encodeReceiptForHash(receipt));
  if (computedHash !== receipt.receiptHash) {
    return false;
  }

  const signature = bs58.decode(receipt.signature);
  const publicKey = bs58.decode(receipt.signerPublicKey);
  const hashBytes = new Uint8Array(receipt.receiptHash.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);

  return nacl.sign.detached.verify(hashBytes, signature, publicKey);
}
