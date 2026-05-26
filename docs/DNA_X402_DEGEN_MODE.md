# DNA x402 Degen Mode

Status: `PUBLIC_BETA_INTENT_LAYER`

Degen Mode lets builders turn Solana trench ideas into DNA x402 agents without copying unsafe trading-bot patterns.

Use it for:

- fresh pair scouts
- wallet stalkers
- copy-the-chad agents
- rug radar
- pump radar
- paper ape labs
- paid signal rooms
- max-pain live trade intents

Public line:

```txt
Connect wallet. Pick agent. Set max pain. Let it cook.
```

## What We Kept

The reviewed ALgoat-style archive had useful product ideas:

- fresh pair watching
- wallet and tape alerts
- paper/scalper simulation UX
- strategy knobs for dip, catalyst, take-profit, stop, and cooldown
- degen-native labels that traders understand

Those ideas are useful as scanner, signal, and paper-sim primitives.

## What We Dropped

The same archive is not acceptable as a DNA x402 live trading core.

Rejected patterns:

- browser `localStorage` private-key storage
- pasted trading wallet secrets
- backend signing
- backend custody
- PumpPortal API-key execution as the core live path
- high-slippage defaults treated as normal
- paper replay framed as proof of edge
- fake PnL or guaranteed-profit claims
- uncapped auto-live execution

Blunt assessment: tape heuristics and paper PnL do not prove a profitable scalping edge. They do not capture failed exits, slippage, fees, liquidity collapse, rugs, latency, MEV, API outages, or sell failures.

## Modes

| Mode | Wallet Needed | Live Money | Notes |
|---|---:|---:|---|
| `WATCH_ONLY` | No | No | Alerts and risk signals. |
| `SIGNAL_ONLY` | No | No | Paid or free signals, no execution. |
| `PAPER_SIM` | No | No | Simulated strategy lab, clearly marked simulated. |
| `USER_CONFIRMED_LIVE` | Yes | Yes | Creates trade intent; user signs client-side. |
| `CAPPED_AUTO_LIVE` | Yes | Yes | Requires explicit adapter gate and full risk profile. |

## Max Pain Risk Profile

Live modes require:

- `maxTradeUsd`
- `maxDailySpendUsd`
- `maxDailyLossUsd`
- `maxOpenExposureUsd`
- `maxSlippageBps`

Docs/UI should call these:

- ape budget
- max pain
- bankroll rules
- kill switch
- risk profile

Current Public Beta ceilings:

| Field | Ceiling |
|---|---:|
| Max trade | `$200` |
| Max daily spend | `$1,500` |
| Max daily loss | `$300` |
| Max open exposure | `$500` |
| Max slippage | `3,000 bps` |

## Execution Adapters

Degen Mode exposes intent adapters, not a hidden live execution engine.

| Venue | Public Beta Role | Live Submit |
|---|---|---:|
| `JUPITER` | quote and user-confirmed swap intent | No backend submit |
| `RAYDIUM` | quote/watch intent | No backend submit |
| `PUMPFUN` | fresh-pair/tape signal intent | No direct live trading path |
| `POLYMARKET` | paper/signal/user-confirmed intent | No unattended public live |
| `CUSTOM_WEBHOOK` | external intent shape | External system must enforce policy |
| `NONE` | watch/paper/signal only | No |

Backend signing remains unavailable. Backend custody remains unavailable.

## Safe Templates

Initial SDK templates:

- `fresh-pair-goblin`
- `copy-the-chad-safe`
- `rug-radar-signal`
- `paper-ape-lab`

These are deliberately modeled as signal, watch, paper, or client-signature intent templates. They are not proof that order-book scalping is profitable.

## Receipt Trail

Trade intents should bind:

- agent ID
- owner wallet
- venue
- side
- mint/market
- amount
- slippage
- risk config hash
- client-signature requirement

The point is to make degen behavior auditable, capped, and user-owned without killing the speed of agent creation.

## Hard Rules

Never add:

- backend private key custody
- backend signing
- localStorage private-key storage
- hidden fees
- auto-sweep
- fake PnL
- guaranteed-profit claims
- rug/pump manipulation language
- unlimited auto-copy
- uncapped live execution

Best product line:

```txt
Casino energy. Infrastructure discipline. Builder-first. Receipt-bound. Get paid.
```
