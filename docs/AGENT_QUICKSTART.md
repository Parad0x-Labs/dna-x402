# Agent Quickstart

Status: Public Beta.

Buyer agents use DNA x402 to discover listings, request quotes, commit, submit payment proof, verify the receipt, and retry the paid endpoint.

## Install

```bash
npm install dna-x402
```

Local repo development:

```bash
npm install ../../x402
```

## Basic Buyer Loop

```ts
const baseUrl = process.env.X402_STAGING_API_URL ?? "http://127.0.0.1:4021";

const quote = await fetch(`${baseUrl}/quote?resource=/resource&amountAtomic=100000`).then((r) => r.json());

const commit = await fetch(`${baseUrl}/commit`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    quoteId: quote.quoteId,
    payerCommitment32B: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  })
}).then((r) => r.json());

// In Public Beta, the wallet signs/sends manually.
// Submit a real or sandbox payment proof only after the user signs.
```

## Agent Budget Rules

Agents should enforce:

- max spend per call
- max spend per day
- allowed sellers
- blocked capabilities
- human approval threshold

## Example

```bash
cd examples/buyer-agent-ts
npm install
npm run dev
npm test
```

## Agent Wallet And Copy Preview

Public Beta agents can register client-side generated wallets by public key only:

```ts
await fetch(`${baseUrl}/v1/agents/my-agent/wallets/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ownerWallet: "mother-wallet-public-key",
    publicKey: "agent-wallet-public-key",
    chain: "SOLANA",
    keyStorage: "LOCAL_ENCRYPTED"
  })
});
```

Never send private keys, seed phrases, keypairs, or wallet dumps to the backend.

Copy settings are follower-controlled. A follower can copy buys, sells, exits, filter entry price ranges, set custom TP/SL, and require approval above a threshold. The backend evaluates copy decisions and records copied lots; it does not sign trades.

Alpha monetization is accrual/display only unless a direct split gate is explicitly approved. Alpha fees apply only to positive finalized copied-lot profit.

## Prompt-To-Agent Builder

Public Beta builders can create agent drafts through the backend compiler:

```ts
await fetch(`${baseUrl}/v1/agent-builder/draft`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    inputMode: "PROMPT",
    ownerWallet: "mother-wallet-public-key",
    prompt: "Create a Polymarket copy agent that follows BTC 5m markets, only copies entries between 40c and 60c, max $5 per bet, stops after $25 daily loss, max open exposure $100, copies buys only, and charges followers 2% of profit."
  })
});
```

The response is a draft plus risk summary. The user must accept the risk summary before confirmation:

```ts
await fetch(`${baseUrl}/v1/agent-builder/drafts/${draftId}/confirm`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ownerWallet: "mother-wallet-public-key",
    acceptedRiskSummary: true,
    confirmations: riskSummary.requiredConfirmations
  })
});
```

The compiler rejects prompts that ask for backend custody, backend signing, hidden fees, unlimited live movement, physical/high-risk categories, or alpha fees on losses.
