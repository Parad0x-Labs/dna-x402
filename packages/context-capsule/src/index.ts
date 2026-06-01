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
 *
 * Correction-Intent API (added 2026-06-02):
 *   const intent = tagMessageIntent(message, priorMessages);
 *   const enriched = taggedCompressContext(messages);
 *   const injection = injectEnrichedCapsule(enriched);
 *   // enriched.activeInstructions has corrections applied — latest wins
 *
 * CorrectionChain API (added 2026-06-02):
 *   const chain  = buildCorrectionChain(messages);
 *   const tx     = await anchorCorrectionChain(chain);
 *   const result = await verifiableCapsule(messages, { sessionId: "..." });
 *   // result.capsule has on-chain proof of its correction history
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

// ── Correction-Intent Tagger ──────────────────────────────────────────────────

/**
 * Intent classification for a single message within a conversation.
 *
 * CORRECTION  — overrides or revises a prior message
 * INSTRUCTION — new directive with no override of prior content
 * ADDITIVE    — extends prior without replacing it
 * QUERY       — question, not actionable
 * ACK         — acknowledgment (ok, got it, yes, thanks, etc.)
 */
export const MessageIntent = {
  INSTRUCTION:    "instruction",
  CORRECTION:     "correction",
  ADDITIVE:       "additive",
  QUERY:          "query",
  ACKNOWLEDGMENT: "ack",
} as const;

export type MessageIntent = typeof MessageIntent[keyof typeof MessageIntent];

/**
 * A correction entry in an EnrichedCapsule.
 * Records what was corrected and the replacement content.
 */
export interface CorrectionEntry {
  /** The correcting message content */
  content: string;
  /** Description of what prior content this overrides */
  overrides: string;
  /** Index in the original messages array */
  index: number;
}

/**
 * A tagged message — original message plus its detected intent.
 */
export interface TaggedMessage extends Message {
  intent: MessageIntent;
  /** Index in the original messages array */
  index: number;
}

/**
 * Extended capsule that includes intent analysis on top of the base ContextCapsule.
 */
export interface EnrichedCapsule extends ContextCapsule {
  /** All messages with their detected intent */
  intents: TaggedMessage[];
  /** Messages classified as CORRECTION, with what they override */
  corrections: CorrectionEntry[];
  /** Instructions with corrections applied — latest value for each slot wins */
  activeInstructions: string[];
}

// Explicit correction markers (ordered: more specific first)
const CORRECTION_PHRASES = [
  "scratch that",
  "forget that",
  "ignore that",
  "never mind",
  "nevermind",
  "i meant",
  "what i meant",
  "correction:",
  "correction —",
  "to clarify:",
  "rather than",
  "instead of",
  "actually",
  "wait,",
  "wait —",
  "i said earlier",
  "the previous",
];

// Explicit markers that mean "starts with contrastive connector"
const CONTRASTIVE_STARTS = [
  "but ",
  "however,",
  "however ",
  "on the contrary",
  "no, ",
  "nope, ",
  "wrong, ",
  "incorrect, ",
];

// Additive markers — presence means "extend, not replace"
const ADDITIVE_MARKERS = [
  "also",
  "additionally",
  "and also",
  "one more thing",
  "another thing",
  "furthermore",
  "in addition",
  "plus,",
  "plus ",
  "as well",
];

// Acknowledgment terms for short messages
const ACK_TERMS = [
  "ok", "okay", "got it", "gotcha", "sure", "yes", "yep", "yeah",
  "no", "nope", "thanks", "thank you", "perfect", "great",
  "understood", "alright", "sounds good", "cool", "noted",
];

// Question-word starters
const QUESTION_STARTERS = [
  "what ", "what's", "what'", "how ", "why ", "when ",
  "where ", "who ", "which ", "is ", "are ", "can ", "could ",
  "will ", "would ", "does ", "do ", "did ", "has ", "have ",
  "should ", "shall ",
];

/**
 * Extract content words from a message (lowercase, length >= 4, no stop-words).
 * Used for "negation of prior" detection.
 */
