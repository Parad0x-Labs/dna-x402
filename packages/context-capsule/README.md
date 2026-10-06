# @parad0x_labs/context-capsule

Keep agent session history out of the prompt until it is needed. Stores the
history losslessly, gives the model a short pointer, and retrieves matching
messages on demand.

## What it does

- `compressContext()` stores the session as zlib-compressed JSONL (lossless) with a SHA-256 Merkle root over the messages.
- `injectCapsule()` returns a short pointer string for the prompt: session id, zlib ratio, up to 5 topic words, Merkle prefix. It does not contain the session's facts.
- `searchCapsule()` decompresses the archive and returns every message containing any query term. Your code decides when to call it and puts the result in the prompt.

All of it is deterministic and local. No exported function calls a model.
How each stage works: [docs/CONTEXT_CAPSULE_DATAFLOW.md](https://github.com/Parad0x-Labs/dna-x402/blob/main/docs/CONTEXT_CAPSULE_DATAFLOW.md).

## Public benchmark

Model-free and reproducible; Node.js 22, no dependencies. Bundled 109-message
development fixture, 40 questions written with it (35 answerable from it).
Token counts are `chars / 4` estimates.

| Measurement | Result | What it covers |
|---|---|---|
| Archive (zlib, lossless) | 31,818 -> 10,382 bytes (3.1x) | stored history |
| Initial prompt payload | 7,919 -> 53 tokens | pointer string only; retrieval not counted |
| Pointer alone, answer keywords present | 2 / 40 | no-retrieval control |
| `searchCapsule(question)` keyword recovery | 34 / 40, ~6,800 tokens retrieved per question | retrieval returns 93 of 109 messages on average |
| `searchCapsule(content words)` keyword recovery | 33 / 40, ~2,600 tokens per question | 22 of 109 messages on average |
| End-to-end model task success / total tokens | not measured yet | harness defined, see benchmark doc |

Keyword recovery means every required keyword occurs in the retrieved message
text; it is not a model answering the question. Method, baselines (sliding
window, top-k retrieval), result files and the planned model-task comparison:
[docs/CONTEXT_CAPSULE_BENCHMARK.md](https://github.com/Parad0x-Labs/dna-x402/blob/main/docs/CONTEXT_CAPSULE_BENCHMARK.md).

```bash
cd packages/context-capsule
npm run bench:public   # bench/results/latest.json, latest.md
npm run bench:scope    # bench/results/scope.json, scope.md (all arms)
```

Limits:

- The fixture is one synthetic session; other content compresses and retrieves differently.
- The pointer is a reference, not a summary. Without retrieval the model does not see earlier details.
- Retrieval is term matching (any term, substring). A question in different words than the session may miss; a broad query returns most of the history.
- Token counts are estimates, not a model tokenizer.

## Install

```bash
npm install @parad0x_labs/context-capsule
```

## Usage

```typescript
import { compressContext, injectCapsule, searchCapsule, estimateSavings } from '@parad0x_labs/context-capsule'

// Compress session history
const capsule = compressContext(messages, { sessionId: 'my-session' })

// Short pointer for the next LLM call (53 estimated tokens on the bundled fixture)
const injection = injectCapsule(capsule)

// When earlier detail is needed, retrieve it and add it to the prompt yourself
const relevant = searchCapsule(capsule, 'payment receipt')

// Pointer size vs full history (initial payload only; retrieval not included)
const savings = estimateSavings(messages, capsule)
console.log(savings.savedPercent)
```

## API

### `compressContext(messages, opts?): ContextCapsule`

Compresses an array of `{ role, content }` messages using zlib deflate (level 9), lossless.
Builds a SHA-256 Merkle root over per-message hashes, so a stored history can be checked against a recorded root.

### `injectCapsule(capsule): string`

Returns a short pointer string (53 estimated tokens on the bundled fixture) with session ID,
zlib ratio, up to 5 topic words, and a truncated Merkle root. It does not include facts or decisions.

### `searchCapsule(capsule, query): string`

Decompresses the capsule and returns, in original order and untruncated, every message that
contains any query term (case-insensitive substring). Results are not ranked or capped, so
common words return most of the history; use specific terms.

### `estimateSavings(messages, capsule): SavingsEstimate`

Compares `chars / 4` of the full JSONL history with `chars / 4` of the `injectCapsule()` string,
plus a USD delta at a fixed $15 per 1M input tokens. It measures the initial pointer only;
tokens from `searchCapsule()` results are not included.

## ContextCapsule shape

```typescript
interface ContextCapsule {
  sessionId: string          // set by caller or auto-generated
  capsuleId: string          // sha256(sessionId + createdAt + merkleRoot)[:32]
  originalTokenEstimate: number
  compressedBytes: number
  compressionRatio: string   // zlib ratio, e.g. "3.1x"
  topics: string[]           // up to 5 extracted key topics
  merkleRoot: string         // 64-char hex SHA-256 Merkle root
  createdAt: number          // Unix ms
  compressedBase64: string   // zlib-deflated JSONL, base64-encoded
}
```

## Corrections and anchoring

`taggedCompressContext()` tags each message (instruction, correction, additive, query, ack) with
keyword heuristics and builds `activeInstructions`, where a correction replaces the earlier
instruction it overlaps most. `injectEnrichedCapsule()` prints only the counts; render
`capsule.activeInstructions` into your prompt if the model should see the corrected instructions.

`anchorCorrectionChain()` posts a Merkle root of the correction chain as an SPL Memo
(`correction_chain:<root>`). It returns `dry_run:<merkleRoot>` and sends nothing unless
`SOLANA_KEYPAIR` is set and `@solana/web3.js` is installed; the dry-run string is not a
transaction. When both are present it signs with that keypair and sends to the given RPC
URL, defaulting to Solana mainnet-beta.

## Requirements

Node.js >= 22.0.0. No external npm dependencies — only Node.js built-ins (`node:crypto`, `node:zlib`).

## License

MIT
