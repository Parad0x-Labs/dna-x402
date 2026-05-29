# null-miner-sdk

> **Your app's users earn USDC while they sleep. You collect fees. We take tx dust.**
>
> First autonomous dark-agent payment rail on Solana. Built on DNA x402 + Dark NULL.

---

## What this is

`null-miner-sdk` is pure payment infrastructure. Drop it into **any app** — Lovable projects, social platforms, AI builders, script-based sites — and your users' devices automatically perform micro-tasks for the network, earning USDC. You earn platform fees on every tx. We earn a tiny protocol cut.

**No app to build. No UI to design. One npm install.**

---

## Never done on Solana before

| What | Why it's new |
|------|-------------|
| **Reverse x402 escrow** | Agents *pull* tasks from a dark pool. USDC auto-releases on proof hash. No centralized clearinghouse. ZK Groth16 Phase 2. |
| **Dark Agent Passport** | Each agent has a stealth identity derived from device entropy. Reputation 0–1000. No wallet address ever exposed. SHA-256 commitment now, Groth16 Phase 2. |
| **Unified USDC + NULL yield** | Host earns USDC for work completed *and* NULL tokens from the protocol flywheel — two revenue streams, one SDK. |
| **Platform-agnostic** | Next.js middleware → REST gate → OpenClaw plugin → browser extension — same SDK, any stack. |
| **Residential IP + real proof** | Agents do verifiable real tasks: bandwidth relay, app store data, location attestation. Not fake PoW. |

Compare: Grass (bandwidth only, centralized), io.net (GPUs only, KYC), Helium (hardware required). We work on every phone and laptop already deployed.

---

## Install

```bash
npm install null-miner-sdk
```

---

## 3-line quickstart

```typescript
import { NullMiner } from "null-miner-sdk";

const miner = new NullMiner({
  rpcUrl:     "https://api.devnet.solana.com",   // swap for mainnet when live
  hostWallet: wallet,                             // any Solana wallet adapter
  platformId: "your-platform-id",                // for fee attribution
});

await miner.start();
// agent scans tasks → claims best → executes → earns → repeat every 30s
```

That's it. Users earn automatically. You collect fees. Shut it down anytime:

```typescript
miner.stop();
const stats = miner.getStats();
// { usdcEarned: 0.14, nullEarned: 0.0072, tasksCompleted: 28, tier: "silver" }
```

---

## Framework adapters

### Next.js (App Router)

Gate any API route behind a USDC micropayment:

```typescript
// app/api/ai-query/route.ts
import { nullMinerMiddleware } from "null-miner-sdk/nextjs";

export const GET = nullMinerMiddleware({ priceUsdc: 0.005 }, async (req) => {
  return Response.json({ result: await runAIQuery(req) });
});
```

Returns HTTP 402 with x402 payment requirements if unpaid. Auto-verifies payment receipt. Anchors on Solana.

### Express / Node.js

```typescript
import { nullMinerGate } from "null-miner-sdk/express";

app.get("/premium-data", nullMinerGate({
  priceUsdc: 0.001,
  platformWallet: process.env.PLATFORM_WALLET!,
  platformFeePct: 0.10,  // 10% to you, rest to task executor
}), (req, res) => {
  res.json({ data: "premium" });
});
```

### OpenClaw (Momo-compatible)

```typescript
import { nullMinerPlugin } from "null-miner-sdk/openclaw";

const plugin = nullMinerPlugin({
  rpcUrl:     process.env.SOLANA_RPC!,
  hostWallet: agentWallet,
  platformId: "my-app",
});

// plugin.tools: null_miner_stats, null_miner_pause, null_miner_resume, null_miner_passport
```

### Browser / Chrome Extension

```typescript
import { createBrowserMiner } from "null-miner-sdk/browser";

// Works in service workers, web pages, React apps — no Node.js required
const miner = await createBrowserMiner({
  rpcUrl:     "https://api.devnet.solana.com",
  platformId: "my-webapp",
  // hostWallet auto-derived from device entropy + stored in localStorage
});

await miner.start();
```

---

## Revenue model

```
Task completes: $0.005 USDC
├── Agent host:    $0.0045  (90%) — user's device did the work
├── Platform:      $0.0005  (10%) — you, for integrating the SDK
└── Protocol fee:  ~0.0001  (2bp) — DNA x402 tx dust
         + NULL emission: 5% of task value → NULL flywheel → distributed to hosts
```

**As a platform:** You set `platformFeePct` (default 10%). Every task your users complete pays you. 100 active users × 60 tasks/hour = 6,000 tasks/hr × $0.0005 = **$3/hr per 100 users, zero marginal cost.**

---

## Task kinds

