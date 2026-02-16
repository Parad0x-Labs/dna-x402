import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ReceiptSigner, verifySignedReceipt } from "../../src/receipts.js";

interface ReceiptCheck {
  receiptId: string;
  valid: boolean;
  receiptHash: string;
  prevHash: string;
}

interface ReceiptAuditPayload {
  generatedAt: string;
  source: "synthetic_local";
  sampleSize: number;
  validCount: number;
  receipts: ReceiptCheck[];
  negativeTests: {
    tamperedPayloadRejected: boolean;
    wrongSignatureRejected: boolean;
  };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sampleSizeRaw = parseFlagValue(argv, "--sample") ?? "10";
  const sampleSize = Number.parseInt(sampleSizeRaw, 10);
  if (!Number.isFinite(sampleSize) || sampleSize < 10) {
    throw new Error("--sample must be >= 10");
  }

  const x402Root = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..");
  const outPath = parseFlagValue(argv, "--out") ?? path.join(x402Root, "audit_out", "receipts_sample.json");

  const signer = ReceiptSigner.generate();
  const receipts = [] as ReturnType<ReceiptSigner["sign"]>[];

  for (let i = 0; i < sampleSize; i += 1) {
    receipts.push(signer.sign({
      receiptId: `audit-sample-${i}`,
      quoteId: `quote-${i}`,
      commitId: `commit-${i}`,
      resource: "/resource",
      payerCommitment32B: crypto.randomBytes(32).toString("hex"),
      recipient: "audit-recipient-wallet",
      mint: "USDC",
      amountAtomic: "1000",
      feeAtomic: "10",
      totalAtomic: "1010",
      settlement: "transfer",
      settledOnchain: true,
      txSignature: `tx-${i}`,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    }));
  }

  const checks: ReceiptCheck[] = receipts.map((receipt) => ({
    receiptId: receipt.payload.receiptId,
    valid: verifySignedReceipt(receipt),
    receiptHash: receipt.receiptHash,
    prevHash: receipt.prevHash,
  }));

  const tampered = {
    ...receipts[0],
    payload: {
      ...receipts[0].payload,
      totalAtomic: "999999",
    },
  };

  const wrongSignature = {
    ...receipts[1],
    signature: receipts[1].signature.slice(0, -1) + (receipts[1].signature.endsWith("1") ? "2" : "1"),
  };

  const payload: ReceiptAuditPayload = {
    generatedAt: new Date().toISOString(),
    source: "synthetic_local",
    sampleSize,
    validCount: checks.filter((check) => check.valid).length,
    receipts: checks,
    negativeTests: {
      tamperedPayloadRejected: !verifySignedReceipt(tampered),
      wrongSignatureRejected: !verifySignedReceipt(wrongSignature),
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    outPath,
    sampleSize: payload.sampleSize,
    validCount: payload.validCount,
    negativeTests: payload.negativeTests,
  }, null, 2));

  if (payload.validCount < 10 || !payload.negativeTests.tamperedPayloadRejected || !payload.negativeTests.wrongSignatureRejected) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
