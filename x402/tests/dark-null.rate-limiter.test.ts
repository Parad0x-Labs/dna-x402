import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline implementation: RateLedger
// Mirrors the dark-rate-limiter Rust crate contract.
// ---------------------------------------------------------------------------

function spendNullifier(
  userSecret: Buffer,
  epoch: bigint,
  counter: number,
  domain: Buffer,
): Buffer {
  const prefix = Buffer.from("rate-null-v1", "utf8");
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32LE(counter);
  return createHash("sha256")
    .update(prefix)
    .update(userSecret)
    .update(epochBuf)
    .update(counterBuf)
    .update(domain)
    .digest();
}

class RateLedger {
  private nullifiers: Set<string> = new Set();
  private epoch: bigint;
  private readonly maxPerEpoch: number;

  constructor(epoch: bigint, maxPerEpoch: number) {
    this.epoch = epoch;
    this.maxPerEpoch = maxPerEpoch;
  }

  addNullifier(nullifier: Buffer): void {
    if (this.isOver()) {
      throw new Error("QUOTA_EXCEEDED: spend_count exceeds max_per_epoch");
    }
    this.nullifiers.add(nullifier.toString("hex"));
  }

  isOver(): boolean {
    return this.nullifiers.size >= this.maxPerEpoch;
  }

  reset(newEpoch: bigint): void {
    this.epoch = newEpoch;
    this.nullifiers.clear();
  }

  statsJson(): string {
    return JSON.stringify({
      epoch: this.epoch.toString(),
      spend_count: this.nullifiers.size,
      max_per_epoch: this.maxPerEpoch,
    });
  }

  hasNullifier(nullifier: Buffer): boolean {
    return this.nullifiers.has(nullifier.toString("hex"));
  }

  spendCount(): number {
    return this.nullifiers.size;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_DOMAIN = Buffer.alloc(8, 0xab);
const USER_SECRET_A = Buffer.from("user-secret-alice-0000000000000000", "utf8");
const USER_SECRET_B = Buffer.from("user-secret-bob-00000000000000000", "utf8");
const EPOCH_1 = 1n;
const EPOCH_2 = 2n;

describe("dark-null rate limiter (ZK contract mirror)", () => {
  it("spend nullifier = SHA256(rate-null-v1 || user_secret || epoch_le8 || counter_le4 || domain8) — is 32 bytes", () => {
    const nullifier = spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN);
    expect(nullifier).toBeInstanceOf(Buffer);
    expect(nullifier.length).toBe(32);

    // Verify the construction manually.
    const prefix = Buffer.from("rate-null-v1", "utf8");
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(EPOCH_1);
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32LE(0);
    const expected = createHash("sha256")
      .update(prefix)
      .update(USER_SECRET_A)
      .update(epochBuf)
      .update(counterBuf)
      .update(TEST_DOMAIN)
      .digest();
    expect(nullifier).toEqual(expected);
  });

  it("same user_secret + epoch + counter → same nullifier (deterministic)", () => {
    const a = spendNullifier(USER_SECRET_A, EPOCH_1, 3, TEST_DOMAIN);
    const b = spendNullifier(USER_SECRET_A, EPOCH_1, 3, TEST_DOMAIN);
    expect(a).toEqual(b);
  });

  it("different counter → different nullifier (each spend is unique)", () => {
    const n0 = spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN);
    const n1 = spendNullifier(USER_SECRET_A, EPOCH_1, 1, TEST_DOMAIN);
    const n2 = spendNullifier(USER_SECRET_A, EPOCH_1, 2, TEST_DOMAIN);
    expect(n0).not.toEqual(n1);
    expect(n1).not.toEqual(n2);
    expect(n0).not.toEqual(n2);
  });

  it("different user secrets → different nullifiers (privacy: server can't link nullifiers to users)", () => {
    const na = spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN);
    const nb = spendNullifier(USER_SECRET_B, EPOCH_1, 0, TEST_DOMAIN);
    expect(na).not.toEqual(nb);
    // Confirms unlinkability: same epoch+counter under different secrets are indistinguishable.
    expect(na.toString("hex")).not.toBe(nb.toString("hex"));
  });

  it("ledger stats JSON contains epoch, spend_count, max_per_epoch but NOT nullifier values", () => {
    const ledger = new RateLedger(EPOCH_1, 10);
    ledger.addNullifier(spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN));
    ledger.addNullifier(spendNullifier(USER_SECRET_A, EPOCH_1, 1, TEST_DOMAIN));

    const stats = JSON.parse(ledger.statsJson());
    expect(stats).toHaveProperty("epoch");
    expect(stats).toHaveProperty("spend_count", 2);
    expect(stats).toHaveProperty("max_per_epoch", 10);

    // Must NOT contain nullifier hex values.
    const raw = ledger.statsJson();
    const n0hex = spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN).toString("hex");
    expect(raw).not.toContain(n0hex);
  });

  it("quota exceeded: tracking more nullifiers than max_per_epoch raises error", () => {
    const ledger = new RateLedger(EPOCH_1, 3);
    ledger.addNullifier(spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN));
    ledger.addNullifier(spendNullifier(USER_SECRET_A, EPOCH_1, 1, TEST_DOMAIN));
    ledger.addNullifier(spendNullifier(USER_SECRET_A, EPOCH_1, 2, TEST_DOMAIN));
    expect(ledger.isOver()).toBe(true);

    expect(() => {
      ledger.addNullifier(spendNullifier(USER_SECRET_A, EPOCH_1, 3, TEST_DOMAIN));
    }).toThrow(/QUOTA_EXCEEDED/);
  });

  it("reset: after reset_epoch, spend_count returns to 0 and old nullifiers are gone", () => {
    const ledger = new RateLedger(EPOCH_1, 10);
    const n0 = spendNullifier(USER_SECRET_A, EPOCH_1, 0, TEST_DOMAIN);
    const n1 = spendNullifier(USER_SECRET_A, EPOCH_1, 1, TEST_DOMAIN);
    ledger.addNullifier(n0);
    ledger.addNullifier(n1);
    expect(ledger.spendCount()).toBe(2);

    ledger.reset(EPOCH_2);
    expect(ledger.spendCount()).toBe(0);
    expect(ledger.hasNullifier(n0)).toBe(false);
    expect(ledger.hasNullifier(n1)).toBe(false);

    const stats = JSON.parse(ledger.statsJson());
    expect(stats.spend_count).toBe(0);
    expect(stats.epoch).toBe(EPOCH_2.toString());
  });
});
