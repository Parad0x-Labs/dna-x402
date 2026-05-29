# Gap Analysis — What's Missing for MVP

> The monorepo has ~70% of the infrastructure.
> This doc is the 30% that doesn't exist yet.

---

## Gap 1 — External task types in `bounty-blink-jobs`

**What exists:** `JobKind` enum with 8 protocol-internal maintenance tasks
(CloseExpiredAccount, SubmitNullifier, CompactReceiptRoot, etc.)

**What's missing:** External-facing task kinds that enterprises/AI agents
will actually buy:

```rust
// Add to crates/bounty-blink-jobs/src/lib.rs

pub enum ExternalTaskKind {
    /// Proxy an HTTP request via residential IP. Payload: url_hash + headers_hash.
    /// Proof: response_hash + latency_ms + status_code.
    ResidentialRelay {
        url_commitment: [u8; 32],
        target_country: Option<[u8; 2]>, // ISO 3166-1 alpha-2
    },

    /// Query App Store / Google Play for pricing/ranking data.
    /// Proof: response_hash + store_id + timestamp.
    AppStoreSnapshot {
        app_id_commitment: [u8; 32],
        store: AppStore, // AppStore::Apple | AppStore::Google
        country: [u8; 2],
    },

    /// Generate signed proof-of-location.
    /// Proof: ZK location proof (lat/lon inside radius, not exact coords).
    LocationAttestation {
        geofence_commitment: [u8; 32], // encrypted lat/lon/radius
        min_accuracy_meters: u32,
    },

    /// Collect sensor data sample.
    /// Proof: encrypted_payload_hash + sensor_types_bitmap + duration_ms.
    SensorSample {
        sensor_types: u32, // bitmask: GPS=1, ACCEL=2, BARO=4, MIC=8
        duration_ms: u32,
        output_schema_hash: [u8; 32],
    },
}
```

**Effort:** Small. Additive change to existing enum + `create_job` / `complete_job` handlers.

---

## Gap 2 — `null-flywheel-core` TaskCompletion event path

**What exists:** `null-flywheel-core` routes 5bp of premium fees → NULL community rewards.
The event source is `PremiumFeeEvent`.

**What's missing:** A second event source: `TaskCompletionEvent` → NULL mint to host.

```rust
// Add to crates/null-flywheel-core/src/lib.rs

pub struct TaskCompletionReward {
    /// The host's public key (NOT the agent's stealth address — the phone owner).
    pub host_pubkey_hash: [u8; 32],
    /// USDC value of the completed task (in lamports equivalent).
    pub task_usdc_value: u64,
    /// NULL to mint = task_usdc_value * emission_rate_bps / 10000, at NULL/USDC spot.
    pub null_to_mint: u64,
    /// Links to the ComputeReceipt that triggered this.
    pub receipt_hash: [u8; 32],
    pub epoch: u64,
}

pub fn compute_host_yield(
    task_usdc_value: u64,
    emission_rate_bps: u16,   // e.g. 500 = 5% of task value → NULL
    null_usdc_spot: u64,       // NULL price in lamports per NULL
) -> u64 {
    let usdc_to_null = (task_usdc_value as u128 * emission_rate_bps as u128) / 10_000;
    (usdc_to_null * 1_000_000) / null_usdc_spot as u128  // convert USDC → NULL at spot
}
```

**Effort:** Medium. Requires oracle feed for NULL/USDC spot price (use `dark-oracle-feed` or
Switchboard/Pyth integration). The flywheel distribution logic already handles rate limiting
and epoch management.

---

## Gap 3 — NULL Miner client SDK (the phone app / browser extension)

**What exists:** `sleep-earn-watcher` (Rust library — scans jobs, builds execution plans).
All the underlying crates (passport, escrow, receipt, fog router) are Rust.

**What's missing:** A deployable client that runs on a phone or browser:
- **Option A:** Browser extension (TypeScript) wrapping x402 JS SDK + WASM-compiled crates
  - Pros: ships fast, works on desktop + mobile browser, same distribution as Grass
  - Cons: no access to native GPS/sensors, limited to bandwidth/app scraping tasks
- **Option B:** React Native app wrapping native Rust via FFI (expo-modules)
  - Pros: full sensor access, GPS, background execution, residential IP from phone carrier
  - Cons: slower to ship, Apple review process
- **Option C:** Progressive Web App (PWA) with Service Worker
  - Pros: cross-platform, no app store, background sync API for passive tasks
  - Cons: iOS background execution is severely limited, no GPS in background

**Recommendation for MVP:** Browser extension (Option A).
- The `packages/` folder already has TypeScript x402 infrastructure
- Grass proved browser extension DePIN works at 8.5M nodes
- Bandwidth + App Store tasks don't need native phone access
- Time to ship: 2–4 weeks vs. 3–6 months for native app

**Effort:** High (new artifact). But technically: wrap `sleep-earn-watcher` logic in TypeScript,
call DNA x402 marketplace API for task discovery, use x402 JS SDK for payment receipt submission.

---

## Gap 4 — Enterprise task poster UX

**What exists:** `bounty-blink-jobs` has `create_job()` as a Rust API.
The x402 marketplace has OpenAPI/MCP import for agent-to-agent tasks.

**What's missing:** An enterprise-facing interface:
- A simple REST API (or hosted UI) where a company can:
  1. Describe a task (URL to scrape, location to verify, etc.)
  2. Set a USDC bounty + expiry
  3. Pay via x402 to fund the escrow
  4. Receive results + ComputeReceipt as proof of delivery

**Effort:** Medium. The `site-agent/` folder has the existing agent UI infrastructure.
Add a "Post a Task" flow on top of `bounty-blink-jobs` + `dark-agent-escrow` +
x402 checkout. The hardest part is the task result delivery (how does the enterprise
*receive* the output from the agent in a privacy-preserving way — likely encrypted
to the buyer's key on IPFS/Arweave, hash anchored on-chain).

---

## Summary

| Gap | Effort | Blocks MVP? |
|---|---|---|
| External task kinds in `bounty-blink-jobs` | Small (1–2 days) | Yes — no external tasks without this |
| `null-flywheel-core` TaskCompletion path | Medium (3–5 days) | Yes — no NULL mining reward without this |
| NULL Miner client (browser extension) | High (2–4 weeks) | Yes — no node operators without this |
| Enterprise task poster UX | Medium (1–2 weeks) | No — can launch with agent-to-agent tasks first |

**Minimal viable NULL Miner** (no enterprise UX needed):
1. Add external task kinds ← 2 days
2. Add flywheel TaskCompletion path ← 5 days
3. Ship browser extension ← 3 weeks

**Demand side for MVP launch:** Route existing DNA x402 agent traffic (agents
already paying for data via x402 marketplace) through NULL Miner nodes.
No enterprise sales needed on day 1 — the agent economy is already the buyer.
