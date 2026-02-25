import crypto from "node:crypto";
import fs from "node:fs";

export type AuditEventKind =
  | "QUOTE_ISSUED"
  | "COMMIT_CREATED"
  | "PAYMENT_VERIFIED"
  | "PAYMENT_REJECTED"
  | "RECEIPT_ISSUED"
  | "RECEIPT_ANCHORED"
  | "NETTING_FLUSH"
  | "WEBHOOK_SENT"
  | "WEBHOOK_FAILED"
  | "RATE_LIMITED"
  | "PAUSE_ACTIVATED"
  | "PAUSE_DEACTIVATED"
  | "SHOP_REGISTERED"
  | "SHOP_DISABLED"
  | "CONFIG_LOADED"
  | "SERVER_STARTED"
  | "SERVER_STOPPED";

export interface AuditEntry {
  id: string;
  ts: string;
  kind: AuditEventKind;
  traceId?: string;
  actor?: string;
  shopId?: string;
  endpointId?: string;
  quoteId?: string;
  commitId?: string;
  receiptId?: string;
  settlement?: string;
  amountAtomic?: string;
  mint?: string;
  recipient?: string;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  filePath?: string;
  stdout?: boolean;
  maxEntriesInMemory?: number;
}

export class AuditLogger {
  private readonly entries: AuditEntry[] = [];
  private readonly maxEntries: number;
  private readonly filePath?: string;
  private readonly stdout: boolean;
  private fileStream?: fs.WriteStream;

  constructor(options: AuditLoggerOptions = {}) {
    this.maxEntries = options.maxEntriesInMemory ?? 10_000;
    this.stdout = options.stdout ?? true;
    this.filePath = options.filePath;

    if (this.filePath) {
      this.fileStream = fs.createWriteStream(this.filePath, { flags: "a" });
    }
  }

  record(partial: Omit<AuditEntry, "id" | "ts">): AuditEntry {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      ...partial,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    const line = JSON.stringify(entry);
    if (this.stdout) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
    if (this.fileStream) {
      this.fileStream.write(line + "\n");
    }

    return entry;
  }

  query(filter: {
    kind?: AuditEventKind;
    shopId?: string;
    traceId?: string;
    since?: string;
    limit?: number;
  }): AuditEntry[] {
    let result = this.entries;

    if (filter.kind) {
      result = result.filter((e) => e.kind === filter.kind);
    }
    if (filter.shopId) {
      result = result.filter((e) => e.shopId === filter.shopId);
    }
    if (filter.traceId) {
      result = result.filter((e) => e.traceId === filter.traceId);
    }
    if (filter.since) {
      const sinceMs = new Date(filter.since).getTime();
      result = result.filter((e) => new Date(e.ts).getTime() >= sinceMs);
    }

    const limit = filter.limit ?? 100;
    return result.slice(-limit);
  }

  summary(windowMs = 86_400_000): {
    totalEvents: number;
    paymentsVerified: number;
    paymentsRejected: number;
    receiptsIssued: number;
    receiptsAnchored: number;
    webhooksSent: number;
    webhooksFailed: number;
    rateLimited: number;
    uniqueShops: number;
    uniqueTraces: number;
  } {
    const cutoff = Date.now() - windowMs;
    const window = this.entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
    const shops = new Set<string>();
    const traces = new Set<string>();
    let paymentsVerified = 0;
    let paymentsRejected = 0;
    let receiptsIssued = 0;
    let receiptsAnchored = 0;
    let webhooksSent = 0;
    let webhooksFailed = 0;
    let rateLimited = 0;

    for (const e of window) {
      if (e.shopId) shops.add(e.shopId);
      if (e.traceId) traces.add(e.traceId);
      switch (e.kind) {
        case "PAYMENT_VERIFIED": paymentsVerified++; break;
        case "PAYMENT_REJECTED": paymentsRejected++; break;
        case "RECEIPT_ISSUED": receiptsIssued++; break;
        case "RECEIPT_ANCHORED": receiptsAnchored++; break;
        case "WEBHOOK_SENT": webhooksSent++; break;
        case "WEBHOOK_FAILED": webhooksFailed++; break;
        case "RATE_LIMITED": rateLimited++; break;
      }
    }

    return {
      totalEvents: window.length,
      paymentsVerified,
      paymentsRejected,
      receiptsIssued,
      receiptsAnchored,
      webhooksSent,
      webhooksFailed,
      rateLimited,
      uniqueShops: shops.size,
      uniqueTraces: traces.size,
    };
  }

  exportNdjson(since?: string): string {
    const entries = since
      ? this.entries.filter((e) => new Date(e.ts).getTime() >= new Date(since).getTime())
      : this.entries;
    return entries.map((e) => JSON.stringify(e)).join("\n");
  }

  close(): void {
    this.fileStream?.end();
  }
}
