# DNA x402 Agent Builder

Status: Public Beta backend surface

DNA x402 Agent Builder turns user intent into safe, structured agent drafts. It supports prompt input, guided options, templates, and cloneable recipes.

The builder does not execute trades. It compiles configuration only.

## Core Flow

```txt
prompt / guided answers / template / clone
-> normalize intent
-> map into AgentConfigDraft
-> enforce Public Beta constraints
-> policy check
-> risk summary
-> draft preview
-> explicit user confirmation
-> confirmed agent config
```

The compiler never directly produces live executable behavior.

## Supported Inputs

- `PROMPT`
- `GUIDED`
- `TEMPLATE`
- `CLONE`

## Backend-Owned Surfaces

- `POST /v1/agent-builder/draft`
- `GET /v1/agent-builder/drafts/:draftId`
- `POST /v1/agent-builder/drafts/:draftId/confirm`
- `POST /v1/agent-builder/drafts/:draftId/reject`
- `GET /v1/agent-builder/templates`
- `GET /v1/agent-builder/guided-tree`
- `POST /v1/agent-builder/recipes`
- `GET /v1/agent-builder/recipes/:recipeId`
- `POST /v1/agent-builder/recipes/:recipeId/clone`
- `GET /v1/agent-builder/recipes/public`

## Safety Rules

The builder rejects prompts or configs that request:

- backend private key custody
- backend signing
- hidden fees
- DNA fee bypass
- emergency pause bypass
- unlimited auto-copy
- unrestricted live Polymarket betting
- unrestricted autonomous Solana token trading
- physical goods
- high-risk categories
- success fees on losses or unrealized PnL

Safe alternative wording returned by rejected drafts:

```txt
Use paper mode, signal mode, or user-confirmed live mode with caps.
```

## Example Prompt

```txt
Create a Polymarket copy agent that follows BTC 5m markets, only copies entries between 40c and 60c, max $5 per bet, stops after $25 daily loss, copies buys only, and charges followers 2% of profit.
```

Expected compiled config properties:

- agent type: `POLYMARKET_COPY_AGENT`
- mode: `AUTO_COPY_PUBLIC_BETA`
- venue: `POLYMARKET`
- market filters: `BTC`, `5m`
- entry range: `4000` to `6000` bps
- max bet: `5000000`
- daily loss cap: `25000000`
- alpha fee: `200` bps
- backend custody: `false`
- backend signing: `false`

## Confirmation

Draft confirmation requires:

- matching owner wallet
- accepted risk summary
- all required confirmation strings
- draft status not rejected
- policy still passing

The website must show the risk summary and require acknowledgement before calling confirm.

## Persistence

Agent Builder records are durable in Postgres:

- `agent_builder_drafts`
- `agent_recipes`
- `agent_builder_events`

Backup/restore verifies drafts, recipes, cloneability, and builder events survive.

## Status Language

DNA x402 supports Prompt-to-Agent and Guided Agent Builder in Public Beta. Users can create safe agent drafts from prompts, templates, guided flows, or cloned recipes. Every generated config is compiled into an allowed schema, policy-checked, previewed with risk limits and fees, and confirmed by the user before activation. Backend custody, backend signing, hidden fees, and unrestricted autonomous live trading remain outside beta scope.