function contentWords(text: string): Set<string> {
  const stopWords = new Set([
    "that", "this", "with", "have", "from", "they", "will",
    "been", "were", "what", "when", "where", "which", "while",
    "about", "after", "before", "through", "because", "should",
    "then", "than", "their", "there", "these", "those", "just",
    "like", "also", "some", "more", "into", "your", "over",
    "each", "both", "only", "same", "very", "such", "even",
    "most", "much", "back", "been", "come", "does", "here",
    "make", "many", "need", "show", "them", "time", "want",
  ]);
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
  return new Set(words.filter(w => !stopWords.has(w)));
}

/**
 * Classify a single message's intent given the conversation so far.
 *
 * Detection runs in this priority order:
 *   1. ACK         — very short + acknowledgment word
 *   2. QUERY       — ends with "?" or starts with a question word
 *   3. CORRECTION  — explicit marker, contrastive start, negation of prior, temporal override
 *   4. ADDITIVE    — additive marker present, no negation of prior
 *   5. INSTRUCTION — default
 *
 * Pure heuristics — zero ML, deterministic, fast.
 *
 * @param message       The message being classified
 * @param priorMessages Messages that came before this one
 * @returns             MessageIntent value
 */
export function tagMessageIntent(
  message: Message,
  priorMessages: Message[],
): MessageIntent {
  const raw   = message.content ?? "";
  const lower = raw.toLowerCase().trim();

  // ── 1. ACKNOWLEDGMENT ──────────────────────────────────────────────────────
  if (lower.length < 40) {
    const stripped = lower.replace(/[!.,?]+$/, "").trim();
    if (ACK_TERMS.some(t => stripped === t || stripped.startsWith(t + " ") || stripped.endsWith(" " + t))) {
      return MessageIntent.ACKNOWLEDGMENT;
    }
  }

  // ── 2. QUERY ───────────────────────────────────────────────────────────────
  if (lower.endsWith("?")) return MessageIntent.QUERY;
  if (QUESTION_STARTERS.some(s => lower.startsWith(s))) return MessageIntent.QUERY;

  // ── 3. CORRECTION ──────────────────────────────────────────────────────────

  // 3a. Explicit correction phrases
  if (CORRECTION_PHRASES.some(p => lower.includes(p))) {
    return MessageIntent.CORRECTION;
  }

  // 3b. Contrastive turn-start
  if (CONTRASTIVE_STARTS.some(s => lower.startsWith(s))) {
    return MessageIntent.CORRECTION;
  }

  // 3c. "not X but Y" or "don't X, Y" patterns
  if (/\bnot\b.{1,40}\bbut\b/i.test(raw) || /\bdon't\b.{1,40},/.test(raw)) {
    return MessageIntent.CORRECTION;
  }

  // 3d. Temporal override: "now do / from now on / going forward" + directive
  if (/\b(from now on|going forward|now do|from this point)\b/i.test(raw)) {
    return MessageIntent.CORRECTION;
  }

  // 3e. "instead" standalone (not "instead of" which is already caught above)
  if (/\binstead\b/i.test(raw)) {
    return MessageIntent.CORRECTION;
  }

  // 3f. Negation of prior content:
  //     "not" or "don't" immediately before a word that appeared in a recent prior message
  if (priorMessages.length > 0) {
    const recentPrior = priorMessages.slice(-3); // look back up to 3 messages
    const priorWords  = new Set<string>();
    for (const m of recentPrior) {
      for (const w of contentWords(m.content)) priorWords.add(w);
    }

    const negationPattern = /\b(?:not|don't|dont|no longer|never)\s+(\w{4,})/gi;
    let match: RegExpExecArray | null;
    while ((match = negationPattern.exec(raw)) !== null) {
      if (priorWords.has(match[1].toLowerCase())) {
        return MessageIntent.CORRECTION;
      }
    }

    // 3g. Same-slot override: same content word appearing after "use", "switch to",
    //     "change to", "make it", "set it to", "replace" + no additive connector
    const overridePattern = /\b(?:use|switch to|change to|make it|set it to|replace with?|update to)\s+(\w[\w\s]{0,30})/gi;
    const hasAdditive = ADDITIVE_MARKERS.some(m => lower.includes(m));

    if (!hasAdditive) {
      while ((match = overridePattern.exec(raw)) !== null) {
        // Only treat as correction if we have prior instructions (not the very first message)
        if (priorMessages.some(pm => pm.role === "user" || pm.role === "assistant")) {
          return MessageIntent.CORRECTION;
        }
      }
    }
  }

  // ── 4. ADDITIVE ────────────────────────────────────────────────────────────
  if (ADDITIVE_MARKERS.some(m => lower.includes(m))) {
    return MessageIntent.ADDITIVE;
  }

  // ── 5. INSTRUCTION (default) ───────────────────────────────────────────────
  return MessageIntent.INSTRUCTION;
}

/**
 * Summarise what a correction message is overriding by inspecting prior messages.
 *
 * Finds the most recent prior instruction that shares content words with the
 * correction, or returns a generic description.
 */
function inferOverrides(correction: Message, priorMessages: Message[]): string {
  const corrWords = contentWords(correction.content);
  if (corrWords.size === 0) return "prior instruction";

  // Walk backwards through prior user/assistant messages
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const m = priorMessages[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    const mWords = contentWords(m.content);

    // Count overlap
    let overlap = 0;
    for (const w of corrWords) {
      if (mWords.has(w)) overlap++;
    }

    if (overlap >= 1) {
      // Truncate the prior message for display
      const preview = m.content.length > 80
        ? m.content.slice(0, 77) + "..."
        : m.content;
      return `message[${i}]: "${preview}"`;
    }
  }

  return "prior instruction";
}

/**
 * Compress a session's message history into an EnrichedCapsule that includes
 * intent classification and correction-resolved active instructions.
 *
 * The key property: activeInstructions has corrections applied.
 * If message[5] says "use Redis" and message[12] says "actually use Postgres",
 * activeInstructions will contain Postgres, not Redis.
 *
 * @param messages  Full message history
 * @param opts      Same options as compressContext()
 * @returns         EnrichedCapsule
 */
export function taggedCompressContext(
  messages: Message[],
  opts: CompressOptions = {},
): EnrichedCapsule {
  if (!messages || messages.length === 0) {
    throw new Error("taggedCompressContext: messages must be a non-empty array");
  }

  // Build base capsule
  const base = compressContext(messages, opts);

  // Tag every message with its intent
  const intents: TaggedMessage[] = messages.map((m, idx) => ({
    ...m,
    index: idx,
    intent: tagMessageIntent(m, messages.slice(0, idx)),
  }));

  // Collect corrections
  const corrections: CorrectionEntry[] = intents
    .filter(t => t.intent === MessageIntent.CORRECTION)
    .map(t => ({
      content: t.content,
      overrides: inferOverrides(t, messages.slice(0, t.index)),
      index: t.index,
    }));

  // Build activeInstructions:
  // Start with all INSTRUCTION messages from users.
  // Then apply corrections: each correction can supersede a prior instruction
  // if the two share content words.

  // Gather instructions (user messages classified as INSTRUCTION)
  const instructionSlots: Map<string, string> = new Map();
  // key = normalised "slot" (a canonical word that represents the topic)
  // value = latest content for that slot

  for (const tagged of intents) {
    if (tagged.role !== "user") continue;

    if (tagged.intent === MessageIntent.INSTRUCTION || tagged.intent === MessageIntent.ADDITIVE) {
      // Add or extend the instruction
      const key = `inst_${tagged.index}`;
      instructionSlots.set(key, tagged.content);

    } else if (tagged.intent === MessageIntent.CORRECTION) {
      // Find the instruction slot with the most word overlap and supersede it
      const corrWords = contentWords(tagged.content);
      let bestKey: string | null = null;
      let bestOverlap = 0;

      for (const [k, v] of instructionSlots) {
        const slotWords = contentWords(v);
        let overlap = 0;
        for (const w of corrWords) {
          if (slotWords.has(w)) overlap++;
        }
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestKey = k;
        }
      }

      if (bestKey !== null && bestOverlap >= 1) {
        // Replace the superseded slot with the correction
        instructionSlots.delete(bestKey);
        instructionSlots.set(`corr_${tagged.index}`, tagged.content);
      } else {
        // No clear match — treat as a new slot
        instructionSlots.set(`corr_${tagged.index}`, tagged.content);
      }
    }
  }

  const activeInstructions = Array.from(instructionSlots.values());

  return {
    ...base,
    intents,
    corrections,
    activeInstructions,
  };
}