| Kind | What happens | Pays |
|------|-------------|------|
| `residential_relay` | Proxy HTTP request via host's IP | $0.003–$0.01 |
| `app_store_snapshot` | Query App Store / Play Store rankings | $0.001–$0.003 |
| `location_attestation` | ZK proof-of-location (no exact coords) | $0.002–$0.005 |
| `sensor_sample` | Collect accelerometer/barometer data | $0.0005–$0.002 |
| `protocol_maintenance` | Close expired accounts, compact roots | $0.0001–$0.001 |

Allow or restrict task kinds per platform:

```typescript
const miner = new NullMiner({
  allowedTasks: ["residential_relay", "app_store_snapshot"], // your choice
  minRewardUsdc: 0.003, // don't bother with tiny tasks
  maxTasksPerHour: 30,  // rate limit per user
  // ...
});
```

---

## Custom task executors

Register your own task types:

```typescript
import { TaskRegistry, TaskKind } from "null-miner-sdk";

const registry = new TaskRegistry();
registry.register("my_custom_task" as TaskKind, {
  async execute(task) {
    const result = await doYourWork(task.encryptedPayload);
    return sha256(result); // return proof hash
  }
});
```

---

## Agent Passport (ZK identity)

Each agent has a deterministic stealth identity derived from device entropy. No wallet address is ever exposed to the task marketplace.

```typescript
import { AgentPassport } from "null-miner-sdk";

const passport = new AgentPassport({ spendKey: "your-32-byte-hex-key" });

console.log(passport.passportId);      // deterministic, anonymous
console.log(passport.reputationScore); // 0–1000
console.log(passport.tier);            // bronze | silver | gold | elite

// Derive one-time stealth address for each task (privacy)
const stealth = passport.deriveStealthAddress(taskId);

// Attest reputation (ZK stub now → Groth16 Phase 2)
const attestation = passport.attest(passport.reputationScore);
```

Higher reputation → access to higher-paying task tiers:
- **Bronze** (0–199): basic tasks, public pool
- **Silver** (200–499): app store + relay tasks
- **Gold** (500–799): all task kinds, priority queue
- **Elite** (800–1000): enterprise dark pool, max rewards

---

## Architecture

```
╔═══════════════════════════════════════════════════════════════╗
║                    YOUR APP (any stack)                       ║
║                                                               ║
║  npm install null-miner-sdk                                   ║
║  ┌──────────────────────────────────────────────────────────┐ ║
║  │  NullMiner.start()                                       │ ║
║  │     ↓ AgentLoop (30s poll)                               │ ║
║  │     ↓ fetchAvailableTasks() → task marketplace API       │ ║
║  │     ↓ selectBestTask() → score by reward                 │ ║
║  │     ↓ claimTask() → dark-agent-escrow (Solana)           │ ║
║  │     ↓ executeTask() → TaskRegistry executor              │ ║
║  │     ↓ submitProof() → hash verify → USDC auto-release     │ ║
║  │     ↓ onEarn(result) → your callback                     │ ║
║  └──────────────────────────────────────────────────────────┘ ║
║                                                               ║
╠═══════════════════════════════════════════════════════════════╣
║                    DNA x402 RAILS (Solana)                    ║
║                                                               ║
║  dark-agent-escrow  →  null-miner-tasks  →  null-flywheel    ║
║  (pull-based claim)    (proof verify)       (NULL emission)   ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## Devnet testing

```bash
git clone https://github.com/Parad0x-Labs/dna-x402
cd packages/null-miner-sdk
npm install
npm test         # 44 unit tests
npm run test:devnet  # live devnet integration (requires SOL)
```

The SDK falls back to mock tasks when the task marketplace API is unreachable — your devnet tests always work offline.

---

## Production status

| Component | Status |
|-----------|--------|
| Core SDK | ✅ Devnet |
| Next.js adapter | ✅ Devnet |
| Express adapter | ✅ Devnet |
| OpenClaw adapter | ✅ Devnet |
| Browser adapter | ✅ Devnet |
| Task marketplace API | ✅ Devnet |
| Browser extension | ✅ Devnet |
| Dark-agent-escrow (Solana program) | 🔶 Devnet (ZK stub) |
| Groth16 ZK proofs | ❌ Phase 2 |
| Mainnet deploy | ❌ Pending deployment gates |

**`IS_MAINNET_READY = false`** — Devnet works fully. Mainnet opens after deploy funding, final config, and smoke evidence.

---

## Stack

- **DNA x402** — Solana HTTP 402 micropayment standard. Quote→Pay→Verify→Anchor.
- **Dark NULL** — Hash-commitment privacy layer. Stealth addresses, nullifier banks, compressed receipts. Poseidon/Groth16 Phase 2.
- **null-flywheel-core** — 5bp of every task → NULL token yield to host.
- **dark-agent-escrow** — Condition-hash escrow. Agent submits proof hash → USDC auto-releases. ZK Groth16 Phase 2.
- **Agent Passport** — SHA-256 commitment identity derived from spend key. Reputation 0–1000. Groth16 Phase 2.

---

## License

MIT — Parad0x Labs
