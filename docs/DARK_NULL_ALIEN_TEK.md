# Dark Null Alien Tek Research

*Five deep research threads across forgotten e-cash, cryptographic holy grails, proof aggregation, MPC primitives, and UTXO privacy systems. Synthesized May 2026.*

*These are things that have been discussed in theory, exist only in academic literature, were deployed in adjacent domains and forgotten, or were long abandoned for non-cryptographic reasons. All claims are cited. If something is practical, it says so. If something is theoretical, it says so.*

---

## 1. The Access Pattern Privacy Leak — The Dirty Secret of Every Deployed ZK Payment System

Every deployed ZK payment system — Zcash, Tornado Cash, Light Protocol, Dark Null — has the same unaddressed gap. When you generate a spend proof you need the sibling hashes along your Merkle path. You fetch them from a full node. **The full node sees which siblings were requested. The access pattern reveals which leaf you are proving.**

The Groth16 proof leaks nothing. The HTTP request to the RPC node leaks the leaf index.

Two independent solutions now approach practical deployment:

### Piano PIR (IEEE S&P 2024, Carnegie Mellon)

Private Information Retrieval lets a client query a server database without the server learning which entry was queried. Piano achieves: 12ms computation + 60ms network per query, 220KB communication, on a 100GB database. Client maintains O(√n) hints from a one-time preprocessing download.

- Open-source: `github.com/wuwuz/Piano-PIR-new`
- A nullifier set of 10M 32-byte entries is ~320MB. Piano requires ~18MB client storage and 220KB per check.
- Paper: ePrint 2023/452

### TACEO:OMap (production-targeted, 2025)

Combines Sparse Merkle Trees (verifiability) + MPC (distributed tree so no single party sees access pattern) + Cuckoo-table ORAM (hides path traversal). Benchmarks AWS co-located: 181ms read at tree depth 20, +200ms for CoSNARK proof.

- Site: core.taceo.io
- Designed for private token transfers with hidden sender/receiver/amount

### Flashbots ORAM for Blockchain State (near-deployment)

Path ORAM inside a TEE for block building. Clients query Ethereum state without identifying which state they're accessing. 50 microseconds per access at database size 2³⁰. 200K requests per second.

- Post: writings.flashbots.net/scalable-oblivious-accesses-to-blockchain-data

### The Synthesis Nobody Has Shipped

Piano for nullifier checks + TEE/MPC ORAM for Merkle path fetches = a ZK payment system with end-to-end private proof generation. Not just private on-chain — private against the node used to generate the proof. All pieces exist. Zero production deployments combining them. Engineering gap, not research.

*Papers: Piano ePrint 2023/452. Spiral ePrint 2022/368. Flashbots ORAM writings.flashbots.net. TACEO:OMap core.taceo.io. Path ORAM arXiv 1202.5150.*

---

## 2. Blind Diffie-Hellman Key Exchange — 40-Year-Old Chaum Tech Deployed in a Swiss Bank

**The year: 1982.** David Chaum's "Blind Signatures for Untraceable Payments" (CRYPTO '82, proceedings 1983) introduced one property that has not been equaled: the signer produces a valid signature on a message it **never saw**. The mint issuing a coin cannot link the issuance event to the spending event even with full records. Algebraically impossible, not computationally hard.

The modern construction (BDHKE — Blind Diffie-Hellman Key Exchange, David Wagner):

```
Mint publishes:   K = k·G
User computes:    Y = hash_to_curve(secret)
User blinds:      B_ = Y + r·G
Mint signs:       C_ = k·B_
User unblinds:    C = C_ - r·K = k·Y
Spend:            present (secret, C)
Mint verifies:    k·hash_to_curve(secret) == C
                  mark secret spent
```

The mint verifies without seeing which issuance event produced this coin. Information-theoretically unlinkable. No ZK proof at point of use — one hash and one curve multiplication.

**Production deployments:**
- Cashu: Bitcoin/Lightning ecash protocol using BDHKE, multiple wallets in production
- Fedimint: Federated threshold variant, production on Bitcoin
- GNU Taler: Deployed at Maerki Baumann Bank, Switzerland. CHF ecash. GLS Bank Germany partner. v1.0 released May 2025. 11 partners across 8 European countries in the NGI TALER consortium.

