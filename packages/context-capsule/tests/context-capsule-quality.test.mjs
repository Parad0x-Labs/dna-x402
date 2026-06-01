/**
 * @parad0x_labs/context-capsule — adversarial quality tests
 * Run: node --test tests/context-capsule-quality.test.mjs
 *
 * These tests probe fidelity, determinism, and retrieval precision.
 * All data is synthetic — no file I/O required.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { compressContext, injectCapsule, searchCapsule } from "../src/index.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a session from a flat array of [role, content] pairs. */
function session(...pairs) {
  return pairs.map(([role, content]) => ({ role, content }));
}

/** Build a session of n filler messages that mention no databases. */
function fillerSession(n = 10) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: discussing payment flows and agent passports on Solana.`,
    });
  }
  return msgs;
}

// ── Test 1: capsule must not invent missing facts ─────────────────────────────

test("capsule must not invent missing facts", () => {
  // Session has NO mention of Redis or PostgreSQL
  const messages = fillerSession(12);
  const capsule = compressContext(messages, { sessionId: "no_db_test" });

  const result = searchCapsule(capsule, "database");

  // The search must not hallucinate words never present in the original session
  const lower = result.toLowerCase();
  assert.ok(
    !lower.includes("redis"),
    `searchCapsule invented "Redis" — not present in original session`
  );
  assert.ok(
    !lower.includes("postgresql"),
    `searchCapsule invented "PostgreSQL" — not present in original session`
  );
});

// ── Test 2: capsule must preserve explicit TODOs ──────────────────────────────

test("capsule must preserve explicit TODOs", () => {
  const messages = session(
    ["user", "We need to add more endpoints."],
    ["assistant", "Agreed. TODO: add rate limiting to the API before going live."],
    ["user", "Noted. Anything else?"],
    ["assistant", "That should cover it for now."]
  );
  const capsule = compressContext(messages, { sessionId: "todo_test" });

  const result = searchCapsule(capsule, "TODO");

  assert.ok(
    result.toLowerCase().includes("rate limiting"),
    `searchCapsule(capsule, "TODO") must contain "rate limiting". Got:\n${result}`
  );
});

// ── Test 3: capsule must preserve security constraints ────────────────────────

test("capsule must preserve security constraints", () => {
  // The session explicitly states a security rule.
  // We search for a term present in that rule to confirm fidelity.
  const messages = session(
    ["system", "You are a code review agent."],
    ["user", "Any hardcoded secrets in the repo?"],
    ["assistant", "NEVER commit private keys to git. Store them in environment variables only."],
    ["user", "What about API tokens?"],
    ["assistant", "Same rule applies — no secrets in version control."]
  );
  const capsule = compressContext(messages, { sessionId: "security_test" });

  // Search for "private" — a term that appears in the constraint message.
  // searchCapsule does term-matching against message content.
  const result = searchCapsule(capsule, "private");

  const lower = result.toLowerCase();
  const containsPrivateKey = lower.includes("private key");
  const containsCommit = lower.includes("commit");

  assert.ok(
    containsPrivateKey || containsCommit,
    `searchCapsule must contain "private key" or "commit". Got:\n${result}`
  );
});

// ── Test 4: capsule must preserve file paths ──────────────────────────────────

test("capsule must preserve file paths", () => {
  // The assistant messages contain the file path "anchor.ts".
  // We search for "anchor" — a term present in those assistant responses —
  // to verify the capsule faithfully preserves the specific file path.
  const messages = session(
    ["user", "What changed in the last PR?"],
    ["assistant", "src/anchor.ts was updated to fix the BigInt overflow in the receipt anchor."],
    ["user", "Any other files?"],
    ["assistant", "Only src/anchor.ts in this diff."]
  );
  const capsule = compressContext(messages, { sessionId: "filepath_test" });

  const result = searchCapsule(capsule, "anchor.ts");

  assert.ok(
    result.includes("anchor.ts"),
    `searchCapsule must contain "anchor.ts". Got:\n${result}`
  );
});

// ── Test 5: capsule must preserve failed decisions ────────────────────────────

test("capsule must preserve failed decisions", () => {
  const messages = session(
    ["user", "What caching layer did we evaluate?"],
    ["assistant", "We considered using Redis but rejected it because of latency issues in our Solana-adjacent stack."],
    ["user", "So we went with in-memory?"],
    ["assistant", "Correct — in-process LRU cache for now."]
  );
  const capsule = compressContext(messages, { sessionId: "rejection_test" });

  const result = searchCapsule(capsule, "rejected");

  const lower = result.toLowerCase();
  assert.ok(
    lower.includes("redis"),
    `searchCapsule must contain "Redis" (the rejected technology). Got:\n${result}`
  );
  assert.ok(
    lower.includes("latency") || lower.includes("rejected"),
    `searchCapsule must contain "latency" or "rejected". Got:\n${result}`
  );
});

// ── Test 6: capsule output is deterministic ───────────────────────────────────

test("capsule output is deterministic", () => {
  const messages = session(
    ["user", "Compress this session."],
    ["assistant", "Compressing now with ContextCapsule."]
  );

  const capsule1 = compressContext(messages, { sessionId: "det_quality" });
  const capsule2 = compressContext(messages, { sessionId: "det_quality" });

  assert.equal(
    capsule1.merkleRoot,
    capsule2.merkleRoot,
    `merkleRoot must be identical across two builds of the same session.\n` +
    `First:  ${capsule1.merkleRoot}\nSecond: ${capsule2.merkleRoot}`
  );
});

// ── Test 7: capsule handles empty session ─────────────────────────────────────

test("capsule handles empty session", () => {
  // The implementation throws on empty input — that is the documented contract.
  // An empty array contains no tokens, so the capsule cannot be built.
  // We verify the function throws rather than silently producing garbage.
  assert.throws(
    () => compressContext([]),
    (err) => {
      // Must be an Error with a descriptive message
      assert.ok(err instanceof Error, "must throw an Error instance");
      assert.ok(
        err.message.length > 0,
        "thrown error must have a non-empty message"
      );
      return true;
    },
    "compressContext([]) must throw on empty input"
  );
});

// ── Test 8: savings are real on medium session ────────────────────────────────

test("savings are real on medium session", () => {
  const messages = [];
  for (let i = 0; i < 50; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}: processing x402 payment for transaction sig_${i.toString(16).padStart(8, "0")} ` +
               `on Solana mainnet-beta. Receipt anchored. Merkle leaf: ` +
               `${"abcdef01".repeat(8)}. Agent Passport verified. All checks passed.`,
    });
  }

  const capsule = compressContext(messages, { sessionId: "savings_test" });
  const injected = injectCapsule(capsule);

  const jsonl = messages.map((m) => JSON.stringify(m)).join("\n");
  const originalLength = jsonl.length;
  const injectedLength = injected.length;

  const savingsPct = (1 - injectedLength / originalLength) * 100;

  assert.ok(
    savingsPct >= 50,
    `injected string (${injectedLength} chars) must be >= 50% shorter than JSONL (${originalLength} chars). ` +
    `Actual saving: ${savingsPct.toFixed(1)}%`
  );
});

