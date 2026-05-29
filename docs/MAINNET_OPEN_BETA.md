# DNA x402 — Mainnet Open Beta

## Status

**Open beta is not production. Open beta is not an audited release.**

The six NULL Miner pilot programs and the x402 payment rail may be deployed on
mainnet-beta in a capped configuration. All deployments under this track are:

- Unaudited by any third party
- Capped by daily payment volume
- Gated by `MAINNET_BETA_EVIDENCE.json` (must exist before claiming beta status)
- Subject to the `check:mainnet:beta` gate passing without blockers

## What Is Allowed Under Beta

| Activity | Allowed |
|---|---|
| Developer testing with real SOL | Yes, with caps |
| Integration partner pilots | Yes, with caps |
| Public marketing as "production" | No |
| High-value autonomous fund movement | No |
| Claiming external audit clearance | No |

## What Is Blocked Until External Audit

- Removing payment volume caps
- Claiming "production ready" or "audited"
- Deploying dark_bn254_gate or dark_shielded_pool
- Registering NULL Token-2022 hook on the live NULL token

## How to Activate Beta

1. Deploy all 6 pilot programs on mainnet-beta
2. Fill `x402/MAINNET_BETA_EVIDENCE.json` from the example file
3. Run `npm run check:mainnet:beta` — must pass with no blockers
4. Set upgrade authority to multisig before expanded public use

## Audit Funding

We are seeking audit funding to move from evidence-backed public beta to
audited mainnet production. See `GRANT_APPLICATION.md` for scope and ask.

## Risk Disclosure

This software is unaudited. Use at your own risk. The security model protects
against backend/database leaks. It does not protect against a compromised
browser or application-layer JavaScript.
