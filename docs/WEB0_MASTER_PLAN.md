# Web0 — Master Plan

> _Last updated: 2026-06-04 (full session). Prior draft compiled from memory files;
> this version reflects all work completed through today including mainnet deploy,
> Arweave upload, extension wiring, and ClawHub skills._

---

## 1. What Web0 is

**"Ready Player One for agents and humans."** A parallel, censorship-resistant
internet where no single party can pull the plug:

- **Sites live on Arweave** — no server to seize, no ICANN to pressure.
- **`.null` domains are Solana PDAs** — no registrar to shut down.
- **Payments are x402** — no bank to freeze.
- **Agents carry Dark Passports** — cryptographic identity, not a login.
- **Local LLMs plug into a "neural mesh" (NULLA)** and collaborate on big tasks.
- **People earn credits** for completing tasks → spend them or sell them as
  proof of work.
- **Resource sharing** — rent CPU / GPU / Apple Silicon to the mesh, earn NULL.
- **Agent "visa"** = Dark Passport + x402 endpoint + (future) fiat off-ramp.

> The only way to take it down is to take down **Solana AND Arweave
> simultaneously**. That's the thesis.

---

## 2. The `.null` layer — identity & discovery

A `.null` domain is **not** a wallet address or base58 string. It's a
human-readable name that resolves to the whole stack:

```
agent47.null
  → Dark Passport      (who is this agent?)
  → x402 endpoint      (how do I pay them?)
  → NULLA mesh         (what can they do?)
  → receipt-dag        (proof-of-work history)
  → NULL credits       (what they've earned)
```

**Anyone can build on `.null`:**

| Name | What it is |
|---|---|
| `shop.null` | e-commerce, x402 payments |
| `news.null` | blog/media, censorship-resistant |
| `agent47.null` | AI agent endpoint, earns per call |
| `game.null` | on-chain game |
| `api.null` | x402-gated API |
| `stream.null` | NullLive attested content |

**Updatable:** the Arweave content hash lives in the Solana PDA and is mutable by
the owner — update your site anytime, it's not a one-time snapshot.

---

## 3. Architecture — the full stack

```
┌───────────────────────────────────────────────────────────────┐
│  DISCOVERY / IDENTITY      .null domain (Solana PDA)            │
├───────────────────────────────────────────────────────────────┤
│  CONTENT                   Arweave (permanent, mutable pointer) │
│  IDENTITY                  Dark Passport (ZK reputation proof)  │
│  PAYMENTS                  x402 on Solana (USDC, per-call)      │
│  WORK / COMPUTE            NULLA mesh (local LLMs + GPU rental) │
│  PROOF                     receipt-dag (x402 receipts = PoW)    │
│  REWARD                    NULL token + task credits            │
└───────────────────────────────────────────────────────────────┘
```

Each layer is independently useful; `.null` is the connective tissue that makes
them addressable as one thing.

---

## 4. What's built — full inventory (as of 2026-06-04)

### 4a. Core Web0 components (original 6-agent workflow, 2026-06-03)

| Component | Repo | Commit | Status |
|---|---|---|---|
| `null_registrar` Solana program | dna-x402 | 04dc319c | ✅ deployed devnet + **mainnet** |
| `extensions/null-resolver/` Chrome extension | dna-x402 | 42be99c9 | ✅ wired to mainnet, zipped for Web Store |
| `@parad0x_labs/null-marketplace` | dna-x402 | e9b33fd2 | ✅ task posting + bidding + proof-anchored |
| `core/mesh/task_router.py` | nulla-local | bb2f398 | ✅ local LLMs bid on tasks |
| `core/credits/proof_of_work.py` | nulla-local | bb2f398 | ✅ WorkProof minted per task, tradeable (3-layer anti-cheat) |
| `core/compute/rental_market.py` | nulla-local | bb2f398 | ✅ CPU/GPU/Apple Silicon rental for NULL |

### 4b. null_registrar — deployed addresses (v1, reconciled 2026-06-06)

| Network | Program ID | Config PDA | parad0x.null PDA |
|---|---|---|---|
| **Mainnet** | `H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm` | `BQTxsYxocM2ZC3Wb2pVdnyzTPduBcNhKojhBenR6AXYG` | `DRDHB6HfXuBWW3gQKd3BJpxw86jb2WJL7mYmfMJazS45` |
| **Devnet** | `GQPitYUne8e5PwoAbGt1jZMdf3mA6cmeJLndtnPoitJh` | `2hosEo8Zb4LMsy3ComEvZLJKBGnp75BrSCF89QeVDnsx` | `8Rrt5EbR2dc6yXg2mpoPtuA85soBJSV2A4WYXbPNXwp5` |