/**
 * Generate an enriched injection string that includes intent context.
 *
 * Format:
 * [CONTEXT CAPSULE: Xms compression. Active instructions: N.
 *  Corrections applied: M. Key topics: ...]
 *
 * @param capsule  EnrichedCapsule from taggedCompressContext()
 * @returns        Short injection string (~80–120 tokens)
 */
export function injectEnrichedCapsule(capsule: EnrichedCapsule): string {
  const topicList = capsule.topics.length > 0
    ? capsule.topics.join(", ")
    : "general conversation";

  const rootShort = capsule.merkleRoot.slice(0, 12);
  const corrCount = capsule.corrections.length;
  const instrCount = capsule.activeInstructions.length;

  const corrNote = corrCount > 0
    ? ` Corrections applied: ${corrCount} (latest intent wins).`
    : "";

  return (
    `[CONTEXT CAPSULE: session ${capsule.sessionId} compressed ${capsule.compressionRatio}.` +
    ` Active instructions: ${instrCount}.${corrNote}` +
    ` Key topics: ${topicList}.` +
    ` Merkle: ${rootShort}...` +
    ` Full history available on request.]`
  );
}

// ── CorrectionChainReceipt ────────────────────────────────────────────────────

/**
 * A single correction event in the session, cryptographically identified.
 *
 * THE ANGLE: not just "we compressed it" but "we compressed it AND proved
 * which corrections were applied AND anchored that on Solana."
 */
