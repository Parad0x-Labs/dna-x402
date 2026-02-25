import fs from "node:fs";
import path from "node:path";
import { ReceiptAnchorClient } from "../onchain/receiptAnchorClient.js";
import { MarketEvent } from "./types.js";

export interface AnchoringQueueEntry {
  receiptId: string;
  anchor32: string;
  shopId: string;
  endpointId: string;
  capabilityTags: string[];
  priceAmount: string;
  mint: string;
  settlementMode?: "transfer" | "stream" | "netting";
  statusCode?: number;
}

export interface AnchoredReceiptRecord {
  receiptId: string;
  signature: string;
  bucketId: string;
  bucketPda: string;
  anchoredAt: string;
}

interface AnchoringQueueConfig {
  client: ReceiptAnchorClient;
  batchSize: number;
  flushIntervalMs: number;
  flushMinQueue?: number;
  immediate: boolean;
  listEvents: () => MarketEvent[];
  recordEvent: (event: Omit<MarketEvent, "ts">) => void;
  signatureLogPath?: string;
}

export class AnchoringQueue {
  private readonly queue = new Map<string, AnchoringQueueEntry>();
  private readonly anchored = new Map<string, AnchoredReceiptRecord>();
  private readonly bucketCounts = new Map<string, number>();
  private readonly batchSize: number;
  private readonly flushMinQueue: number;
  private readonly flushIntervalMs: number;
  private readonly immediate: boolean;
  private readonly signatureLogPath?: string;
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private lastFlushAt: string | null = null;
  private lastAnchorSig: string | null = null;
  private lastBucketId: string | null = null;
  private lastBucketCount: number | null = null;

  constructor(private readonly config: AnchoringQueueConfig) {
    this.batchSize = Math.max(1, Math.min(32, config.batchSize));
    const configuredFlushInterval = Math.max(1000, config.flushIntervalMs);
    const configuredFlushMinQueue = Math.max(1, config.flushMinQueue ?? this.batchSize);
    const gauntletMode = (process.env.GAUNTLET_MODE ?? "").toLowerCase();
    const gauntletEnabled = gauntletMode === "1" || gauntletMode === "true";
    this.flushIntervalMs = gauntletEnabled ? 2_000 : configuredFlushInterval;
    this.flushMinQueue = gauntletEnabled ? 4 : configuredFlushMinQueue;
    this.immediate = config.immediate;
    this.signatureLogPath = config.signatureLogPath;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flushNow();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  enqueue(entry: AnchoringQueueEntry): void {
    if (this.anchored.has(entry.receiptId)) {
      return;
    }
    this.queue.set(entry.receiptId, entry);
    if (this.immediate || this.queue.size >= this.flushMinQueue || this.queue.size >= this.batchSize) {
      void this.flushNow();
    }
  }

  isAnchored(receiptId: string): boolean {
    return this.anchored.has(receiptId);
  }

  getAnchoredRecord(receiptId: string): AnchoredReceiptRecord | undefined {
    return this.anchored.get(receiptId);
  }

  getAnchoredCount(): number {
    return this.anchored.size;
  }

  getPendingCount(): number {
    return this.queue.size;
  }

  recentSignatures(limit = 20): string[] {
    return Array.from(this.anchored.values())
      .slice(-Math.max(1, limit))
      .map((row) => row.signature);
  }

  getStatus(): {
    queueDepth: number;
    anchoredCount: number;
    lastFlushAt: string | null;
    lastAnchorSig: string | null;
    lastBucketId: string | null;
    lastBucketCount: number | null;
  } {
    return {
      queueDepth: this.queue.size,
      anchoredCount: this.anchored.size,
      lastFlushAt: this.lastFlushAt,
      lastAnchorSig: this.lastAnchorSig,
      lastBucketId: this.lastBucketId,
      lastBucketCount: this.lastBucketCount,
    };
  }

  async flushNow(): Promise<void> {
    if (this.flushing || this.queue.size === 0) {
      return;
    }

    this.flushing = true;
    try {
      const selected = Array.from(this.queue.values()).slice(0, this.batchSize);
      if (selected.length === 0) {
        return;
      }

      try {
        const batchResult = await this.config.client.sendBatch({
          anchors: selected.map((entry) => entry.anchor32),
          useAlt: false,
          includeClockSysvar: false,
          includeSystemProgram: false,
        });
        if (batchResult.confirmed) {
          this.markAnchored(selected, batchResult.signature, batchResult.bucketId, batchResult.bucketPda);
          this.logSignature(batchResult.signature, batchResult.bucketPda, batchResult.bucketId, selected.length);
        }
        return;
      } catch {
        // likely first bucket creation path: fall through to initialize with single.
      }

      const [first, ...rest] = selected;
      const initResult = await this.config.client.sendSingle({
        anchor32: first.anchor32,
        includeClockSysvar: false,
        includeSystemProgram: true,
        includeBucketId: false,
      });
      if (!initResult.confirmed) {
        return;
      }
      this.markAnchored([first], initResult.signature, initResult.bucketId, initResult.bucketPda);
      this.logSignature(initResult.signature, initResult.bucketPda, initResult.bucketId, 1);

      if (rest.length === 0) {
        return;
      }

      const batchResult = await this.config.client.sendBatch({
        anchors: rest.map((entry) => entry.anchor32),
        useAlt: false,
        includeClockSysvar: false,
        includeSystemProgram: false,
      });
      if (!batchResult.confirmed) {
        return;
      }
      this.markAnchored(rest, batchResult.signature, batchResult.bucketId, batchResult.bucketPda);
      this.logSignature(batchResult.signature, batchResult.bucketPda, batchResult.bucketId, rest.length);
    } catch (error) {
      const maybeCode = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`anchoring_flush_failed code=${maybeCode ?? "unknown"} message=${message}`);
      if (maybeCode === "ANCHOR_PROGRAM_MISCONFIGURED") {
        this.stop();
      }
    } finally {
      this.flushing = false;
    }
  }

