# NULL Miner — Full Concept Spec

## The One-Line Pitch

> Your phone hosts an autonomous AI agent that earns USDC doing real tasks in a dark pool —
> you earn NULL tokens just for keeping it running.

---

## Problem it solves

DePIN networks have proven $50M–$500M+ ARR is achievable (Grass, io.net, Hivemapper).
But every single one has the same architectural flaw: **centralized revenue clearinghouse**.

- Grass collects fiat from AI data buyers → converts → pays GRASS weekly
- io.net collects from GPU renters → converts → pays IO monthly
- Helium collects carrier fees → converts → pays HNT per epoch

This creates: single point of failure, regulatory exposure, conversion friction,
delayed payouts, and no privacy for either task buyer or task performer.

**DNA x402 has the infrastructure to eliminate every one of these.**

---

## How NULL Miner works (user perspective)

1. User installs **NULL Miner** app (mobile or browser extension)
2. App initializes a **Dark Agent** with a fresh `DarkAgentPassport` — ZK identity,
   stealth address, reputation starts at 0
3. Agent autonomously scans the task market (pull-based — agent *claims* tasks,
   tasks don't get pushed to agent)
4. Agent completes a task, submits a `ComputeReceipt` as proof of work
5. `dark-agent-escrow` verifies the proof hash and releases USDC to the agent's
   stealth wallet — *real-time, per-task, no batch*
6. A portion of that USDC triggers the `null-flywheel-core` → NULL tokens minted
   to the phone host as "mining yield"
7. Agent reputation increments on the Passport — higher reputation = higher-value tasks

**The human does nothing after install.** The agent earns. The human collects NULL.

---

## How it works (protocol perspective)

```
Enterprise / AI Agent (task buyer)
        │
        │  POST /task  (x402 gated — pays USDC upfront)
        ▼
┌──────────────────────────────┐
│  Task Dark Pool              │  ← bounty-blink-jobs + dark-agent-escrow
│  (task content ZK-encrypted) │    USDC locked in escrow on-chain
│  (buyer identity hidden)     │
└──────────────────────────────┘
        │
        │  agent claims task (pull-based)
        ▼
┌──────────────────────────────┐
│  Dark Agent (on user phone)  │  ← dark-agent-passport (identity)
│  Passport: reputation 0–1000 │    sleep-earn-watcher (autonomous scanner)
│  Stealth address per task    │    dark-agent-payment-sdk (receive USDC)
└──────────────────────────────┘
        │
        │  completes task, submits proof
        ▼
┌──────────────────────────────┐
│  dark-compute-receipt        │  ← verifiable proof of completion
│  + dark-nullifier-banks      │    double-claim prevention (256-shard)
│  + dark-compressed-receipts  │    on-chain anchoring
└──────────────────────────────┘
        │
        │  condition verified → escrow releases
        ▼
┌──────────────────────────────┐
│  Agent stealth wallet        │  ← USDC arrives via x402 transfer
│  + null-flywheel-core        │    5% → NULL Flywheel → minted to host
└──────────────────────────────┘
```

---

## What tasks can agents do? (ranked by proven revenue)

### Tier 1 — Proven market, structural phone advantage

**Residential bandwidth relay**
- Phones have residential IPs (unblockable by target sites)
- AI companies pay $3–8/GB for residential proxies to scrape the web
- Grass proved this is $50M+ ARR
- Task type: `relay_request(url, headers) → response_bytes`
- Proof: response hash + timing proof

**iOS/Android ecosystem access**
- Real device + real account = App Store scraping, in-app flow verification, push testing
- Datacenter IPs are blocked; phones with accounts are not
- App analytics firms (Sensor Tower, data.ai) buy this at scale
- Task type: `app_store_lookup(app_id, country) → price_data`
- Proof: screenshot hash + timestamp

### Tier 2 — Structural phone advantage, market forming

**Physical location proof**
- GPS + cell tower triangulation = unfakeable proof-of-location
- Foot traffic analytics, geofenced oracle triggers, retail presence verification
- Task type: `location_proof(lat, lon, radius) → signed_attestation`
- Proof: GPS reading + cell tower reading + ZK location proof

**Sensor data streams**
- Accelerometer + barometer + microphone → road quality, noise mapping, weather micro-sensing
- IBM/weather companies have historically paid for this; market is forming on-chain
- Task type: `sensor_sample(types[], duration_sec) → encrypted_payload`

### Tier 3 — Speculative but architecturally sound

**Passive NPU compute**
- iPhone 15 Neural Engine: 35 TOPS, mostly idle at night on charger
- Batch AI labeling, embedding generation, small model fine-tuning
- Task type: `run_inference(model_hash, input_commitment) → output_commitment`
- Currently too slow for real-time inference (Phi-3 mini ~2 tok/s on phone)
- Target: 2027+ as models compress

---

## Who are the users?

**Node operators (phone hosts)**
- Crypto-native early adopters who know what DePIN is
- Anyone who wants passive income from their phone
- Privacy-maximalists who like that the agent identity is ZK

**Task buyers**
- AI companies that need web data (Grass's entire customer base)
- App analytics firms
- Market research companies
- Other AI agents that need real-world data (x402 agent-to-agent payments)

**The DNA x402 agent economy is already the demand side.**
An AI agent using the DNA x402 marketplace to scrape data
can be routed directly to NULL Miner nodes as the supply side.

---

## Why now

x402 launched May 2025. Solana: 400ms finality, $0.00025/tx — micropayments
as small as $0.001 are viable. No DePIN project has deployed x402 as primary
settlement yet. The infrastructure window is open. Grass has proven the market
exists. The architecture to do it better is ready.
