# @parad0x_labs/context-capsule

LLM context compression. Reduces token usage while preserving agent memory.

## What it does

Compresses agent session history before injecting into an LLM context window.
Instead of sending 50,000 tokens of previous conversation, send a ~80-token
capsule that preserves the key facts.

## Public Benchmark

Reproducible. No paid LLM required.

```bash
npm install
node --experimental-strip-types packages/context-capsule/scripts/bench-public.ts
```

Or from within the package:

```bash
cd packages/context-capsule
npm run bench:public
```

| Metric | Result | Gate |
|---|---|---|
| Original tokens | ~7,919 | — |
| Capsule tokens | ~53 | — |
| Token savings | **>= 95%** | >= 95% |
| Recovery score | **>= 90%** | >= 90% (40 questions, keyword match) |
| Runtime | **< 1000ms** | < 1000ms |

Token savings measured as: `(original_tokens - capsule_inject_tokens) / original_tokens`.
Original tokens: `chars / 4` estimate on the raw JSONL session.
Capsule tokens: `chars / 4` on the `injectCapsule()` output string.

Recovery score: 40 golden questions answered from the capsule via `searchCapsule()`.
Each question passes if all required keywords appear in the result (case-insensitive).
No LLM is involved.

Benchmark output is written to `bench/results/latest.json` and `bench/results/latest.md`.

**This is a benchmark on the included 100-message fixture (`bench/fixtures/agent-session-100.json`).
Results vary by content type.**

## What it does NOT prove

- That all possible session types compress this well
- That the capsule is lossless (it is not — searchCapsule retrieves by term matching)
- That the recovery score holds for all domains or question styles
- Token estimates are approximate (chars/4 heuristic, not a real tokenizer)

## Install

```bash
npm install @parad0x_labs/context-capsule
```

## Usage

```typescript
import { compressContext, injectCapsule, searchCapsule, estimateSavings } from '@parad0x_labs/context-capsule'

// Compress session history
const capsule = compressContext(messages, { sessionId: 'my-session' })

// Inject into next LLM call (~80 tokens instead of thousands)
const injection = injectCapsule(capsule)

// Retrieve specific context on demand
const relevant = searchCapsule(capsule, 'payment receipt')

// Estimate cost savings
const savings = estimateSavings(messages, capsule)
console.log(savings.savedPercent)              // e.g. "97.3%"
console.log(savings.estimatedUsdSavingsPerCall) // e.g. "$0.000109"
```

## API

### `compressContext(messages, opts?): ContextCapsule`

Compresses an array of `{ role, content }` messages using zlib deflate (level 9).
Builds a SHA-256 Merkle root over per-message hashes for tamper-evident auditing.

### `injectCapsule(capsule): string`

Returns a ~80-token summary string ready to inject as a system message.
Includes session ID, compression ratio, extracted topics, and truncated Merkle root.

### `searchCapsule(capsule, query): string`

Decompresses the capsule and returns only messages matching the query terms.
Never returns the full history for a specific query — retrieval is selective.

### `estimateSavings(messages, capsule): SavingsEstimate`

Returns token counts, savings percent, and estimated USD cost delta at $15/1M tokens.

## ContextCapsule shape

```typescript
interface ContextCapsule {
  sessionId: string          // set by caller or auto-generated
  capsuleId: string          // sha256(sessionId + createdAt + merkleRoot)[:32]
  originalTokenEstimate: number
  compressedBytes: number
  compressionRatio: string   // e.g. "8.3x"
  topics: string[]           // up to 5 extracted key topics
  merkleRoot: string         // 64-char hex SHA-256 Merkle root
  createdAt: number          // Unix ms
  compressedBase64: string   // zlib-deflated JSONL, base64-encoded
}
```

The `merkleRoot` can be anchored on-chain via `receipt_anchor` for auditability.

## Requirements

Node.js >= 22.0.0. No external npm dependencies — only Node.js built-ins (`node:crypto`, `node:zlib`).

## License

MIT
