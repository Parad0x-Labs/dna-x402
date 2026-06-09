# .null Portal — Web0 Design System

> The single source of truth for every page in the .null marketplace and private-pay portal.
> Source of record: `apps/null-portal/tailwind.config.ts` + `apps/null-portal/app/globals.css`,
> lifted verbatim from `.clone/web0-internal/site/parad0x-null/index.html` (the public `.null` landing page).
> If a value isn't in here, it doesn't exist yet — mark it `TODO`, don't invent it.

Status: Public Beta. Non-custodial, capped, unaudited.

---

## 0. What this is

One system. One accent. One radius. One backdrop. Every new page consumes these tokens —
`bg-surf`, `border-line`, `text-dim`, `text-acc`, `rounded-web0`, `font-mono` — and introduces
**no new hexes**. If a value must change, change it in **both** the Tailwind config and the
`parad0x-null/index.html` CSS vars. They are kept in lockstep on purpose.

This is the **quiet Web0 terminal system (A)**. The colorful comic/zine homepage
(`Parad0xSplashHero`, `ComicChrome` — five neons, Bangers font, 0 radius, hard offset shadows)
is a **separate marketing skin** for `parad0xlabs.com`. The legacy "cosmic OS" tokens
(coral/violet/mint) in the marketing site's `app/globals.css` are a **dead third layer** — never
pull any of it into the portal. When systems conflict on a portal page, **the portal system wins**.

---

## 1. Principles + the anti-slop leash

The look is a **dark cypherpunk operator console**: near-black blue-greys, one mint-green accent,
heavy monospace for anything that's data, hairline borders instead of shadows, tight negative-tracked
display type, and a faint technical grid. High contrast. Information-dense. Verifiable.

Every rule below is enforceable on sight. A reviewer can reject a page by pointing at the broken rule.

### DO / DON'T (reviewer rejects on the DON'T)

| # | DON'T (AI-slop tell) | DO (Web0) |
|---|---|---|
| 1 | Purple / indigo / violet gradient anything (bg, hero text, buttons) | ONE mint accent `#2DD4A0` as solid fills + 1px borders. Only gradient allowed is the single 6%-alpha mint radial glow at the top of the page. |
| 2 | Glassmorphism — frosted `backdrop-blur` cards, translucent white overlays, shadow stacks as the surface treatment | Solid, opaque, stepped surfaces (`surf` / `surf2`) separated by crisp 1px lines. Zero `backdrop-filter` in the portal. Depth = hairline border + one tonal step. |
| 3 | Emoji-stuffed headings (🚀✨🔒), stock icon-grid "feature soup", emoji bullets | Glyphs that mean something: the mint `❯` prompt, a 7px status dot (`acc` available / `steel` taken), the blinking caret, uppercase mono eyebrows. |
| 4 | Oversized, vague, centered hero — "Empower your workflow" over a soft gradient | Left-aligned, tight, negative-tracked extrabold H1 saying a concrete thing, with a small uppercase steel eyebrow above it. Accent the load-bearing word. |
| 5 | Low-contrast gray-on-gray (`#888` on `#999`) that reads as unfinished | The deliberate `ink → dim → faint` ladder. Bright `ink` for what matters, `faint` only for true provenance microcopy. |
| 6 | Random radii (8px here, 24px there, a sharp corner over there) | Single `rounded-web0` (14px) for every card/panel/console. Sub-elements step down predictably to `lg`/`md`. |
| 7 | A Solana address / fee / tx sig / status rendered in the body sans font | Anything that is data, a literal, an address, a price, or a system status is **mono**. Prose stays sans. |
| 8 | Decorative ambient motion — parallax, floating blobs, breathing glows, shimmer sweeps | The entire vocabulary is: blinking caret + one spinner + color/border hover transitions. Nothing else. |
| 9 | One-idea-per-giant-card with lots of empty centered whitespace and a lone CTA | Pack TRUE facts: status + name + plain-English explainer + exact fee + on-chain provenance line, stacked tight. |
| 10 | Fake trust — "secure" shield badges, "powered by blockchain" lines | Prove it inline: real derived PDA linked to Solscan, real owner, real tx sig, "computed in your browser, just now". Verifiability **is** the brand. |
| 11 | Hype filler — "Unlock the power of…", "Seamlessly empower…" | Confident-terminal, lowercase, plain-declarative. Loading copy names the real machine action. Errors say what's wrong + what to do. |
| 12 | Nully cartoon dropped into a data console | Portal stays terminal-clean. Nully is a marketing-surface asset. The portal's only mark is the minimal mint-circle favicon. |

