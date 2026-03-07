# DNA x402

`dna-x402` is Parad0x Labs' payment rail for agent-to-agent and API commerce on Solana.

This repository's active product is the `x402/` package: quote, payment verification, receipts, anchoring, analytics, marketplace intelligence, and seller tooling for machine-speed payments. The published npm package is `dna-x402`, and the git remote for this repo is `Parad0x-Labs/dna-x402`.

## What This Repo Is

- Fast x402 payment infrastructure for agents and APIs
- Solana settlement via netting, SPL transfers, and stream-style access flows
- Signed receipts plus `receipt_anchor` on-chain anchoring
- Agent-facing seller SDK, buyer SDK, diagnostics, analytics, and audit tooling

## What This Repo Is Not

- Not a mixer repo
- Not a privacy-pool product landing page
- Not a zk-SNARK hot-path payment system

The live x402 payment path in this repo does not use zk proofs. It is optimized for low-latency agent payments.

## Product Boundary

Parad0x Labs has two separate lanes:

1. `DNA x402`
   Fast payment rail for agent commerce. This is the active product in this repo.

2. `Dark Null Protocol`
   Separate privacy research/product line for private settlement and zk-based flows. That work belongs in its own repo and is not the live `dna-x402` payment path.

If you are looking for the privacy protocol, treat it as a separate project. Do not read this repo as a privacy-pool or mixer product.

## Start Here

- Product docs: `x402/README.md`
- Agent quick reference: `x402/AGENTS.md`
- Proof and audit docs: `docs/`
- Front-end entry points: `site/` and `site-agent/`

## Repo Layout

- `x402/`
  Canonical product package and server for DNA x402
- `programs/receipt_anchor/`
  Solana program that anchors payment receipts
- `site/`
  Public proof/docs front door
- `site-agent/`
  `/agent` onboarding and control-room UI
- `docs/`
  Deploy, proof, programmability, and security docs

Some older top-level files and directories in this workspace come from prior privacy-protocol experiments. They are not the canonical DNA x402 package surface.

## Current Status

- `dna-x402@1.0.0` package metadata is present under `x402/package.json`
- Mainnet reports and stress artifacts are checked in under `x402/test-mainnet/`
- Current audit/sim/gauntlet tooling lives under `x402/scripts/`

For the actual product entry point, open `x402/README.md`.
