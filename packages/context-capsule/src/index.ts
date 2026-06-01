/**
 * @parad0x_labs/context-capsule
 *
 * LLM token compression layer for nulla-local and OpenClaw agents.
 *
 * Problem: AI agent sessions accumulate thousands of tokens of history.
 * Every new LLM call re-sends that full history = expensive.
 *
 * Solution: ContextCapsule compresses session history before injecting
 * into context. Instead of 8000 tokens of chat history, inject a 96-token
 * capsule summary with deterministic Merkle root for auditability.
 *
 * Usage:
 *   const capsule = compressContext(messages);
 *   const injection = injectCapsule(capsule);  // use this in your LLM call
 *   const relevant  = searchCapsule(capsule, "payments"); // retrieval
 *   const savings   = estimateSavings(messages, capsule);
 */

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Message {
  role: string;
  content: string;
}

/**
 * A compressed, auditable snapshot of an agent session's message history.
 * The merkleRoot is what gets anchored on-chain via receipt_anchor.
 */
export interface ContextCapsule {
  /** Session identifier — set by caller or auto-generated */
  sessionId: string;
  /** Unique per compression — changes if same messages re-compressed */
  capsuleId: string;
  /** Original token estimate: chars / 4 approximation */
  originalTokenEstimate: number;
  /** Size of the compressed payload in bytes */
  compressedBytes: number;
  /** Human-readable compression ratio, e.g. "83x" */
  compressionRatio: string;
  /** Up to 5 extracted key topics from message content */
  topics: string[];
  /** SHA-256 Merkle root over per-message hashes, hex-encoded */
  merkleRoot: string;
  /** Unix timestamp ms when this capsule was created */
  createdAt: number;
  /** zlib-deflated JSONL of the original messages, base64-encoded */
  compressedBase64: string;
}

export interface SavingsEstimate {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  savedPercent: string;
  /** At $15 / 1M input tokens (GPT-4 / Claude Opus tier) */
  estimatedUsdSavingsPerCall: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface CompressOptions {
  sessionId?: string;
  /** Unused in current impl but reserved for future token-budget capping */
  maxOutputTokens?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** SHA-256 of a UTF-8 string → Buffer */
function sha256(data: string): Buffer {
  return createHash("sha256").update(data, "utf8").digest();
}

/**
 * Build a SHA-256 Merkle root over an ordered list of leaf buffers.
 * Empty list → 32-byte zero buffer.
 * Single leaf → that leaf is the root (no wrapping).
 * Internal nodes: sha256(left || right), odd node duplicates itself.
 */
function buildMerkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return Buffer.alloc(32, 0);
  if (leaves.length === 1) return leaves[0];

  let level: Buffer[] = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate odd
      next.push(createHash("sha256").update(left).update(right).digest());
    }
    level = next;
  }
  return level[0];
}

/**
 * Extract up to `maxTopics` noun-phrase-like tokens from text.
 * Strategy: grab capitalised words and multi-word runs (Title Case or UPPER),
 * then fall back to longest unique plain words. Simple but effective for
 * agent conversation topics like "payment receipts", "Agent Passport", etc.
 */
function extractTopics(messages: Message[], maxTopics = 5): string[] {
  const allText = messages.map(m => m.content).join(" ");

  // 1. Capitalised / title-case noun phrases (2–4 words)
  const titlePhrases = allText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) ?? [];

  // 2. Single capitalised words (proper nouns, acronyms)
  const properNouns = allText.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? [];

  // 3. Longest plain words as fallback (length > 6, strip common stop-words)
  const stopWords = new Set([
    "the","and","for","that","this","with","have","from","they","will",
    "been","were","what","when","where","which","while","about","above",
    "after","before","between","through","during","because","should",
  ]);
  const plainWords = allText
    .toLowerCase()
    .match(/\b[a-z]{7,}\b/g)
    ?.filter(w => !stopWords.has(w)) ?? [];

  // Combine, deduplicate, take first maxTopics
  const seen = new Set<string>();
  const topics: string[] = [];

  for (const raw of [...titlePhrases, ...properNouns, ...plainWords]) {
    const key = raw.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      topics.push(raw);
      if (topics.length >= maxTopics) break;
    }
  }

  return topics;
}

/** Deterministic capsule ID: sha256(sessionId + createdAt + merkleRoot) */
function buildCapsuleId(sessionId: string, createdAt: number, merkleRoot: string): string {
  return createHash("sha256")
    .update(`${sessionId}:${createdAt}:${merkleRoot}`)
    .digest("hex")
    .slice(0, 32); // 16 bytes → 32 hex chars
}

/** Estimate token count from character length (chars / 4 approximation) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compress a session's message history into a ContextCapsule.
 *
 * @param messages  Array of {role, content} messages — the full session history
 * @param opts      Optional: sessionId, maxOutputTokens (reserved)
 * @returns         ContextCapsule — contains compressed payload + metadata
 */