export interface CorrectionChainReceipt {
  /** Session identifier this correction belongs to */
  sessionId: string;
  /** 1-based ordinal — which correction this is in the session */
  correctionIndex: number;
  /** 0-based position of the correcting message in the session */
  messageIndex: number;
  /** sha256 of the message being overridden (hex), or 64 zeros if none found */
  overrides: string;
  /** First 60 chars of the overridden message content */
  before: string;
  /** First 60 chars of the correcting message content */
  after: string;
  /** Detected topic of the correction (storage, auth, ui, payments, api, …) */
  topic: string;
  /** sha256(before + after + topic + sessionId) hex — deterministic receipt ID */
  correctionHash: string;
  /** Solana tx signature, populated after anchorCorrectionChain() */
  solanaTx?: string;
}

// ── Topic detection (minimal keyword map) ────────────────────────────────────

const CHAIN_TOPIC_MAP: Array<[string, string[]]> = [
  ["auth",     ["auth", "login", "signin", "jwt", "token", "credential", "keypair", "wallet", "signature", "metamask", "session"]],
  ["storage",  ["database", "storage", "redis", "postgres", "mongo", "sqlite", "persist", "save", "load", "read", "write", "file"]],
  ["payments", ["payment", "x402", "solana", "usdc", "lamport", "anchor", "on-chain", "blockchain", "transaction", "null token"]],
  ["ui",       ["ui", "component", "button", "style", "css", "tailwind", "render", "display", "layout", "page", "view", "frontend"]],
  ["api",      ["api", "endpoint", "route", "request", "response", "http", "rest", "fetch", "server", "backend"]],
  ["testing",  ["test", "spec", "unit", "integration", "mock", "coverage", "jest", "vitest", "playwright"]],
  ["infra",    ["deploy", "docker", "kubernetes", "ci", "cd", "pipeline", "env", "config", "infrastructure", "cloud"]],
];

function detectChainTopic(content: string): string {
  const lower = content.toLowerCase();
  for (const [label, keywords] of CHAIN_TOPIC_MAP) {
    if (keywords.some(kw => lower.includes(kw))) return label;
  }
  return "general";
}

