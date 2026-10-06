Published from Parad0x-Labs/openclaw-skills; this copy is not published.

# context-capsule — OpenClaw ContextEngine plugin

> 💜 **Saving you tokens?** [Star it on ClawHub](https://clawhub.ai/parad0x-labs/context-capsule) — it's a context engine, so it works silently in the background. A star is the only way other agent builders find it.

Compresses agent session history before it reaches the LLM. **Self-contained:**
the compression core is vendored inline (`src/compression.ts`) — no external
runtime dependency, and no network, file-system, or on-chain access. It uses
only Node's built-in `zlib` and `crypto`.

Sessions under 20 messages pass through unchanged. Longer sessions have their
older history compressed into a capsule summary (injected as a system message)
while the last 10 messages are kept verbatim — giving the model full coherence
on recent turns without paying for the full transcript.

> **Before you use this skill — read these:**
>
> - **All messages are vault-scanned** for secrets and PII on every path (short
>   sessions, verbatim tail, and compressed history alike). Matched values are
>   replaced with typed placeholders. However, the vault scan covers common
>   patterns — it is not a guarantee that all sensitive content is removed.
>   Do not rely on it as the sole protection for highly sensitive sessions.
>
> - **Compression alters history fidelity.** Older messages are summarised, not
>   preserved verbatim. Detail, nuance, and exact wording can be lost. Do not
>   use this skill where exact transcript fidelity is required.
>
> - **Compressed history is injected as a system message.** This places
>   summarised content in a privileged prompt position. Be aware that prior
>   user/assistant content will influence the model from the system role after
>   compression.
>
> - **No external runtime dependency.** The compression core is vendored inline
>   (`src/compression.ts`), so there is nothing external to resolve or verify.
>   The standalone `@parad0x_labs/context-capsule` library on npm is optional and
>   only relevant for non-OpenClaw use.

**Most useful for:** local models (Ollama, LM Studio) and GPT-4 where context
cost matters. Claude users with a 200k context window and built-in compaction
enabled may not need this.

## Benchmark

This private copy (1.4.0) replaces older history with a short pointer string
(topics, zlib ratio, Merkle prefix) and has no retrieval, so the model does not
see older details. It is not the published plugin.

The figures previously shown here (99.3% savings, 90% recovery) came from the
standalone library's `bench-public.ts`: the savings figure is the pointer
string vs the full history, and the recovery figure is keyword matching on
`searchCapsule()` output, which this plugin never calls. Neither measures this
plugin. Current measurements:

- standalone library: [docs/CONTEXT_CAPSULE_BENCHMARK.md](../../docs/CONTEXT_CAPSULE_BENCHMARK.md)
- published plugin (1.7.0, extractive capsule + verbatim tail): [openclaw-skills docs/CONTEXT_CAPSULE_BENCHMARK.md](https://github.com/Parad0x-Labs/openclaw-skills/blob/main/docs/CONTEXT_CAPSULE_BENCHMARK.md)

## Activation

```jsonc
// openclaw.json
{
  "plugins": {
    "slots": {
      "contextEngine": "context-capsule"
    }
  }
}
```

## Config options

| Key | Default | Description |
|---|---|---|
| `minMessages` | `20` | Sessions shorter than this pass through unchanged |
| `keepRecentMessages` | `10` | Recent messages kept verbatim after compression |

```jsonc
{
  "plugins": {
    "entries": {
      "context-capsule": {
        "minMessages": 15,
        "keepRecentMessages": 8
      }
    }
  }
}
```
