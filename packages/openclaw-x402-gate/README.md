# openclaw-x402-gate — charge other agents with x402 on Solana

> ⚠️ **MOVED — this copy is frozen.** The canonical home of this skill is now
> [openclaw-skills/skills/x402-gate](https://github.com/Parad0x-Labs/openclaw-skills/tree/main/skills/x402-gate).
> Install from, file issues against, and contribute to openclaw-skills; this
> directory remains only as a historical pointer and will not receive updates.

Turn any OpenClaw skill or API into a paid endpoint. Mint an HTTP **402 Payment
Required** challenge, verify the payment, then serve. Funds settle **straight to
your own wallet** on Solana — the skill holds no keys and takes no custody. Pairs
with [`openclaw-x402-pay`](https://github.com/Parad0x-Labs/dna-x402/tree/main/packages/openclaw-x402-pay)
(the paying side) for the full agent-to-agent loop on a rail that's **live on
Solana mainnet**.

## Trust model

- **No custody.** `recipientAddress` is *your* public wallet; payments land there
  on-chain. This skill signs nothing and holds no keys.
- **Stateless.** Both tools reconstruct the same requirement from config +
  resource, so receipt hashes match the paying side with no shared state.
- **Revenue-grade option.** Set `requireOnChain: true` and a payment is accepted
  only after its transaction is **confirmed settled on Solana** — not just a
  well-formed header. The check binds to the unique receipt hash in the tx memo,
  so proofs can't be replayed against a different charge.

> **Status: Public Beta.** Non-custodial, **unaudited** — no external audit has
> been completed or scheduled.

## The two tools

```
x402_challenge({ resource, priceUsdc?, description? })
  → { status: 402, body }          // send `body` to an unpaid caller

x402_verify({ header, resource, priceUsdc? })
  → { valid, payerAddress, amountUsdc, receiptHash, onChainVerified }
```

## Config

```jsonc
{
  "plugins": {
    "entries": {
      "x402-gate": {
        "recipientAddress": "YOUR_SOLANA_WALLET",  // required — where funds land
        "priceUsdc": 0.05,
        "network": "solana-devnet",                 // or solana-mainnet
        "requireOnChain": true,                      // confirm settlement before serving
        "rpcUrl": "https://..."                      // optional private RPC
      }
    }
  }
}
```

| Key | Default | Description |
|---|---|---|
| `recipientAddress` | — (required) | Your wallet; payments settle here. Public key only. |
| `priceUsdc` | `0.01` | Default price per request |
| `network` | `solana-devnet` | Settlement network |
| `requireOnChain` | `false` | Accept only after on-chain confirmation (recommended for real value) |
| `rpcUrl` | public RPC | Optional RPC override |

## Flow

1. Caller hits your gated capability with no payment → `x402_challenge` returns a
   402 telling them the price and your address.
2. Caller pays (e.g. via `openclaw-x402-pay`) and retries with an `X-Payment`
   header.
3. `x402_verify` checks it. With `requireOnChain`, it confirms the transaction
   settled before you serve the resource.

## No external @parad0x_labs dependency

Constants and wire types are vendored inline. The only runtime dependency is the
well-known `@solana/web3.js` (used solely for on-chain confirmation).

## Source

github.com/Parad0x-Labs/dna-x402/tree/main/packages/openclaw-x402-gate
