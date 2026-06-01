/**
 * active-state.ts
 *
 * Active State Graph for intent-ordered compression.
 *
 * Insight: a conversation is not a flat array. It is a graph where:
 *   - Instructions create nodes
 *   - Corrections create edges that mark prior nodes as SUPERSEDED
 *   - The "active state" is the set of non-superseded nodes
 *
 * This is the theoretically correct model for "what does the agent currently
 * believe it should do?" — it answers that question without re-reading history.
 *
 * Usage:
 *   const graph = buildActiveStateGraph(messages);
 *   const injection = injectActiveState(graph);
 *   // inject into LLM call instead of (or alongside) injectCapsule()
 */

// ── Intent classification ─────────────────────────────────────────────────────

export type MessageIntent =
  | "INSTRUCTION"   // tells the agent to do something
  | "CORRECTION"    // revises a prior instruction
  | "QUESTION"      // asks for information
  | "ANSWER"        // provides information
  | "ACKNOWLEDGMENT" // confirms / ok / thanks
  | "OTHER";

// Patterns ordered from most specific to least specific.
// First match wins.
const INTENT_PATTERNS: Array<{ intent: MessageIntent; patterns: RegExp[] }> = [
  {
    intent: "CORRECTION",
    patterns: [
      /\b(actually|wait|no[,.]?\s+use|instead[,.]?\s+use|change\s+(?:that\s+)?to|switch\s+to|replace\s+with|use\s+\w+\s+instead|not\s+\w+[,;]\s+use|scratch\s+that|forget\s+(?:that|what\s+i\s+said))\b/i,
      /\b(correction:|update:|revised?:|changing\s+(?:my\s+mind|requirement|that))\b/i,
    ],
  },
  {
    intent: "INSTRUCTION",
    patterns: [
      /\b(use|make|create|add|remove|delete|update|change|refactor|implement|build|write|generate|set|configure|enable|disable|ensure|always|never|should|must|don'?t|do\s+not)\b/i,
      /\b(from\s+now\s+on|going\s+forward|henceforth|please\s+(?:use|make|add|remove))\b/i,
    ],
  },
  {
    intent: "QUESTION",
    patterns: [
      /\?/,
      /\b(what|how|why|when|where|which|who|can\s+you|could\s+you|would\s+you|is\s+it|are\s+there)\b/i,
    ],
  },
  {
    intent: "ACKNOWLEDGMENT",
    patterns: [
      /^\s*(ok|okay|got\s+it|thanks?|thank\s+you|sounds?\s+good|perfect|great|sure|alright|cool|makes?\s+sense|understood|noted)\s*[.!]?\s*$/i,
    ],
  },
  {
    intent: "ANSWER",
    patterns: [
      /^(yes|no|correct|right|exactly|indeed|affirmative|negative)\b/i,
    ],
  },
];

function classifyIntent(content: string): MessageIntent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some(p => p.test(content))) {
      return intent;
    }
  }
  return "OTHER";
}

// ── Topic detection ───────────────────────────────────────────────────────────

export type Topic =
  | "storage"
  | "auth"
  | "api"
  | "testing"
  | "ui"
  | "infra"
  | "general";

const TOPIC_KEYWORDS: Array<{ topic: Topic; keywords: RegExp }> = [
  {
    topic: "storage",
    keywords: /\b(redis|postgres|postgresql|database|db|cache|storage|sqlite|mongo|mongodb|dynamo|s3|rds|cassandra|mysql|supabase|prisma|drizzle)\b/i,
  },
  {
    topic: "auth",
    keywords: /\b(auth|login|logout|password|token|jwt|oauth|session|credential|bearer|api[_-]?key|apikey|sign[_-]?in|sign[_-]?up|register|passport|wallet|metamask|siwe|web3auth)\b/i,
  },
  {
    topic: "api",
    keywords: /\b(endpoint|route|api|url|http|https|rest|graphql|grpc|webhook|fetch|axios|request|response|handler|controller|middleware|openapi|swagger)\b/i,
  },
  {
    topic: "testing",
    keywords: /\b(test|spec|jest|pytest|vitest|mocha|chai|assert|expect|mock|stub|fixture|coverage|e2e|integration|unit\s+test)\b/i,
  },
  {
    topic: "ui",
    keywords: /\b(color|colour|style|button|layout|css|font|dark|light|theme|component|react|vue|svelte|tailwind|classname|className|render|modal|dialog|icon|design)\b/i,
  },
  {
    topic: "infra",
    keywords: /\b(docker|k8s|kubernetes|deploy|server|host|env|environment|production|staging|ci|cd|pipeline|nginx|vercel|cloudflare|aws|gcp|azure|fly\.io|heroku|railway)\b/i,
  },
];

