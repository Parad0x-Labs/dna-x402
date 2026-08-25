/**
 * Replay protection for accepted payments.
 *
 * The default InMemoryReplayStore only guards a single process lifetime.
 * PRODUCTION MUST INJECT A DURABLE STORE (Redis, database, ...) via plugin
 * config `replayStore`, otherwise a restart clears the used-proof set and a
 * captured X-Payment header can be replayed.
 */

/**
 * Pluggable replay store. Keys are `<receiptHash>:<txSignature>` pairs derived
 * from an accepted payment proof.
 */
export interface ReplayStore {
  /** Returns true if this key was already consumed. */
  has(key: string): boolean;
  /** Marks this key as consumed. */
  markUsed(key: string): void;
}

/** Process-lifetime default implementation. Not durable — see module doc. */
export class InMemoryReplayStore implements ReplayStore {
  private used = new Set<string>();

  has(key: string): boolean {
    return this.used.has(key);
  }

  markUsed(key: string): void {
    this.used.add(key);
  }
}