The three gates every surface must pass (from the brand voice bible):
- **Normie test** — would someone who's never heard "Solana" understand the first sentence?
- **Dunk test** — could a hostile reviewer screenshot this and prove it false? Loud ≠ false.
- **Nully test** — does it sound like us (loud, precise, receipt-obsessed) or like generic AI copy?

---

## 2. Color tokens

Thirteen tokens. No fourteenth. States are `acc` (good/available), `steel` (neutral/taken),
`danger` (error) — nothing else gets a color.

| Token | Hex | Tailwind | Role / usage |
|---|---|---|---|
| `--bg` | `#0B0E13` | `bg` | Page background. Near-black blue-grey. (`body` bg in globals.css lowercases to `#0b0e13`.) |
| `--bg2` | `#0E1219` | `bg2` | Slightly lighter inset — console header bars, register panel, result cards. |
| `--surf` | `#12161F` | `surf` | Primary card/surface fill — console body, cards, chips, list rows. |
| `--surf2` | `#161B26` | `surf2` | Secondary surface — suggestion chips, nested fills. |
| `--line` | `#222A37` | `line` | The workhorse 1px hairline on **everything** — cards, header, footer, console, row dividers. |
| `--line2` | `#2C3545` | `line2` | Stronger border — hover/emphasis, "miss"/neutral result state, ghost-button border. |
| `--ink` | `#EFF3F8` | `ink` | Primary text (near-white, faint blue tint). `body` color. `text-ink/90` for slightly muted body copy. |
| `--dim` | `#8A97A9` | `dim` | Secondary/muted — body lede, descriptions, inactive nav, console captions. Most-used muted tone. |
| `--faint` | `#5A6675` | `faint` | Tertiary/faintest — placeholders, meta lines, addresses, footer signature, provenance microcopy. |
| `--acc` | `#2DD4A0` | `acc` | **THE brand accent — mint green.** `.null` suffix, primary buttons, live dots, active nav, caret, links, focus borders. |
| `--acc-d` | `#1FAE84` | `acc-d` | Darker accent — accent **borders** (available card, register/success panel, live pill) + hover border on connect/ghost buttons (`hover:border-acc-d`). |
| `--steel` | `#7C93B5` | `steel` | Blue-grey "data" accent — eyebrows/kickers, mono metadata links (addresses), neutral/miss dots, "premium/invalid" labels. |
| `--danger` | `#E05C5C` | `danger` | The single error red. Registration errors, mismatch states. The only color outside the blue-grey + green system. |

### Hard-coded constants (NOT tokens — use these exact literals where noted)

| Literal | Where | Why it isn't a token |
|---|---|---|
| `#062018` | text color on every `bg-acc` button (`text-[#062018]`) | Very dark green so the label reads on bright mint. Always paired with `bg-acc`. |
| `#3DE6B0` | source-page `button:hover` background lift | In the portal this is replaced by `hover:brightness-110` on accent buttons — no discrete token. |
| `#2a3340` | the three console "window dots" (`bg-[#2a3340]`) | Decorative, not live status. |
| `#1c2430` | spinner ring track (`border`), top-color = `--acc` | Spinner-only. |
| `rgba(45,212,160,.15)` | logo/live-dot glow ring (`shadow-[0_0_0_3px_...]`) | The single accent glow in the system. |
| `rgba(45,212,160,.06)` | top-of-page mint radial glow | The one permitted gradient. |
| `rgba(255,255,255,.018)` | `.web0-grid` lines | Almost subliminal grid. |

**Banned in the portal:** `#8f73ff` (marketing violet), the comic 5-neon palette
(`#06D6F7`/`#FF2BD6`/`#21F08D`/`#FFD23F`/`#FF2E3E`), and the cosmic-OS tokens
(`#ff5c7b`/`#75f5bd`/`#5fbaff`). The green bridge — comic `#21F08D` ≈ portal `#2DD4A0` — is the
only reason the two brand systems read as one family; the portal still uses **only** `#2DD4A0`.

---

## 3. Typography

Two system stacks. No web-font purchase. The terminal feel comes from **mono usage**, not a typeface.

### Font stacks

```
--font-sans : ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif   /* body + display headings; <body class="font-sans"> */
--font-mono : ui-monospace, "SF Mono", Menlo, Consolas, monospace                       /* ALL chrome + data */
```