function detectTopic(content: string): Topic {
  for (const { topic, keywords } of TOPIC_KEYWORDS) {
    if (keywords.test(content)) {
      return topic;
    }
  }
  return "general";
}

// ── State Node & Graph types ──────────────────────────────────────────────────

export interface StateNode {
  /** Index of the source message in the original messages array */
  messageIndex: number;
  /** Raw message content */
  content: string;
  /** "user" | "assistant" | "system" */
  role: string;
  /** Classified intent of this message */
  intent: MessageIntent;
  /** Detected topic domain */
  topic: Topic;
  /** Index of the message that supersedes this one (if any) */
  supersededBy?: number;
  /** Index of the message that this one supersedes (if any) */
  supersedes?: number;
  /** true = still in effect; false = overridden by a later correction */
  active: boolean;
}

export interface CorrectionEdge {
  /** messageIndex of the node being superseded */
  from: number;
  /** messageIndex of the node doing the superseding */
  to: number;
  /** Topic domain the correction applies to */
  topic: Topic;
}

export interface ActiveStateGraph {
  nodes: StateNode[];
  /** Nodes where active=true AND intent=INSTRUCTION */
  activeInstructions: StateNode[];
  /** Directed edges: from=superseded, to=superseder */
  correctionEdges: CorrectionEdge[];
  /** Human-readable summary of the graph */
  summary: string;
}

// ── Core algorithm ────────────────────────────────────────────────────────────

/**
 * Build the Active State Graph from a flat message array.
 *
 * Algorithm:
 *   1. Classify intent and topic for every message.
 *   2. For each CORRECTION node, look backward for the most recent INSTRUCTION
 *      node with the same topic that is still active. Mark it superseded.
 *   3. If no same-topic instruction is found, walk backward and supersede the
 *      most recent active INSTRUCTION regardless of topic (last-writer wins).
 *   4. Collect correction edges and compute activeInstructions.
 *
 * This is O(n²) worst case but conversations are bounded (< 1000 messages)
 * and the inner loop exits on first match, so practical performance is O(n).
 */
export function buildActiveStateGraph(
  messages: Array<{ role: string; content: string }>,
): ActiveStateGraph {
  if (!messages || messages.length === 0) {
    return {
      nodes: [],
      activeInstructions: [],
      correctionEdges: [],
      summary: "0 active instructions, 0 corrections applied, 0 topics revised",
    };
  }

  // 1. Build initial node list
  const nodes: StateNode[] = messages.map((msg, idx) => ({
    messageIndex: idx,
    content: msg.content,
    role: msg.role,
    intent: classifyIntent(msg.content),
    topic: detectTopic(msg.content),
    active: true,
  }));

  const correctionEdges: CorrectionEdge[] = [];
  const revisedTopics = new Set<Topic>();

  // 2 & 3. Walk forward; when we hit a CORRECTION, supersede prior instruction
  for (let i = 0; i < nodes.length; i++) {
    const corrector = nodes[i];
    if (corrector.intent !== "CORRECTION") continue;

    // First pass: find most recent active INSTRUCTION with same topic
    let target: StateNode | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = nodes[j];
      if (
        candidate.active &&
        candidate.intent === "INSTRUCTION" &&
        candidate.topic === corrector.topic
      ) {
        target = candidate;
        break;
      }
    }

    // Fallback: any most recent active INSTRUCTION
    if (!target) {
      for (let j = i - 1; j >= 0; j--) {
        const candidate = nodes[j];
        if (candidate.active && candidate.intent === "INSTRUCTION") {
          target = candidate;
          break;
        }
      }
    }

    if (target) {
      // Establish the edge
      target.active = false;
      target.supersededBy = corrector.messageIndex;
      corrector.supersedes = target.messageIndex;

      correctionEdges.push({
        from: target.messageIndex,
        to: corrector.messageIndex,
        topic: corrector.topic,
      });

      revisedTopics.add(corrector.topic);
    }
  }

  // 4. Collect active instructions (user or system, intent=INSTRUCTION, active=true)
  const activeInstructions = nodes.filter(
    n => n.active && n.intent === "INSTRUCTION",
  );

  // 5. Build summary string
  const topicRevisionCount = revisedTopics.size;
  const summary = [
    `${activeInstructions.length} active instruction${activeInstructions.length !== 1 ? "s" : ""}`,
    `${correctionEdges.length} correction${correctionEdges.length !== 1 ? "s" : ""} applied`,
    `${topicRevisionCount} topic${topicRevisionCount !== 1 ? "s" : ""} revised`,
  ].join(", ");

  return {
    nodes,
    activeInstructions,
    correctionEdges,
    summary,
  };
}

