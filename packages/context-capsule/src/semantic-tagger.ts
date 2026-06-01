/**
 * semantic-tagger.ts — Local LLM-powered correction detection
 *
 * Problem: rule-based keyword matching misses implicit corrections.
 * "make it blue" after "make it red" — no correction keywords, yet clearly
 * a correction/override of the previous instruction.
 *
 * Solution: when the rule engine is uncertain, ask a local Qwen 14B model
 * running in Ollama or LM Studio. Token cost = $0.00.
 *
 * Architecture:
 *   1. hybridTagMessage() — entry point for callers
 *   2. ruleBasedTag()     — fast keyword scan (no I/O)
 *   3. semanticTagMessage() — calls local LLM for ambiguous cases
 *
 * The prompt is kept under 200 tokens so even a slow local model answers
 * in < 2 s. If Ollama is unreachable the function degrades gracefully and
 * returns the rule-based result.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageIntent = "CORRECTION" | "INSTRUCTION";
export type TagMethod = "rules" | "llm" | "hybrid";

export interface Message {
  role: string;
  content: string;
}

export interface SemanticTaggerConfig {
  /** Ollama / LM Studio base URL. Default: http://127.0.0.1:11434 */
  ollamaUrl: string;
  /** Local model to use. Default: qwen2.5:14b */
  model: string;
  /** Minimum LLM confidence to trust its answer. Default: 0.7 */
  confidenceThreshold: number;
  /** Max ms to wait for local LLM before falling back. Default: 2000 */
  timeoutMs: number;
}

export interface TagResult {
  intent: MessageIntent;
  confidence: number;
  /** Which path produced this result */
  method: TagMethod;
  /** Human-readable explanation (LLM path only; empty string for pure rules) */
  reasoning: string;
  /** true when semanticTagMessage() was invoked, false for pure rule path */
  usedLLM: boolean;
}

/** Raw return type for semanticTagMessage() */
export interface SemanticTagResult {
  intent: MessageIntent;
  confidence: number;
  usedLLM: boolean;
  reasoning: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SemanticTaggerConfig = {
  ollamaUrl: "http://127.0.0.1:11434",
  model: "qwen2.5:14b",
  confidenceThreshold: 0.7,
  timeoutMs: 2000,
};

// ── Rule-based engine ─────────────────────────────────────────────────────────

/**
 * Strong correction signals — explicit override language.
 * When these match the confidence is high enough to skip the LLM.
 */
const STRONG_CORRECTION_PATTERNS: RegExp[] = [
  /\b(actually|no[,]?\s+wait|scratch\s+that|forget\s+(that|it|what\s+i\s+said))\b/i,
  /\b(cancel\s+that|ignore\s+(the\s+)?last|undo\s+that)\b/i,
  /\b(instead\s+of|rather\s+than|not\s+.{1,30}\bbut\b)\b/i,
  /\b(change\s+(it|that|this)\s+to|replace\s+(it|that|this)\s+with|switch\s+(it|that|this)\s+to)\b/i,
  /\b(i\s+meant|i\s+mean|correction:?|update:?)\b/i,
  /\bnot\s+(that|the\s+(previous|last|prior|earlier))\b/i,
];

/**
 * Weak correction signals — suggestive but not conclusive.
 * If present but no strong signal, we're "ambiguous" → eligible for LLM.
 */
const WEAK_CORRECTION_PATTERNS: RegExp[] = [
  /\b(actually|wait|hmm|oops|sorry)\b/i,
  /\b(make\s+it|use\s+.{1,20}\binstead\b)\b/i,
  /\b(different|another|other\s+(one|option|approach))\b/i,
];

/**
 * Strong new-instruction signals — clearly a fresh task, not a correction.
 */
const STRONG_INSTRUCTION_PATTERNS: RegExp[] = [
  /^(please\s+)?(create|build|generate|write|add|implement|show|list|fetch|get|run|execute|deploy|check|verify|explain|summarize|analyze)\b/i,
  /\b(new\s+(task|request|step|feature|endpoint|function))\b/i,
  /^(also|additionally|furthermore|next|then)\b/i,
];

interface RuleResult {
  intent: MessageIntent;
  confidence: number;
  isAmbiguous: boolean;
}

/**
 * Classify a single message using only keyword/pattern rules.
 * Returns isAmbiguous=true when the rules aren't confident — caller should
 * then escalate to semanticTagMessage().
 */
function ruleBasedTag(candidate: Message, context: Message[]): RuleResult {
  const text = candidate.content.trim();

  // 1. Strong correction match → high confidence CORRECTION
  for (const pattern of STRONG_CORRECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: "CORRECTION", confidence: 0.92, isAmbiguous: false };
    }
  }

  // 2. Strong instruction match → high confidence INSTRUCTION
  for (const pattern of STRONG_INSTRUCTION_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: "INSTRUCTION", confidence: 0.88, isAmbiguous: false };
    }
  }

  // 3. Weak correction signal → low-confidence CORRECTION, ambiguous
  for (const pattern of WEAK_CORRECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: "CORRECTION", confidence: 0.45, isAmbiguous: true };
    }
  }

  // 4. Context heuristic: if the prior user message has a similar verb/object
  //    and this message changes a parameter, it's likely a correction.
  //    We check for short imperative messages (< 8 words) following another
  //    short imperative user message about the same topic.
  const lastUserMsg = [...context]
    .reverse()
    .find(m => m.role === "user");

  if (lastUserMsg && isLikelyImplicitOverride(text, lastUserMsg.content)) {
    return { intent: "CORRECTION", confidence: 0.55, isAmbiguous: true };
  }

  // 5. Default: new instruction, but marked ambiguous for borderline cases
  //    (short messages without obvious verbs could go either way)
  const wordCount = text.split(/\s+/).length;
  const isShort = wordCount <= 6;

  return {
    intent: "INSTRUCTION",
    confidence: isShort ? 0.60 : 0.80,
    isAmbiguous: isShort,
  };
}