### When to use mono (the strongest anti-slop lever)

Mono is the brand's primary **voice** font. Use `font-mono` for: nav, labels, captions, **every
address / fee / tx sig / hash / price**, status labels, eyebrows-as-data, console lines, the `.null`
name input, suggestion chips, the footer signature. Body prose stays sans. **An on-chain address or
status pill not in `font-mono` = reject.**

### Type scale

| Role | Spec | Where |
|---|---|---|
| Hero H1 | `clamp(40px,8vw,76px)` · `font-extrabold` (800) · `tracking-[-3px]` · `leading-none` | Portal hero. Source landing goes bigger: `clamp(48px,8.5vw,92px)`. Pair with accent `.null` suffix + blinking caret. |
| Secondary H1 | `clamp(32px,6vw,52px)` · `font-extrabold` · `tracking-[-2px]` · `leading-none` | My-names page — same recipe, one notch down. |
| Result name | `text-2xl` (24px) → `text-3xl` (30px) on success · `font-extrabold` · `tracking-[-1px]` | Resolved/registered name display. `.null` in accent. |
| Tagline | `clamp(18px,2.6vw,26px)` · weight 700 · `tracking-[-.4px]` · `color: ink` | Hero deck line, accent on the load-bearing word. |
| Eyebrow / kicker | `12px` · `letter-spacing: 3px` · `UPPERCASE` · `text-steel` · `mb-5` | Above every section/hero. Almost a system label. |
| Status label | `font-mono` · `11px` · `letter-spacing: 1.5px` · `UPPERCASE` | In-card status (available/taken/premium/invalid/registered). Colored by state. Paired with a 7px dot. |
| Body lede | `15–16.5px` · `text-dim` · `leading-relaxed` (~1.65) · `max-w-[560–600px]` | Intro paragraph. Inline `<strong>` → `text-ink font-semibold`; accent single nouns, never whole sentences. |
| Command input | `font-mono` · `text-lg` (18px) · `tracking-[0.3px]` · transparent bg · no border | The `❯`-prefixed terminal input. Signature component. |
| Stat numeral | `36px` · weight 800 · `text-acc` · `tabular-nums` (count-up) | Stat tiles. Real, checkable numbers. |

The core type move: **huge + heavy + tight-negative H1** above a **tiny + wide-tracked + uppercase
steel eyebrow.** Reuse for every section header.

---

## 4. Spacing + layout

Information-dense and structured — sections divided by hairline rules, not airy gaps.

| Token | Value | Notes |
|---|---|---|
| Page container | `mx-auto max-w-[1060px] px-5 sm:px-7` | Canonical width + gutter. `main`/`header`/`footer` all share it. Source `.wrap` = `1060px / 0 28px`. |
| Section rhythm | `pt-12 sm:pt-16 pb-8` | Page sections. Source `.section` = `60px 0` with a `border-top` divider. |
| Hero rhythm | eyebrow `mb-5` · lede `mt-5` · console `mt-9` · panels `mt-4` | Source `.hero` = `64px 0 30px`. |
| Footer | `border-t border-line mt-16 py-8` | A 1px rule, not a margin gap. |
| Section divider | `border-t border-line` between sections | Top hairline, **never** large whitespace. Reinforces the operator feel. |

### Padding scale inside surfaces

| Surface | Padding |
|---|---|
| Console header bar | `px-4 py-3` |
| Console body | `p-4` |
| Register / success / state panels | `p-6` |
| Result cards | `px-5 py-4` |
| List rows | `px-4 py-4` |

General rule: **16–26px** inside surfaces — tighter on bars, roomier on commit panels.

### Marketing-section layout vocabulary (canonical, present in source; `TODO` to port into the React portal)

All share `border-line` + `rounded-web0` + `bg-surf`:
- **Flow** — `flex` row of bordered numbered steps (`01`–`05`, mono number in `acc`); collapses to stacked bottom-borders below 760px.
- **Stats** — `grid-cols-4` → `grid-cols-2` mobile; `tabular-nums` count-up cards.
- **Cards** — `grid-cols-3` → `1`; uppercase steel `.lab` label per card.
- **Agents** — two-col `1.05fr / .95fr` → `1fr`.
- **Layers** — two-col stack-status rows with `LIVE` / `SOON` pills.

### Density rule

Every card should carry real, verifiable facts. A card that could sit on any SaaS template because
it carries no on-chain data = reject. Build hierarchy from the **contrast ladder**, not size alone.

