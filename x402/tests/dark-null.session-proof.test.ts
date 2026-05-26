import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline implementation: Session
// Mirrors the dark-session-proof Rust crate contract.
// ---------------------------------------------------------------------------

function computeSessionId(agentSecret: Buffer, nonce: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.from("session-id-v1", "utf8"))
    .update(agentSecret)
    .update(nonce)
    .digest();
}

function computeChainAdvance(prevRoot: Buffer, msgHash: Buffer, counter: number): Buffer {
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32LE(counter);
  return createHash("sha256")
    .update(Buffer.from("chain-v1", "utf8"))
    .update(prevRoot)
    .update(msgHash)
    .update(counterBuf)
    .digest();
}

interface ChainLink {
  prevRoot: Buffer;
  msgHash: Buffer;
  counter: number;
  nextRoot: Buffer;
}

class Session {
  readonly sessionId: Buffer;
  private chainRoot: Buffer;
  private messageCount: number = 0;
  private lastLink: ChainLink | null = null;

  constructor(agentSecret: Buffer, nonce: Buffer) {
    this.sessionId = computeSessionId(agentSecret, nonce);
    this.chainRoot = Buffer.from(this.sessionId);
  }

  advance(message: Buffer): void {
    const msgHash = createHash("sha256").update(message).digest();
    const prevRoot = Buffer.from(this.chainRoot);
    const counter = this.messageCount;
    const nextRoot = computeChainAdvance(prevRoot, msgHash, counter);
    this.lastLink = { prevRoot, msgHash, counter, nextRoot };
    this.chainRoot = nextRoot;
    this.messageCount++;
  }

  verifyLastLink(): boolean {
    if (!this.lastLink) return false;
    const { prevRoot, msgHash, counter, nextRoot } = this.lastLink;
    const recomputed = computeChainAdvance(prevRoot, msgHash, counter);
    return recomputed.equals(nextRoot);
  }

  getChainRoot(): Buffer {
    return Buffer.from(this.chainRoot);
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  sessionProofJson(agentSecret: Buffer): string {
    // Must NOT include agentSecret.
    void agentSecret; // intentionally omitted from output
    return JSON.stringify({
      session_id: this.sessionId.toString("hex"),
      message_count: this.messageCount,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const AGENT_SECRET = Buffer.from("agent-secret-test-000000000000000000000", "utf8");
const NONCE_A = Buffer.from("nonce-alpha-00000000", "utf8");
const NONCE_B = Buffer.from("nonce-beta-000000000", "utf8");

describe("dark-null session chain proof (ZK contract mirror)", () => {
  it("session ID = SHA256(session-id-v1 || agent_secret || nonce) — 32 bytes", () => {
    const session = new Session(AGENT_SECRET, NONCE_A);
    expect(session.sessionId).toBeInstanceOf(Buffer);
    expect(session.sessionId.length).toBe(32);

    const expected = createHash("sha256")
      .update(Buffer.from("session-id-v1", "utf8"))
      .update(AGENT_SECRET)
      .update(NONCE_A)
      .digest();
    expect(session.sessionId).toEqual(expected);
  });

  it("different nonces → different session IDs (session is nonce-bound)", () => {
    const s1 = new Session(AGENT_SECRET, NONCE_A);
    const s2 = new Session(AGENT_SECRET, NONCE_B);
    expect(s1.sessionId).not.toEqual(s2.sessionId);
  });

  it("chain_root starts as session_id (initial state)", () => {
    const session = new Session(AGENT_SECRET, NONCE_A);
    expect(session.getChainRoot()).toEqual(session.sessionId);
    expect(session.getMessageCount()).toBe(0);
  });

  it("after 1 message advance: chain_root = SHA256(chain-v1 || prev_root || msg_hash || counter_le4) — changes", () => {
    const session = new Session(AGENT_SECRET, NONCE_A);
    const initialRoot = Buffer.from(session.getChainRoot());

    const msg = Buffer.from("hello-world-message-0", "utf8");
    session.advance(msg);

    const newRoot = session.getChainRoot();
    expect(newRoot).not.toEqual(initialRoot);

    // Verify the construction manually.
    const msgHash = createHash("sha256").update(msg).digest();
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32LE(0);
    const expected = createHash("sha256")
      .update(Buffer.from("chain-v1", "utf8"))
      .update(initialRoot)
      .update(msgHash)
      .update(counterBuf)
      .digest();
    expect(newRoot).toEqual(expected);
  });

  it("after 3 message advances: chain_root has changed 3 times from session_id", () => {
    const session = new Session(AGENT_SECRET, NONCE_A);
    const roots: string[] = [session.getChainRoot().toString("hex")];

    session.advance(Buffer.from("msg-one", "utf8"));
    roots.push(session.getChainRoot().toString("hex"));

    session.advance(Buffer.from("msg-two", "utf8"));
    roots.push(session.getChainRoot().toString("hex"));

    session.advance(Buffer.from("msg-three", "utf8"));
    roots.push(session.getChainRoot().toString("hex"));

    expect(session.getMessageCount()).toBe(3);

    // All 4 roots (initial + 3 advances) must be distinct.
    const unique = new Set(roots);
    expect(unique.size).toBe(4);

    // Final root is different from session_id.
    expect(roots[3]).not.toBe(roots[0]);
  });

  it("session_proof JSON contains session_id and message_count but NOT agent_secret", () => {
    const session = new Session(AGENT_SECRET, NONCE_A);
    session.advance(Buffer.from("test-message", "utf8"));

    const proof = JSON.parse(session.sessionProofJson(AGENT_SECRET));
    expect(proof).toHaveProperty("session_id");
    expect(proof).toHaveProperty("message_count", 1);

    const raw = session.sessionProofJson(AGENT_SECRET);
    expect(raw).not.toContain(AGENT_SECRET.toString("hex"));
    expect(raw).not.toContain(AGENT_SECRET.toString("utf8"));
  });

  it("link verification: recomputed next_chain_root matches stored next_chain_root", () => {
    const session = new Session(AGENT_SECRET, NONCE_A);
    session.advance(Buffer.from("verify-this-message", "utf8"));
    expect(session.verifyLastLink()).toBe(true);
  });
});
