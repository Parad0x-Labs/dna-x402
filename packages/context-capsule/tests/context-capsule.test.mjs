/**
 * @parad0x_labs/context-capsule — test suite
 * Run: node --test tests/context-capsule.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compressContext, injectCapsule, searchCapsule, estimateSavings } from "../src/index.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Realistic 20-message agent conversation about payments and identity */
function makeConversation(n = 20) {
  const turns = [
    { role: "system",    content: "You are a financial agent operating on the Solana blockchain. You process x402 payments, anchor receipts, and manage Agent Passport credentials." },
    { role: "user",      content: "What is the current status of the payment receipt for transaction sig_abc123?" },
    { role: "assistant", content: "The payment receipt for sig_abc123 has been successfully anchored on Solana mainnet-beta. The receipt shows 1000 USDC transferred from AgentAlice to ApiEndpoint. Merkle root: deadbeef01234567." },
    { role: "user",      content: "Can you verify the Agent Passport credential for agent identity parad0x_007?" },
    { role: "assistant", content: "Agent Passport parad0x_007 is verified. The Ed25519 public key is bound to the Solana wallet address. Last activity: 2026-05-31T00:00:00Z. PRF attestation confirmed." },
    { role: "user",      content: "I need to compress the session history before the next LLM call to reduce token costs." },
    { role: "assistant", content: "Understood. I will use ContextCapsule to compress the session history. The compression ratio should be approximately 80-100x for typical agent conversations." },
    { role: "user",      content: "What receipts are anchored in the last 24 hours?" },
    { role: "assistant", content: "In the last 24 hours, 4,237 payment receipts were anchored. Total volume: 2.1M USDC. Top endpoints: payments.parad0x.io (1,200 calls), agents.null.so (987 calls), api.openclaw.dev (650 calls)." },
    { role: "user",      content: "Fetch the Dark NULL privacy layer status." },
    { role: "assistant", content: "Dark NULL privacy layer is active. Shielded pool has 0.0 NULL balance (stub). ZK circuit: dark_shielded_pool v0.3. Poseidon hash: aligned. Recipient binding: verified." },
    { role: "user",      content: "What is the NULL token price and liquidity?" },
    { role: "assistant", content: "NULL token: no price data yet (pre-launch). Liquidity: 0. Target TGE: Q3 2026. Planned initial DEX offering on Raydium with 5% of supply." },
    { role: "user",      content: "Run the x402 payment flow for a new agent request." },
    { role: "assistant", content: "Initiating x402 payment flow. Step 1: Quote requested from server. Step 2: Payment signed by agent wallet. Step 3: Receipt anchored on-chain. Step 4: Access granted to protected resource. Flow completed in 1.3s." },
    { role: "user",      content: "Show me the Merkle root for the current batch." },
    { role: "assistant", content: "Current batch Merkle root: a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890. This covers 256 receipts. Batch sealed at block 345,678,901." },
    { role: "user",      content: "What is the DePIN mining status?" },
    { role: "assistant", content: "NULL Mining Network is in design phase. Target: phones performing real computational tasks (receipt verification, ZK witness generation) to earn NULL. Protocol earns USDC via x402 gating." },
    { role: "user",      content: "Check the session token count and suggest compression." },
    { role: "assistant", content: "Session history is approximately 3,800 tokens. ContextCapsule compression should reduce this to under 100 tokens for the injection string, saving approximately 97% of tokens per call." },
    { role: "user",      content: "Verify the BLS12-381 aggregated proof for this batch." },
    { role: "assistant", content: "BLS12-381 aggregated proof: VALID. 16 agent signatures aggregated into single compact proof. Verification time: 4.2ms. Solana program: bls_verify_agg v0.1 on devnet." },
    { role: "user",      content: "What subscriptions are active for this agent?" },
    { role: "assistant", content: "Active subscriptions: 3. Streamflow streams: payments-oracle (0.01 USDC/hr), market-data-feed (0.05 USDC/hr), compliance-check (0.02 USDC/hr). Total burn: 0.08 USDC/hr." },
    { role: "user",      content: "Final summary: what did we accomplish in this session?" },
    { role: "assistant", content: "Session summary: verified payment receipts, confirmed Agent Passport credentials, checked Dark NULL status, reviewed NULL token pre-launch metrics, executed x402 payment flows, verified BLS12-381 aggregated proofs, and reviewed active Streamflow subscriptions. All systems nominal." },
  ];

  // If n < turns.length, slice; if n > turns.length, repeat-pad
  if (n <= turns.length) return turns.slice(0, n);

  const result = [...turns];
  let i = 0;
  while (result.length < n) {
    const base = turns[i % turns.length];
    result.push({ role: base.role, content: `[repeat ${result.length}] ${base.content}` });
    i++;
  }
  return result;
}

// ── Compression ───────────────────────────────────────────────────────────────

