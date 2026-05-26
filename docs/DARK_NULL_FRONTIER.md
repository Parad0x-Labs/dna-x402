# Dark Null Frontier Primitives

*Research directions and experimental convergences. Not shipped. Not roadmap line items. These are the shapes that become possible when the current Groth16 stack meets adjacent infrastructure that is either live or close.*

*Evidence rule: if it is shipped, we say so and point to the code. If it is not, this document is the correct place to put it.*

---

## Why These Primitives Matter

The current Dark Null stack proves one thing: Groth16 settlement on Solana works, the proof fits in 256 bytes (128-byte compressed target), and a relayer can execute the full shield-unshield cycle without ever touching user keys.

That is not the ceiling. It is the foundation.

The following ten directions are not independent roadmap features. They are convergences — places where the existing circuit, the existing nullifier logic, and the existing x402 payment rail meet Solana infrastructure that is either shipping now or becoming real in the 2026–2030 window.

Each one, if it lands, makes Dark Null harder to route around.

---

## 1. ZK Access Receipts — Private x402 Machine Payments

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

**What it needs:** extend the x402 payment verifier to accept a Dark Null proof as the payment credential. The existing Groth16 verifier and nullifier check already exist. The wiring is a new settlement mode in `x402/src/verifier/`.

---

## 2. Recursive Proof Batches — Anonymity Set That Compounds

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

## Precedence Order

| Primitive | Core Dependency | Risk |
|---|---|---|
| ZK access receipts | x402 verifier extension | Low — circuit already exists |
| Proof-carrying relayer swarm | Small new circuits + registry | Low — straightforward |
| MEV-aware settlement | Jito private bundle integration | Medium — external API |
| Alpenglow-ready UX | Solana core (no code change) | Low — time-based |
| Recursive proof batches | Recursive constraint system depth | Medium — circuit work |
| Compressed nullifier state | ZK Compression / Light Protocol | Medium — backend swap |
| Private ephemeral sessions | MagicBlock production | High — external dependency |
| Confidential T22 bridge | T22 audit + circuit extension | High — audit-gated |
| MPC sealed pricing | Arcium production on Solana | High — external dependency |
| Full private agent commerce | All above at sufficient maturity | Long |

---

*All items above are research directions. None are shipping dates. If something in this document ships, this document will say so and link to the code or the deploy transaction.*
