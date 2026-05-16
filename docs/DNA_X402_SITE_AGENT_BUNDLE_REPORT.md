# DNA x402 Site Agent Bundle Report

Command:

```bash
npm --prefix site-agent run build
npm --prefix site-agent run analyze
```

Current result:

- initial app chunk: about `177 KiB` raw / `57 KiB` gzip
- wallet/Solana chunk: about `291 KiB` raw / `85 KiB` gzip
- marketplace chunk: about `7 KiB` raw / `2 KiB` gzip
- no server-only imports detected in client source

Fix applied:

- wallet-heavy routes are lazy-loaded.
- marketplace and Polymarket screens are route chunks.
- Solana wallet/web3 code no longer sits in the initial app chunk.

Remaining note:

The wallet chunk is still large because `@solana/web3.js` is heavy. That is acceptable only because it is lazy-loaded behind wallet routes. Further reduction would require a lighter wallet/transaction path or deeper web-worker split.