test("compression produces smaller output than input", () => {
  const messages = makeConversation(20);
  const capsule = compressContext(messages);

  const jsonl = messages.map(m => JSON.stringify(m)).join("\n");
  const originalBytes = Buffer.byteLength(jsonl, "utf8");

  assert.ok(
    capsule.compressedBytes < originalBytes,
    `compressed (${capsule.compressedBytes}B) must be smaller than original (${originalBytes}B)`
  );

  // Expect at least 50% compression on realistic conversation text
  const ratio = originalBytes / capsule.compressedBytes;
  assert.ok(ratio >= 2, `compression ratio ${ratio.toFixed(1)}x must be >= 2x`);

  console.log(`  Compression: ${originalBytes}B → ${capsule.compressedBytes}B = ${capsule.compressionRatio}`);
});

test("compressContext returns valid ContextCapsule shape", () => {
  const messages = makeConversation(5);
  const capsule = compressContext(messages, { sessionId: "test_session_001" });

  assert.equal(typeof capsule.sessionId, "string");
  assert.equal(typeof capsule.capsuleId, "string");
  assert.equal(typeof capsule.originalTokenEstimate, "number");
  assert.equal(typeof capsule.compressedBytes, "number");
  assert.equal(typeof capsule.compressionRatio, "string");
  assert.ok(Array.isArray(capsule.topics));
  assert.equal(typeof capsule.merkleRoot, "string");
  assert.equal(typeof capsule.createdAt, "number");
  assert.equal(typeof capsule.compressedBase64, "string");

  // merkleRoot is 64 hex chars (32 bytes)
  assert.equal(capsule.merkleRoot.length, 64);
  assert.ok(/^[0-9a-f]+$/i.test(capsule.merkleRoot), "merkleRoot must be hex");

  // compressionRatio ends with "x"
  assert.ok(capsule.compressionRatio.endsWith("x"), "compressionRatio must end with 'x'");

  assert.equal(capsule.sessionId, "test_session_001");
});

test("compressContext rejects empty messages", () => {
  assert.throws(() => compressContext([]), /non-empty/);
});

// ── Injection ─────────────────────────────────────────────────────────────────

test("injectCapsule returns short string with topic mentions", () => {
  const messages = makeConversation(20);
  const capsule = compressContext(messages, { sessionId: "inject_test" });
  const injection = injectCapsule(capsule);

  // Must be a single non-empty string
  assert.equal(typeof injection, "string");
  assert.ok(injection.length > 0);

  // Must be short — under 400 characters (roughly 100 tokens)
  assert.ok(
    injection.length < 400,
    `injection string length ${injection.length} should be under 400 chars`
  );

  // Must mention the session id
  assert.ok(injection.includes("inject_test"), "injection must mention sessionId");

  // Must mention compression ratio
  assert.ok(injection.includes("x"), "injection must mention compression ratio");

  // Must mention Merkle root (first 12 chars)
  assert.ok(
    injection.includes(capsule.merkleRoot.slice(0, 12)),
    "injection must include truncated merkle root"
  );

  // Must mention at least one topic
  const hasTopic = capsule.topics.some(t => injection.includes(t));
  assert.ok(hasTopic, `injection must include at least one extracted topic. Topics: ${capsule.topics.join(", ")}`);

  console.log(`  Injection (${injection.length} chars): ${injection}`);
});

test("injectCapsule is far shorter than full history", () => {
  const messages = makeConversation(20);
  const capsule = compressContext(messages);
  const injection = injectCapsule(capsule);
  const fullHistory = messages.map(m => `${m.role}: ${m.content}`).join("\n");

  assert.ok(
    injection.length * 10 < fullHistory.length,
    `injection (${injection.length}) should be at least 10x shorter than full history (${fullHistory.length})`
  );
});

// ── Search ────────────────────────────────────────────────────────────────────

test("searchCapsule finds relevant messages", () => {
  const messages = makeConversation(20);
  const capsule = compressContext(messages);

  const result = searchCapsule(capsule, "payment receipt");

  assert.ok(result.includes("CAPSULE SEARCH RESULTS"), "should return search results header");
  assert.ok(
    result.toLowerCase().includes("payment") || result.toLowerCase().includes("receipt"),
    "search result must contain payment or receipt content"
  );

  console.log(`  Search result preview: ${result.slice(0, 200)}...`);
});

test("searchCapsule does not return full history for specific query", () => {
  const messages = makeConversation(20);
  const capsule = compressContext(messages);

  // Search for something that appears in only a few messages
  const result = searchCapsule(capsule, "Merkle");
  const fullHistory = messages.map(m => `${m.role}: ${m.content}`).join("\n");

  assert.ok(
    result.length < fullHistory.length,
    `search result (${result.length}) should be shorter than full history (${fullHistory.length})`
  );
  assert.ok(result.toLowerCase().includes("merkle"), "should find merkle-related messages");
});

test("searchCapsule returns no-match message for unknown query", () => {
  const messages = makeConversation(10);
  const capsule = compressContext(messages);

  const result = searchCapsule(capsule, "quantum_unicorn_xyz_notaword");

  assert.ok(result.includes("no messages matched"), "should report no matches");
});

test("searchCapsule handles empty query gracefully", () => {
  const messages = makeConversation(5);
  const capsule = compressContext(messages);

  const result = searchCapsule(capsule, "");

  assert.ok(result.includes("empty query"), "should report empty query error");
});