Deployer / upgrade authority: `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY` (verified on-chain). All four PDAs above verified owned by the live v1 registrar.

> **v0 is CLOSED — do not use.** The first deploy (`GRasGMtZsv…` mainnet / `3mqpDJ6c…` devnet)
> used the 154-byte schema and was closed (programdata reclaimed). Its orphaned config/domain
> PDAs (`FaJ3NmZY`/`CxtZviKg`, `E1FSZjma`/`ApsGmZ1d`) still resolve but are dead.

**Bug fixed on deploy:** the original program used the full 64-byte padded name
buffer as PDA seed, exceeding Solana's 32-byte per-seed limit. Fixed to use
printable bytes only (`&name[..printable_len]`) in both `find_program_address`
AND the `invoke_signed` signer seeds, across all 4 instructions (Register,
UpdateContent, Transfer, Resolve).

`IS_MAINNET_READY = false` — NULL fee payment CPI is skipped, domain PDAs still
created correctly. Pilot mode until post-audit.

### 4c. parad0x.null — live on Arweave

| | |
|---|---|
| **Arweave TX (mainnet page)** | `jgvIdsbI3vScGSw-w5rhxCZvH0yu0_08gnzIluyXyz8` (canonical — read from on-chain PDA `DRDHB6Hf…`) |
| **URL** | https://arweave.net/jgvIdsbI3vScGSw-w5rhxCZvH0yu0_08gnzIluyXyz8 |
| **Content hash** | SHA-256 of the Arweave TX ID, stored in the NullDomain PDA |
| **Source** | `site/null/parad0x.html` in dna-x402 repo |
| **UpdateContent sig** | `3XXmTt8wwQKjYBpHpfXF2YPEDLpXuxMEFWPo2YpDKo4...` |

Arweave devnet page (first upload) also exists at:
`https://arweave.net/oFF_Usd-VKZv2ehJ61xSdei65m_MhK4ZP5q4fmnsKm0`

### 4d. Chrome extension — null-resolver

| | |
|---|---|
| **Source** | `extensions/null-resolver/` |
| **Zip (Web Store ready)** | `dist/null-resolver-extension.zip` (15.3 KB) |
| **PROGRAM_ID** | `H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm` (v1 mainnet — already set in `null-resolver-page.js`) |
| **RPC** | browser-safe pool: `solana-rpc.publicnode.com` + fallbacks (`api.mainnet-beta.solana.com` 403s on a browser Origin) |
| **Web Store status** | ⏳ Pending submission (zip ready, needs manual upload) |

**To load locally:** `chrome://extensions` → Developer mode → Load unpacked →
`G:\DNA x402\extensions\null-resolver` → type `parad0x.null` in address bar.

**To submit to Web Store:**
1. https://chrome.google.com/webstore/devconsole
2. New item → upload `dist/null-resolver-extension.zip`
3. Name: `Null Resolver — Web0 Domains`
4. Description: *Resolves .null domains to Arweave content via the Solana
   null_registrar program. Type parad0x.null to try it.*

### 4e. ClawHub skills — x402 payment loop (2026-06-04)

| Skill | npm | ClawHub | Role in Web0 |
|---|---|---|---|
| `openclaw-context-capsule` | `1.4.0` ✅ | Live ✅ | Memory layer for mesh agents. Self-contained, passed SkillSpector. 250+ installs. |
| `openclaw-x402-pay` | built, not yet published | Ready to upload | "Payments are x402" — agents pay for gated resources. BYO-signer, never holds keys. |
| `openclaw-x402-gate` | built, not yet published | Ready to upload | "Agents earn per call" — charge other agents, direct to your wallet, zero custody. |

All three are at `G:\DNA x402\packages\openclaw-{context-capsule,x402-pay,x402-gate}/`

`x402-pay` + `x402-gate` form the complete agent-to-agent payment loop — verified
cross-skill: a payment minted by pay verifies at gate with an identical receipt
hash (28/28 tests, mocked RPC). This is `agent47.null`'s x402 endpoint made real.

