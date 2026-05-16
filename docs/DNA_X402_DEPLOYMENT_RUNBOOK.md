# DNA x402 Deployment Runbook

Date: 2026-05-15

## Required Before Public Production

- `.env.example` is current.
- Boot config validates required and optional env vars.
- Health checks cover server, verifier, chain RPC, queues, webhooks, and storage.
- Structured logs are enabled.
- Admin actions write audit events.
- Emergency pause blocks new quotes and finalizes.
- Existing receipts remain readable during pause.
- Backup script exists.
- Restore script exists.
- Backup/restore test passes.
- Incident runbook is published.

## Gated Areas

- production money movement
- unattended signing
- public netting
- public physical goods
- high-risk categories
- Polymarket live money movement

## Current State

The modular service layer is testable locally. Deployment hardening still needs full environment validation, backup/restore scripts, and monitoring dashboards.