---

## 5. Radius / border / shadow

### Radius

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--web0` / `--r` | `14px` | `rounded-web0` | **THE signature radius.** All cards, panels, consoles, result drawers. |
| step-down | `8–12px` | `rounded-lg` (8) · `rounded-xl` (12) | Buttons, currency/connect controls, big CTAs. |
| small | `6–7px` | `rounded-md` (6) | Suggestion/manage pills, small tags. |

Rule: **14px = cards, ~8–12px = buttons, 6–7px = small chips/pills.** A panel that isn't
`rounded-web0`, or a radius value that appears nowhere else in the system, = reject. The comic system
uses 0-radius sharp corners — the portal **must** keep 14px.

### Border

The 1px hairline is the structural primitive. `border-line` (`#222A37`) everywhere by default;
`border-line2` (`#2C3545`) on hover/emphasis and neutral "miss" states; `border-acc-d` (`#1FAE84`)
on accent-positive states (available / success / register / live pill).

### Shadow / depth

**Borders over shadows.** Elevation = 1px solid `--line` + one tonal step. The system has exactly two
shadow uses, both intentional:
- Accent glow ring on the live/logo dot: `shadow-[0_0_0_3px_rgba(45,212,160,0.15)]`
- (source-only) hover lift: `translateY(-1px)` buttons / `translateY(-2px)` cards

No drop-shadow stacks. No glow-everywhere. This restraint is what reads as "crafted," not "glass-slop."

---

## 6. Motion

The **entire** portal motion vocabulary. Anything beyond this on a portal page = reject.

| Motion | Spec | Use |
|---|---|---|
| Caret blink | `4px × 0.82em` mint bar · `blink 1.1s steps(1) infinite` (`50%{opacity:0}`) | After the hero H1. `steps(1)` = hard on/off, reads as a real cursor, not a flourish. |
| Spinner | `26px` (source 30px) · `3px` ring `#1c2430` · `border-top-color: acc` · `spin 0.8s linear infinite` | RPC/availability/scanning states. Pair with `font-mono text-sm text-dim` honest status copy. |
| Hover transitions | `transition-colors` on borders/text (chips/nav/cards) · `transition` + `hover:brightness-110` on accent buttons · `hover:border-acc-d` on ghosts | Subtle. Hover reveals accent via **border**, not a fill color swap. |
| Signature ease | `cubic-bezier(.22,1,.36,1)` | The brand ease — used by source scroll-reveal. |

**Marketing-section motion (canonical, source-only; `TODO` to port):** scroll-reveal
`opacity 0→1 + translateY(18px)→0, .7s cubic-bezier(.22,1,.36,1)` via IntersectionObserver;
animated count-up stat numerals; typewriter hero cycling names (`parad0x → nulla → agent47 → …`).
These belong to the marketing-section language, not the transactional app chrome.

Banned (these live in the marketing site only): parallax, floating blobs, `breatheGlow`,
`glowDrift`, `shimmer`, animated gradients, scroll-jacking.

---

## 7. Component patterns

Copy-paste, token-only. These are Tailwind class strings using the tokens above.

### 7.1 Operator console (THE signature card)

The one element that makes a page unmistakably ours. Wrap primary interactive surfaces in it.

```tsx
<section className="border border-line rounded-web0 bg-surf overflow-hidden">
  {/* header bar */}
  <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-bg2 font-mono text-xs text-dim">
    <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
    <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
    <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
    <span className="ml-2">register any <b className="text-steel">.null</b> name — live, on Solana mainnet</span>
  </div>
  {/* body */}
  <div className="p-4">
    {/* command input / content */}
  </div>
</section>
```

### 7.2 Terminal command input

```tsx
<div className="flex items-center gap-3">
  <span className="text-acc text-lg font-mono select-none">❯</span>
  <input
    className="flex-1 bg-transparent border-none outline-none text-ink text-lg
               font-mono tracking-[0.3px] placeholder:text-faint"
    placeholder="type a name…"
  />
</div>
```

### 7.3 Buttons

```tsx
{/* PRIMARY — exactly one primary style. mint fill, dark-green label. */}
<button className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018]
                   hover:brightness-110 transition disabled:opacity-60">
  Register
</button>

{/* PRIMARY (header/compact variant) */}
<button className="rounded-lg bg-acc px-4 py-2 font-mono text-sm font-bold text-[#062018]
                   hover:brightness-110 transition disabled:opacity-60">
  Connect
</button>

{/* SECONDARY / GHOST — hover reveals accent via BORDER, not fill */}
<button className="rounded-xl border border-line2 px-5 py-3 font-semibold text-ink
                   hover:border-acc-d transition">
  On-chain proof ↗
</button>
```

