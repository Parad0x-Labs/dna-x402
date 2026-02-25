/**
 * DNA x Liquefy Bridge — Vault Exporter
 *
 * Streams DNA payment data into a Liquefy-ready directory structure that
 * `tracevault_pack.py` can compress into a .null vault.
 *
 * Output directory structure:
 *   <outDir>/
 *     manifest.json          — run manifest (Liquefy run metadata)
 *     telemetry.jsonl        — all audit events in Liquefy telemetry format
 *     proofs/
 *       <receiptId>.json     — individual signed receipt proof artifacts
 *     receipts.jsonl         — all proof artifacts as NDJSON (bulk)
 *
 * Then run:
 *   python tools/tracevault_pack.py <outDir> --org dna --out ./vault/dna-run --json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AuditEntry } from "../../logging/audit.js";
import type { SignedReceipt } from "../../types.js";
import {
  auditEntryToTelemetry,
  buildRunManifest,
  ndjsonLine,
  receiptToProofArtifact,
} from "./adapter.js";

export interface VaultExporterOptions {
  outDir: string;
  runId?: string;
  cluster?: string;
  version?: string;
}

export class LiquefyVaultExporter {
  private readonly outDir: string;
  private readonly proofsDir: string;
  private readonly runId: string;
  private readonly cluster: string;
  private readonly version: string;
  private readonly startedAt: string;
  private telemetryStream?: fs.WriteStream;
  private receiptsStream?: fs.WriteStream;
  private receiptCount = 0;
  private eventCount = 0;
  private receiptsCollected: SignedReceipt[] = [];

  constructor(options: VaultExporterOptions) {
    this.outDir = options.outDir;
    this.proofsDir = path.join(options.outDir, "proofs");
    this.runId = options.runId ?? crypto.randomUUID();
    this.cluster = options.cluster ?? "unknown";
    this.version = options.version ?? "dev";
    this.startedAt = new Date().toISOString();
  }

  init(): void {
    fs.mkdirSync(this.outDir, { recursive: true });
    fs.mkdirSync(this.proofsDir, { recursive: true });
    this.telemetryStream = fs.createWriteStream(
      path.join(this.outDir, "telemetry.jsonl"),
      { flags: "a" },
    );
    this.receiptsStream = fs.createWriteStream(
      path.join(this.outDir, "receipts.jsonl"),
      { flags: "a" },
    );
  }

  writeAuditEvent(entry: AuditEntry): void {
    if (!this.telemetryStream) this.init();
    const record = auditEntryToTelemetry(entry);
    this.telemetryStream!.write(ndjsonLine(record) + "\n");
    this.eventCount++;
  }

  writeReceipt(receipt: SignedReceipt): void {
    if (!this.receiptsStream) this.init();
    const proof = receiptToProofArtifact(receipt);
    this.receiptsStream!.write(ndjsonLine(proof) + "\n");

    const proofPath = path.join(this.proofsDir, `${receipt.payload.receiptId}.json`);
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));

    this.receiptsCollected.push(receipt);
    this.receiptCount++;
  }

  finalize(): { manifestPath: string; telemetryPath: string; receiptsPath: string; stats: Record<string, number> } {
    const manifest = buildRunManifest(
      this.runId,
      this.startedAt,
      this.receiptsCollected,
      this.cluster,
      this.version,
    );

    const manifestPath = path.join(this.outDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    this.telemetryStream?.end();
    this.receiptsStream?.end();

    return {
      manifestPath,
      telemetryPath: path.join(this.outDir, "telemetry.jsonl"),
      receiptsPath: path.join(this.outDir, "receipts.jsonl"),
      stats: {
        events: this.eventCount,
        receipts: this.receiptCount,
        proofFiles: this.receiptCount,
      },
    };
  }
}
