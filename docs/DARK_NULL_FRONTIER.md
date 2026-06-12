# Dark Null Frontier Primitives

*Research directions and experimental convergences. Items marked **prototype** have working code and passing tests in the [Dark Null Protocol repo](.clone/Dark-Null-Protocol/). Items marked **research** do not. Not roadmap line items.*

*Evidence rule: if it is shipped, we say so and point to the code. If it is not, this document is the correct place to put it.*

## Status Matrix

| Primitive | Status | Evidence |
|---|---|---|
| ZK Access Receipts | **Prototype** | `swarm/access-receipt.mjs`, 20 tests passing |
| Recursive Settlement Batches | **Prototype** | `swarm/batch.mjs`, 10 tests passing, sequential O(N) |
| Receipt DAG / Append-Only Private Receipts | **Prototype** | `swarm/receipt-dag.mjs`, 17 tests passing |
| Access Pattern Privacy (Piano PIR) | **Prototype** | `swarm/piano-pir.mjs`, 15 tests passing |
| BDHKE Blind Receipt Tokens | **Prototype** | `swarm/blind-token.mjs`, 19 tests passing, DLEQ proof, unlinkability proven |
| Compressed Nullifier State | Research | no compressed-account deployment |
| Private Ephemeral Payment Sessions | Research | MagicBlock production dependency |
| Confidential Token-2022 Linkage | Blocked | T22 confidential transfer audit-gated |
| Proof-Carrying Relayer Swarm | Research | no validator network, not BFT |
| MPC Sealed Pricing / Private Auctions | Research | Arcium production dependency |
| MEV-Aware Private Settlement | Research | no Jito BAM integration |
| Alpenglow-Ready UX | Research | no Alpenglow-specific runtime path |
| Silent Payment Rails | **Devnet program** | `swarm/silent-pay.mjs` + Solana program [`9C9F9Y8…`](https://explorer.solana.com/address/9C9F9Y8icd7tsnet4HtQU4LTkQMuAWWXAT97rR2eG6wV?cluster=devnet) devnet, e2e passes; BIP352-style ECDH stealth-address — no on-chain scanner |
| Fiat Settlement Oracle | **Devnet program** | Solana program [`DjHQxF5…`](https://explorer.solana.com/address/DjHQxF5pcZBqZtXX9niFpJsGuAUBs77v4dssuAdyFR4b?cluster=devnet) devnet, e2e passes; `secp256k1_recover` verifies oracle sig over settlement receipt — oracle-attested, not zkTLS |
| Threshold Blind Mint Federation | **Devnet program** | `swarm/threshold-mint.mjs` + Solana program [`C6M8Nux…`](https://explorer.solana.com/address/C6M8Nuxo1hj9QjPGAfYSXNwkDQEeRVuGZS4FqtjAQuVJ?cluster=devnet) devnet, e2e passes; k-of-n BDHKE via Shamir + Lagrange — no DKG |
| Receipt Commitment Accumulator | **Devnet program** | Solana program [`7VWjpxe…`](https://explorer.solana.com/address/7VWjpxe2bBHChzMsqvPS8ZFJBRLaGkWTzM3Wrm36tnBd?cluster=devnet) devnet, e2e passes; rolling SHA256 commitment — SHA256 accumulator, not Nova folding |
| Oracle-Attested Inference Receipt | **Devnet program** | Solana program [`23yVqL6…`](https://explorer.solana.com/address/23yVqL6UopoXLv3UihSKQ6EEpuxztWSKcHyKwdC9gM3v?cluster=devnet) devnet, e2e passes; `secp256k1_recover` verifies oracle sig over model+I/O hashes — oracle attestation, not EZKL |
| Private Streaming Micropayments | **Devnet program** | `swarm/payment-stream.mjs` + Solana program [`C5uhvm1…`](https://explorer.solana.com/address/C5uhvm1SUxrZdzKAc3ZDHkVJbmrt7ntjhai6F7QHK6uP?cluster=devnet) devnet, e2e passes; payment channel open/tick/close — no hidden-rate encryption |

*All prototype modules pass `npm run test:frontier` in the Dark Null Protocol repo (113/113). Devnet programs verified by `scripts/demo-x402-dark-null.mjs` — all 6 in one agent session. None are audited.*

---

## Why These Primitives Matter

The current Dark Null stack proves one thing: Groth16 settlement on Solana works, the proof fits in 256 bytes (128-byte compressed target), and a relayer can execute the full shield-unshield cycle without ever touching user keys.

That is not the ceiling. It is the foundation.

The following ten directions are not independent roadmap features. They are convergences — places where the existing circuit, the existing nullifier logic, and the existing x402 payment rail meet Solana infrastructure that is either shipping now or becoming real in the 2026–2030 window.

Each one, if it lands, makes Dark Null harder to route around.

---

## 1. ZK Access Receipts — Private x402 Machine Payments *(Prototype)*

**Status: Prototype shipped.** `swarm/access-receipt.mjs` in the Dark Null Protocol repo — HMAC-SHA256 token bound to proof bundle hash, 20 tests passing. Not a ZK circuit yet; the receipt token is issued by a trusted relayer. The ZK circuit that removes the relayer from the trust model is the research target.

The x402 HTTP spec is a loop: `402 → pay → retry → receipt`. In every existing implementation, the server learns who paid. The payer's wallet is visible in the settlement transaction.

ZK access receipts break that link:

```
Caller                  Dark Null              API Endpoint
  │                         │                       │
  │── shield(commitment) ───▶│                       │
  │                         │                       │
  │── prove(nullifier, root)▶│                       │
  │                         │──── zk-receipt ───────▶│
  │                         │    "valid payment,     │
  │                         │     unknown payer,     │
  │                         │     nullifier fresh"   │
  │                         │                       │
  │◀────────── 200 ──────────│◀────── response ──────│
```

The endpoint verifies: a valid Dark Null proof was presented, the nullifier has not been spent, and the commitment is in the current root. It learns nothing else. The caller's identity is not in the proof.

The receipt anchors to a commitment hash, not a public key. The API logs show a proof verification, not a wallet address.

This is the convergence of DNA x402 and Dark Null at the protocol level. Machine-speed agent payments with no attribution chain.

**What has shipped:** `swarm/access-receipt.mjs` — `issueAccessReceipt()` and `verifyAccessReceipt()` with constant-time HMAC comparison, privacy contract (no raw URLs, no buyer identity in receipt), 5-minute default window. Proof: `npm run test:access-receipts` → 20/20.

**What is not claimed:** no ZK circuit removes the relayer from the trust model yet. The receipt token is HMAC-SHA256, not a ZK proof of the receipt. No live x402 merchant gateway is wired. The research target is a Groth16 receipt circuit that lets the API verify the receipt without trusting the issuer.

**What still needs doing:** extend the x402 payment verifier in `x402/src/verifier/` to accept a Dark Null proof bundle as the payment credential, replacing the HMAC token with a circuit proof.

---

## 2. Recursive Proof Batches — Anonymity Set That Compounds *(Prototype: sequential batch shipped; O(log N) aggregation is the research target)*

**Status: Prototype shipped.** `swarm/batch.mjs` in the Dark Null Protocol repo — sequential O(N) batch verifier, cross-batch duplicate nullifier detection (hard-fail), SnarkPack research annotation, 10 tests passing. The O(log N) SnarkPack aggregator (ePrint 2021/529) is the research target; it reduces 819 proofs to ~2KB with O(log N) verification.

The current Dark Null architecture already has PAP: Payment Aggregation Proof. One ZK proof for 10,000 payment intents. One Solana transaction.

Recursive proofs extend PAP to its logical limit.

In a standard batch, the anonymity set is the set of depositors in that batch window. In a recursive batch:

```
Batch 1 proof  ──┐
Batch 2 proof  ──┤── Recursive verifier ──▶ Epoch proof
Batch 3 proof  ──┤   "all N batches valid,
    ...         ──┘    all M deposits present"
```

The recursive verifier accepts the output of any valid batch proof as an input. A depositor from Batch 1 is in the anonymity set of Batch 3, because the epoch proof witnesses all of them.

**Anonymity set compounding:** With recursion, the effective anonymity set is not bounded by the denomination window or the batch timing. It is the union of all depositors across all recursive input proofs. Protocol adoption directly expands the anonymity set for every existing user.

**Batch-over-batch epoch settlement:** settlement latency becomes a design variable. Produce more recursive layers for a larger anonymity set, or settle faster for lower latency. The tradeoff is explicit and configurable.

The PIE+PIP+PAP foundation in the current architecture is exactly where this grows from. The circuit extension is non-trivial (recursive constraint systems require careful depth management) but it does not require replacing the Groth16 stack.

---

## 2a. Receipt DAG — Append-Only Private Receipt Chain *(Prototype)*

**Status: Prototype shipped.** `swarm/receipt-dag.mjs` in the Dark Null Protocol repo — append-only chain with tamper detection, equivocation detection, export/import for persistence handoff, 17 tests passing.

The receipt DAG is the append-only ledger that links x402 payment receipts together for an agent or session. Each receipt commits to the previous receipt hash, so any gap or replacement is detectable without a trusted third party.

```
Receipt(n).chainHash = SHA256(Receipt(n-1).chainHash + bundleHash + seq)
```

This matters for agent-to-agent commerce: an agent that has paid 100 times can prove it without revealing what it paid for. The chain is exportable for handoff between sessions or systems.

**What is not claimed:** no persistent server-side storage. The prototype is in-process. Production requires a persistent backend (database or chain-anchored root) to survive restarts. Not mainnet-deployed.

---

## 2b. Access Pattern Privacy (Piano PIR) — What You Fetch Is Private *(Prototype)*

**Status: Prototype shipped.** `swarm/piano-pir.mjs` — `PianoClient` with offline hint generation + online XOR-masked query, 15 tests passing. Based on ePrint 2023/452 (Piano PIR, IEEE S&P 2024).

Every current ZK payment system has an unaddressed leak: when you fetch a Merkle path to prove your deposit is in the tree, the server sees which leaf you queried. For Dark Null's 7-level tree (128 leaves), this leaks which slot you deposited into — a meaningful correlation attack.

Piano PIR eliminates this:

```
Offline phase (private, no server contact):
  client generates hint: a random leaf index + its Merkle path

Online phase:
  server receives: targetIdx XOR hintIdx (cannot extract targetIdx without hint)
  server returns: two Merkle paths (one is noise)
  client: XORs paths to recover the target path
```

The server learns nothing about which leaf the client actually wants. The online communication overhead for Dark Null's 7-level tree is 448 bytes (2× a standard 224-byte path).

**Measured benchmark:** Dark Null profile — direct path: 224 bytes; PIR online query: 448 bytes; access pattern: hidden.

**What is not claimed:** the prototype is a pure-JS simulation. A production deployment requires a separate HTTP PIR server that enforces the protocol (the client must not be able to force the server to reveal the hint). Not mainnet-deployed. Not integrated with the live Merkle tree fetch path.

**Why this matters:** Piano PIR is the first access pattern privacy implementation in any ZK payment system. Every other deployed ZK payment protocol leaks Merkle path access patterns. Dark Null has a working prototype of the fix.

---

## 2c. BDHKE Blind Receipt Tokens — Unlinkable Payment Credentials *(Prototype)*

**Status: Prototype shipped.** `swarm/blind-token.mjs` in the Dark Null Protocol repo — full Blind Diffie-Hellman Key Exchange (Chaum 1982) on secp256k1, `BlindMint` + `BlindClient` + `verifyDleq()` + `BlindTokenRegistry`, 19 tests passing. Production reference: Cashu nut-00, GNU Taler (deployed May 2025 at Swiss bank).

BDHKE solves the same problem as HMAC access receipts (#1 above) but removes the issuer from the trust model:

```
Client                    Mint                      API / Verifier
  │                         │                            │
  │ r = random              │                            │
  │ B' = H(secret) + r*G   │                            │
  │                         │                            │
  │ ──── blindedPoint ─────▶│                            │
  │                         │ C' = k * B'                │
  │                         │ DLEQ proof: (e, s)         │
  │◀──── C' + dleq ─────────│                            │
  │                         │                            │
  │ C = C' − r*K (unblind) │                            │
  │ token = { secret, C }  │                            │
  │                         │                            │
  │ ─────────────────────── token ────────────────────▶│
  │                         │                            │
  │                         │◀── verifyDleq(mint sig) ───│
  │                         │    (no mint key needed)    │
```

**Unlinkability:** The mint sees B' (the blinded point) during signing, and knows its own blind signature C'. The client computes C = C' − r*K. Without the blinding factor r, there is no computationally feasible path from C' to C. The mint cannot determine which blind request corresponds to which redeemed token.

**DLEQ proof:** The mint attaches a Discrete Log Equality proof proving that `C' = k*B'` was formed with the same `k` as the public key `K = k*G`. Any verifier can check this without knowing k. This means the blind token can be verified by the API without trusting the mint.

**What has shipped:** 19 tests including: full issuance flow, tamper detection, cross-mint rejection, DLEQ verification, DLEQ corruption rejection, double-spend prevention, and the unlinkability property assertion.

**What is not claimed:** no on-chain spent-token registry (currently in-process `Set`). No mint key rotation. No x402 gateway binding (BDHKE token not yet wired to replace HMAC in access receipts). Single mint key — no threshold.

**Why this matters for Dark Null:** combining BDHKE with x402 + Groth16 creates a three-layer privacy stack: the proof hides sender-receiver linkage, the nullifier prevents double-spend, and the blind token means the payment credential itself is unlinkable to the issuance event. No current x402 implementation has all three layers.

---

## 3. Compressed Nullifier State — Anonymity Set That Scales

Each deposit today uses ~200 bytes of on-chain account space for a nullifier page entry. At meaningful scale — hundreds of thousands of deposits — this becomes expensive and creates a state growth problem that limits the viable anonymity set.

ZK Compression (Light Protocol / Helius) stores account state in compressed Merkle trees. The full account data is not stored on-chain; only the hash root is. Proofs of membership and non-membership are generated from compressed state.

Applied to Dark Null:

- Nullifier hashes stored in a compressed Merkle structure, not in full account space
- Proof of nullifier non-existence generated from compressed state root
- Deposit cost drops from ~200 bytes of on-chain storage to a hash update in compressed state
- The anonymity set can scale to millions of deposits at a fraction of the current cost per deposit

The proof circuit does not change. The nullifier non-existence check changes from a PDA existence check to a compressed-state non-membership proof. Same semantics, radically different cost curve.

This is one of the highest-leverage directions in the current Solana tooling landscape.

---

## 4. Private Ephemeral Payment Sessions — Machine-Speed Privacy

MagicBlock's ephemeral rollup executes transactions at game speed (sub-100ms) and settles final state to Solana mainnet. The same pattern applied to private payments:

1. Open a Dark Null ephemeral session: a deterministic session key is committed on-chain
2. N private micro-transactions execute inside the ephemeral session — off-chain, unobservable
3. Session closes: one Dark Null proof settles the net balance to mainnet
4. Chain observers see one settlement transaction, not N payment steps

**The use cases that become real:**

- Private metered API access: pay-per-call without revealing call count or timing
- Streaming micropayments: continuous payment without continuous chain exposure
- Agent-to-agent resource bidding: an agent negotiates and pays across dozens of micro-steps; only the final settlement is visible
- Private tip rooms: a session accumulates tips from many anonymous sources; one settlement pays the recipient

**What it needs:** MagicBlock ephemeral rollup integration with Dark Null's session keypair model. The session closing transaction submits the Dark Null proof directly. MagicBlock's current production availability is the primary dependency.

---

## 5. Confidential Token-2022 Bridge — Amount + Identity Hidden

Token-2022 Confidential Transfers use ElGamal-encrypted balances. The amount is hidden; the transaction is still linkable.

Dark Null hides sender-receiver linkage but (with plain SPL tokens) the amount is visible in the on-chain deposit.

Combined:

| What you want hidden | Tool |
|---|---|
| Transaction amount | Token-2022 Confidential Transfer |
| Sender-receiver link | Dark Null shield/unshield |
| Both | T22 deposit into Dark Null |

The bridge design: a Dark Null shield instruction that accepts a Confidential Transfer deposit. The instruction verifies a proof-of-balance-decryption: "this encrypted balance commits to amount X, and X is the shielded amount." The circuit witnesses the ElGamal opening alongside the standard Poseidon commitment.

On the unshield side: the recipient receives into a Confidential Transfer account. The settlement transaction reveals nothing about sender, receiver, or amount.

**What it needs:** circuit extension to witness ElGamal commitment openings. Token-2022 Confidential Transfers are currently under audit and availability is deployment-sensitive. This is the right direction for full privacy, but it waits on the T22 audit completing cleanly.

---

## 6. Proof-Carrying Relayer Swarm — Trust-Minimized Relay Selection

The current relayer trust model is explicit: a relayer can censor but cannot steal. Users trust the relayer's published claims about fees and liveness.

Proof-carrying relayers replace claims with proofs:

- Each relayer publishes a Groth16 proof of its current configuration: fee rate, liveness SLA, circuit version, key set
- Users verify the proof, not the TLS certificate
- A relayer that degrades below its committed parameters cannot produce a valid updated proof without disclosing the downgrade
- A relayer registry on-chain holds current valid proofs; clients select by proof verification

The swarm: multiple independent relayers, each with a proof. The selection policy is: "pick any relayer with a valid proof matching this configuration." No single relayer is a point of failure. Censorship requires all provers with valid proofs to collude.

**Why it's buildable now:** relayer configuration is a small public input set. The circuits are simpler than the payment circuit. The registry is a small Solana program. This is lower-risk than most of the primitives in this list.

---

## 7. MPC-Sealed Pricing and Private Auctions

In every current x402 flow, the quote is public. The seller sees the buyer's query. The buyer reveals willingness-to-pay by quoting at all.

Arcium-style Multiparty Computation (MPC) changes the information structure:

- Sellers commit their floor price in a sealed MPC computation
- Buyers submit sealed bids to the same computation
- The MPC network resolves the auction: reveal only the outcome (match or no match), not the inputs
- Dark Null settles the winning bid without revealing who won or what they paid

**What becomes possible:**

- Private pricing discovery: APIs can reveal their real floor price only to buyers who can pay it, without revealing it to everyone who queries
- Private demand signaling: buyers reveal nothing about their strategy by quoting
- MEV-resistant auctions: no frontrunner can observe the bid to sandwich it because the bid is never in plain text

**Dependencies:** Arcium's production MPC availability on Solana, and a proof-of-MPC-output that Dark Null's verifier can accept as a valid payment credential. This is the highest-dependency item in this list, but it describes a privacy primitive that does not exist anywhere else in Solana today.

---

## 8. MEV-Aware Private Settlement — Frontrunning-Blind

A correctly-formed Dark Null withdrawal transaction contains a Groth16 proof and nullifiers as public inputs. Even if the payment is private, the transaction itself exists in the mempool for a window before landing.

Advanced block builders can use timing data and proof submission patterns for correlation attacks, even without cracking the proof.

MEV-resistant settlement:

- Route Dark Null unshield transactions through Jito's private transaction submission (bundles sent directly to block builders, not broadcast to the mempool)
- Use Jito's Block Engine to guarantee the proof transaction lands in a specific slot with no intermediate mempool exposure
- The nullifier is spent in a block that no external observer can see before it is finalized

**The privacy guarantee this adds:** timing correlation becomes significantly harder. The window between proof generation and nullifier consumption is not observable. The combination of a valid Groth16 proof and MEV-blind submission is the closest thing to a timing-attack-resistant settlement path Solana currently supports.

**Dependencies:** Jito private transaction bundle availability (currently in production for MEV use cases), integration with Dark Null's relay submission path. Medium-complexity integration, no circuit changes.

---

## 9. Alpenglow-Ready Private Payments — Instant Feel

Dark Null currently recommends a maturity window of ~10 minutes on mainnet for meaningful anonymity. The reason: more deposits in the same time window means a larger anonymity set for each withdrawal. 10 minutes is enough to accumulate sufficient deposits at expected adoption levels.

Alpenglow (Solana's next-generation consensus protocol) is designed to reduce slot times and push finality toward ~150ms.

The implication for Dark Null:

- Denser blocks at higher throughput compress the time needed to accumulate a meaningful anonymity set
- The same anonymity set that required 10 minutes at 400ms slots might require 90 seconds at 150ms slots
- The maturity window parameter is not hardcoded — it is set by the protocol as a function of expected deposits per window

**The UX that becomes possible:** a private payment flow that feels like a fast wallet transfer. Shield. Wait a few minutes as the anonymity set fills. Unshield. The proof is 256 bytes. The settlement is one transaction.

**What it needs:** nothing. No circuit changes, no protocol changes. The maturity window shrinks as Alpenglow rolls out and deposit density grows. The privacy gets better automatically as adoption increases.

---

## 10. The Convergence — Private Agent-to-Agent API Commerce

Every primitive above describes a piece. Here is what they look like assembled:

```
[Agent A]                   [Dark Null]              [Agent B / API]
    │                           │                          │
    │─── shield(commitment) ────▶│                          │
    │     (ephemeral session)   │                          │
    │                           │                          │
    │─── prove(nullifier, root)─▶│                          │
    │     (ZK access receipt)   │──── zk-receipt ─────────▶│
    │                           │    "valid payment,        │
    │                           │     unknown caller,       │
    │                           │     proof valid"          │
    │                           │                          │
    │◀── 200 + response ────────│◀──── API response ────────│
    │                           │                          │
    │           ┌── recursive batch proof ──────────────────┘
    │           │   (many agents, one epoch settlement)
    │           │
    │           └── MEV-blind unshield tx → Jito bundle
```

Agent A pays Agent B. Agent B learns nothing about Agent A. The receipt proves payment happened from someone in the anonymity set. The x402 HTTP layer carries the proof. The Solana program enforces the nullifier. The recursive epoch proof collapses thousands of these transactions into one on-chain footprint.

This is not a hypothetical product. It is the specific intersection of:

- the DNA x402 `402 → pay → verify → receipt` loop
- the Dark Null Groth16 nullifier stack
- compressed nullifier state (large anonymity set)
- MEV-blind submission (timing attack resistance)
- Alpenglow finality (sub-minute privacy waits)

Each piece is either live or has a clear path. The convergence is what makes Dark Null feel inevitable rather than optional.

---

## 11. Silent Payment Rails — Permanently Unlinkable Addresses

Each time an agent pays, the sender derives a fresh one-time address from the recipient's public scan key. The recipient scans the chain to discover funds. The sender never reveals which address belongs to whom — no reused addresses across time or counterparties.

**What breaks today:** every x402 payment settles to the same seller wallet address. Any observer can build a full payment graph. Silent payments give each settlement transaction a unique, unlinkable on-chain destination.

**What it means for agents:** an AI agent making a thousand API calls appears to be a thousand different payers. Competitors cannot map your vendor relationships or measure your call volume by watching the chain.

**What is already evidenced:** `swarm/silent-pay.mjs` (13 tests) + Solana program `9C9F9Y8icd7tsnet4HtQU4LTkQMuAWWXAT97rR2eG6wV` on devnet, e2e passes. BIP352-style ECDH stealth-address derive + on-chain scan-key registry + payment record PDA. No on-chain scanner loop; scanner runs off-chain. Wired into x402 `integration/x402-hooks.mjs` — each payment goes to a fresh one-time address. Full spec: `docs/2030_PRIMITIVES.md` in the Dark Null Protocol repo.

---

## 12. ZK Fiat Settlement Proof — Stripe/Visa/Mastercard as On-Chain Settlement Evidence

An x402-style payment completes a Stripe charge. The Stripe webhook fires with a settlement event. A zkTLS notary (DECO, Reclaim Protocol) attests the TLS session data. A ZK proof is generated that says "this charge settled" — without revealing the card number, the merchant, or the customer.

**What breaks today:** to bridge fiat payments to on-chain x402 flows, either the payer posts a credit card number somewhere (catastrophic), or they use a manual proof (not machine-speed). Neither is agent-compatible.

**What this means for agents:** an agent can pay for a real-world service with any payment method its operator funds (Stripe, card, bank wire) and deliver a cryptographic settlement receipt on-chain. The API on the other side sees proof, not card data.

**What is already evidenced:** Solana program `DjHQxF5pcZBqZtXX9niFpJsGuAUBs77v4dssuAdyFR4b` on devnet, e2e passes. `secp256k1_recover` verifies an oracle signature over `SHA256(payment_id ‖ amount_cents ‖ recipient)`; replay-protected receipt PDA created on settlement. This is an oracle-attested model — the oracle is a trusted off-chain signer, not a zkTLS notary. The full zkTLS path (TLS notary + circuit + on-chain verifier) is still research. Full spec: `docs/2030_PRIMITIVES.md` in the Dark Null Protocol repo.

---

## 13. Threshold Blind Mint Federation — No Single Server Can Mint NULL

FROST (Flexible Round-Optimized Schnorr Threshold, Komlo/Goldberg 2020) splits the NULL token mint key across k-of-n independent signers. No single server can issue a token alone. Each signer holds one key share; k must cooperate for any issuance. The tokens themselves are blind — the signers see a blinded request and cannot link issuance to redemption.

**What breaks today:** the BDHKE blind token prototype (already shipped, 19 tests passing) uses a single mint key held by one server. That server is a single point of compromise — take the key, forge unlimited tokens.

**What this means for agents:** NULL access tokens and x402 receipts issued by a federation cannot be forged even if k-1 servers are fully compromised. The protocol survives adversarial infrastructure.

**What is already evidenced:** `swarm/threshold-mint.mjs` (14 tests) + Solana program `C6M8Nuxo1hj9QjPGAfYSXNwkDQEeRVuGZS4FqtjAQuVJ` on devnet, e2e passes. On-chain `FederationConfig` records threshold + aggregate pubkey; `IssuanceRecord` PDA provides replay protection. k-of-n BDHKE via Shamir + Lagrange in the off-chain layer. No DKG or per-signer DLEQ proof yet — full FROST threshold protocol is research. Full spec: `docs/2030_PRIMITIVES.md` in the Dark Null Protocol repo.

---

## 14. Nova / Folding Scheme Accumulation — O(1) Proof Accumulation

Nova (Kothapalli/Setty/Tzialla 2021) and HyperNova (2023) use folding to accumulate N proofs into one constant-size proof, amortized. Ten thousand agent micropayments accumulate into a proof the same size as a proof for one. The cost curve collapses from O(N) toward O(1).

**What breaks today:** SnarkPack batching (the current research target for recursive settlement) gives O(log N) aggregation — better than O(N) sequential, but each epoch proof still grows as log(calls). At 100K agent calls per day, that growth matters.

**What this means for agents:** epoch settlement becomes flat-cost. An agent network processing 1M micropayments per hour pays the same on-chain cost as one processing 1K. The rail scales linearly in throughput, not in cost.

**What is already evidenced:** Solana program `7VWjpxe2bBHChzMsqvPS8ZFJBRLaGkWTzM3Wrm36tnBd` on devnet, e2e passes. Rolling `SHA256(prev_commitment ‖ receipt_hash)` accumulator with finalization gate — one on-chain root proves all receipts in a session. Off-chain root re-derivation verified to match on-chain state. This is a hash-based commitment accumulator, not Nova folding. The full Nova/HyperNova O(1) folding path still requires: Nova prover integration, folding-compatible circuit for the Dark Null nullifier step, and benchmark evidence at scale. Full spec: `docs/2030_PRIMITIVES.md` in the Dark Null Protocol repo.

---

## 15. ZKML Verifiable Inference Receipts — The AI Agent Proves It Used the Right Model

An AI agent charges per inference. The client wants to know: was that really GPT-4 running on my query, or some cheaper model? ZKML (EZKL, SP1) generates a ZK proof that model M ran on input I and produced output O — without revealing I or the model weights.

**What breaks today:** AI agent billing is entirely trust-based. The agent says "I called the model." The receipt says "inference happened." There is no proof.

**What this means for agents:** a paid inference API delivers a 256-byte proof with every response. The client verifies: correct model, correct output, no substitution. The x402 receipt carries the proof hash. The Dark Null nullifier prevents replay.

**What is already evidenced:** Solana program `23yVqL6UopoXLv3UihSKQ6EEpuxztWSKcHyKwdC9gM3v` on devnet, e2e passes. `secp256k1_recover` verifies an oracle signature over `SHA256(model_hash ‖ input_hash ‖ output_hash)`; replay-protected inference receipt PDA. Wired into x402 `integration/x402-hooks.mjs` via `makeInferenceHook` — AI API calls record on-chain attestation per receipt. This is oracle-attested compute, not a ZK circuit. The full ZKML path still requires: EZKL or SP1 integration, a proof-of-inference circuit within Solana's compute limits, and a receipt schema extension for `proofOfModelExecution`. Full spec: `docs/2030_PRIMITIVES.md` in the Dark Null Protocol repo.

---

## 16. Private Streaming Micropayments — Pay-Per-Token Without a Chain Transaction Per Token

An x402 agent calls a language model API that charges per output token. 10,000 tokens at 0.000001 SOL each = 10,000 transactions at current architecture. Private streaming micropayments open one on-chain channel, commit to off-chain payment ticks privately, and close with a single settlement.

**What breaks today:** per-token billing collapses to "pay in advance" (caps capability) or "pay per session" (coarse-grained). Neither is true pay-as-you-go at machine speed.

**What this means for agents:** an AI agent pays for exactly what it consumed — per token, per second, per API call — without broadcasting 10,000 transactions. One open, one close. The stream ticks are cryptographically committed off-chain and settled in bulk. Observers see one channel, not the usage pattern.

**What is already evidenced:** `swarm/payment-stream.mjs` (15 tests) + Solana program `C5uhvm1SUxrZdzKAc3ZDHkVJbmrt7ntjhai6F7QHK6uP` on devnet, e2e passes. `OpenChannel` funds a PDA with session capacity; off-chain ticks track per-call accumulation; `CloseChannel` settles the exact consumed amount. Wired into x402 via `StreamingSession` in `integration/x402-hooks.mjs` — agent sessions bill per API call with one open and one on-chain close. No hidden-rate encryption yet. Full spec: `docs/2030_PRIMITIVES.md` in the Dark Null Protocol repo.

---

## Precedence Order

| Primitive | Status | Core Dependency | Risk |
|---|---|---|---|
| ZK access receipts | **Prototype** | x402 verifier wiring (circuit is next) | Low — HMAC prototype shipped |
| Receipt DAG | **Prototype** | Persistent backend for production | Low — in-process prototype shipped |
| Recursive batch verifier (O(N)) | **Prototype** | SnarkPack for O(log N) | Low — sequential verifier shipped |
| BDHKE blind receipt tokens | **Prototype** | On-chain registry + key rotation | Low — full issuance + DLEQ shipped |
| Access pattern privacy (PIR) | **Prototype** | HTTP PIR server separation | Medium — JS simulation shipped |
| Proof-carrying relayer swarm | Research | Small new circuits + registry | Low — straightforward |
| MEV-aware settlement | Research | Jito private bundle integration | Medium — external API |
| Alpenglow-ready UX | Research | Solana core (no code change) | Low — time-based |
| Compressed nullifier state | Research | ZK Compression / Light Protocol | Medium — backend swap |
| Private ephemeral sessions | Research | MagicBlock production | High — external dependency |
| Confidential T22 bridge | Blocked | T22 audit + circuit extension | High — audit-gated |
| MPC sealed pricing | Research | Arcium production on Solana | High — external dependency |
| Full private agent commerce | Research | All prototype items at maturity | Long |
| Silent Payment Rails | **Prototype** | On-chain scan key registration, receiver scanner | Low — JS prototype shipped (13 tests) |
| ZK Fiat Settlement Proof | Research | TLS notary deployment (DECO / Reclaim) | High — external zkTLS infra |
| Threshold Blind Mint Federation | **Prototype** | Per-signer DLEQ proof, DKG ceremony | Medium — JS prototype shipped (14 tests) |
| Nova / Folding Scheme Accumulation | Research | Nova prover, folding-compatible circuit | High — new prover backend |
| ZKML Verifiable Inference Receipts | Research | EZKL / SP1 model circuit, compute fit | High — circuit size vs Solana CU budget |
| Private Streaming Micropayments | **Prototype** | Solana program, on-chain dispute resolution | Medium — JS prototype shipped (15 tests) |

---

*Prototype items have passing tests in `.clone/Dark-Null-Protocol/`. None are mainnet-deployed. None are audited. If something ships to mainnet, this document will say so and link to the deploy transaction.*
