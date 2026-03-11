import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditEntryToTelemetry,
  buildRunManifest,
  receiptToProofArtifact,
} from "../src/bridge/liquefy/adapter.js";
import { LiquefyVaultExporter } from "../src/bridge/liquefy/exporter.js";
import { LiquefySidecar } from "../src/bridge/liquefy/sidecar.js";
import { AuditEntry, AuditLogger } from "../src/logging/audit.js";
import { ReceiptSigner } from "../src/receipts.js";
import { ReceiptPayload, SignedReceipt } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "audit-123",
    ts: "2026-03-11T10:00:00.000Z",
    kind: "PAYMENT_VERIFIED",
    traceId: "trace-123",
    shopId: "shop-alpha",
    quoteId: "quote-123",
    commitId: "commit-123",
    receiptId: "receipt-123",
    settlement: "transfer",
    amountAtomic: "5000",
    mint: "USDC",
    recipient: "recipient-xyz",
    durationMs: 42,
    meta: { route: "/resource" },
    ...overrides,
  };
}

function makePayload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    receiptId: "receipt-123",
    quoteId: "quote-123",
    commitId: "commit-123",
    resource: "/resource",
    requestId: "req-123",
    requestDigest: "request-digest-123",
    responseDigest: "response-digest-123",
    shopId: "shop-alpha",
    payerCommitment32B: "a".repeat(64),
    recipient: "recipient-xyz",
    mint: "USDC",
    amountAtomic: "5000",
    feeAtomic: "100",
    totalAtomic: "5100",
    settlement: "transfer",
    settledOnchain: true,
    txSignature: "tx-123",
    createdAt: "2026-03-11T10:00:05.000Z",
    ...overrides,
  };
}

function makeSignedReceipt(overrides: Partial<ReceiptPayload> = {}): SignedReceipt {
  const signer = ReceiptSigner.generate();
  return signer.sign(makePayload(overrides));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (check()) {
        return;
      }
    } catch {
      // File-backed streams flush asynchronously, so reads can race for a moment.
    }
    await delay(20);
  }
  throw new Error("timed out waiting for expected file output");
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

