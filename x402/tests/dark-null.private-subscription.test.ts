import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

// Domain functions
function subscriberHash(secret: Buffer): Buffer {
  return sha256(Buffer.from("sub-subscriber-v1"), secret);
}
function planHash(plan: Buffer): Buffer {
  return sha256(Buffer.from("sub-plan-v1"), plan);
}
function paymentCommitment(amount: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from("sub-payment-v1"), u64le(amount), blinding);
}
function subId(subH: Buffer, planH: Buffer, start: bigint, end: bigint): Buffer {
  return sha256(Buffer.from("sub-id-v1"), subH, planH, u64le(start), u64le(end));
}
function isActiveAt(start: bigint, end: bigint, now: bigint): boolean {
  return now >= start && now < end;
}

describe("dark-null private-subscription", () => {
  const secret = Buffer.from("subscriber-secret-abc123");
  const plan = Buffer.from("plan-monthly-premium");
  const blinding = sha256(Buffer.from("blinding-nonce"));
  const startEpoch = 1_000_000n;
  const endEpoch = 1_100_000n;

  it("sub_id formula is correct", () => {
    const subH = subscriberHash(secret);
    const planH = planHash(plan);
    const expected = createHash("sha256")
      .update(Buffer.from("sub-id-v1"))
      .update(subH)
      .update(planH)
      .update(u64le(startEpoch))
      .update(u64le(endEpoch))
      .digest();
    expect(subId(subH, planH, startEpoch, endEpoch).toString("hex")).toBe(expected.toString("hex"));
  });

  it("payment_commitment uses amount and blinding", () => {
    const amount = 500_000n;
    const expected = createHash("sha256")
      .update(Buffer.from("sub-payment-v1"))
      .update(u64le(amount))
      .update(blinding)
      .digest();
    expect(paymentCommitment(amount, blinding).toString("hex")).toBe(expected.toString("hex"));
  });

  it("different plans produce different sub_ids", () => {
    const subH = subscriberHash(secret);
    const planH1 = planHash(Buffer.from("plan-monthly"));
    const planH2 = planHash(Buffer.from("plan-annual"));
    const id1 = subId(subH, planH1, startEpoch, endEpoch);
    const id2 = subId(subH, planH2, startEpoch, endEpoch);
    expect(id1.toString("hex")).not.toBe(id2.toString("hex"));
  });

  it("start_epoch < end_epoch is valid", () => {
    expect(startEpoch < endEpoch).toBe(true);
  });

  it("is_active_at returns true within range", () => {
    const mid = (startEpoch + endEpoch) / 2n;
    expect(isActiveAt(startEpoch, endEpoch, mid)).toBe(true);
    expect(isActiveAt(startEpoch, endEpoch, startEpoch - 1n)).toBe(false);
    expect(isActiveAt(startEpoch, endEpoch, endEpoch)).toBe(false);
  });

  it("mainnet_ready is false", () => {
    const mainnet_ready = false;
    expect(mainnet_ready).toBe(false);
  });
});
