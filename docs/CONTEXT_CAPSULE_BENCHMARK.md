# Context Capsule benchmark: method and results

Package: `@parad0x_labs/context-capsule` ([`packages/context-capsule`](../packages/context-capsule)).
Package version 1.2.0. Results last refreshed 2026-10-06 in a network-isolated container (method below).
Dataflow of every stage measured here: [CONTEXT_CAPSULE_DATAFLOW.md](CONTEXT_CAPSULE_DATAFLOW.md).

All numbers are deterministic and model-free. No LLM was called. Token counts
are `ceil(chars / 4)` estimates, not a model tokenizer.

## What each number means

| Scope | Question it answers | Measured here |
|---|---|---|
| Archive size | How small is the stored, lossless history? | yes |
| Initial prompt payload | How many tokens does the first injected string cost? | yes |
| Information available in one call | Is the answer text in what the model receives? (keyword availability) | yes |
| With retrieval | Same, after a `searchCapsule()` call, counting the retrieved text | yes |
| Model task success, total task tokens, cost per successful answer | Does a model answer correctly, and what does the whole task cost? | **no** (harness defined below) |

A small initial payload is not the same as a total-token saving: if the task
needs the earlier detail, retrieval adds it back, and those tokens count.

## Dataset

- Session: [`bench/fixtures/agent-session-100.json`](../packages/context-capsule/bench/fixtures/agent-session-100.json), 109 messages (55 user, 54 assistant), synthetic, about building a receipt-anchoring package. SHA-256 `18b4a6590cbde822835a70d107a2c7b29f72753edcb9e2c8c905fdaa4d1942aa`.
- Questions: [`bench/fixtures/recovery-questions.json`](../packages/context-capsule/bench/fixtures/recovery-questions.json), 40 questions with `required_keywords` (corrections 10, bugs 6, files 5, decisions 5, tests 4, todos 4, security 4, commands 2). SHA-256 `f691e86c423a1d9bc35ce38a6a046206f162aad4514407775d984c78839ef5e0`.
- The questions were written together with the session by the maintainers. They are a development set, not a held-out evaluation.
- 5 questions (32, 35, 36, 39, 40) are not answerable from the session: at least one required keyword never occurs in it. They carry `"unanswerable": true` in the question file, and `bench-scope.ts` fails if a flag disagrees with the session text.

## Results (fixture `agent-session-100`)

### Archive

| JSONL bytes | zlib level 9 bytes | zlib ratio | base64 bytes held in the capsule object |
|---:|---:|---:|---:|
| 31,818 | 10,382 | 3.1x | 13,844 |

The archive is lossless. The ratio is ordinary zlib on JSON text.

### Initial prompt payload

| Full history, JSONL | Full history, `[ROLE]: content` | `injectCapsule()` | `injectEnrichedCapsule()` |
|---:|---:|---:|---:|
| 7,919 | 7,281 | 53 | 71 |

`7,919 -> 53` (99.3%) is the size of the pointer string relative to the JSONL
history. The pointer carries the session id, the zlib ratio, 5 topic words and
a Merkle prefix. It does not carry the session's facts.

### Keyword availability per arm (40 questions)

"Pass" = every required keyword occurs in the text the model would receive.
This shows whether the answer is present, not whether a model answers correctly.

| Arm | Pass (of 40) | Pass (of 35 answerable) | Mean tokens per question | Messages returned, mean (min-max) of 109 |
|---|---:|---:|---:|---:|
| Full history | 35 | 35 | 7,281 | all |
| Sliding window, last 10 | 9 | 9 | 581 | 10 |
| Sliding window, last 20 | 11 | 11 | 1,319 | 20 |
| `injectCapsule()` only, no retrieval (negative control) | 2 | 2 | 53 | 0 |
| `injectCapsule()` + `searchCapsule(question)` | 34 | 34 | 6,803 | 92.9 (28-107) |
| `injectCapsule()` + `searchCapsule(question content words)` | 33 | 33 | 2,599 | 22.4 (1-59) |
| `injectCapsule()` + `searchCapsule(question content words, { limit: 8 })` | 32 | 32 | 1,131 | 7.7 (1-8) |
| Ordinary retrieval: top 8 messages by term overlap, no capsule | 32 | 32 | 1,063 | 8 |

Reading the table:

- The pointer alone makes 2 of 40 answers available. Recall depends on retrieval.
- Passing the whole question to `searchCapsule()` returns most of the session (term matching is any-term substring), so its 34/40 costs about 94% of the full-history tokens.
- Content-word queries keep 33/40 at about 36% of full-history tokens; with `limit: 8` they keep 32/40 at about 16%.
- A plain top-8 overlap retriever reaches 32/40 at about 15% of full-history tokens.

### Unit and quality tests

`tests/context-capsule.test.mjs` 35/35 pass (6 added in 1.2.0 for the search header, `limit`, and anchoring without a default cluster), `tests/context-capsule-quality.test.mjs` 10/10 pass, no skips. Runtime of the full benchmark: under 50 ms.

## Scoring note: query echo (fixed 2026-10-06)

