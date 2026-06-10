# web0.null — Product & Design Brief

> Self-contained handoff. Everything a designer (human or AI) needs to continue building the web0.null portal without prior context. Pair this with `DESIGN_SYSTEM.md` (same folder) for the exact token/component spec.
>
> **Posture, stated once and meant everywhere:** Public Beta. Non-custodial. Unaudited. Devnet for the private-payment + marketplace rails; the existing `.null` registrar is live on Solana mainnet. Do not write "anonymous", "untraceable", or "audited" anywhere in the product.

---

## 1. What web0.null is

The flagship app of **Web0** — the "internet you actually own." One product, two hooks:

1. **"The web, without the rent."** Claim a `.null` name, own it as a Solana account (no DNS, no registrar, nobody can revoke it), point it at a site on Arweave, and it's online forever for **$0/month**. The portal itself is the proof — it runs this way.
2. **"Your name is public. Your money isn't."** Pay anyone by their `.null` name and the funds land on a **fresh one-time stealth address** only they can find and spend. The name is the public handle; the money stays unlinkable. The anti-Venmo.

A `.null` name is therefore three things at once: a **username**, a **website**, and a **private payment address**.

---

## 2. The screens

| Screen | Status | What it does |
|---|---|---|
| **Landing** (`/`) | built (WOW) | hero "the web, without the rent." → animated `$0.00/mo` cost ledger → Web2-vs-Web0 comparison → on-chain proof (real registrar id + Solscan) → live name search |
| **Register** | built | search a name, see availability + fee + derived PDA, register via Phantom (mainnet) |
| **`/pay`** (private send) | built, devnet | type `alice.null` → resolves her stealth meta → **derives a fresh one-time address in the browser** → sends via Phantom. Two privacy tiers (below). |
| **My Names** | built | names your wallet owns, read live from chain |
| **Sell** | planned | list a name: buy-now price *or* starting bid; 0.01 SOL flat listing fee |
| **Browse** | planned | the marketplace — open listings + premium auctions, bid/buy |

A **cluster switcher** (mainnet ⇄ devnet pill in the header) is built: landing/register default mainnet; `/pay` auto-pins devnet where the stealth rail is live.

---

## 3. Private-pay tiers (be exact about what each hides)

- **Basic · LIVE** — hides the **recipient**. Funds go to a fresh one-time address per payment; two payments to one name never share an on-chain address. **The sender (your wallet) is still the visible on-chain payer** — say this plainly in the UI; it's normal for a basic send.
- **Max private · SOON** — routes the payment through a **shielded pool** so the **sender and amount are hidden too**. Gated on a multi-party trusted-setup ceremony + an audit before it touches mainnet. Show it as a real, disabled "coming" tier — never imply it's live.

The honest one-liner for the whole thing: *privacy you keep or blow.* A stealth address only protects you if you don't sweep it into a reused, doxxed wallet — so the UX should make the private path the easy path and warn loudly before a cash-out that re-links funds.

---

## 4. The marketplace (economics — locked)

| Action | Fee | On sale | On no sale |
|---|---|---|---|
| **List** a name (buy-now or auction) | **0.01 SOL flat, non-refundable** (anti-spam toll) | protocol **5%**, seller **95%** | protocol keeps the 0.01 |
| **Premium auction** (1–3 char names) | buyer locks ≥ floor at create | 100% → treasury, mint-on-settle | per auction rules |

- Premium floors: **$10k / $3k / $500** for 1 / 2 / 3-char.
- **Custody = delegation, NOT escrow.** A listed name **stays in the seller's wallet**; they just authorise the marketplace to transfer it *if* it sells. A buy is atomic (pay + transfer or neither). Delist anytime.
- **Optional "escrow-as-a-service" (1% fee)** — a separate opt-in product for OTC deals: both parties use the contract as a neutral middleman for a pre-arranged sale.

---

## 5. Design language (the short version — full spec in `DESIGN_SYSTEM.md`)

A **dark cypherpunk operator console.** Crafted, sharp, information-dense, verifiable. The WOW comes from craft + motion + typography + depth, never from decoration.

