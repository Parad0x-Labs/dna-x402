/**
 * DNA x Liquefy Bridge — Server Sidecar
 *
 * Attaches to a running DNA x402 server and streams audit events + receipts
 * into a Liquefy-ready vault directory in real-time.
 *
 * Usage in server.ts:
 *   import { LiquefySidecar } from "./bridge/liquefy/sidecar.js";
 *   const sidecar = new LiquefySidecar({ outDir: "./vault-live", cluster: "devnet" });
 *   sidecar.attach(context);
 */

import type { AuditEntry, AuditLogger } from "../../logging/audit.js";
import type { SignedReceipt } from "../../types.js";
import { LiquefyVaultExporter } from "./exporter.js";

export interface LiquefySidecarOptions {
  outDir: string;
  cluster?: string;
  version?: string;
  flushIntervalMs?: number;
}

export class LiquefySidecar {
  private exporter: LiquefyVaultExporter;
  private readonly flushIntervalMs: number;
  private flushTimer?: NodeJS.Timeout;
  private originalRecord?: AuditLogger["record"];

  constructor(options: LiquefySidecarOptions) {
    this.exporter = new LiquefyVaultExporter({
      outDir: options.outDir,
      cluster: options.cluster,
      version: options.version,
    });
    this.flushIntervalMs = options.flushIntervalMs ?? 300_000;
    this.exporter.init();
  }

  /**
   * Wraps the audit logger's record method to also stream events to Liquefy.
   * Non-invasive: the original record function still fires normally.
   */
  attachAuditLogger(auditLog: AuditLogger): void {
    const originalRecord = auditLog.record.bind(auditLog);
    this.originalRecord = originalRecord;

    auditLog.record = (partial: Omit<AuditEntry, "id" | "ts">): AuditEntry => {
      const entry = originalRecord(partial);
      try {
        this.exporter.writeAuditEvent(entry);
      } catch {
        // Never let bridge failures affect the payment path
      }
      return entry;
    };
  }

  writeReceipt(receipt: SignedReceipt): void {
    try {
      this.exporter.writeReceipt(receipt);
    } catch {
      // Silently ignore bridge failures
    }
  }

  startPeriodicFlush(): void {
    this.flushTimer = setInterval(() => {
      try {
        this.exporter.finalize();
        this.exporter = new LiquefyVaultExporter({
          outDir: this.exporter["outDir"],
          cluster: this.exporter["cluster"],
          version: this.exporter["version"],
        });
        this.exporter.init();
      } catch {
        // Ignore flush failures
      }
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  stop(): { manifestPath: string; telemetryPath: string; receiptsPath: string; stats: Record<string, number> } {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    return this.exporter.finalize();
  }
}
