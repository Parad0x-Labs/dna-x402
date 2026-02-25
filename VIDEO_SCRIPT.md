# Liquefy + DNA — Hackathon Video Script

**Total duration: ~120 seconds (2 minutes)**
**Format: Slide-based with AI voiceover + subtitles**
**Tone: Confident, technical, not hype — let the product speak**

---

## SLIDE 1 — HOOK (0:00–0:08)
**Visual:** Dark background. Text fades in: "AI agents have two unsolved problems."
**Voiceover:**
"AI agents have two unsolved problems. They can't pay each other. And the data they produce — logs, traces, artifacts — is an unverified mess."

---

## SLIDE 2 — INTRO (0:08–0:15)
**Visual:** Parad0x Labs logo. Then split screen: "Liquefy" on left, "DNA x402" on right. Tagline: "Compression. Payments. Verified."
**Voiceover:**
"We built two open-source protocols to fix both. Liquefy — and DNA x402. Here's what they do."

---

## SLIDE 3 — LIQUEFY TITLE (0:15–0:18)
**Visual:** Liquefy logo/text. Subtitle: "Entropy-Native Log Analytics"
**Voiceover:**
"Liquefy."

---

## SLIDE 4 — THE PROBLEM (0:18–0:27)
**Visual:** Explosion graphic showing JSONL logs, HTML reports, tool outputs, memory files flying everywhere. Text: "Agent trace explosions"
**Voiceover:**
"Every AI agent run produces a trace explosion. JSONL logs, tool outputs, HTML reports, memory dumps. Megabytes per session. Uncompressed. Unverified. Unsearchable."

---

## SLIDE 5 — 23 ENGINES (0:27–0:35)
**Visual:** Grid showing engine names: Apache, CloudTrail, Syslog, SQL, JSON, VPC Flow, etc. Center text: "23 Specialized Compression Engines"
**Voiceover:**
"Liquefy has twenty-three specialized compression engines. It auto-detects the data format — JSON, syslog, SQL, CloudTrail, VPC flow, Apache logs — and routes to the optimal engine. No configuration."

---

## SLIDE 6 — BIT-PERFECT (0:35–0:42)
**Visual:** Diagram: Original file → Compress → Decompress → checkmark "Bit-Perfect Match". Badge: "MRTV Verified"
**Voiceover:**
"Every compression is verified bit-perfect through Mandatory Round-Trip Verification. What goes in comes out identical. Guaranteed. Enterprise-certified."

---

## SLIDE 7 — TRACE VAULT (0:42–0:52)
**Visual:** Folder icon → arrow → .null archive file. Commands shown:
```
tracevault_pack.py ./runs/latest
tracevault_restore.py ./vault/latest
```
**Voiceover:**
"Trace Vault packs entire agent run folders into verified dot-null archives. Optional per-org encryption. Bit-perfect restore. One command to pack, one command to restore."

---

## SLIDE 8 — SEARCHABLE + SECURE (0:52–1:00)
**Visual:** Split screen. Left: search terminal showing `tracevault_search.py --query "error"`. Right: lock icon with "LeakHunter — Secret Scanning"
**Voiceover:**
"Search inside compressed vaults without restoring them. And LeakHunter scans for leaked credentials and secrets before anything gets archived. Security built into the pipeline, not bolted on."

---

## SLIDE 9 — DNA TITLE (1:00–1:03)
**Visual:** DNA x402 logo/text. Subtitle: "Payment Rails for AI Agents"
**Voiceover:**
"DNA x402."

---

## SLIDE 10 — THE PAYMENT PROBLEM (1:03–1:12)
**Visual:** Multiple agent icons with broken links between them. Text: "Agents can't pay agents. API keys don't scale. Credit cards don't automate."
**Voiceover:**
"AI agents need to pay for things — inference, storage, compute, data. But there's no standard. Every provider has its own auth, its own billing. Agents from different ecosystems can't transact."

---

## SLIDE 11 — ONE STANDARD (1:12–1:22)
**Visual:** Flow diagram:
```
Agent → GET /api → 402 Payment Required
Agent → Pay (USDC) → Receipt anchored on Solana
Agent → Access granted
```
**Voiceover:**
"DNA implements the x402 protocol on Solana. Any agent hits any API. Gets a price quote. Pays in USDC. Gets a cryptographic receipt anchored on-chain. Three HTTP calls. Universal. Programmable."