// ── Injection string ──────────────────────────────────────────────────────────

/**
 * Generate a compact active-state injection string for LLM context.
 *
 * This replaces (or supplements) injectCapsule() for agents that need to
 * take action — they get the CURRENT STATE, not compressed history.
 *
 * Format:
 *   [ACTIVE STATE: 3 instructions (storage→Postgres, auth→JWT, testing→jest).
 *    2 corrections applied.]
 *
 * The topic→value pairs are extracted by scanning active instructions for the
 * first recognizable technology keyword within that topic domain.
 */
export function injectActiveState(graph: ActiveStateGraph): string {
  if (graph.activeInstructions.length === 0) {
    return `[ACTIVE STATE: no active instructions. ${graph.correctionEdges.length} corrections applied.]`;
  }

  // Build "topic→keyword" pairs for the active instructions
  const topicValues: string[] = graph.activeInstructions.map(node => {
    const keyword = extractTopicKeyword(node.content, node.topic);
    return keyword
      ? `${node.topic}→${keyword}`
      : node.topic;
  });

  // Deduplicate while preserving order (later instructions win per topic)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let i = topicValues.length - 1; i >= 0; i--) {
    const topic = graph.activeInstructions[i].topic;
    if (!seen.has(topic)) {
      seen.add(topic);
      deduped.unshift(topicValues[i]);
    }
  }

  const instructionCount = graph.activeInstructions.length;
  const correctionCount = graph.correctionEdges.length;

  const instructionList = deduped.join(", ");
  const correctionClause = correctionCount > 0
    ? ` ${correctionCount} correction${correctionCount !== 1 ? "s" : ""} applied.`
    : "";

  return (
    `[ACTIVE STATE: ${instructionCount} instruction${instructionCount !== 1 ? "s" : ""} ` +
    `(${instructionList}).${correctionClause}]`
  );
}

// ── Internal: keyword extraction per topic ────────────────────────────────────

/**
 * Given an instruction's content and its detected topic, return the most
 * prominent technology keyword mentioned (e.g. "Postgres", "JWT", "jest").
 * Returns undefined if no recognizable keyword is found.
 */
function extractTopicKeyword(content: string, topic: Topic): string | undefined {
  const KEYWORD_MAPS: Record<Topic, RegExp> = {
    storage:  /\b(redis|postgres|postgresql|sqlite|mongo|mongodb|dynamo|s3|mysql|supabase|prisma|drizzle|cassandra|rds|memory)\b/i,
    auth:     /\b(jwt|oauth|session|cookie|metamask|siwe|web3auth|passkey|apikey|api[_-]?key|bearer|wallet)\b/i,
    api:      /\b(rest|graphql|grpc|openapi|swagger|trpc|webhook|http2|http3)\b/i,
    testing:  /\b(jest|vitest|pytest|mocha|chai|cypress|playwright|jasmine|ava)\b/i,
    ui:       /\b(tailwind|css|scss|styled-components|mui|chakra|shadcn|radix|next|react|vue|svelte|solid)\b/i,
    infra:    /\b(docker|k8s|kubernetes|vercel|cloudflare|aws|gcp|azure|fly|railway|heroku|nginx|caddy)\b/i,
    general:  /\b([A-Z][a-z]{2,}(?:[A-Z][a-z]*)*)\b/, // PascalCase proper noun as best guess
  };

  const match = content.match(KEYWORD_MAPS[topic]);
  if (!match) return undefined;

  // Normalise well-known casing
  const CANONICAL: Record<string, string> = {
    postgres: "Postgres", postgresql: "Postgres",
    mongodb: "MongoDB", mongo: "MongoDB",
    redis: "Redis", sqlite: "SQLite",
    jwt: "JWT", oauth: "OAuth",
    graphql: "GraphQL", grpc: "gRPC",
    jest: "jest", vitest: "vitest", pytest: "pytest",
    tailwind: "Tailwind", react: "React", vue: "Vue", svelte: "Svelte",
    docker: "Docker", kubernetes: "k8s", k8s: "k8s",
    vercel: "Vercel", cloudflare: "Cloudflare",
    supabase: "Supabase", prisma: "Prisma", drizzle: "Drizzle",
    metamask: "MetaMask", siwe: "SIWE",
  };

  const lower = match[0].toLowerCase();
  return CANONICAL[lower] ?? match[0];
}