// ── Test 9: searchCapsule never returns full history for specific query ────────

test("searchCapsule never returns full history for specific query", () => {
  const messages = [];
  for (let i = 0; i < 100; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 42
        ? "UNIQUE_TERM_X9Z: the anchor was updated at slot 999888777."
        : `Generic turn ${i}: discussing Solana payments and receipts.`,
    });
  }

  const capsule = compressContext(messages, { sessionId: "precision_test" });
  const result = searchCapsule(capsule, "UNIQUE_TERM_X9Z");

  const fullSession = messages.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");
  const threshold = fullSession.length / 5;

  assert.ok(
    result.length < threshold,
    `searchCapsule result (${result.length} chars) must be < 1/5 of full session (${fullSession.length} chars). ` +
    `Threshold: ${threshold.toFixed(0)} chars`
  );

  // Also confirm it actually found the one relevant message
  assert.ok(
    result.includes("UNIQUE_TERM_X9Z"),
    "result must contain the queried term"
  );
});

// ── Test 10: capsule topic extraction works ───────────────────────────────────

test("capsule topic extraction works", () => {
  const messages = session(
    ["user", "What changed in anchor.ts?"],
    ["assistant", "The BigInt overflow was fixed in anchor.ts. The receipt_anchor instruction now handles large amounts correctly."],
    ["user", "Is receipt_anchor production-ready?"],
    ["assistant", "Yes, receipt_anchor and the BigInt fix are merged and deployed."]
  );

  const capsule = compressContext(messages, { sessionId: "topics_test" });

  // The extractor picks up Title Case phrases, proper nouns (capitalised),
  // and long plain words. "BigInt" is a proper noun capitalised word.
  // "receipt_anchor" contains 13 chars and appears as a plain long word.
  // "anchor.ts" stripped to "anchor" is 6 chars (below the 7-char threshold)
  // but "BigInt" starts with uppercase so it qualifies as a proper noun.
  const topicsLower = capsule.topics.map((t) => t.toLowerCase());

  const candidates = ["anchor.ts", "bigint", "receipt_anchor"];
  const matched = candidates.filter((c) =>
    topicsLower.some((t) => t.includes(c) || c.includes(t))
  );

  assert.ok(
    matched.length >= 1,
    `capsule.topics must include at least one of ${candidates.join(", ")}.\n` +
    `Extracted topics: ${capsule.topics.join(", ")}`
  );
});
