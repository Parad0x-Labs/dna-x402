import crypto from "node:crypto";

export interface ReplayKeyInput {
  shopId: string;
  txSig: string;
  amountAtomic: string;
  recipient: string;
  mint: string;
}

export function createReplayKey(input: ReplayKeyInput): string {
  return crypto
    .createHash("sha256")
    .update(`${input.shopId}|${input.txSig}|${input.amountAtomic}|${input.recipient}|${input.mint}`)
    .digest("hex");
}

export class ReplayStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {
    if (!ReplayStore.isProductionSafe()) {
      console.warn(
        "WARNING: ReplayStore is in-memory. Replay attacks are possible across restarts. Configure POSTGRES_URL for durable replay protection."
      );
    }
  }

  /**
   * Returns true when the replay store is safe for production use — either
   * because we are not running in production, or because a durable backing
   * store (POSTGRES_URL) has been configured.
   */
  static isProductionSafe(): boolean {
    return process.env.NODE_ENV !== "production" || !!process.env.POSTGRES_URL;
  }

  consume(key: string, nowMs = Date.now()): boolean {
    this.cleanup(nowMs);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }

  has(key: string, nowMs = Date.now()): boolean {
    this.cleanup(nowMs);
    return this.seen.has(key);
  }

  size(nowMs = Date.now()): number {
    this.cleanup(nowMs);
    return this.seen.size;
  }

  private cleanup(nowMs: number): void {
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= nowMs) {
        this.seen.delete(key);
      }
    }
  }
}