**Tokens (the single source of truth is `tailwind.config.ts`):**
- bg `#0B0E13` · bg2 `#0E1219` · surf `#12161F` · surf2 `#161B26`
- line `#222A37` · line2 `#2C3545`
- ink `#EFF3F8` · dim `#8A97A9` · faint `#5A6675`
- **accent (the one and only): mint `#2DD4A0`** · acc-d `#1FAE84` · steel `#7C93B5` · danger `#E05C5C`
- one radius: `rounded-web0` = **14px** · text on mint buttons = `#062018`

**Enforceable anti-slop rules (reject a page on sight if it breaks one):**
1. ❌ purple/indigo gradients → ✅ one mint accent, solid fills + 1px borders (the only gradient allowed is a single ~6%-alpha mint radial glow at the top of a page)
2. ❌ glassmorphism / backdrop-blur / shadow stacks → ✅ solid stepped surfaces + hairline borders for depth
3. ❌ emoji-stuffed headings, stock icon-grid "feature soup" → ✅ meaningful glyphs: the mint `❯` prompt, a 7px status dot, a blinking caret, uppercase mono eyebrows
4. ❌ giant centered vague hero → ✅ left-aligned, tight, negative-tracked extrabold H1 saying a concrete thing, load-bearing word in mint
5. ❌ random radii → ✅ the single 14px radius everywhere
6. ❌ a Solana address / fee / sig / status in the body sans font → ✅ **mono** for anything that is data; prose stays sans
7. ❌ ambient parallax/blobs/shimmer → ✅ the whole motion vocabulary is: blinking caret + one spinner + the count-up + color/border hover transitions
8. ❌ fake "🔒 secure" badges → ✅ prove it inline (real PDA → Solscan, "computed in your browser, just now")

**Three gates every surface must pass:** the **normie test** (would someone who's never heard "Solana" get the first sentence?), the **dunk test** (could a hostile screenshot prove it false?), the **nully test** (does it sound like us — loud, precise, receipt-obsessed — or like generic AI copy?).

**Voice:** lowercase, terse, plain-declarative, confident-terminal. No hype filler ("unlock the power of…"), no mid-sentence bolding of hype, no AI-slop tics — especially avoid the "it's X, not Y" contrast and openers like "great question." Loading copy names the real machine action. Errors say what's wrong + what to do.

**Brand marks:** the wordmark is `web0.null` (mint dot + mono). "Nully" is a mascot for marketing surfaces — keep the *portal* terminal-clean; its only mark is the mint-dot brand primitive, not cartoon art.

---

## 6. What's real under the hood (so design knows what it's selling)

All devnet-verified on-chain unless noted:
- **NullPay** — ed25519 one-time stealth addresses, native Solana signing, no trusted setup. Powers `/pay`. (Hides recipient.)
- **Dark Relay Rail** — Groth16 shielded pool: hides sender + amount; permissionless relayers (recipient never signs); beacon-sealed **dry-run** ceremony VK (not yet trustless). Powers "max private".
- **Federated eNULL** — k-of-n guardian ecash: hides sender + amount, **ceremony-free**; a critical drain bug was found in adversarial testing and fixed + verified reverting on-chain.
- **Fusion** — one shielded-pool withdraw that hides all three legs (sender + amount + recipient) in a single tx; verified by the on-chain account list (payee wallet absent from the withdraw tx).
- **Marketplace program** (`null-auction`) — `CreateListing` / `BuyNow` / 0.01 listing fee / 95-5 split already written; pending verify + frontend wiring.
- **Registrar** — `.null` names live on Solana **mainnet**; the stealth-meta-enabled registrar runs on devnet.

**The one defensible "first" claim** (survived an adversarial prior-art sweep, use with the date + caveats): *"As of June 2026, the first Solana rail to resolve a human-readable name directly to a one-time stealth address — recipient-unlinkable, native settlement, no mixer or pool."* (Re-verify Umbra + stealthr.xyz before publishing it loud.)

---

## 7. What to design next

1. **Sell + Browse** — the marketplace surfaces (list flow with buy-now/bid + 0.01 fee; the browse grid + premium-auction cards). On-brand, on the tokens above.
2. **`/pay` success + polish** — a sent state, the ephemeral-key receipt, a recipient view-key "scan my incoming" flow, and the burner-discipline warning UX.
3. **A real "max private" teaser** — design the disabled tier so it reads as *coming*, with the honest ceremony/audit gate.

Keep every new screen inside §5. If a value isn't in `tailwind.config.ts`, it doesn't exist yet — mark it TODO, don't invent it.
