# Changelog

## 1.2.0

Behaviour changes:

- **`anchorCorrectionChain()` has no default cluster.** Before, with
  `SOLANA_KEYPAIR` set and no `rpcUrl`, it sent the Memo to Solana mainnet-beta.
  Now the endpoint must come from the `rpcUrl` argument or the
  `CONTEXT_CAPSULE_ANCHOR_RPC` environment variable; without one it sends
  nothing, logs the reason, and returns `dry_run:<merkleRoot>`. Callers that
  relied on the mainnet default must pass the endpoint explicitly. New export:
  `ANCHOR_RPC_ENV`.
- **`searchCapsule()` header no longer repeats the query.** It now reads
  `[CAPSULE SEARCH RESULTS — <returned>/<total> messages]`, and the no-match
  message is `[CAPSULE SEARCH: no messages matched]`. The returned message text
  is unchanged.

Additions:

- `searchCapsule(capsule, query, { limit })`: keep at most `limit` messages,
  preferring those that contain the most distinct query terms, in original
  order. Without `limit` every match is returned, as before.

Packaging and docs:

- The package ships `src/index.ts`, `README.md` and this file. `src/active-state.ts`
  and `src/semantic-tagger.ts` were in earlier tarballs but never reachable through
  the package entry point; they are no longer shipped.
- README benchmark figures state their measured scope (initial pointer vs
  retrieval vs model tasks); see `docs/CONTEXT_CAPSULE_BENCHMARK.md` in the
  repository.

## 1.1.0 (prepared, not published to npm)

- The SPL Memo written by `anchorCorrectionChain()` is `correction_chain:<merkleRoot>`
  and no longer names the retired receipt-anchor program.

## 1.0.0

- First release.
