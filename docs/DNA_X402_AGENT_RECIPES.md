# DNA x402 Agent Recipes

Status: Public Beta backend surface

Agent recipes are reusable, cloneable agent configurations with attached risk summaries.

They let users start from:

- built-in templates
- public recipes
- cloneable alpha profiles
- previously generated prompt/guided drafts

## Recipe Model

Each recipe stores:

- `recipeId`
- source: `PROMPT`, `GUIDED`, `TEMPLATE`, or `CLONE`
- title
- description
- optional original prompt
- safe `AgentConfigDraft`
- risk summary
- visibility: `PRIVATE`, `PUBLIC`, or `CLONEABLE`
- version
- created timestamp

## Clone Rules

Cloning a recipe:

- creates a new draft
- assigns the new owner wallet
- preserves safe risk limits
- preserves fee visibility
- preserves backend custody/signing false
- requires confirmation before activation

Private recipes cannot be cloned through the public clone endpoint.

## Built-In Templates

Current backend templates:

- `btc-40-60-copy-agent`
- `paper-polymarket-scout`
- `solana-token-signal-watcher`
- `low-risk-data-feed-seller`
- `paid-api-agent`
- `alpha-profile-agent`
- `conservative-copy-agent`
- `degen-paper-strategy-lab`

## API

- `GET /v1/agent-builder/templates`
- `POST /v1/agent-builder/recipes`
- `GET /v1/agent-builder/recipes/:recipeId`
- `POST /v1/agent-builder/recipes/:recipeId/clone`
- `GET /v1/agent-builder/recipes/public`

## Non-Claims

Recipes are not permission to run unrestricted live trading.

Recipes do not enable:

- backend signing
- backend custody
- hidden fees
- unlimited auto-copy
- public unattended Polymarket live betting
- unrestricted Solana autonomous token trading