---

## SLIDE 12 — SETTLEMENT MODES (1:22–1:32)
**Visual:** Three columns:
| Netting | Transfer | Stream |
| Off-chain batched | Real on-chain USDC | Continuous access |
| $0.00001+ | $0.01+ | Time-locked |
| Zero SOL per tx | Verified on-chain | Streamflow |
**Voiceover:**
"Three settlement modes. Netting batches thousands of nano-payments off-chain — zero Solana fees per transaction. Transfer sends real on-chain USDC with cryptographic proof. Stream for continuous access via time-locked payments."

---

## SLIDE 13 — INTEGRATION (1:32–1:40)
**Visual:** Code snippet side by side:
```
// Buyer: 3 lines
fetchWith402(url, { wallet, maxSpend })

// Seller: 3 lines
app.use("/api", dnaPaywall({ price, recipient }))
```
**Voiceover:**
"Three lines to integrate as a buyer. Three lines as a seller. Any AI agent, any framework, any language that speaks HTTP."

---

## SLIDE 14 — MAINNET PROOF (1:40–1:50)
**Visual:** Stats dashboard:
```
50 agents  |  80 trades  |  84/84 passed
$0.00001 → $2.00  |  20 on-chain USDC transfers
80/80 receipts anchored  |  Zero failures
```
Solscan link shown.
**Voiceover:**
"Tested on Solana mainnet. Fifty agents. Eighty trades. Eighty-four out of eighty-four tests passed. Nano to normal amounts. Twenty real on-chain USDC transfers. Eighty receipts anchored. Zero failures."

---

## SLIDE 15 — TOGETHER (1:50–1:58)
**Visual:** Diagram showing the combined flow:
```
Agent pays via DNA → Accesses Liquefy vault
DNA audit logs → Liquefy bridge → .null vault (archived)
```
**Voiceover:**
"Together — DNA provides the payment layer, Liquefy provides the data layer. Agents pay to access vault services. Payment audit trails get archived into verified vaults. Full circle. Fully verifiable."

---

## SLIDE 16 — CLOSE (1:58–2:08)
**Visual:** Dark background. GitHub links:
```
github.com/Parad0x-Labs/dna-x402
github.com/Parad0x-Labs/liquefy-openclaw-integration
```
Program ID shown. Parad0x Labs logo.
Text: "Open source. MIT + BUSL-1.1. Built by Parad0x Labs."
**Voiceover:**
"Both protocols are open source and live on GitHub. Plug in, test it, break it. One standard for agent payments. One vault for agent data. Built by Parad0x Labs."

---

# PRODUCTION NOTES

**Voiceover style:** Clear, measured, slightly technical. Male or female — confident, not salesy. Think documentary narrator, not infomercial.

**Music:** Low ambient electronic. Subtle. Doesn't compete with voice. Suggest: royalty-free dark ambient or minimal techno underscore.

**Subtitles:** White text, dark semi-transparent background bar. Large enough to read on mobile. Sync to voiceover word-by-word or phrase-by-phrase.

**Transitions:** Simple fade or cut. No flashy transitions. Let the content carry it.

**Color palette:** Dark background (#0a0a0a), accent colors: cyan (#00d4ff) for Liquefy, green (#00ff88) for DNA, white for text.

**Resolution:** 1920x1080 (16:9) for YouTube/hackathon. Also export 1080x1920 (9:16) if posting to X/TikTok.

---

# HOW TO ASSEMBLE (fastest path)

1. **CapCut (free):**
   - Create new project → add slides as image backgrounds
   - Paste each voiceover section into CapCut's "Text to Speech"
   - Auto-generate subtitles with "Auto Captions"
   - Add ambient music from their library
   - Export → done in ~15 minutes

2. **Canva:**
   - Use "Video Presentation" template
   - Add slides → use "Present and Record" or paste script into AI voiceover
   - Enable auto-subtitles
   - Export as MP4

3. **HeyGen (most polished):**
   - Paste full script
   - Choose AI avatar or voice-only mode
   - Auto-generates subtitles
   - Export → ready in 5 minutes