More than one primary-button color, or a primary that isn't `bg-acc` with `text-[#062018]`, = reject.

### 7.4 Chip / toggle / suggestion

```tsx
{/* suggestion chip */}
<button className="font-mono text-xs rounded-md border border-line bg-surf2 px-3 py-1.5
                   text-dim hover:text-acc hover:border-line2 transition-colors">
  vault.null
</button>

{/* currency toggle — active */}
<button className="font-mono text-xs rounded-md border border-transparent bg-acc px-3 py-1.5
                   font-bold text-[#062018]">USDC</button>
{/* currency toggle — inactive */}
<button className="font-mono text-xs rounded-md border border-line bg-surf px-3 py-1.5
                   text-dim hover:border-line2 disabled:opacity-40 disabled:cursor-not-allowed">SOL</button>
```

Active = accent fill; inactive = mono + dim + hairline.

### 7.5 State result card

```tsx
{/* border switches by state: available/success → border-acc-d ; taken/error → border-line2 */}
<div className="border border-acc-d rounded-web0 bg-bg2 px-5 py-4">
  {/* status label + dot */}
  <div className="flex items-center gap-2 font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-3">
    <span className="w-[7px] h-[7px] rounded-full bg-acc" />
    available · forever
  </div>
  {/* big tracked name */}
  <div className="text-2xl font-extrabold tracking-[-1px] mb-2">
    vault<span className="text-acc">.null</span>
  </div>
  {/* plain-English explainer */}
  <p className="text-ink/90 text-[15px] leading-relaxed max-w-[520px]">
    owned by your wallet, on mainnet. No DNS, no host, no renewals, nobody can revoke it.
  </p>
  {/* mono faint provenance — steel address links */}
  <div className="mt-4 font-mono text-[11px] text-faint break-all">
    derives to <a className="text-steel hover:text-acc" href="#">8xKp…2Qf</a>
    {" "}— computed in your browser, just now
  </div>
</div>
```

### 7.6 Status dot + label

```tsx
{/* live */}
<span className="w-[7px] h-[7px] rounded-full bg-acc" />        {/* neutral: bg-steel */}
{/* logo/live dot with glow ring */}
<span className="w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
```

### 7.7 Header / nav

```tsx
<header className="mx-auto max-w-[1060px] px-5 sm:px-7">
  <div className="flex items-center justify-between py-5">
    {/* logo lockup: 7px acc dot + glow + mono wordmark */}
    <a className="flex items-center gap-2 font-mono text-sm font-bold tracking-wider">
      <span className="w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
      .null<span className="text-faint">/register</span>
    </a>
    {/* nav — lowercase mono; active = acc, inactive = dim hover ink */}
    <nav className="flex gap-5 font-mono text-xs sm:text-sm">
      <a className="text-acc">search</a>
      <a className="text-dim hover:text-ink transition-colors">my names</a>
    </nav>
  </div>
</header>
```

### 7.8 List / table row

```tsx
<div className="border border-line rounded-web0 bg-surf overflow-hidden">
  <div className="flex items-center justify-between px-4 py-4 border-b border-line last:border-b-0">
    <span className="font-extrabold tracking-[-0.5px]">vault<span className="text-acc">.null</span></span>
    <a className="font-mono text-xs text-steel hover:text-acc break-all">8xKp…2Qf ↗</a>
  </div>
</div>
```

### 7.9 Address / proof card (the core trust primitive)

Every claim renders as a copyable mono address + explorer link + status pill. Reuse verbatim for
program IDs, receipt TXs, domain records, payment proofs.

```tsx
<div>
  <div className="font-mono text-[11px] break-all text-steel bg-bg border border-line rounded-lg p-[9px]">
    H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm
  </div>
  <div className="mt-2 flex items-center gap-2">
    <a className="text-sm font-semibold text-acc hover:brightness-110">View on Solana Explorer →</a>
    <span className="font-mono text-[10px] text-acc border border-acc-d rounded-md px-[7px] py-[2px]">live</span>
  </div>
</div>
```

### 7.10 Badge / status pill