export function compressContext(messages: Message[], opts: CompressOptions = {}): ContextCapsule {
  if (!messages || messages.length === 0) {
    throw new Error("compressContext: messages must be a non-empty array");
  }

  const sessionId = opts.sessionId ?? `session_${Date.now()}`;
  const createdAt = Date.now();

  // 1. Stringify to JSONL (one JSON object per line)
  const jsonl = messages.map(m => JSON.stringify(m)).join("\n");

  // 2. Compress with zlib deflate (sync, level 9 for max compression)
  //    This mirrors what Liquefy does in Rust — same deflate algorithm.
  const compressed = deflateSync(Buffer.from(jsonl, "utf8"), { level: 9 });
  const compressedBase64 = compressed.toString("base64");

  // 3. Estimate original tokens
  const originalTokenEstimate = estimateTokens(jsonl);

  // 4. Compute compression ratio
  const originalBytes = Buffer.byteLength(jsonl, "utf8");
  const compressedBytes = compressed.length;
  const ratioNum = originalBytes / compressedBytes;
  const compressionRatio = `${ratioNum.toFixed(1)}x`;

  // 5. Extract key topics
  const topics = extractTopics(messages);

  // 6. Build SHA-256 Merkle root over per-message hashes
  //    Each leaf: sha256(JSON.stringify(message))
  const leaves = messages.map(m => sha256(JSON.stringify(m)));
  const root = buildMerkleRoot(leaves);
  const merkleRoot = root.toString("hex");

  // 7. Build capsule ID (deterministic over sessionId + createdAt + root)
  const capsuleId = buildCapsuleId(sessionId, createdAt, merkleRoot);

  return {
    sessionId,
    capsuleId,
    originalTokenEstimate,
    compressedBytes,
    compressionRatio,
    topics,
    merkleRoot,
    createdAt,
    compressedBase64,
  };
}

/**
 * Generate a compact injection string to replace full history in an LLM call.
 *
 * Instead of re-sending 8000 tokens, the agent injects ~80 tokens describing
 * what happened and offering retrieval on demand.
 *
 * @param capsule    The ContextCapsule from compressContext()
 * @param maxTokens  Optional token budget hint (unused, for future truncation)
 * @returns          Short context injection string (~60–100 tokens)
 */
export function injectCapsule(capsule: ContextCapsule, maxTokens?: number): string {
  const topicList = capsule.topics.length > 0
    ? capsule.topics.join(", ")
    : "general conversation";

  const rootShort = capsule.merkleRoot.slice(0, 12);

  return (
    `[CONTEXT CAPSULE: session ${capsule.sessionId} compressed ${capsule.compressionRatio}. ` +
    `Key topics: ${topicList}. ` +
    `Merkle: ${rootShort}... ` +
    `Full history available on request.]`
  );
}

/**
 * Search the capsule for messages relevant to a query.
 *
 * Decompresses the capsule and returns only messages whose content
 * contains one or more query terms. Never returns the full history
 * unless the query matches every message.
 *
 * @param capsule   The ContextCapsule to search
 * @param query     Space-separated search terms (case-insensitive)
 * @returns         Matching messages formatted as a readable string
 */
export function searchCapsule(capsule: ContextCapsule, query: string): string {
  if (!query || query.trim() === "") {
    return "[CAPSULE SEARCH: empty query — provide search terms to retrieve relevant context]";
  }

  // Decompress
  const compressed = Buffer.from(capsule.compressedBase64, "base64");
  const raw = inflateSync(compressed).toString("utf8");

  // Parse JSONL back to messages
  const messages: Message[] = raw
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Message);

  // Build term set (lowercase)
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

  // Filter: message must contain at least one term
  const matches = messages.filter(m =>
    terms.some(term => m.content.toLowerCase().includes(term))
  );

  if (matches.length === 0) {
    return `[CAPSULE SEARCH: no messages matched "${query}"]`;
  }

  const formatted = matches
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join("\n\n");

  return (
    `[CAPSULE SEARCH RESULTS for "${query}" — ${matches.length}/${messages.length} messages]\n\n` +
    formatted
  );
}

/**
 * Estimate the token and cost savings of using a capsule vs. full history.
 *
 * Pricing model: $15 / 1M input tokens (GPT-4o / Claude Opus tier).
 * compressedTokens counts the injectCapsule() string, not the raw compressed bytes.
 *
 * @param originalMessages  The original messages array
 * @param capsule           The ContextCapsule produced from those messages
 * @returns                 SavingsEstimate with USD cost delta
 */
export function estimateSavings(
  originalMessages: Message[],
  capsule: ContextCapsule,
): SavingsEstimate {
  // Original: full JSONL token count
  const jsonl = originalMessages.map(m => JSON.stringify(m)).join("\n");
  const originalTokens = estimateTokens(jsonl);

  // Compressed: the injection string token count (what actually goes to LLM)
  const injectionString = injectCapsule(capsule);
  const compressedTokens = estimateTokens(injectionString);

  const savedTokens = Math.max(0, originalTokens - compressedTokens);
  const savedPercent = originalTokens > 0
    ? `${((savedTokens / originalTokens) * 100).toFixed(1)}%`
    : "0.0%";

  // $15 per 1M tokens
  const usdPerToken = 15 / 1_000_000;
  const savedUsd = savedTokens * usdPerToken;
  const estimatedUsdSavingsPerCall = `$${savedUsd.toFixed(6)}`;

  return {
    originalTokens,
    compressedTokens,
    savedTokens,
    savedPercent,
    estimatedUsdSavingsPerCall,
  };
}
