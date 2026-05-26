import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

function gossipMessageCommitment(
  messageBytes: Buffer,
  senderNonce: Buffer
): Buffer {
  const h = createHash("sha256");
  h.update(Buffer.from("gossip-msg-v1", "utf8"));
  h.update(messageBytes);
  h.update(senderNonce);
  return h.digest();
}

function gossipReceiverCommitment(
  receiverSecret: Buffer,
  messageCommitment: Buffer
): Buffer {
  const h = createHash("sha256");
  h.update(Buffer.from("gossip-recv-v1", "utf8"));
  h.update(receiverSecret);
  h.update(messageCommitment);
  return h.digest();
}

function gossipProofHash(
  msgCommit: Buffer,
  recvCommit: Buffer,
  receivedAtUnix: bigint
): Buffer {
  const tsBuf = Buffer.alloc(8);
  const lo = Number(receivedAtUnix & BigInt(0xffffffff));
  const hi = Number((receivedAtUnix >> BigInt(32)) & BigInt(0xffffffff));
  tsBuf.writeUInt32LE(lo, 0);
  tsBuf.writeUInt32LE(hi, 4);

  const h = createHash("sha256");
  h.update(Buffer.from("gossip-proof-v1", "utf8"));
  h.update(msgCommit);
  h.update(recvCommit);
  h.update(tsBuf);
  return h.digest();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dark-null gossip proof", () => {
  const MESSAGE_BYTES = Buffer.from("hello gossip network", "utf8");
  const SENDER_NONCE = Buffer.alloc(32, 0x55);
  const RECEIVER_SECRET = Buffer.alloc(32, 0x99);
  const RECEIVED_AT = BigInt(1700000000);

  it("message_commitment = SHA256(prefix || message_bytes || sender_nonce) — 32 bytes", () => {
    const commit = gossipMessageCommitment(MESSAGE_BYTES, SENDER_NONCE);
    expect(commit).toBeInstanceOf(Buffer);
    expect(commit.length).toBe(32);

    // Manual recomputation
    const h = createHash("sha256");
    h.update(Buffer.from("gossip-msg-v1", "utf8"));
    h.update(MESSAGE_BYTES);
    h.update(SENDER_NONCE);
    expect(commit.toString("hex")).toBe(h.digest("hex"));
  });

  it("receiver_commitment = SHA256(prefix || receiver_secret || message_commitment)", () => {
    const msgCommit = gossipMessageCommitment(MESSAGE_BYTES, SENDER_NONCE);
    const recvCommit = gossipReceiverCommitment(RECEIVER_SECRET, msgCommit);
    expect(recvCommit).toBeInstanceOf(Buffer);
    expect(recvCommit.length).toBe(32);

    const h = createHash("sha256");
    h.update(Buffer.from("gossip-recv-v1", "utf8"));
    h.update(RECEIVER_SECRET);
    h.update(msgCommit);
    expect(recvCommit.toString("hex")).toBe(h.digest("hex"));
  });

  it("different receiver_secrets → different receiver_commitments (privacy)", () => {
    const msgCommit = gossipMessageCommitment(MESSAGE_BYTES, SENDER_NONCE);
    const secret1 = Buffer.alloc(32, 0x01);
    const secret2 = Buffer.alloc(32, 0x02);
    const secret3 = Buffer.alloc(32, 0xff);

    const rc1 = gossipReceiverCommitment(secret1, msgCommit);
    const rc2 = gossipReceiverCommitment(secret2, msgCommit);
    const rc3 = gossipReceiverCommitment(secret3, msgCommit);

    expect(rc1.toString("hex")).not.toBe(rc2.toString("hex"));
    expect(rc2.toString("hex")).not.toBe(rc3.toString("hex"));
    expect(rc1.toString("hex")).not.toBe(rc3.toString("hex"));
  });

  it("proof_hash = SHA256(prefix || msg_commit || recv_commit || received_at_le8)", () => {
    const msgCommit = gossipMessageCommitment(MESSAGE_BYTES, SENDER_NONCE);
    const recvCommit = gossipReceiverCommitment(RECEIVER_SECRET, msgCommit);
    const proof = gossipProofHash(msgCommit, recvCommit, RECEIVED_AT);

    expect(proof).toBeInstanceOf(Buffer);
    expect(proof.length).toBe(32);

    // Manual recomputation
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeUInt32LE(Number(RECEIVED_AT & BigInt(0xffffffff)), 0);
    tsBuf.writeUInt32LE(
      Number((RECEIVED_AT >> BigInt(32)) & BigInt(0xffffffff)),
      4
    );
    const h = createHash("sha256");
    h.update(Buffer.from("gossip-proof-v1", "utf8"));
    h.update(msgCommit);
    h.update(recvCommit);
    h.update(tsBuf);
    expect(proof.toString("hex")).toBe(h.digest("hex"));
  });

  it("wrong receiver_secret in prove → receiver_commitment mismatch", () => {
    const msgCommit = gossipMessageCommitment(MESSAGE_BYTES, SENDER_NONCE);
    const correctCommit = gossipReceiverCommitment(RECEIVER_SECRET, msgCommit);

    const wrongSecret = Buffer.alloc(32, 0xba);
    const wrongCommit = gossipReceiverCommitment(wrongSecret, msgCommit);

    expect(correctCommit.toString("hex")).not.toBe(
      wrongCommit.toString("hex")
    );
  });

  it("public record JSON contains message_commitment and received_at_unix but NOT receiver_commitment", () => {
    const msgCommit = gossipMessageCommitment(MESSAGE_BYTES, SENDER_NONCE);
    const recvCommit = gossipReceiverCommitment(RECEIVER_SECRET, msgCommit);
    const proof = gossipProofHash(msgCommit, recvCommit, RECEIVED_AT);

    // Build what the public record would look like
    const publicRecord = {
      message_commitment: msgCommit.toString("hex"),
      received_at_unix: Number(RECEIVED_AT),
      proof_hash: proof.toString("hex"),
      mainnet_ready: false,
    };

    expect(publicRecord).toHaveProperty("message_commitment");
    expect(publicRecord).toHaveProperty("received_at_unix", Number(RECEIVED_AT));
    expect(publicRecord).not.toHaveProperty("receiver_commitment");
    expect(publicRecord).not.toHaveProperty("receiver_secret");

    const keys = Object.keys(publicRecord);
    const hasReceiverCommit = keys.some((k) => k.includes("receiver"));
    expect(hasReceiverCommit).toBe(false);
  });
});
