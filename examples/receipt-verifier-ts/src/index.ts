import { verifySignedReceipt, type SignedReceipt } from "dna-x402";

export function verifyReceipt(receipt: SignedReceipt): boolean {
  return verifySignedReceipt(receipt);
}

export function assertFeeWaterfallHash(receipt: SignedReceipt, expectedHash: string): void {
  if (receipt.payload.feeWaterfallHash !== expectedHash) {
    throw new Error("fee waterfall hash mismatch");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("receipt-verifier: receipt verification helper ready");
  console.log("receipt-verifier: fee waterfall hash must match quoted waterfall");
}