// ── buildCorrectionChain ──────────────────────────────────────────────────────

/**
 * Build an ordered CorrectionChainReceipt[] from a session's messages.
 *
 * Algorithm:
 *   1. Tag every message with tagMessageIntent() to find CORRECTION entries.
 *   2. For each CORRECTION, walk backward to find the best candidate being
 *      overridden: prefer a prior user message sharing topic overlap, fall back
 *      to the nearest preceding non-assistant message.
 *   3. Extract before/after key phrases (first 60 chars).
 *   4. Compute correctionHash = sha256(before + after + topic + sessionId).
 *
 * @param messages  Full session message array ({role, content})
 * @returns         Ordered CorrectionChainReceipt[]
 */
export function buildCorrectionChain(
  messages: Array<{ role: string; content: string }>,
): CorrectionChainReceipt[] {
  if (!messages || messages.length === 0) return [];

  // Derive a stable sessionId from message content fingerprint
  const fingerprint = messages.map(m => m.content).join("|");
  const sessionId = `session_${createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16)}`;

  // Tag intents using existing tagMessageIntent (single-message API)
  const tagged: Array<{ role: string; content: string; intent: MessageIntent; index: number }> =
    messages.map((m, i) => ({
      ...m,
      index: i,
      intent: tagMessageIntent(m, messages.slice(0, i)),
    }));

  // Hash each message for the overrides pointer
  const messageHashes = messages.map(m =>
    createHash("sha256").update(JSON.stringify(m), "utf8").digest("hex"),
  );

  const chain: CorrectionChainReceipt[] = [];
  let correctionIndex = 0;

  for (const entry of tagged) {
    if (entry.intent !== MessageIntent.CORRECTION) continue;

    correctionIndex++;
    const topic = detectChainTopic(entry.content);

    // Walk backward: prefer same-topic non-assistant INSTRUCTION/ADDITIVE/CORRECTION
    let overriddenIdx = -1;
    for (let j = entry.index - 1; j >= 0; j--) {
      const candidate = tagged[j];
      if (candidate.role === "assistant") continue;
      if (
        detectChainTopic(candidate.content) === topic &&
        (candidate.intent === MessageIntent.INSTRUCTION ||
          candidate.intent === MessageIntent.ADDITIVE ||
          candidate.intent === MessageIntent.CORRECTION)
      ) {
        overriddenIdx = j;
        break;
      }
    }

    // Fallback: nearest non-assistant message
    if (overriddenIdx === -1) {
      for (let j = entry.index - 1; j >= 0; j--) {
        if (tagged[j].role !== "assistant") {
          overriddenIdx = j;
          break;
        }
      }
    }

    const overridesHash = overriddenIdx >= 0 ? messageHashes[overriddenIdx] : "0".repeat(64);
    const before = overriddenIdx >= 0 ? messages[overriddenIdx].content.slice(0, 60) : "(no prior instruction found)";
    const after = entry.content.slice(0, 60);

    const correctionHash = createHash("sha256")
      .update(before + after + topic + sessionId, "utf8")
      .digest("hex");

    chain.push({
      sessionId,
      correctionIndex,
      messageIndex: entry.index,
      overrides: overridesHash,
      before,
      after,
      topic,
      correctionHash,
    });
  }

  return chain;
}

// ── anchorCorrectionChain ─────────────────────────────────────────────────────

const RECEIPT_ANCHOR_PROGRAM = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";
const DEFAULT_ANCHOR_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Internal: build a SHA-256 Merkle root over an array of hex-encoded hashes.
 * Uses the same buildMerkleRoot() already defined for ContextCapsule.
 */
function correctionMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return "0".repeat(64);
  const leaves = hashes.map(h => Buffer.from(h, "hex"));
  return buildMerkleRoot(leaves).toString("hex");
}

