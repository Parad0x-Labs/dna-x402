# Context Capsule — Public Proof

This document explains what was tested, how numbers were calculated, how to
reproduce the results, and what the benchmark does not prove.

---

## What was tested

A 100-message realistic agent session covering the DNA x402 payment system
build. The fixture is committed at:

```
packages/context-capsule/bench/fixtures/agent-session-100.json
```

The session covers: x402 payment flows, Agent Passport identity, MetaMask
ETH wallet binding, Dark NULL privacy layer, ContextCapsule compression,
SHA-256 Merkle rooting, ZK receipt compression, Wormhole cross-chain solver,
NULL token governance, DePIN mining, BLS12-381 aggregation, WebAuthn PRF
key derivation, and Arweave archival. It ends with a summary message.

The fixture is self-referential by design — it contains the package's own
documentation and behaviour descriptions, which makes it a representative
case for agent sessions that discuss what the agent is doing.

---

## How token savings were calculated

No tokenizer is used. Both sides use the `chars / 4` approximation, which
is the industry-standard heuristic for English prose token estimation.

**Original tokens**: the full session serialised as JSONL (one
`JSON.stringify(message)` per line, newline-separated), then
`Math.ceil(totalCharacters / 4)`.

**Capsule tokens**: the output of `injectCapsule(capsule)` — the short
summary string that actually gets sent to the LLM on subsequent calls —
then `Math.ceil(string.length / 4)`.

**Savings percent**: `(original_tokens - capsule_tokens) / original_tokens * 100`.

The capsule inject string is not the compressed blob — it is the human-readable
summary (`[CONTEXT CAPSULE: session X compressed 8.3x. Key topics: ...]`).
The compressed blob (`compressedBase64`) is kept in memory for `searchCapsule`
calls; it does not go to the LLM unless explicitly retrieved.

---

## How recovery was scored

40 golden questions are defined in:

```
packages/context-capsule/bench/fixtures/recovery-questions.json
```

Each question has:
- a natural-language question string
- a list of `required_keywords` (all must appear in the result)

For each question, the benchmark calls:

```typescript
const result = searchCapsule(capsule, question)
```

`searchCapsule` decompresses the capsule and returns only the messages that
contain at least one term from the question (case-insensitive). A question
passes if every `required_keyword` appears in the returned result string
(case-insensitive).

No LLM is involved. This tests whether the compressed capsule preserves
enough of the original text that keyword-level retrieval still works. It
does not test semantic understanding.

**Recovery score** = questions passed / 40 * 100.

The gate is 90%. Failing a gate exits the benchmark with code 1.

---

## How to reproduce

From the repository root:

```bash
npm install
npm run bench:public --prefix packages/context-capsule
```

Or equivalently:

```bash
cd packages/context-capsule
npm run bench:public
```

The script runs directly with Node.js 22 using `--experimental-strip-types`
to execute TypeScript without a compile step. No build tools required.

Output is written to:

```
packages/context-capsule/bench/results/latest.json   # machine-readable metrics
packages/context-capsule/bench/results/latest.md     # formatted table + per-question breakdown
```

The CI workflow at `.github/workflows/context-capsule-proof.yml` runs this
automatically on every push to `packages/context-capsule/**`.

---

## Benchmark gates

| Gate | Threshold | Exit code on failure |
|---|---|---|
| Token savings | >= 95% | 1 |
| Recovery score | >= 90% (36/40 questions) | 1 |
| Runtime | < 1000ms | 1 |

---

## What it does NOT prove

**Not universal.** The fixture is one specific 100-message session about a
Solana payment system. Sessions with different content — long code blocks,
binary data, very short messages — will produce different savings ratios.

**Not lossless.** `searchCapsule` retrieves by term matching. If a question
uses different vocabulary from the original messages, the relevant message
may not be returned. The capsule does not perform semantic search.

**Not a real tokenizer.** The chars/4 estimate diverges from actual
tokenizer counts for code, special characters, and non-English text.
The actual savings seen in production will depend on the LLM's tokenizer.

**Not a substitute for measuring your own sessions.** Pass `--fixture=my-file`
to run the benchmark on your own session data:

```bash
npm run bench:public -- --fixture=my-session-name
# loads bench/fixtures/my-session-name.json
```

**Results are fixture-specific.** The numbers in this document reflect the
included `agent-session-100` fixture only.