```tsx
{/* LIVE */}
<span className="font-mono text-[10px] tracking-[1px] text-acc border border-acc-d rounded-md px-[9px] py-[4px]">LIVE</span>
{/* SOON */}
<span className="font-mono text-[10px] tracking-[1px] text-steel border border-line2 rounded-md px-[9px] py-[4px]">SOON</span>
```

### 7.11 Kill-chips (signature positioning move — port for personality)

```tsx
<div className="flex flex-wrap gap-2">
  <span className="font-mono text-xs rounded-md border border-line bg-surf px-3 py-1.5
                   text-faint line-through decoration-line2">not web2</span>
  <span className="font-mono text-xs rounded-md border border-line bg-surf px-3 py-1.5
                   text-faint line-through decoration-line2">not web3</span>
  <span className="font-mono text-xs rounded-md border border-transparent bg-acc px-3 py-1.5
                   font-bold text-[#062018]">Web0 — the real one</span>
</div>
```

### 7.12 Modal — `TODO`

No modal/dialog component exists in the grounded source. When built, it MUST inherit:
`border border-line rounded-web0 bg-surf`, a `bg-bg2` console-style header bar, `p-6` body, and the
`#0B0E13` page behind it at reduced opacity (solid scrim, **no** `backdrop-blur`). Do not introduce a
new radius, shadow stack, or hue. Mark any other choice `TODO` until grounded.

### 7.13 Toast — `TODO`

No toast component exists in the grounded source. When built, it MUST be:
`border border-line2 rounded-web0 bg-bg2`, `font-mono text-sm`, with a 7px status dot
(`bg-acc` success / `bg-danger` error) and plain-English copy. Errors say what's wrong + what to do,
never an error code. Spec beyond this is `TODO`.

---

## 8. Voice + copy

**Loud voice. Tight claims. One story. Two front doors.** Maximum swagger on tone; every hard number
leashed to what is live and checkable. The `.null` marketplace + pay portal sit on the **terminal /
cypherpunk register** — lead terminal, borrow the comic swagger sparingly.

### Tone

Write like a confident terminal. Lowercase action labels. Loading copy names the **real** machine
action. Sovereignty stated flat. Honest about status.

- Labels: `search`, `my names`, `connecting…`, `sign in Phantom…`
- Loading: `deriving address & querying Solana mainnet…`, `scanning the registrar…`
- Sovereignty: `owned by your wallet, on mainnet. No DNS, no host, no renewals, nobody can revoke it. Register it once, own it forever.`
- Disclaimer (literal, every public surface): `Public Beta. Non-custodial, capped, unaudited.`

### Rule 3 — NO operator jargon on user surfaces (the most load-bearing copy rule)

Buttons say what they do. Banned in user UI: `x402`, `mandate`, `CLOB`, `pUSD`, `deposit intent`,
`bridge session`, `proof gauntlet`, `reconcile heartbeat`, `Atomic Settlement Ledger`. Jargon
(`x402`, ZK, receipt-DAG) is allowed **only** on an explicit "under the hood" / builder surface, and
even there, gently. Errors say what went wrong + what to do — never a code or a proof name.

Microcopy swaps (verb-first, plain, state the outcome + next action):

| Don't say | Say |
|---|---|
| Create deposit intent | Deposit |
| Submit mandate | Place bet |
| Bridge to pUSD | Send to Polymarket |
| Reconcile heartbeat (loading) | Settling… |
| `<proof-name / error code>` | That didn't go through — your balance is unchanged. Try again. |

### Capitalization

- Neutral marketplace/portal UI → **sentence-case**.
- Nully-voiced moments → **all-lowercase degen** (reserve for explicit Nully copy only).
- `@Parad0x_Labs` org voice → sentence-case, confident-founder.
- Product names stay cased: `$NULL`, `.null`, `Dark Null`, `Agent Passport`, `DNA x402`, `Web0`, `Solana`, `Arweave`.
- Display headlines may go ALL-CAPS for impact.

### Words

**USE:** rails, settle/settles, receipt, anchor, edge, the bag, war chest, lane, print(s), proof,
sign, hold, void, ghost, sovereign, censorship-resistant, seizure-resistant, permanent,
non-custodial, local-first, "you sign, you hold."

**AVOID:** `protocol`/`Groth16`/`x402` on consumer surfaces; fluff adjectives (`revolutionary`,
`seamless`, `cutting-edge`, `next-gen`); `vibes`; anything that reads like a SaaS template.
**Numbers beat adjectives** — "numbers, not vibes," "math, not promises."

