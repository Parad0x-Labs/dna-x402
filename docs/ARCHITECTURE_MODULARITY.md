# Architecture — modularity + blast radius (pre-audit)

*Question this answers: if one program fails an audit, what else dies with it? Verified from
program `Cargo.toml` deps + CPI sites, not assumed.*

## Three independent pillars
Each pillar stands or falls on its own — no cross-pillar runtime dependency:

1. **x402 payments** — `dark_x402_access_gate` (Groth16 access proof) · `receipt_anchor` (6HSRGivd, receipts)
2. **.null identity** — `null_registrar` (v1 domains) · `null-auction` (resale)
3. **privacy reputation** — `receipt_commitment_tree` (root source) · `dark_reputation_gate` (track-record proof) · `dark_nullifier_record` (single-use)

## Coupling map (the only couplings that exist)
| Program | Shared code | CPIs out | Reads (value only) |
|---|---|---|---|
| `dark_x402_access_gate` | `dark-groth16-core` | — | — |
| `dark_reputation_gate` | `dark-groth16-core` | → `dark_nullifier_record` | tree root |
| `dark_nullifier_record` | none | — | — |
| `receipt_commitment_tree` | none | — | — |
| `null_registrar` | none | — | — |
| `null-auction` | none | → `null_registrar` | — |
| `receipt_anchor` (6HSRGivd) | none | — | — |

Everything not listed as a dependency is `solana-program` only. **5 of 7 programs have zero outward
coupling.** Each program has its own program ID + upgrade authority → any one can be paused,
upgraded, or abandoned **without redeploying the others.**

## Blast radius — "if X fails its audit"
| Fails audit | Impact | Survives untouched |
|---|---|---|
| **`dark-groth16-core`** (the verifier lib) | both ZK gates (access + reputation) | nullifier, tree, registrar, auction, receipt_anchor — *the entire payment rail + identity* |
| `dark_reputation_gate` | private reputation only | everything else |
| `receipt_commitment_tree` | reputation roots only (the gate's crypto is fine) | everything else |
| `dark_nullifier_record` | reputation **degrades** (loses single-use); access gate unaffected | everything else |
| `null_registrar` | auction's domain custody | both gates, tree, nullifier, receipt_anchor |
| `null-auction` | resale only | **everything else** |
| `dark_x402_access_gate` | x402 access gating only | everything else |
| `receipt_anchor` | x402 receipt anchoring only | everything else |

**So yes — a single component's audit failure is contained.** The worst case is the shared
`dark-groth16-core` taking down *both* ZK gates — but even then the payment rail (`receipt_anchor`),
identity (`registrar`/`auction`), nullifier, and tree all keep working.

## The one concentration — and how it's already handled
`dark-groth16-core` is the only shared-fate crypto. Mitigations (already in the roadmap):
- It's small + single-purpose (alt_bn128 Groth16 verify) → audit it **hardest**.
- Planned swap to **Lightprotocol/groth16-solana** (audited, backs sp1-solana) + **light-poseidon**
  (Veridise-audited) — turns the one liability into an audited component.
- It's a **compiled library**, not a deployed program: a fix = rebuild + upgrade the two gates;
  it cannot be exploited as a standalone attack surface.

## Fail-closed (failures propagate as errors, never silent corruption)
- The reputation→nullifier CPI is atomic: if `dark_nullifier_record` errors, the whole tx reverts —
  the gate never "succeeds without recording." Same for auction→registrar.
- Verifiers return `Err(Custom(1))` on any bad proof; stub gates fail-closed (per `DARK_CRATES_STATUS`).

## Audit guidance
Audit **per program**, independently. Order by blast radius: `dark-groth16-core` first (shared by 2),
then each gate, then the standalone programs in any order. A finding in one is a scoped fix to one
program ID — not a rewrite of the stack.