Up to 1.1.0, `searchCapsule()` output started with a header line that repeated
the query. `bench-public.ts` previously scored the whole string, so a keyword that occurs
only in the question text counted as recovered. Questions 39 (`final`) and 40
(`retract`) passed that way. Scoring now uses the returned message bodies only.
The reported recovery changed from 36/40 (90%) to 34/40 (85%); retrieval
behaviour did not change. The recovery gate in `bench-public.ts` moved from 90%
to 85% to match the corrected measurement. Since 1.2.0 the header reports counts
only and no longer repeats the query, so the leak cannot recur.

## Gate choice

`bench-public.ts` reports recovery over all 40 questions (34/40, 85.0%) and over
the 35 answerable ones (34/35, 97.1%). The gate is on the total, at 85%. A gate
on the answerable set would need a margin below the measured 97.1%, but the next
step down is 33/35 (94.3%), so any such gate tolerates no more misses than the
total-based one and adds no headroom. Both figures are published; only the total
is gated. The gate equals the measured value, so any loss in retrieval fails CI.

## Result files (in this repository)

| File | Produced by |
|---|---|
| [`bench/results/latest.json`](../packages/context-capsule/bench/results/latest.json), [`latest.md`](../packages/context-capsule/bench/results/latest.md) | `scripts/bench-public.ts` (CI gate: pointer savings >= 95%, keyword recovery >= 85% of 40, runtime < 1 s; answerable-set recovery reported, not gated) |
| [`bench/results/scope.json`](../packages/context-capsule/bench/results/scope.json), [`scope.md`](../packages/context-capsule/bench/results/scope.md) | `scripts/bench-scope.ts` (all arms above, per question) |
| [`bench/results/e2e-dryrun.json`](../packages/context-capsule/bench/results/e2e-dryrun.json) | `scripts/e2e-harness.ts --dry-run` (prompt sizes only, no task success) |

## Reproduce

Requires only Node.js 22 (no dependencies). The run recorded above used a
container with no network, a read-only root filesystem, and a tmpfs work
directory, with the package copied in through stdin (no host mounts):

```sh
# from the repository root
tar -cf - packages/context-capsule | docker run --rm -i --network none --read-only \
  --tmpfs /work:rw,exec,size=256m --tmpfs /tmp:rw,size=64m -w /work node:22-bookworm-slim sh -c '
  tar -xf - -C /work && cd packages/context-capsule &&
  node --test tests/context-capsule.test.mjs &&
  node --test tests/context-capsule-quality.test.mjs &&
  node --experimental-strip-types scripts/bench-public.ts &&
  node --experimental-strip-types scripts/bench-scope.ts &&
  node --experimental-strip-types scripts/e2e-harness.ts --dry-run'
```

Image `node:22-bookworm-slim` (`sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`), Node v22.23.3.
Without Docker: `cd packages/context-capsule && npm run bench:public && npm run bench:scope && npm run bench:e2e:dry`.

The CI workflow `Context Capsule Public Proof` runs the same tests and
benchmarks on every push to `packages/context-capsule/**` and fails if the
deterministic fields of the committed result files drift from a fresh run.

## Not yet measured: end-to-end model tasks

The comparison that would support a total-token or cost claim is defined but
has not been run (it needs model access, which this run did not use):

- **Arms:** full history; sliding window; model-written summary; ordinary retrieval (top-k); capsule pointer + `search_capsule` tool the model may call.
- **Same for every arm:** tasks, model, system text, decoding settings, grader.
- **Tasks:** a held-out file, not the 40 development questions, covering exact identifiers, updated facts, multi-record answers, negation, source provenance, and a no-retrieval negative control. Schema: `{ id, question, type, gold: { must_include[], must_not_include[] } }`.
- **Count everything:** input and output tokens of every call, tool-schema tokens, retrieval responses, retries, and the summarization call for the summary arm; cached input tokens reported separately; latency.
- **Report:** success rate, total tokens, tokens per successful answer, and cost per successful answer at a stated price, alongside dataset, tokenizer, model id, seeds, exclusions and failures. No tuning on the evaluation file.

[`scripts/e2e-harness.ts`](../packages/context-capsule/scripts/e2e-harness.ts) implements these arms and the accounting. With `--adapter=<module>` exporting `callModel()` it runs the comparison; without it (`--dry-run`) it only sizes the first requests. Dry-run means on the development questions (chars/4 tokens, input only):

| Arm | Mean input tokens |
|---|---:|
| Full history | 7,330 |
| Sliding window, last 10 | 630 |
| Top-8 retrieval | 1,131 |
| Capsule, first request (pointer + 55-token tool schema) | 152 |
| Capsule, second request after one simulated search | 2,806 |
| Capsule, both requests | 2,958 |
| Model-written summary | needs a model |

These are prompt sizes, not results. A model may call the tool more than once,
or not at all; only a live run settles success and total cost.

## Wording these numbers support

- "On the bundled 109-message development fixture, the initial prompt payload drops from 7,919 to 53 estimated tokens (pointer string only; retrieval not counted)."
- "Lossless zlib archive, 3.1x on the fixture, with a SHA-256 Merkle root over messages."
- "Keyword recovery through `searchCapsule()`: 34 of 40 development questions (34 of the 35 answerable), returning about 6,800 tokens per question with question-text queries, about 2,600 with content-word queries, or about 1,130 with content words and `limit: 8` (32 of 40)."
- "End-to-end model task success and total token cost have not been measured."

Unqualified "83x", "98% token cost reduction", or "~80 tokens that preserve the key facts" are not supported by these measurements.