/**
 * Lightweight structural check for implicit overrides.
 * "make it blue" after "make it red" — same verb frame, different argument.
 */
function isLikelyImplicitOverride(current: string, prior: string): boolean {
  const cur = current.toLowerCase().trim();
  const prr = prior.toLowerCase().trim();

  // Both must be short (likely imperatives)
  if (cur.split(/\s+/).length > 8 || prr.split(/\s+/).length > 8) return false;

  // Extract leading verb
  const verbMatch = cur.match(/^(\w+)/);
  const priorVerbMatch = prr.match(/^(\w+)/);
  if (!verbMatch || !priorVerbMatch) return false;

  // Same leading verb → likely same operation, different argument
  if (verbMatch[1] === priorVerbMatch[1]) return true;

  // Common "make/set/use/change" verb family
  const paramVerbs = new Set(["make", "set", "use", "change", "switch", "pick", "choose", "select", "go"]);
  if (paramVerbs.has(verbMatch[1]) && paramVerbs.has(priorVerbMatch[1])) return true;

  return false;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the compact Ollama prompt (target: < 200 tokens).
 * We take the last 3 context messages + the candidate, formatted tersely.
 */
function buildPrompt(candidate: Message, context: Message[]): string {
  const last3 = context.slice(-3);

  const historyLines = last3
    .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 120)}`)
    .join("\n");

  const candidateLine = `${candidate.role.toUpperCase()}: ${candidate.content.slice(0, 120)}`;

  return (
    `Given this conversation history (last ${last3.length} messages):\n` +
    `${historyLines}\n\n` +
    `New message:\n${candidateLine}\n\n` +
    `Does the new message CORRECT/OVERRIDE a prior statement, or is it a NEW instruction?\n` +
    `Answer: CORRECTION or INSTRUCTION. Confidence 0-100. One word + number only.\n` +
    `Example: CORRECTION 85\n` +
    `Your answer:`
  );
}

/**
 * Parse the LLM's terse response: "CORRECTION 85" or "INSTRUCTION 72".
 * Returns null if the response cannot be parsed.
 */
function parseOllamaResponse(raw: string): { intent: MessageIntent; confidence: number } | null {
  const cleaned = raw.trim().toUpperCase();

  // Try "CORRECTION 85" or "INSTRUCTION 72"
  const match = cleaned.match(/^(CORRECTION|INSTRUCTION)\s+(\d{1,3})\b/);
  if (match) {
    const intent = match[1] as MessageIntent;
    const confidence = Math.min(100, parseInt(match[2], 10)) / 100;
    return { intent, confidence };
  }

  // Fallback: just look for either keyword
  if (cleaned.includes("CORRECTION")) return { intent: "CORRECTION", confidence: 0.7 };
  if (cleaned.includes("INSTRUCTION")) return { intent: "INSTRUCTION", confidence: 0.7 };

  return null;
}

// ── Ollama client ─────────────────────────────────────────────────────────────

/**
 * Call the Ollama /api/generate endpoint with an AbortSignal timeout.
 * Returns null if the request fails or times out.
 */
async function callOllama(
  prompt: string,
  config: SemanticTaggerConfig,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.0,   // deterministic
          num_predict: 16,    // we only need "CORRECTION 85"
          stop: ["\n"],
        },
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { response?: string };
    return data.response ?? null;
  } catch {
    // Network error, timeout, or Ollama not running
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a message using a local LLM (Ollama / LM Studio).
 *
 * This is the pure LLM path — it sends the compact prompt to the local model
 * and returns its verdict. Falls back gracefully if Ollama is not reachable.
 *
 * For most callers, prefer hybridTagMessage() which runs rules first and only
 * calls this for genuinely ambiguous cases.
 *
 * @param candidate  The message to classify
 * @param context    Prior messages in the conversation (last 3 used for prompt)
 * @param config     Optional overrides for URL, model, threshold, timeout
 */
export async function semanticTagMessage(
  candidate: Message,
  context: Message[],
  config?: Partial<SemanticTaggerConfig>,
): Promise<SemanticTagResult> {
  const cfg: SemanticTaggerConfig = { ...DEFAULT_CONFIG, ...config };

  const prompt = buildPrompt(candidate, context);
  const raw = await callOllama(prompt, cfg);

  if (raw === null) {
    // Ollama unavailable — fall back to rule engine
    const ruleResult = ruleBasedTag(candidate, context);
    return {
      intent: ruleResult.intent,
      confidence: ruleResult.confidence,
      usedLLM: false,
      reasoning: "Ollama unavailable; fell back to rule-based classification.",
    };
  }

  const parsed = parseOllamaResponse(raw);

  if (parsed === null || parsed.confidence < cfg.confidenceThreshold) {
    // LLM response unparseable or below threshold — trust rules instead
    const ruleResult = ruleBasedTag(candidate, context);
    return {
      intent: ruleResult.intent,
      confidence: ruleResult.confidence,
      usedLLM: true,
      reasoning: `LLM response "${raw.trim()}" was below confidence threshold or unparseable; using rule fallback.`,
    };
  }

  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    usedLLM: true,
    reasoning: `Local LLM (${cfg.model}) classified as ${parsed.intent} with ${(parsed.confidence * 100).toFixed(0)}% confidence.`,
  };
}

/**
 * Hybrid classifier — the recommended entry point.
 *
 * Strategy:
 *   1. Run rule-based classifier (zero latency, no I/O).
 *   2. If rules are confident (high confidence, not ambiguous) → return immediately.
 *   3. If rules are uncertain, escalate to local LLM.
 *   4. If LLM returns a higher-confidence result, use it; otherwise keep rules.
 *
 * This means the LLM is only invoked for cases like "make it blue" after
 * "make it red" — where there are no correction keywords at all.
 *
 * @param candidate  The message to classify
 * @param context    Prior conversation messages
 * @param config     Optional SemanticTaggerConfig overrides
 * @returns          TagResult with intent, confidence, method, reasoning, usedLLM
 */
export async function hybridTagMessage(
  candidate: Message,
  context: Message[],
  config?: Partial<SemanticTaggerConfig>,
): Promise<TagResult> {
  const cfg: SemanticTaggerConfig = { ...DEFAULT_CONFIG, ...config };

  // Step 1: rule engine
  const rules = ruleBasedTag(candidate, context);

  // Step 2: if rules are confident and unambiguous, return immediately
  if (!rules.isAmbiguous && rules.confidence >= cfg.confidenceThreshold) {
    return {
      intent: rules.intent,
      confidence: rules.confidence,
      method: "rules",
      reasoning: "",
      usedLLM: false,
    };
  }

  // Step 3: ambiguous — try semantic LLM
  const semantic = await semanticTagMessage(candidate, context, cfg);

  // Step 4: pick the higher-confidence result
  if (semantic.usedLLM && semantic.confidence >= cfg.confidenceThreshold && semantic.confidence > rules.confidence) {
    return {
      intent: semantic.intent,
      confidence: semantic.confidence,
      method: "hybrid",
      reasoning: semantic.reasoning,
      usedLLM: true,
    };
  }

  // LLM didn't improve on rules (or wasn't available)
  return {
    intent: rules.intent,
    confidence: rules.confidence,
    method: semantic.usedLLM ? "hybrid" : "rules",
    reasoning: semantic.reasoning,
    usedLLM: semantic.usedLLM,
  };
}

// ── Re-export config default for convenience ──────────────────────────────────

export { DEFAULT_CONFIG as defaultSemanticTaggerConfig };