**Next:** real devnet e2e run → confirm `registerTool` API against live OpenClaw
SDK → `npm publish` both → upload to ClawHub as two separate listings.

---

## 5. All mainnet programs — full registry (2026-06-04)

| Program | Mainnet Address | Authority | Deployed |
|---|---|---|---|
| `dark_semaphore` | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | multisig | 2026-05-29 |
| `dark_secp256r1_vault` | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` | multisig | 2026-05-29 |
| `dark_secp256k1_auth` | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | multisig | 2026-05-29 |
| `null_token_hook` | `14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g` | multisig | 2026-05-29 |
| `null_lottery` | `3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG` | multisig | 2026-05-29 |
| `null_mint_gate` | `5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1` | multisig | 2026-05-29 |
| `receipt_anchor` | `6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN` | multisig | 2026-05-29 |
| `dark_proof_gate_lite` | `PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2` | multisig | 2026-05-29 |
| `dark_bn254_gate` | `GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd` | multisig | 2026-05-29 |
| **`null_registrar`** (v1) | **`H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm`** | **deployer** | **2026-06-06** |
| **`null_auction`** | **`7uxLhqLzkEzPpkvdmTwqgL3g66yq2aMBS5QgcjaZZEaw`** | **deployer** | **2026-06-06** |
| **`dark_x402_access_gate`** | **`EepqzVBNuzCgD6XGiB19pDDhzFG3gUL4z1nabBYxpfjS`** | **deployer** | **2026-06-06** |
| `dna_x402_main` (receipt anchor used by SDK) | `9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF` | 7wWKi3S3 ✓ controlled | earlier |

**$NULL token mint:** `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` (Token-2022)
**Deployer** (authority = "deployer" above): `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY`
**Squads multisig** (authority = "multisig" above): `9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5` — controls the 2026-05-29 batch.
**Authority note (reconciled 2026-06-06):** the 2026-05-29 batch is under the Squads multisig
(not the deployer). `dna_x402_main` (`9bPBmDNn`, the receipt anchor the x402 SDK calls) is under
`7wWKi3S3…` — **controlled by founder** (key recovered + backed up to the offline vault 2026-06-06).

---

## 6. The economic engine — $NULL

### Flywheel (PHASED — founder decision 2026-05-31)

- **Phase 1 (now):** public framing = *"usage fills a community rewards war chest"*
  — more rail usage → bigger community treasury. The deliberately-lawyered docs
  that say *"No buyback… does not place orders on any DEX/AMM"* + *"not an offer
  of securities"* disclaimer **stay as-is**. **No buyback / buy-pressure / price
  language anywhere public in Phase 1.**
- **Phase 2 (later):** revenue-funded market accumulation/buyback — but **only**
  with (a) legal/counsel sign-off and (b) **public disclosure**. Disclosed = fine.
  Concealed = the legal risk AND off-brand for a receipts-first project.

### Mechanism facts

- Premium fees → capped slice (**5 bps** x402 rail; **5% of task value** null-miner
  DePIN) → $NULL into the RewardsVault.
- $NULL is **fixed supply, not minted/emitted** — launched ~6mo ago on pump.fun.
- Vault is `NOT_PRODUCTION` / devnet — nothing live yet.

### `.null` registration → NULL demand

Every `.null` domain costs NULL to register (when `IS_MAINNET_READY = true`):
```
Agent needs identity → buys NULL → pays fee → domain minted forever
→ protocol earns NULL → backs ecosystem → more agents → more NULL demand
```

### DePIN angle — "NULL Mining Network"

Phones/laptops run real tasks, earn NULL; protocol earns USDC via x402.
**Moat:** x402 settles per-task USDC buyer→miner with no centralized clearinghouse
— x402 receipts ARE the proof of work. Grass ($50M+ ARR) still uses centralized
payout; x402-native DePIN is strictly superior architecture.

---

## 7. NULLA local LLM mesh (planned, not pushed)

Goal: squeeze large LLMs through weak hardware via Liquefy/Nebula compression +
quantization. Test rig: 1080 GPU (on this machine) running models it "shouldn't".
Target: 20+ tok/s. "COMING SOON" tweet drafted — **not posted yet**, more work first.

---

## 8. Cryptographic enabler — SIMD-0302 (BN254 G2)

Reviving dormant Solana PR #549 — needed for Groth16 G2 on-chain (ZK Passports,
shielded x402). **`samkim-crypto` confirmed G2 already implemented** under feature
gate `bn1hKNURMGQaQoEVxahcEAcqiX3NwRs6hgKKNSLeKxH` — active testnet + devnet,
in queue for mainnet. Devnet reference: `7JchQFr5MESd7VfBU5DHT5XB5hswm1GvbAWUc3Tm6Fdd`.

**Two doc fixes still needed** before Anza/Firedancer approval:
1. Security Considerations — small-subgroup risk when ADD/SUB feeds pairings
2. `extends:` frontmatter — reference SIMD-0284

---

## 9. Marketing & positioning

- **Dual-track, equal — Web0 umbrella:**
  - Track A (consumer): parad0xlabs.com, Nully, BTC 5-min
  - Track B (builder): dna-x402, Dark Null, Agent Passport, Liquefy
  - Bolted by **$NULL**
- **Mascot — Nully:** male, blue liquid-chrome ghost-bot. 🔵 Blue / 🔴 Red.
  X: `@Parad0x_Labs` (brand) + `@nully_ai` (intern).
- **No website edits** — Codex's lane.
- **Voice:** loud, un-dunkable — verified numbers only.

### Claims guardrails

**GREEN:** 10 programs mainnet · Dark Null 256-byte verifier / 128-byte proof ·
Liquefy 33–61× JSON, 1.4–6× vs Zstd · Agent Passport T0-2 · x402 receipts on-chain ·
"first to COMBINE x402+Groth16+Passport+receipt anchoring" · nebula VMAF 88.1 ·
parad0x.null live on Arweave (permanent, seizure-resistant).

**RED:** "audited" · "first x402/shielded pool" · buyback/price language (Phase 1) ·
invented ratios. Always say: *"Public Beta, non-custodial, capped, audit Q3 2026."*

---

## 10. Scripts & tooling (2026-06-04)

| Script | What it does |
|---|---|
| `scripts/deploy/mainnet-commercial.sh` | Deploy all 8 original mainnet programs |
| `scripts/post-devnet/init-null-registrar.mjs` | InitRegistry + Register parad0x on devnet |
| `scripts/post-devnet/upload-parad0x-null.mjs` | Arweave upload + UpdateContent (devnet) |
| `scripts/post-mainnet/init-null-registrar-mainnet.mjs` | InitRegistry + Register parad0x on mainnet |
| `scripts/post-mainnet/upload-parad0x-null-mainnet.mjs` | Arweave upload + UpdateContent (mainnet) |
| `scripts/post-mainnet/02-verify-programs-mainnet.mjs` | Verify all mainnet programs |

**Keypairs:**
- Mainnet: `scripts/keypairs/mainnet-commercial/*.json` (NOT committed)
- Devnet: `scripts/keypairs/devnet-oss/*.json` (NOT committed)

---

## 11. Open items / pending

- [ ] **SIMD-0302** — fix doc gaps (Security Considerations + `extends:`) → ping Anza/Firedancer.
- [ ] **Chrome Web Store** — submit `dist/null-resolver-extension.zip`.
      Go to https://chrome.google.com/webstore/devconsole → New item → upload zip.
- [ ] **x402 skills** — devnet e2e test → confirm `registerTool` → `npm publish` x402-pay + x402-gate → upload to ClawHub.
- [ ] **NULLA LLM squeeze** — test on 1080, then push + post tweet.
- [ ] **Task marketplace** — open to external builders (needs .null + x402 skills first).
- [ ] **Compute rental** — last, needs everything else.
- [ ] **`IS_MAINNET_READY = true`** — wire SPL CPI in processor.rs → audit → mainnet upgrade for live NULL fee collection.
- [ ] **Squads multisig** — migrate upgrade authority post-audit.
- [ ] **NULL_REGISTRAR_DEVNET program ID** — add to `configs/devnet.oss.json` anchor constant (currently `null`).

---

## 12. Commit trail — Web0 work 2026-06-04

| Commit | What |
|---|---|
| `04dc319c` | `null_registrar` deployed to devnet + PDA seed bug fixed + `parad0x.null` registered |
| `492976f2` | `parad0x.null` uploaded to Arweave (devnet), UpdateContent called |
| `42be99c9` | `null_registrar` deployed to **mainnet** + `parad0x.null` mainnet page on Arweave |

---

_Last updated 2026-06-04. Verify on-chain data against Solana Explorer before asserting as fact._