### Banned claims (the RED leash — distinct from jargon)

- Never `audited` / `audit complete` → say `unaudited` (no schedule). Do **not** copy any "Q3 2026"-style stale date.
- Never `first x402 rail` / `first shielded pool` → only `first to COMBINE x402 + Groth16 + Agent Passport + on-chain receipt anchoring`.
- Never `buyback` / `buy-pressure` / `supports the price` / `yield` / `guaranteed` / `you will win` / price targets. For `$NULL` use only: `fixed supply`, `community war chest`, `usage-funded`, `not a price promise`.
- For ZK: `privacy settlement on devnet; mainnet gated on final trusted setup + audit` (the live verifying key is a placeholder).
- `coming soon` must mean **not live**. Use status verbs precisely: `live` / `devnet-stage` / `rolling out` / `the plan` — never inflate devnet to "live."

### Emoji discipline

At most one emoji per consumer message, often zero. **Never** in a heading. Status is a colored dot
+ mono label, not an emoji. The only sanctioned glyphs are `👻` (Nully), `🧾` (receipt), `📈`
(leaderboard) — and they do not belong in portal chrome.

### Taglines (verbatim)

- Master: **The road to Web0.**
- Builder/portal: **Quote. Pay. Verify. Receipt. Unlock.**
- Infra/trust: **Receipts, not faith.** · **math, not promises.**
- Sovereignty: **No house. No custody. You sign, you hold.**

---

## 9. Iconography + imagery

### Logo / favicon

The portal's only mark: a `32×32` rounded-square (`rx 7`) in `#0B0E13` with a centered `#2DD4A0`
circle (`r 8`) — inline SVG data-URI favicon. The **mint dot** is the recurring logo primitive,
echoed by every 7px status/logo dot in the UI.

```
data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>
  <rect width='32' height='32' rx='7' fill='%230B0E13'/>
  <circle cx='16' cy='16' r='8' fill='%232DD4A0'/>
</svg>
```

> Note: the cyan→blue Parad0x "conductor X" logo (`public/logo/logo.svg`) is a separate brand-mark
> palette, not a UI accent — do not use its gradient anywhere in portal chrome.

### Iconography

There is **no icon set.** Meaning is carried by typographic glyphs: the mint `❯` prompt, the 7px
status dot (semantic color), the blinking caret, and uppercase mono eyebrows. Numbered `01–05` flow
steps replace icon-soup. A decorative-only icon grid = reject.

### Backdrop

Exactly two fixed layers, both `pointer-events:none`, behind content:
1. **Mint glow** — `radial-gradient(1100px 520px at 50% -300px, rgba(45,212,160,.06), transparent 70%)`, `background-attachment: fixed`.
2. **`.web0-grid`** — `fixed inset-0 z-[-1]`, opacity `.5`, two 1px `rgba(255,255,255,.018)` linear-gradients at `54px × 54px`, radial-masked to fade below the hero. `color-scheme: dark`.

A background that draws the eye off the data, or grid lines bright enough to read as neon, = reject.

### Nully mascot

Nully (male liquid-chrome ghost-bot; 🔵 Blue calm / 🔴 Red chaos; "enforcer of edge") is a
**marketing-surface asset** — homepage, betting room, social cards. Keep the portal terminal-clean.

- Portal default: use the minimal mint-circle favicon for brand warmth, not cartoon art.
- The **single** allowed exception: Nully at **small** scale on an empty-state or success screen, to
  avoid a sterile feel — never comic-loud, never in a data console. Don't redesign him, don't switch
  his palette, don't spin up a new token-implying handle.
- Assets: `public/mascots/nully-*.png`, `public/emotes/null.svg`.

---

## TOKENS — single source of truth

> Change a value here **and** in the matching file. The two must stay in lockstep.

### CSS variables (`:root`) — origin: `parad0x-null/index.html:10–16`

