# Ceremony — public announcements (drafts)

Fill the `[BRACKETS]`, then post. Two artifacts: the **contributor recruitment** + the
**beacon pre-commitment**. Keep both public + timestamped.

---

## 1. Contributor recruitment — short (X / farcaster)

> we're running the trusted-setup ceremony for the **privacy layer of agent payments** — the
> first one of its kind that we know of.
>
> our ZK gates let an agent prove it's *authorized, funded, and reputable* without revealing its
> wallet, balance, or history. but a groth16 setup is only as trustless as the people who built
> it. so we're not building it alone.
>
> **we need 7–15 independent contributors.** you run ONE command (~5 min), add your own
> randomness, publish your hash. the setup is sound if **even one** of you is honest — and your
> contribution lives in the public transcript forever.
>
> no token, no cost, no catch. just be part of the trust root for private agent payments.
>
> want in? reply / DM [@HANDLE]. runbook: [REPO_URL]/ceremony/README.md
>
> #x402 #ZK #Solana #web0

## 1b. Contributor recruitment — long (Discord / forum / blog)

**Help make private agent payments trustless — be a setup contributor.**

Coinbase's x402 sells *transparency* as a feature: every agent payment is a permanent public
record of who paid whom for what. We're building the opposite — a privacy layer where an agent
proves it's **authorized, funded, and has a real track record** without leaking its wallet,
balance, counterparties, or history. It's live and verifying on-chain today (devnet).

There's one catch with any Groth16 system: the setup uses secret randomness, and whoever knows it
could forge proofs. The fix is a **multi-party ceremony** — many independent people each add secret
randomness and destroy it. The setup becomes trustless as long as **a single contributor was
honest**. We can't credibly do that alone, so we're opening it up.

**What you do (≈5 minutes, your own machine):**
1. Install snarkjs (`npm i -g snarkjs`).
2. We hand you the current `.zkey`. You run one command:
   `snarkjs zkey contribute prev.zkey yours.zkey --name="<your handle>"`
   — type randomly when prompted, let your OS add entropy.
3. Publish your **Contribution Hash** (a Gist / tweet / signed note) and pass the file on.
4. Destroy your machine's temp state. Done.

**What you get:** a permanent, independently-verifiable place in the published ceremony transcript
— the trust root for the privacy layer of the agent economy. We'll also mint each verified
contributor a `<handle>.null` attestation. No payment, no token sale, no obligation.

**Why it's safe to contribute:** you never see anyone else's secret; you only add to a chain. Even
if every *other* contributor were malicious, your honest contribution keeps the whole setup sound.

Two circuits, one ceremony: the **access gate** (prove funded + authorized) and the **reputation
gate** (prove a private payment track record). Full runbook + verification:
**[REPO_URL]/ceremony/README.md**

Reply here or DM [@HANDLE] to claim a slot. We're aiming to start [DATE] and finalize within
~[N] days with a public beacon (below).

---

## 2. Beacon pre-commitment — POST THIS BEFORE THE CEREMONY STARTS

> **Trusted-setup beacon commitment — DNA x402 ZK ceremony**
>
> To finalize the ceremony with randomness no contributor (or we) can grind, we commit **now**,
> publicly and timestamped, to the following beacon:
>
> **The 32-byte block hash of Solana mainnet at slot `[SLOT]`** — the first finalized block at or
> after **[DATE] [TIME] UTC** (≈ [N] days after the last contribution closes).
>
> This value does not exist yet and cannot be predicted. When slot `[SLOT]` finalizes, anyone can
> fetch it and reproduce the final step:
>
> ```bash
> # the beacon hex = the block hash bytes at the committed slot
> solana block [SLOT] --url mainnet-beta --output json | jq -r .blockhash   # base58
> # -> decode base58 to 32 bytes -> hex -> that hex is the beacon
> snarkjs zkey beacon <circuit>_<N>.zkey <circuit>_final.zkey <BEACON_HEX> 10 -n="Final Beacon"
> ```
>
> Verify the whole ceremony yourself: `snarkjs zkey verify <circuit>.r1cs <ptau> <circuit>_final.zkey`
> → `ZKey Ok!`. Transcript + every contributor's hash: [REPO_URL]/ceremony/transcript/
>
> Committed [TODAY'S DATE] — Parad0x Labs (sls_0x). This message is the commitment; its timestamp
> is the proof we chose the slot before its hash was knowable.

### How to pick `[SLOT]`
Solana ≈ 2.5 slots/sec. Pick a slot ~`days × 86400 × 2.5` ahead of *now*, rounded, that lands a
few days after contributions close. Announce it in the post above and **do not change it**.

---

## Notes
- Post the **beacon commitment first**, before collecting any contribution — its whole value is
  that it predates the randomness.
- Keep the contributor list public as it grows (social proof + transparency).
- After the beacon + `ZKey Ok!`: regenerate the VK (`scripts/zk/*-vk-to-rust.mjs`), flip
  `mainnet_ready`, upgrade the gates. Only then is the setup trustless. (See `ceremony/README.md`.)
