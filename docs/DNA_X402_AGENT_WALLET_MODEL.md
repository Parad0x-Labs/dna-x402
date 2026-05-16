# DNA x402 Agent Wallet Model

Status: Public Beta architecture. Public unattended live trading is not in beta scope yet.

## Custody Model

DNA x402 supports user-owned agent wallets without backend custody.

- The owner wallet is the user's main identity wallet.
- The agent wallet is generated client-side or provided by an external wallet.
- The backend stores only public address metadata.
- The backend never receives private keys, seed phrases, keypairs, wallet dumps, or decrypted signer material.
- Backend signing routes are forbidden.

## Supported Key Storage Modes

- `LOCAL_ENCRYPTED`: encrypted in the user's client environment
- `USER_EXPORTED`: user explicitly exported the key after warning
- `SESSION_ONLY`: temporary client-side session key
- `EXTERNAL_WALLET`: signer remains in a wallet app or extension

## Export Warning

When a user exports an agent wallet private key, the UI must show:

```txt
This is your agent wallet private key.

DNA x402 cannot recover it.
Anyone with this key can move your funds.
Save it somewhere safe.
Do not share it.
DNA x402 never stores this key.
```

Required checkbox:

```txt
I understand DNA x402 cannot recover this key.
```

## API Guardrail

`POST /v1/agents/:agentId/wallets/register` accepts only public key metadata.

Private-key-shaped fields are rejected recursively with `PRIVATE_KEY_FORBIDDEN`.

## Live Modes

Allowed now:

- `PAPER`
- `SIGNAL_ONLY`
- `USER_CONFIRMED_LIVE`
- `AUTO_COPY_PUBLIC_BETA` only as a gated Public Beta decision mode

Never allowed:

- backend signing
- backend custody

Not in beta scope yet:

- public unattended autonomous live trading
- unlimited auto-copy
- public Polymarket live movement

## Postgres Durability

Agent wallet public metadata is now wired to the modular Postgres repository path through `agent_wallets`.

Related audit/action records use `agent_action_ledgers`.

Durable records contain:

- stable ID
- version
- JSON payload
- actor ID
- created timestamp
- updated timestamp

Private key material remains forbidden before persistence. A rejected payload is not written to Postgres.