// ── Savings ───────────────────────────────────────────────────────────────────

test("estimateSavings shows > 50% reduction on realistic inputs", () => {
  const messages = makeConversation(20);
  const capsule = compressContext(messages);
  const savings = estimateSavings(messages, capsule);

  assert.ok(typeof savings.originalTokens === "number" && savings.originalTokens > 0);
  assert.ok(typeof savings.compressedTokens === "number" && savings.compressedTokens > 0);
  assert.ok(savings.savedTokens > 0, "must save some tokens");
  assert.ok(savings.savedPercent.endsWith("%"), "savedPercent must end with %");
  assert.ok(savings.estimatedUsdSavingsPerCall.startsWith("$"), "USD savings must start with $");

  const percent = parseFloat(savings.savedPercent);
  assert.ok(
    percent > 50,
    `savings ${savings.savedPercent} must be > 50% on realistic 20-message conversation`
  );

  console.log(`  Original: ${savings.originalTokens} tokens`);
  console.log(`  Compressed: ${savings.compressedTokens} tokens`);
  console.log(`  Saved: ${savings.savedTokens} tokens (${savings.savedPercent})`);
  console.log(`  USD savings/call: ${savings.estimatedUsdSavingsPerCall}`);
});

test("estimateSavings USD calculation is consistent with $15/1M token rate", () => {
  const messages = makeConversation(10);
  const capsule = compressContext(messages);
  const savings = estimateSavings(messages, capsule);

  const expectedUsd = savings.savedTokens * (15 / 1_000_000);
  const actualUsd = parseFloat(savings.estimatedUsdSavingsPerCall.slice(1));

  assert.ok(
    Math.abs(actualUsd - expectedUsd) < 0.000001,
    `USD calculation off: expected ~$${expectedUsd.toFixed(6)}, got ${savings.estimatedUsdSavingsPerCall}`
  );
});

// ── Merkle root determinism ───────────────────────────────────────────────────

test("Merkle root is deterministic for the same messages", () => {
  const messages = makeConversation(10);

  // Wait 1ms to ensure createdAt differs between runs
  const capsule1 = compressContext(messages, { sessionId: "det_test" });
  const capsule2 = compressContext(messages, { sessionId: "det_test" });

  assert.equal(
    capsule1.merkleRoot,
    capsule2.merkleRoot,
    "Merkle root must be identical for same messages"
  );

  console.log(`  Deterministic root: ${capsule1.merkleRoot.slice(0, 16)}...`);
});

test("Merkle root changes when messages change", () => {
  const messages = makeConversation(10);
  const modified = [...messages];
  modified[5] = { role: modified[5].role, content: modified[5].content + " MODIFIED" };

  const capsule1 = compressContext(messages, { sessionId: "diff_test" });
  const capsule2 = compressContext(modified, { sessionId: "diff_test" });

  assert.notEqual(
    capsule1.merkleRoot,
    capsule2.merkleRoot,
    "Merkle root must differ when messages differ"
  );
});

test("single-message Merkle root is sha256 of that message JSON", () => {
  const msg = { role: "user", content: "hello world" };
  const capsule = compressContext([msg]);

  // Our Merkle: single leaf → leaf is root
  const expected = createHash("sha256")
    .update(JSON.stringify(msg), "utf8")
    .digest("hex");

  assert.equal(capsule.merkleRoot, expected, "single-message root must equal sha256(msg)");
});

// ── Round-trip (compress → search returns original content) ──────────────────

test("search capsule correctly reconstructs original message content", () => {
  const messages = [
    { role: "user",      content: "transfer 500 USDC to agent_0xdeadbeef" },
    { role: "assistant", content: "Transfer complete. TxSig: abc123. Receipt anchored." },
    { role: "user",      content: "what is the Solana slot for this transaction?" },
    { role: "assistant", content: "Slot 345000001. Confirmed. Block time: 2026-05-31T12:00:00Z." },
  ];

  const capsule = compressContext(messages);
  const result = searchCapsule(capsule, "500 USDC");

  assert.ok(
    result.includes("500 USDC"),
    "search must recover original message content faithfully"
  );
  assert.ok(
    result.includes("agent_0xdeadbeef"),
    "search must recover full message text"
  );
});

// ── Scale test ────────────────────────────────────────────────────────────────

test("100-message conversation compresses and injects correctly", () => {
  const messages = makeConversation(100);
  const t0 = performance.now();
  const capsule = compressContext(messages);
  const ms = performance.now() - t0;

  const injection = injectCapsule(capsule);
  const savings = estimateSavings(messages, capsule);

  assert.ok(capsule.compressedBytes > 0);
  assert.ok(injection.length < 400);
  assert.ok(parseFloat(savings.savedPercent) > 80, `Expected >80% savings on 100 msgs, got ${savings.savedPercent}`);

  console.log(`  100 messages compressed in ${ms.toFixed(1)}ms`);
  console.log(`  Ratio: ${capsule.compressionRatio} | Saved: ${savings.savedPercent}`);
  console.log(`  Topics: ${capsule.topics.join(", ")}`);
});