describe("DNA Liquefy bridge", () => {
  it("maps audit entries and receipts into Liquefy bridge records", () => {
    const entry = makeAuditEntry({
      kind: "PAYMENT_REJECTED",
      errorCode: "UNDERPAY",
      errorMessage: "underpay detected",
    });
    const telemetry = auditEntryToTelemetry(entry);
    expect(telemetry).toMatchObject({
      _schema: "liquefy.dna.telemetry.v1",
      _source: "dna-x402",
      event_type: "PAYMENT_REJECTED",
      trace_id: "trace-123",
      severity: "error",
      domain: "payment",
    });
    expect(telemetry.tags).toContain("kind:PAYMENT_REJECTED");
    expect(telemetry.tags).toContain("settlement:transfer");
    expect(telemetry.tags).toContain("shop:shop-alpha");
    expect(telemetry.tags).toContain("mint:USDC");
    expect(telemetry.tags).toContain("error:UNDERPAY");

    const receipt = makeSignedReceipt();
    const proof = receiptToProofArtifact(receipt);
    expect(proof).toMatchObject({
      _schema: "liquefy.dna.proof.v1",
      _source: "dna-x402",
      artifact_type: "signed_receipt",
      receipt_id: receipt.payload.receiptId,
      payment: {
        quote_id: receipt.payload.quoteId,
        commit_id: receipt.payload.commitId,
        total_atomic: receipt.payload.totalAtomic,
        tx_signature: receipt.payload.txSignature,
      },
      resource: {
        path: receipt.payload.resource,
        shop_id: receipt.payload.shopId,
      },
    });
    expect(proof.chain_position).toBeGreaterThan(0);

    const manifest = buildRunManifest("run-bridge", "2026-03-11T10:00:00.000Z", [receipt], "devnet", "test");
    expect(manifest).toMatchObject({
      _schema: "liquefy.dna.run.v1",
      _source: "dna-x402",
      run_id: "run-bridge",
      cluster: "devnet",
      version: "test",
      total_payments: 1,
      total_receipts: 1,
      total_amount_atomic: receipt.payload.totalAtomic,
      proof_artifact_count: 1,
    });
    expect(manifest.mints_used).toEqual(["USDC"]);
    expect(manifest.settlements_used).toEqual(["transfer"]);
    expect(manifest.shops_involved).toEqual(["shop-alpha"]);
  });

  it("maps DNA Guard audit events into receipt and system telemetry domains", () => {
    const invalidReceipt = auditEntryToTelemetry(makeAuditEntry({
      kind: "GUARD_RECEIPT_INVALID",
      receiptId: "receipt-guard",
      errorMessage: "signature mismatch",
    }));
    expect(invalidReceipt).toMatchObject({
      event_type: "GUARD_RECEIPT_INVALID",
      severity: "error",
      domain: "receipt",
    });

    const failOpen = auditEntryToTelemetry(makeAuditEntry({
      kind: "GUARD_FAIL_OPEN",
      errorMessage: "cache unavailable",
    }));
    expect(failOpen).toMatchObject({
      event_type: "GUARD_FAIL_OPEN",
      severity: "warn",
      domain: "system",
    });
  });

  it("writes Liquefy-ready staging files from the exporter", async () => {
    const outDir = makeTempDir("dna-liquefy-exporter-");
    const exporter = new LiquefyVaultExporter({
      outDir,
      runId: "run-exporter",
      cluster: "devnet",
      version: "test",
    });

    const entry = makeAuditEntry();
    const receipt = makeSignedReceipt();
    exporter.writeAuditEvent(entry);
    exporter.writeReceipt(receipt);
    const result = exporter.finalize();

    const proofPath = path.join(outDir, "proofs", `${receipt.payload.receiptId}.json`);
    await waitFor(() => (
      readText(result.telemetryPath).includes(entry.id)
      && readText(result.receiptsPath).includes(receipt.payload.receiptId)
      && readText(proofPath).includes(receipt.payload.receiptId)
      && readText(result.manifestPath).includes("\"run_id\": \"run-exporter\"")
    ));

    const manifest = JSON.parse(readText(result.manifestPath));
    const proof = JSON.parse(readText(proofPath));
    expect(result.stats).toEqual({ events: 1, receipts: 1, proofFiles: 1 });
    expect(manifest.total_receipts).toBe(1);
    expect(manifest.cluster).toBe("devnet");
    expect(proof.receipt_id).toBe(receipt.payload.receiptId);
  });

  it("sidecar mirrors audit logger writes without touching the payment path", async () => {
    const outDir = makeTempDir("dna-liquefy-sidecar-");
    const sidecar = new LiquefySidecar({
      outDir,
      cluster: "devnet",
      version: "test",
    });
    const audit = new AuditLogger({ stdout: false });

    sidecar.attachAuditLogger(audit);
    const entry = audit.record({
      kind: "PAYMENT_VERIFIED",
      traceId: "trace-sidecar",
      quoteId: "quote-sidecar",
      commitId: "commit-sidecar",
      receiptId: "receipt-sidecar",
      settlement: "transfer",
      amountAtomic: "9900",
      mint: "USDC",
      recipient: "recipient-sidecar",
    });
    const receipt = makeSignedReceipt({
      receiptId: "receipt-sidecar",
      quoteId: "quote-sidecar",
      commitId: "commit-sidecar",
    });
    sidecar.writeReceipt(receipt);
    const result = sidecar.stop();

    await waitFor(() => (
      readText(result.telemetryPath).includes(entry.id)
      && readText(result.receiptsPath).includes(receipt.payload.receiptId)
    ));

    const manifest = JSON.parse(readText(result.manifestPath));
    expect(result.stats).toEqual({ events: 1, receipts: 1, proofFiles: 1 });
    expect(manifest.total_receipts).toBe(1);
    expect(manifest.cluster).toBe("devnet");
  });

  it("CLI exports audit events and receipts via mocked DNA admin endpoints", async () => {
    const outDir = makeTempDir("dna-liquefy-cli-");
    const entry = makeAuditEntry();
    const receipt = makeSignedReceipt({ receiptId: entry.receiptId! });
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cliPath = path.join(repoRoot, "src/bridge/liquefy/cli.ts");
    const auditUrl = "https://dna.test/admin/audit/export";
    const receiptUrl = `https://dna.test/receipt/${entry.receiptId}`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === auditUrl) {
        return new Response(`${JSON.stringify(entry)}\nnot-json\n`, { status: 200 });
      }
      if (url === receiptUrl) {
        return new Response(JSON.stringify(receipt), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ""));
    });

    const originalArgv = [...process.argv];
    const originalExitCode = process.exitCode;
    process.argv = [
      "node",
      cliPath,
      "--audit-url",
      auditUrl,
      "--out",
      outDir,
      "--run-id",
      "cli-run",
      "--cluster",
      "devnet",
      "--version",
      "cli-test",
    ];
    process.exitCode = 0;

    try {
      vi.resetModules();
      await import("../src/bridge/liquefy/cli.ts");
      await waitFor(() => fetchMock.mock.calls.length === 2 && logs.length > 0);

      const payload = JSON.parse(logs.at(-1) ?? "");
      expect(payload).toMatchObject({
        schema_version: "liquefy.dna.bridge.cli.v1",
        tool: "dna-liquefy-bridge",
        command: "export",
        ok: true,
        result: {
          out_dir: outDir,
          run_id: "cli-run",
          audit_events_exported: 1,
          receipts_exported: 1,
          proof_artifacts: 1,
        },
      });

      const telemetryPath = path.join(outDir, "telemetry.jsonl");
      const receiptsPath = path.join(outDir, "receipts.jsonl");
      const manifestPath = path.join(outDir, "manifest.json");
      await waitFor(() => (
        readText(telemetryPath).includes(entry.id)
        && readText(receiptsPath).includes(receipt.payload.receiptId)
        && readText(manifestPath).includes("\"run_id\": \"cli-run\"")
      ));
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  });
});