  private markAnchored(entries: AnchoringQueueEntry[], signature: string, bucketId: string, bucketPda: string): void {
    const nextCount = (this.bucketCounts.get(bucketId) ?? 0) + entries.length;
    this.bucketCounts.set(bucketId, nextCount);
    this.lastFlushAt = new Date().toISOString();
    this.lastAnchorSig = signature;
    this.lastBucketId = bucketId;
    this.lastBucketCount = nextCount;

    for (const entry of entries) {
      this.queue.delete(entry.receiptId);

      const anchoredRecord: AnchoredReceiptRecord = {
        receiptId: entry.receiptId,
        signature,
        bucketId,
        bucketPda,
        anchoredAt: new Date().toISOString(),
      };
      this.anchored.set(entry.receiptId, anchoredRecord);

      this.config.recordEvent({
        type: "PAYMENT_VERIFIED",
        shopId: entry.shopId,
        endpointId: entry.endpointId,
        capabilityTags: entry.capabilityTags,
        priceAmount: entry.priceAmount,
        mint: entry.mint,
        settlementMode: entry.settlementMode,
        receiptId: entry.receiptId,
        anchor32: entry.anchor32,
        anchored: true,
        verificationTier: "VERIFIED",
        receiptValid: true,
      });

      const existing = this.config
        .listEvents()
        .filter((event) => event.type === "REQUEST_FULFILLED" && event.receiptId === entry.receiptId);

      for (const fulfilled of existing) {
        this.config.recordEvent({
          type: "REQUEST_FULFILLED",
          shopId: fulfilled.shopId,
          endpointId: fulfilled.endpointId,
          capabilityTags: fulfilled.capabilityTags,
          priceAmount: fulfilled.priceAmount,
          mint: fulfilled.mint,
          settlementMode: fulfilled.settlementMode,
          statusCode: fulfilled.statusCode,
          latencyMs: fulfilled.latencyMs,
          receiptId: entry.receiptId,
          anchor32: entry.anchor32,
          anchored: true,
          verificationTier: "VERIFIED",
          receiptValid: true,
        });
      }
    }
  }

  private logSignature(signature: string, bucketPda: string, bucketId: string, anchorsCount: number): void {
    if (!this.signatureLogPath) {
      return;
    }
    const dir = path.dirname(this.signatureLogPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      this.signatureLogPath,
      `${new Date().toISOString()} sig=${signature} bucket=${bucketPda} bucketId=${bucketId} anchors=${anchorsCount}\n`,
    );
  }
}
