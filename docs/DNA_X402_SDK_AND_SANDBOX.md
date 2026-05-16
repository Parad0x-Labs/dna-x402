# DNA x402 SDK And Sandbox

Date: 2026-05-15

## Purpose

Sellers and buyers need a deterministic no-funds environment before integrating live commerce.

## Sandbox Requirements

- fake verifier
- deterministic fake transaction IDs
- hosted test sellers
- hosted test buyers
- sample paid API
- sample data feed
- sample compute job
- sample auction
- proof-chain dashboard

## SDK Requirements

TypeScript first:

- search listings
- request quote
- commit quote
- finalize payment proof through an adapter
- retry paid endpoint
- verify receipt
- stream top-up
- subscribe to webhooks
- publish seller listing
- handle seller fulfillment callbacks

Python follows after TypeScript. Rust follows after the existing Rust agent proof is cleaned into a production package.

## Current Status

The sandbox-safe mayhem runner exists as `npm run mayhem:x402`. It attacks local service logic without live money movement.