**GNU Taler's regulatory insight**: Taler achieves the exact privacy/accountability model regulators want but that no blockchain has implemented: **buyer completely anonymous, merchant income fully recorded**. The exchange sees `(coin_issued, denomination, time)` and `(merchant_deposit, contract_hash, time)`. It cannot link buyer to merchant. Every merchant deposit is a signed record with contract terms — auditable by tax authorities without revealing buyers. Taler replaced its original RSA blind signature with Clause Blind Schnorr Signatures (2022) which are concurrently secure via the Algebraic Group Model.

**The Phantom Challenge Bug context**: The June 2025 Solana ZK ElGamal Proof Program soundness vulnerability was a Fiat-Shamir transcript failure — a prover-generated challenge not absorbed before the final challenge derivation (one-line fix: `transcript.append_scalar(b"c_max_proof", &c_max_proof)`). Chaumian BDHKE does not use Fiat-Shamir. There is no interactive proof transcript. The soundness class of bugs that took down Solana's ZK program is structurally absent from this construction.

**Applied to x402 machine payments**: An x402 endpoint issues BDHKE tokens backed by locked USDC. Agent pays, receives a blind-signed token, spends the token anonymously. Server cannot link payment to agent even with full RPC logs. No ZK proving infrastructure at spend time.

*Papers: Chaum CRYPTO 1982 proceedings. Taler PhD thesis Dold 2019 HAL. GNU Taler v1.0 taler.net/en/news/2025-01. Cashu protocol docs.cashu.space. BDHKE description delvingbitcoin.org/t/building-intuition-for-the-cashu-blind-signature-scheme/506.*

---

## 3. SnarkPack — Groth16 Proof Aggregation in Production, Not Applied to Privacy Payments

Filecoin aggregates **819 Groth16 proofs into a single 1-2KB proof** in production via SnarkPack. O(log N) on-chain verification instead of O(N) pairing checks. This has been running in Filecoin Lotus since ProveCommitSectorBatch. No privacy payment system has applied this.

**The construction (Gabizon & Williamson, ePrint 2021/529)**:

SnarkPack proves `∏ᵢ e(Aᵢ, Bᵢ) = T` using an inner pairing product argument. Given N Groth16 proofs sharing one verifying key:

- Aggregate proving time: ~0.5 seconds for 1024 proofs, highly parallelizable
- Aggregate proof size: ~1-2 KB for any N (versus N × 192 bytes individually)
- On-chain verification: O(log N) pairings (versus N × 3 pairings individually)
- Required: same verifying key across all proofs + one-time SRS of size 2N

**No circuit rebuild required.** Dark Null's existing Groth16 circuit works today.

For 1000 Dark Null withdraw proofs in a batch window:
- Without SnarkPack: 1000 × 3 pairing operations on-chain
- With SnarkPack: one aggregate proof (~2KB), ~30 pairing operations
- On-chain cost reduction: approximately 100x

**Production reference**: `nikkolasg/snarkpack` (Go), used by Filecoin Lotus. No maintained Rust crate exists — engineering gap, not a research gap. Porting from the Go implementation or wrapping Filecoin FFI is the path.

**Combinability**: SnarkPack aggregates existing Groth16 proofs without circuit changes. HyperNova (Section 7 below) would enable true recursive epoch proofs with circuit rebuild. Both directions from the same Groth16 foundation.

*Papers: SnarkPack ePrint 2021/529. Inner pairing products ePrint 2019/1177. Production: Filecoin Lotus nikkolasg/snarkpack.*

---

## 4. FCMP++ — The Biggest Privacy Advance in Blockchain History, January 2026, Almost Unknown Outside Monero

Monero activated **FCMP++ (Full-Chain Membership Proofs++)** via hard fork Q1 2026.

Before: each transaction input proved membership among **16 decoys**. Anonymity set = 16.

After: each transaction input proves membership among **every output ever created on Monero — over 100,000,000 UTXOs**.

The anonymity set increased from 16 to 100 million in a single hard fork.

### Construction: Curve Trees + Generalized Bulletproofs

The entire Monero UTXO set is organized into a tree. Each leaf is `(K, hash_to_point(K), C)` where K is the output key and C is the amount commitment. Membership proof via tree traversal with per-level re-randomization:

```
K' = K + a·T       (random scalar a)
I' = hash_to_point(K) + b·U
B  = b·V
```

The re-randomization hides which specific leaf is spent. The proof system:
- **Generalized Bulletproofs (GBPs)** with Pedersen Vector Commitments in arithmetic circuit proofs
- **Generalized Schnorr Protocol (GSP)** for linear combination consistency
- **helioselene** optimization: ~95% speedup via divisor-based circuit reduction
- Multi-input transaction proving time: dropped from 5+ minutes to ~1 minute

### CARROT Addressing

8-bit view tags eliminate 99.6% of irrelevant outputs during scanning. Tiered key hierarchy: incoming view key (identifies incoming outputs, cannot compute spend) / full viewing key (delegates proof generation) / spend key (authorization only). Light wallets served by scanning nodes that hold only the find-received key — cannot compute amounts.

### The Seraphis Architectural Insight Behind FCMP++

Membership proofs decoupled from spend authorization proofs. Membership proof computation (which leaf?) does not require the private key — runs on any device. Spend authorization requires the private key — runs on a hardware wallet. Transaction chaining before confirmation is enabled.

### Portability to Solana

FCMP++ uses secp256k1-compatible curve operations. Solana has curve25519 syscall support. Porting to Ristretto is cryptographically feasible. The UTXO accumulator over chain history is the engineering obstacle. The **Curve Trees primitive alone** — prove membership in a set of 100M commitments with a logarithmic proof, no trusted setup, using only Ristretto arithmetic — is buildable on Solana as a standalone proof primitive independent of the full FCMP++ protocol.

No public attempt to port Curve Trees to Solana or any account-model chain exists.

*Papers: FCMP++ specification gist.github.com/kayabaNerve/0e1f7719e5797c826b87249f21ab6f86. Curve Trees (Eagen et al.). CARROT stressnet github.com/seraphis-migration/monero. Monero hard fork Q1 2026 getmonero.org/2024/04/27/fcmps.html.*

---

## 5. Snowblind — Threshold Blind Signatures Where Even Full Signer Collusion Cannot Link Issuance to Spending

**Snowblind** (Crites, Komlo, Maller, Tessaro, Zhu — CRYPTO 2023, Springer LNCS, ePrint 2023/1228).

