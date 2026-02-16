import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { verifySignedReceipt } from "../../src/receipts.js";

interface SmokeResult {
  generatedAt: string;
  baseUrl: string | null;
  hasBaseUrl: boolean;
  first402Observed: boolean;
  paid200Observed: boolean;
  receiptVerified: boolean;
  receiptId?: string;
  commitId?: string;
  settlementMode?: "netting" | "stream";
  paymentTxSignature?: string;
  error?: string;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function loadKeypairFromFile(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as number[];
  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error(`Invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(new Uint8Array(parsed));
}

async function createDevnetPaymentSignature(params: {
  rpcUrl: string;
  payerKeypairPath: string;
  recipient: string;
}): Promise<string> {
  const connection = new Connection(params.rpcUrl, "confirmed");
  const payer = loadKeypairFromFile(params.payerKeypairPath);
  const recipient = new PublicKey(params.recipient);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 5_000,
    }),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;

  const signature = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  const confirmed = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  }, "confirmed");

  if (confirmed.value.err) {
    throw new Error(`Devnet payment signature not confirmed cleanly: ${JSON.stringify(confirmed.value.err)}`);
  }

  return signature;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const x402Root = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..");
  const outDir = parseFlagValue(argv, "--out-dir") ?? path.join(x402Root, "audit_out");
  const baseUrl = parseFlagValue(argv, "--base-url") ?? process.env.DEVNET_X402_BASE_URL ?? null;
  const withTxSignature = hasFlag(argv, "--with-tx-signature");
  const payerKeypairPath = parseFlagValue(argv, "--payer-keypair")
    ?? process.env.SMOKE_PAYER_KEYPAIR
    ?? process.env.DEPLOYER_KEYPAIR
    ?? "";
  const rpcUrl = parseFlagValue(argv, "--rpc-url")
    ?? process.env.SOLANA_RPC_URL
    ?? "https://api.devnet.solana.com";

  fs.mkdirSync(outDir, { recursive: true });
  const out402 = path.join(outDir, "devnet_smoke_402.txt");
  const outPaid = path.join(outDir, "devnet_smoke_paid.txt");
  const outJson = path.join(outDir, "devnet_smoke.json");

  const result: SmokeResult = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    hasBaseUrl: Boolean(baseUrl),
    first402Observed: false,
    paid200Observed: false,
    receiptVerified: false,
  };

  if (!baseUrl) {
    fs.writeFileSync(out402, "DEVNET_X402_BASE_URL not provided\n");
    fs.writeFileSync(outPaid, "DEVNET_X402_BASE_URL not provided\n");
    fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, skipped: true, outJson }, null, 2));
    return;
  }

  try {
    const resourceUrl = `${baseUrl.replace(/\/$/, "")}/resource`;
    const first = await fetch(resourceUrl);
    const firstBodyText = await first.text();
    fs.writeFileSync(out402, `HTTP ${first.status}\n\n${firstBodyText}\n`);

    result.first402Observed = first.status === 402;
    if (!result.first402Observed) {
      throw new Error(`Expected 402, got ${first.status}`);
    }

    const parsed402 = JSON.parse(firstBodyText) as {
      paymentRequirements: {
        quote: {
          quoteId: string;
          recipient: string;
        };
      };
    };

    const quoteId = parsed402.paymentRequirements.quote.quoteId;
    const payerCommitment32B = `0x${crypto.randomBytes(32).toString("hex")}`;

    const commitRes = await fetch(`${baseUrl.replace(/\/$/, "")}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId, payerCommitment32B }),
    });
    const commitText = await commitRes.text();
    if (!commitRes.ok) {
      throw new Error(`Commit failed: ${commitRes.status} ${commitText}`);
    }
    const commitParsed = JSON.parse(commitText) as { commitId: string };

    let settlementMode: "netting" | "stream" = "netting";
    let paymentProof: Record<string, string> = {
      settlement: "netting",
      note: "audit-smoke",
    };

    if (withTxSignature) {
      if (!payerKeypairPath) {
        throw new Error("Missing payer keypair path for --with-tx-signature (use --payer-keypair or DEPLOYER_KEYPAIR).");
      }
      const paymentTxSignature = await createDevnetPaymentSignature({
        rpcUrl,
        payerKeypairPath,
        recipient: parsed402.paymentRequirements.quote.recipient,
      });
      result.paymentTxSignature = paymentTxSignature;
      settlementMode = "stream";
      paymentProof = {
        settlement: "stream",
        streamId: `smoke-stream-${Date.now()}`,
        topupSignature: paymentTxSignature,
      };
    }

    const finalizeRes = await fetch(`${baseUrl.replace(/\/$/, "")}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commitId: commitParsed.commitId,
        paymentProof,
      }),
    });
    const finalizeText = await finalizeRes.text();
    if (!finalizeRes.ok) {
      throw new Error(`Finalize failed: ${finalizeRes.status} ${finalizeText}`);
    }
    const finalizeParsed = JSON.parse(finalizeText) as { receiptId: string };

    const receiptRes = await fetch(`${baseUrl.replace(/\/$/, "")}/receipt/${finalizeParsed.receiptId}`);
    const receiptText = await receiptRes.text();
    if (!receiptRes.ok) {
      throw new Error(`Receipt fetch failed: ${receiptRes.status} ${receiptText}`);
    }
    const receipt = JSON.parse(receiptText);
    result.receiptVerified = verifySignedReceipt(receipt);

    const retry = await fetch(resourceUrl, {
      headers: {
        "x-dnp-commit-id": commitParsed.commitId,
      },
    });
    const retryText = await retry.text();
    fs.writeFileSync(outPaid, [
      `COMMIT ${commitRes.status}`,
      commitText,
      "",
      `FINALIZE ${finalizeRes.status}`,
      finalizeText,
      "",
      `RETRY ${retry.status}`,
      retryText,
      "",
      `RECEIPT ${receiptRes.status}`,
      receiptText,
    ].join("\n"));

    result.commitId = commitParsed.commitId;
    result.receiptId = finalizeParsed.receiptId;
    result.settlementMode = settlementMode;
    result.paid200Observed = retry.status === 200;

    if (!result.paid200Observed) {
      throw new Error(`Expected paid retry 200, got ${retry.status}`);
    }
    if (!result.receiptVerified) {
      throw new Error("Receipt signature verification failed");
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  fs.writeFileSync(outJson, JSON.stringify(result, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: Boolean(result.first402Observed && result.paid200Observed && result.receiptVerified) || !result.hasBaseUrl,
    outJson,
    baseUrl: result.baseUrl,
    settlementMode: result.settlementMode,
    paymentTxSignature: result.paymentTxSignature,
    first402Observed: result.first402Observed,
    paid200Observed: result.paid200Observed,
    receiptVerified: result.receiptVerified,
    error: result.error,
  }, null, 2));

  if (result.hasBaseUrl && (!result.first402Observed || !result.paid200Observed || !result.receiptVerified)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
