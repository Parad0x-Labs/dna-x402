# Competitive Proof — What Doesn't Exist Yet

> Research conducted: 2026-05-28  
> Sources: live project docs, on-chain data, funding announcements

---

## The 4 angles checked — and what was found

### 1. Phone hosting an autonomous AI agent (agent earns, human host earns tokens)

**Closest existing projects:**

| Project | What they do | Why it's different |
|---|---|---|
| Olas / Autonolas | Run autonomous agents via "Pearl" desktop app | Desktop/server only — not phone-native DePIN; no residential IP moat; no host-yield token for uptime |
| Fetch.ai Agentverse | 2.7M registered agents, wallets, USDC/FET payments (launched May 2026) | Cloud-hosted agents, not user-device-hosted; no ZK identity; no privacy layer; centralized payout |
| AgenC (Solana mainnet, 2026) | Agents claim tasks from escrow, generate ZK proofs | No phone-native UX, no host-yield token, all task content and agent IDs are public, no dark pool |
| Bittensor subnets | Miners run inference, validators score work, TAO emissions | Server-grade hardware required, not phone-native, public identity, centralized subnet registration |

**The gap:** "Your phone hosts an AI agent with ZK identity that autonomously earns USDC in an anonymous task market and pays you tokens for hosting it" does not exist as a product. AgenC has the mechanics (pull-based escrow + ZK proof release) but none of the privacy, none of the phone-native host incentive, and none of the ZK identity.

---

### 2. Enterprise dark pool for sensitive AI tasks (ZK-encrypted, mutual anonymity, auto-release escrow)

**Closest existing projects:**

| Project | What they do | Why it's different |
|---|---|---|
| Phala Network | TEE + ZK confidential compute, 1000+ dev teams | Infrastructure layer only — no task marketplace, no USDC escrow, no mutual anonymity between buyer and seller, no x402 integration |
| Secret Network | Encrypted smart contract state | Contract platform, not a marketplace; no task posting/claiming UX |
| Linum Labs | ZK dark pools for DeFi | Finance-focused (token swaps), not AI task execution |
| Marlin Protocol | Confidential compute for AI | Compute layer, not marketplace; no two-sided anonymity |

**The gap:** An enterprise-facing UI where a company posts a task with USDC bounty, the task content is ZK-encrypted to the assigned node, the node submits a ZK proof of completion, escrow auto-releases, and *neither side knows who the other is* — this has never been shipped.

The infrastructure to build it (Phala for TEE, Groth16 for ZK, x402 for payment) all exists. The assembled product does not.

---

### 3. ZK proof-of-human-attention sold to advertisers via micropayment rail

**Closest existing projects:**

| Project | What they do | Why it's different |
|---|---|---|
| Brave + BAT | Privacy Pass tokens for ad engagement, BAT rewards | No ZK proof of sustained attention, no biometric verification, no per-second USDC rail — just opt-in ad watching |
| Brave Boomerang | R&D: Bulletproof proofs for ad eligibility | Still R&D as of 2026, proves eligibility not actual attention, no biometrics, no micropayment per second |
| AdPriva | Cryptographic engagement proofs | No biometrics, no per-second metering, no on-chain USDC settlement |
| Nodle | Phones as connectivity sensors, NODL token | Network infrastructure, not attention proof; no ZK |

**The gap:** Phone generates a ZK proof that a verified human (biometric confirmation — face/touch/eye) engaged with content for exactly N seconds → advertiser pays $0.001/second via x402 USDC → phone earns NULL. No tracking. Cryptographic proof only. This does not exist end-to-end.

Market context: Global digital advertising is $700B/year. Estimated $35–50B is click/view fraud. If you can offer *cryptographically verified* human attention at even 50% of current CPM rates, the buyer demand is massive.

---

### 4. Reverse x402 bounty escrow (pull-based — node claims, ZK proof triggers release)

**Closest existing projects:**

| Project | What they do | Why it's different |
|---|---|---|
| AgenC (Solana, mainnet 2026) | Task poster funds escrow in SOL/SPL; agent claims; ZK proof triggers on-chain release | **Most direct match.** But: all public (no dark pool), no ZK privacy on task content, agent identities exposed, no host-yield token, no phone-native client |
| SAEP (Solana Agent Economy Protocol) | Building similar pull-based task market | Still building as of May 2026; same limitations as AgenC on privacy |
| Grass | Passive bandwidth task market | Push-based (Grass server assigns tasks to client), centralized, no escrow, no ZK |

**The gap:** The pull-based escrow mechanic exists (AgenC). The gap is: ZK-encrypted task content + stealth address payout + ZK proof of completion + host-yield token for uptime. AgenC does the base mechanic; DNA x402 can do the base mechanic *plus everything on top*.

---

## Summary verdict

| Angle | Status | Closest competitor | DNA x402 unique advantage |
|---|---|---|---|
| Phone as sovereign agent host | **Unbuilt as product** | Olas (desktop only, no ZK, no host yield) | ZK Passport + stealth addresses + phone-native x402 |
| Enterprise dark pool for AI tasks | **Unbuilt as marketplace** | Phala (infra layer, no UX) | dark-agent-escrow + dark-pool-sdk + x402 USDC |
| ZK proof-of-attention | **Unbuilt end-to-end** | Brave Boomerang (R&D, no biometrics) | Groth16 verifier + x402 per-second micropayment |
| Reverse x402 escrow | **Mechanic exists (AgenC)** | AgenC (public, no privacy) | Dark pool layer on top of AgenC-style escrow |

**Build order recommendation:**
1. Angle 4 first (bounty escrow — mechanic proven, add privacy layer, mostly built in monorepo)
2. Angle 1 next (phone agent host — most novel, biggest user distribution surface)
3. Angle 2 as enterprise layer on top (same infra, different UX + sales motion)
4. Angle 3 last (requires biometric ZK which is hardest to build correctly)
