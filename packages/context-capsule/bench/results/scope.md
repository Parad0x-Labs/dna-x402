# Context Capsule scope benchmark

Fixture `agent-session-100` (109 messages), 40 questions, tokenizer: chars/4 estimate, model calls: 0.

## Archive (lossless)

| JSONL bytes | zlib-9 bytes | zlib ratio | base64 bytes in capsule |
|---:|---:|---:|---:|
| 31818 | 10382 | 3.1x | 13844 |

## Initial prompt payload

| Full history (JSONL) | Full history (content only) | injectCapsule() | injectEnrichedCapsule() |
|---:|---:|---:|---:|
| 7919 | 6941 | 53 | 71 |

injectCapsule() output on this fixture:

```text
[CONTEXT CAPSULE: session bench-agent-session-100 compressed 3.1x. Key topics: The Merkle, On Solana, Solana Compressed, Solana Foundation, Use Redis. Merkle: c44c3735a89e... Full history available on request.]
```

## Per-question arms (keyword availability, not model task success)

35 of 40 questions are answerable from the session text (all required keywords occur in it); unanswerable: 32, 35, 36, 39, 40.
Search arms score the returned message bodies only (the header line is excluded).

| Arm | Keyword pass (of 40) | Of answerable | Mean tokens / question | Messages returned (mean, min-max) |
|---|---:|---:|---:|---:|
| Full history (no compression) | 35/40 (87.5%) | 35/35 | 7281 | - |
| Sliding window, last 10 messages | 9/40 (22.5%) | 9/35 | 581 | - |
| Sliding window, last 20 messages | 11/40 (27.5%) | 11/35 | 1319 | - |
| injectCapsule() only (no retrieval) | 2/40 (5%) | 2/35 | 53 | - |
| injectCapsule() + searchCapsule(question text) | 34/40 (85%) | 34/35 | 6803 | 92.9 (28-107) of 109 |
| injectCapsule() + searchCapsule(question content words) | 33/40 (82.5%) | 33/35 | 2599 | 22.4 (1-59) of 109 |
| injectCapsule() + searchCapsule(question content words, { limit: 8 }) | 32/40 (80%) | 32/35 | 1131 | 7.7 (1-8) of 109 |
| Ordinary retrieval: top 8 messages by term overlap (no capsule) | 32/40 (80%) | 32/35 | 1063 | - |

Generated 2026-10-06T08:45:43.403Z with Node v22.23.3. Regenerate: `node --experimental-strip-types scripts/bench-scope.ts`.