/**
 * Anchor a CorrectionChainReceipt[] on Solana via the receipt_anchor program.
 *
 * Steps:
 *  1. Compute a Merkle root over all correctionHashes in the chain.
 *  2. Post it as a Memo instruction (no custom IDL — Memo is universal).
 *  3. Sign + send with the keypair from SOLANA_KEYPAIR env var (JSON number[]).
 *  4. Return the transaction signature.
 *
 * Falls back to "dry_run:<merkleRoot>" if SOLANA_KEYPAIR is not set or
 * if @solana/web3.js is not installed.
 *
 * @param chain    Output of buildCorrectionChain()
 * @param rpcUrl   Solana RPC endpoint (defaults to mainnet-beta)
 * @returns        Solana tx signature, or "dry_run:<merkleRoot>"
 */
export async function anchorCorrectionChain(
  chain: CorrectionChainReceipt[],
  rpcUrl = DEFAULT_ANCHOR_RPC,
): Promise<string> {
  const merkleRoot = correctionMerkleRoot(chain.map(r => r.correctionHash));

  const keypairEnv = process.env["SOLANA_KEYPAIR"];
  if (!keypairEnv) {
    const result = `dry_run:${merkleRoot}`;
    console.log(`dry run: would anchor ${merkleRoot} via ${RECEIPT_ANCHOR_PROGRAM}`);
    return result;
  }

  // Lazily import @solana/web3.js (optional peer dep).
  let web3: typeof import("@solana/web3.js");
  try {
    web3 = await import("@solana/web3.js");
  } catch {
    const result = `dry_run:${merkleRoot}`;
    console.warn(
      `anchorCorrectionChain: @solana/web3.js not installed — dry run: ${result}`,
    );
    return result;
  }

  const {
    Connection,
    Keypair,
    Transaction,
    TransactionInstruction,
    PublicKey,
    sendAndConfirmTransaction,
  } = web3;

  const secretKey = Uint8Array.from(JSON.parse(keypairEnv) as number[]);
  const payer = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(rpcUrl, "confirmed");

  // Memo program is available on all Solana clusters
  const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

  const memoData = Buffer.from(
    `correction_chain:${merkleRoot}:${RECEIPT_ANCHOR_PROGRAM}`,
    "utf8",
  );

  const ix = new TransactionInstruction({
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: memoData,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  return sig;
}

// ── verifiableCapsule ─────────────────────────────────────────────────────────

/** Options for verifiableCapsule — extends CompressOptions with anchor control. */
export interface VerifiableCapsuleOptions extends CompressOptions {
  /**
   * If true, call anchorCorrectionChain() when corrections exist.
   * Defaults to true when SOLANA_KEYPAIR is set and chain is non-empty.
   */
  anchor?: boolean;
  /** Solana RPC URL override (passed to anchorCorrectionChain). */
  rpcUrl?: string;
}

/**
 * One-shot API: compress + tag + correction chain + optional on-chain anchor.
 *
 * The returned capsule has on-chain proof of its correction history:
 *   - `capsule`   — EnrichedCapsule (compressed + intent-tagged, corrections applied)
 *   - `chain`     — CorrectionChainReceipt[] (each correction hashed + linked)
 *   - `anchorTx`  — Solana tx sig (or "dry_run:...") when anchor fires
 *
 * @example
 *   const { capsule, chain, anchorTx } = await verifiableCapsule(messages);
 *   console.log(`${chain.length} corrections anchored → ${anchorTx}`);
 */
export async function verifiableCapsule(
  messages: Array<{ role: string; content: string }>,
  opts: VerifiableCapsuleOptions = {},
): Promise<{
  capsule: EnrichedCapsule;
  chain: CorrectionChainReceipt[];
  anchorTx?: string;
}> {
  const capsule = taggedCompressContext(messages, opts);
  const chain = buildCorrectionChain(messages);

  const shouldAnchor =
    opts.anchor ?? (chain.length > 0 && !!process.env["SOLANA_KEYPAIR"]);

  if (chain.length === 0 || !shouldAnchor) {
    return { capsule, chain };
  }

  const anchorTx = await anchorCorrectionChain(chain, opts.rpcUrl);
  return { capsule, chain, anchorTx };
}