```css
:root{
  /* surfaces */
  --bg:#0B0E13; --bg2:#0E1219; --surf:#12161F; --surf2:#161B26;
  --line:#222A37; --line2:#2C3545;
  /* ink */
  --ink:#EFF3F8; --dim:#8A97A9; --faint:#5A6675;
  /* accent + data */
  --acc:#2DD4A0; --acc-d:#1FAE84; --steel:#7C93B5;
  /* error */
  --danger:#E05C5C;
  /* radius */
  --r:14px;
  /* type */
  --font-sans: ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,sans-serif;
  --font-mono: ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}

/* hard-coded constants (not vars — use literals) */
/* on-accent text #062018 · button bright-hover #3DE6B0 · console dots #2a3340 */
/* spinner track #1c2430 · accent glow rgba(45,212,160,.15) */
/* page glow rgba(45,212,160,.06) · grid line rgba(255,255,255,.018) */

/* backdrop */
body{
  background:var(--bg); color:var(--ink); color-scheme:dark;
  font-family:var(--font-sans); line-height:1.55; -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(1100px 520px at 50% -300px,rgba(45,212,160,.06),transparent 70%);
  background-attachment:fixed;
}
.web0-grid{
  position:fixed; inset:0; z-index:-1; opacity:.5; pointer-events:none;
  background-image:
    linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);
  background-size:54px 54px;
  mask-image:radial-gradient(ellipse 75% 50% at 50% 0%,#000,transparent 75%);
}

/* motion */
.caret{display:inline-block;width:4px;height:.82em;background:var(--acc);
  margin-left:5px;vertical-align:-4px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.spinner{width:26px;height:26px;border:3px solid #1c2430;border-top-color:var(--acc);
  border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
```

### Tailwind preset — origin: `apps/null-portal/tailwind.config.ts:13–55`

```ts
// Palette + type lifted from site/parad0x-null/index.html so the portal
// matches the public .null landing page exactly. Change BOTH if you change either.
const web0Preset = {
  theme: {
    extend: {
      colors: {
        bg:    '#0B0E13', bg2:   '#0E1219',
        surf:  '#12161F', surf2: '#161B26',
        line:  '#222A37', line2: '#2C3545',
        ink:   '#EFF3F8', dim:   '#8A97A9', faint: '#5A6675',
        acc:   '#2DD4A0', 'acc-d': '#1FAE84', steel: '#7C93B5',
        danger:'#E05C5C',
      },
      fontFamily: {
        mono: ['ui-monospace','SF Mono','Menlo','Consolas','monospace'],
        sans: ['ui-sans-serif','-apple-system','Segoe UI','Inter','system-ui','sans-serif'],
      },
      borderRadius: { web0: '14px' },           // class: rounded-web0
      keyframes: {
        blink: { '50%': { opacity: '0' } },
        spin:  { to: { transform: 'rotate(360deg)' } },
      },
      animation: {
        blink: 'blink 1.1s steps(1) infinite',
        spin:  'spin 0.8s linear infinite',
      },
    },
  },
}
export default web0Preset
```

### Token cheat-sheet (paste-ready class strings)

```
card        : border border-line rounded-web0 bg-surf
panel inset : border border-line rounded-web0 bg-bg2
console head: flex items-center gap-2 px-4 py-3 border-b border-line bg-bg2 font-mono text-xs text-dim
btn primary : rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60
btn ghost   : rounded-xl border border-line2 px-5 py-3 font-semibold text-ink hover:border-acc-d transition
chip        : font-mono text-xs rounded-md border border-line bg-surf2 px-3 py-1.5 text-dim hover:text-acc hover:border-line2 transition-colors
eyebrow     : text-[12px] tracking-[3px] uppercase text-steel
hero h1     : text-[clamp(40px,8vw,76px)] font-extrabold tracking-[-3px] leading-none
status label: font-mono text-[11px] tracking-[1.5px] uppercase
mono address: font-mono text-[11px] break-all text-steel bg-bg border border-line rounded-lg p-[9px]
dot live    : w-[7px] h-[7px] rounded-full bg-acc        (neutral: bg-steel)
page column : mx-auto max-w-[1060px] px-5 sm:px-7
section      : pt-12 sm:pt-16 pb-8 border-t border-line
```

---

## Provenance

Every value above is grounded in:
- `apps/null-portal/tailwind.config.ts` (lines 13–55) — Tailwind token translation.
- `apps/null-portal/app/globals.css` (lines 5–71) — backdrop, grid, caret, spinner.
- `.clone/web0-internal/site/parad0x-null/index.html` (lines 10–161) — canonical CSS-var origin (verified).
- Component patterns: `SearchRegister.tsx`, `Header.tsx`, `MyNames.tsx`, `app/layout.tsx`.

Open `TODO`s (not yet grounded — do not invent): **Modal/dialog** (§7.12), **Toast** (§7.13), and
**porting** the marketing-section layouts (flow/stats/cards/agents/layers), scroll-reveal, count-up,
and typewriter motion into the React portal (§4, §6).