Before Snowblind: threshold blind signatures either required pairings or achieved only computational blindness (signers can't link in polynomial time, but theoretically could with enough computation).

Snowblind achieves **statistical blindness** in **pairing-free groups** (secp256k1, Ristretto). Every signer colluding with every other signer, sharing all partial signatures and randomness, still cannot link any issuance event to any spending event. Information-theoretic, not computational.

The token is one group element and two scalars. Signing protocol: two rounds among threshold signers, essentially threshold Schnorr with an added blinding layer.

**Applied to Dark Null's relayer network**: A k-of-n relayer set issuing payment authorization tokens via Snowblind:
- No relayer learns who is being authorized
- No coalition of relayers (even all N) can link a token to its issuance event
- Users select any k relayers with valid threshold proofs
- Token size: one group element + two scalars (marginally larger than a Schnorr signature)

This is a strictly stronger privacy property than threshold Groth16 proofs.

### Companion: Threshold BBS+ for Distributed Anonymous Credentials (ePrint 2023/602, IEEE S&P Oakland 2023)

BBS+ supports selective disclosure of signed attributes. Doerner et al. made BBS+ issuable by k-of-n signers without any issuer seeing credential contents. One client request, two signer rounds, implemented and benchmarked.

For agent identity credentials in a private x402 flow: an agent proves it holds a valid credential (issued by a threshold of authorities, none of whom know its contents) without revealing which credential or which authority issued it.

### Blind Multisignatures for Decentralized Anonymous Tokens (ACM CCS 2024, ePrint 2024/1406)

Multiple independent signers each blind-sign a token. No coalition can link issuance to redemption. The most recent construction in this line.

*Papers: Snowblind ePrint 2023/1228. Threshold BBS+ ePrint 2023/602. CCS 2024 ePrint 2024/1406. Stronger security EUROCRYPT 2025. Production reference: Fedimint (threshold BDHKE).*

---

## 6. Lelantus Spark — No Trusted Setup, Sliding Window Anonymity, EUROCRYPT 2023

Lelantus Spark (Jivanyan et al., ePrint 2021/1173, EUROCRYPT 2023) is a complete private payment protocol published at a top-tier academic venue with no trusted setup and a Rust implementation path via existing crates. Activated on Firo mainnet January 2024. Not on Solana or any account-model chain.

**What Spark has that Zcash Sapling does not:**

| Property | Zcash Sapling | Lelantus Spark |
|---|---|---|
| Trusted setup | Yes — MPC ceremony 2017-2018; catastrophic if compromised | None — DDH only |
| Incoming view key | Reveals address to viewer (linkable) | Does not reveal address |
| Full viewing key | Limited delegation | Delegates proof generation, not spending |
| Anonymity set | Global Merkle tree since genesis | Sliding windows of ~65K with 16K overlap |

**The sliding window insight**: Windows fill and new ones start, pre-seeded with ~16K commitments from the previous window. Old coins remain in the anonymity pool via overlap. Adoption compresses wait time for useful anonymity set. Two depositors at different times can be in the same window.

**The Curve Trees extension (research stage)**: Spark's one-of-many proofs are proposed to be upgraded to Curve Trees — giving Spark a global anonymity set covering the entire chain history, the same destination FCMP++ reached on Monero in Q1 2026.

**Porting feasibility to Solana**: Ristretto (curve25519-dalek) supports the arithmetic. `zkcrypto/bulletproofs` over Ristretto exists in Rust. Solana curve25519 syscall support is available. One-of-many proof verification would need splitting across instructions or a dedicated ZK program (same architecture as the ZK ElGamal Proof Program). The UTXO-in-account-model bridge is the engineering challenge, not a fundamental blocker.

*Papers: Lelantus Spark ePrint 2021/1173. EUROCRYPT 2023 Springer proceedings. Firo mainnet launch January 2024 firo.org/2024/01/18/spark-is-live.html.*

---

## 7. Witness Encryption — Pay-to-NP-Witness Is Now Practical for Algebraic Statements

The original Garg-Gentry-Sahai-Waters witness encryption (STOC 2013, ePrint 2013/258) used GGH13 multilinear maps — broken by annihilation attacks (Miles-Sahai-Zhandry, CRYPTO 2016, ePrint 2016/147). That was the "WE is impossible in practice" story.

What happened since:

**Signature-Based Witness Encryption (ASIACRYPT 2024, ePrint 2024/1477)**

Encrypt a message with respect to a tag and a set of signature verification keys. Decryptable only by a party holding valid signatures from a threshold of those keys. Practical. No multilinear maps. Constructed from pairing groups.

**Blockchain-Secured One-Time Programs (ePrint 2025/1064)**

Combines extractable WE with PoS blockchain state. A `T+1-eWEB` construction: a payment program that executes exactly once and self-destructs, whose decryption is contingent on the subsequent block's state. The payment instruction is a cryptographic one-time program — not a smart contract lock, a cryptographic one. No deployed payment system uses this.

**Cassiopeia: Practical On-Chain Witness Encryption (ePrint 2023/635)**

A trusted-committee approximation of WE. A committee holds a secret and releases it only upon a valid NP witness presented to a smart contract. Enables: "funds release only when someone presents a valid ZK proof of X" with no deployer holding the release key.

**Applied to Dark Null**: A payment gated on a ZK proof witness — funds release if and only if the prover knows a valid Groth16 proof for circuit C — becomes a cryptographically enforced primitive, not a smart contract check. The release condition is bound into the ciphertext at creation time.

*Papers: WE original ePrint 2013/258. Signature-based WE ePrint 2024/1477. One-time programs ePrint 2025/1064. Cassiopeia ePrint 2023/635.*

---

## 8. Penumbra ZSwap — Private DEX via Threshold Homomorphic Flow Encryption

Penumbra (Cosmos L1, mainnet 2024) built the most sophisticated private DEX mechanism on any proof-of-stake chain. Nothing close to this exists on Solana.

### The ZSwap Protocol

Users submit swap intents encrypted under a threshold ElGamal key held by the validator set. Each swap amount is split into four 16-bit limbs encrypted as Twisted ElGamal ciphertexts. Validators aggregate all encrypted swaps homomorphically: `C_agg = sum(Cᵢ)` — arithmetic over ciphertexts without decrypting any individual swap.

At block close, validators perform threshold decryption using Lagrange-coefficient secret shares, revealing only the **aggregate net flow per trading pair** — not individual amounts. A uniform clearing price is computed from aggregate flows. Users privately mint their output by proving in ZK they burned input funds and the output matches the public clearing price applied to their encrypted input.

No individual order is ever revealed. Front-running is structurally impossible. MEV within a block is eliminated for this asset pair.

### The Quaternary Poseidon TCT

Penumbra's note commitment tree is not a binary Merkle tree. Three-level **quaternary** tree — 4 children per node. Rate-4 Poseidon hashes 4 field elements simultaneously, matching branching factor exactly. Binary trees require more hash operations per inclusion proof; quaternary trees are Poseidon-native. Semi-lazy hashing combined with sparse representation achieves a reported ~4,000,000x sync speedup for clients skipping most blocks.

No Solana privacy project uses quaternary Poseidon trees.

### Re-Randomizable Spend Authorization

Every spend authorization key is re-randomized per transaction using decaf377-rdsa. Two spends from the same underlying key are computationally unlinkable at the authorization layer. Solana Token-2022 uses persistent account public keys — the linkability difference is fundamental.

*Docs: protocol.penumbra.zone. ZSwap: protocol.penumbra.zone/main/crypto/flow-encryption. TCT: penumbra.exchange/blog/tiered-commitment-tree.*

---

## 9. Functional Encryption for Compliance — The Key That Reveals the Sum Without Revealing the Transactions

**Publicly Auditable FE (ePrint 2023/629)**: Issue a key that lets a third party compute a specific function over encrypted payment data and prove to any observer the computation was done correctly.

For AML compliance:

```
Compliance key:  sk_f for f = "sum of amounts where amount > $10,000"
Input data:      Enc(tx_1), Enc(tx_2), ..., Enc(tx_n) (encrypted, never decrypted)
Output:          aggregate reporting figure
Verifier:        any party confirms result is correct, without seeing any transaction
```

No individual transaction is decrypted. Any observer can verify the aggregate was computed honestly.

**Inner-Product FE from DDH (Abdalla et al., PKC 2015)**: Decryption key computes `⟨y, x⟩` from `Enc(x)`. DDH assumption only — same as ECDH. No trusted setup. Implementations exist in arkworks ecosystem.

**Function-Hiding IPFE (2024)**: Hides both message AND function from the evaluator. The regulator presents the key, the system computes the inner product, nobody — including the regulator — can determine the individual inputs or the key vector from observing the computation.

**Flexible Threshold Multi-Client IPFE (arXiv 2510.15367, October 2025)**: Multiple parties encrypt independently. A combiner decrypts a joint function. Threshold adjustable without re-initialization. For compliance reporting across multiple relayers or exchanges.

Deployment barrier is governance (who holds the compliance key) and regulatory acceptance, not cryptography.

*Papers: FE original ePrint 2010/543. Publicly Auditable FE ePrint 2023/629. Inner-product FE PKC 2015. Flexible threshold arXiv 2510.15367.*

---

## 10. Homomorphic Netting — The ECB Confirmed It Works, Not Open Source, Not on Solana

Multilateral netting eliminates 80%+ of gross settlement obligations. Today it requires a clearinghouse that sees all obligations. Homomorphic netting computes the net over encrypted values.

**Decentralized Privacy-Preserving Netting on Blockchain (FC 2020)**: Pedersen commitments for amount hiding, ZK range proofs for validity, MPC over consortium banks. No single party learns any other's gross obligations. Proved secure in the UC framework. The canonical academic reference.

**ECB / Zama FHE Liquidity Matching Experiment (July 2024)**: Zama's Chief Academic Officer Nigel Smart announced at the FHE Summit in Brussels (July 10, 2024) that Zama collaborated with the ECB to test MPC-based private liquidity matching. The experiment ran Finnish banking economy interbank obligations through an MPC engine. Successful. Scaling to the full European economy was identified as the remaining challenge. Not open-source. Not on any blockchain.

**Solana's position**: The April 2025 Confidential Balances token extension brought Twisted ElGamal homomorphic encryption to SPL token balances. The arithmetic homomorphism is available at the token layer. A netting protocol using these primitives on Solana is architecturally feasible without new cryptographic infrastructure — pure engineering work.

*Papers: FC 2020 researchgate.net/publication/343026944. CT-RSA 2022 ePrint 2021/475. ECB announcement July 2024 coingeek.com/ecb-tests-blockchain-multiparty-computation.*

---

## 11. Diamond iO — First Post-Quantum Indistinguishability Obfuscation, Watching the Trajectory

iO is called the holy grail of cryptography because iO + one-way functions implies every other cryptographic primitive. The original 2013 GGH13 constructions were broken. The 2025 state:

**Diamond iO (ePrint 2025/236, PSE / Ethereum Foundation)**: First construction from pure lattice assumptions — LWE + evasive LWE + all-product LWE in the pseudorandom oracle model. No pairings. Post-quantum security assumption. Implemented at `github.com/MachinaIO/diamond-io` (v1.5.0, May 2025).

Benchmarks:

| Circuit depth | Obfuscation time | Evaluation time | Peak RAM |
|---|---|---|---|
| Depth 0 | 15.8 min | 2.5 min | 34.3 GB |
| Depth 10 | 129.3 min | 29.9 min | 225.1 GB |

Still orders of magnitude from practical payment circuits. But this is the first post-quantum iO construction that does not rely on broken multilinear maps. The Ethereum Foundation paid a $10K bounty in November 2024 for a practical implementation.

What iO enables for payments when practical (not now):
- Spending key embedded in an obfuscated payment program — cannot be extracted
- Deniable transaction encryption — coercion reveals a fake message, real message is hidden
- One-time payment programs that self-destruct after exactly one execution

*Papers: Diamond iO ePrint 2025/236. Machina iO github.com/MachinaIO/diamond-io. Jain-Lin-Sahai STOC 2021 CACM 2023. PSE bounty November 2024.*

---

## Precedence Summary

| Primitive | Status | Dependency |
|---|---|---|
| SnarkPack (Groth16 aggregation) | Production in Filecoin. No Rust crate. | Engineering only |
| BDHKE blind signatures for x402 | Production in Cashu/Fedimint. Not Solana. | Engineering only |
| Threshold BLS via BN254 syscalls | Syscalls live on Solana. Not wired to relayers. | Engineering only |
| Signature-based Witness Encryption | Practical (ePrint 2024/1477). Not deployed. | Engineering + adoption |
| Inner-product FE for compliance | Practical. Not in any payment system. | Engineering + regulatory |
| PIR + ORAM for access pattern privacy | Piano 12ms. ORAM 181ms. Not combined. | Engineering |
| Snowblind threshold blind signatures | CRYPTO 2023. No Solana implementation. | Engineering |
| Lelantus Spark one-of-many proofs | EUROCRYPT 2023. Firo mainnet. Not Solana. | Medium — circuit work |
| Publicly Auditable FE | Theory complete. Not deployed. | Medium |
| FCMP++ Curve Trees primitive | Monero Q1 2026. Ristretto port feasible. | Medium — ZK program |
| Penumbra ZSwap flow encryption | Cosmos mainnet 2024. Not Solana. | High — validator participation |
| HyperNova epoch proofs | sonobe library. No production. | High — circuit rebuild |
| Homomorphic netting | ECB experiment. Not open source. | High |
| Witness Encryption (general NP) | Signature-based practical. General still open. | Long |
| Diamond iO | 225GB RAM for depth-10. Trajectory visible. | Very long |

---

*All items above are research directions and reference observations. Shipping status of each is stated explicitly. If something in this document ships, this document will say so and link to the code or deploy transaction.*

*Sources compiled across: ePrint cryptology archive, IEEE S&P 2021-2024, CRYPTO 2023, EUROCRYPT 2023, ACM CCS 2024, FC 2020, Monero Research Lab, Firo research blog, Penumbra protocol documentation, GNU Taler documentation, Cashu protocol documentation, Flashbots research blog, TACEO research blog, CMU CSD blog, Piano PIR GitHub, Machina iO GitHub.*
