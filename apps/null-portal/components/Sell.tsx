"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { useCluster } from "./ClusterProvider";
import { getConnectionForCluster, getOwnedNames, type OwnedName } from "@/lib/chain";
import { shortAddr, solscanAddr, ixCreateListingSol, ixCreateSolAuction, auctionRegistrarFor, TREASURY } from "@/lib/null-sdk";
import { explorerTx } from "@/lib/cluster";
import { signAndSendInstructions } from "@/lib/wallet";

/* ── marketplace economics (fixed, presented to the seller verbatim) ─────────── */
const LIST_FEE_SOL = 0.01; // flat, NON-REFUNDABLE anti-spam toll
const PROTOCOL_PCT = 5; // protocol cut on a sale
const SELLER_PCT = 100 - PROTOCOL_PCT; // 95
const ESCROW_PCT = 1; // optional escrow-as-a-service

// premium floors for 1–3 char names (buyer locks ≥ floor at create; 100% → treasury)
const PREMIUM_FLOOR_USD: Record<number, number> = { 1: 10_000, 2: 3_000, 3: 500 };

type ListingType = "buy-now" | "auction";

// auction phase lengths (commit phase = reveal phase = the chosen value). A bid is
// SEALED during commit, then opened during reveal; settle runs after reveal ends.
const DURATIONS: { key: string; label: string; secs: number }[] = [
  { key: "2m", label: "2 min · test", secs: 120 },
  { key: "1h", label: "1 hour", secs: 3600 },
  { key: "12h", label: "12 hours", secs: 43200 },
  { key: "1d", label: "1 day", secs: 86400 },
  { key: "3d", label: "3 days", secs: 259200 },
];

const accents = ["mint", "lime", "cyan", "magenta"] as const;
type Accent = (typeof accents)[number];

const DOT: Record<Accent, string> = {
  mint: "bg-mint",
  lime: "bg-lime",
  cyan: "bg-cyan",
  magenta: "bg-magenta",
};
const NAMECOLOR: Record<Accent, string> = {
  mint: "text-mint",
  lime: "text-lime",
  cyan: "text-cyan",
  magenta: "text-magenta",
};
const RING: Record<Accent, string> = {
  mint: "border-mint shadow-[0_0_0_4px_rgba(61,255,176,0.14)]",
  lime: "border-lime shadow-[0_0_0_4px_rgba(198,255,46,0.14)]",
  cyan: "border-cyan shadow-[0_0_0_4px_rgba(25,227,255,0.14)]",
  magenta: "border-magenta shadow-[0_0_0_4px_rgba(255,46,126,0.14)]",
};

export function Sell() {
  const { address, connect, connecting, phantomAvailable } = useWallet();
  const { cluster } = useCluster();

  const [names, setNames] = useState<OwnedName[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [picked, setPicked] = useState<string | null>(null); // pda of chosen name
  const [listingType, setListingType] = useState<ListingType>("buy-now");
  const [price, setPrice] = useState("1.5");
  const [durKey, setDurKey] = useState("1d"); // auction phase length
  const [escrowOptIn, setEscrowOptIn] = useState(false);

  // on-chain listing tx state
  const [listing, setListing] = useState(false);
  const [listSig, setListSig] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async (owner: string, c: typeof cluster) => {
    setLoading(true);
    setError(null);
    try {
      // listable names live under the registrar the AUCTION pairs with (sha256-v2).
      // gpaResilient (inside getOwnedNames) picks a gPA-capable RPC + caps the call.
      const owned = await getOwnedNames(c, new PublicKey(owner), auctionRegistrarFor(c));
      setNames(owned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (address) load(address, cluster);
    else {
      setNames(null);
      setPicked(null);
    }
    setListSig(null);
    setListError(null);
  }, [address, cluster, load]);

  const selected = useMemo(
    () => names?.find((n) => n.pda === picked) ?? null,
    [names, picked],
  );

  // a 1–3 char name is auction-only premium → force auction + show the floor.
  const charLen = selected ? selected.name.length : 0;
  const isPremium = charLen >= 1 && charLen <= 3;
  const floorUsd = isPremium ? PREMIUM_FLOOR_USD[charLen] : null;

  useEffect(() => {
    if (isPremium) setListingType("auction");
  }, [isPremium]);

  const priceNum = useMemo(() => {
    const n = Number(price);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [price]);

  const sellerSol = useMemo(
    () => (priceNum * SELLER_PCT) / 100,
    [priceNum],
  );
  const protocolSol = useMemo(
    () => (priceNum * PROTOCOL_PCT) / 100,
    [priceNum],
  );
  const escrowSol = useMemo(
    () => (escrowOptIn ? (priceNum * ESCROW_PCT) / 100 : 0),
    [escrowOptIn, priceNum],
  );
  const netSellerSol = sellerSol - escrowSol;

  // SOL buy-now AND SOL sealed-bid auction are both wired (devnet-proven). Premium
  // (1–3 char) stays "soon". For an auction, `price` is the starting / minimum bid.
  const canList = !!selected && !isPremium && priceNum > 0 && (listingType === "buy-now" || listingType === "auction");
  const dur = DURATIONS.find((d) => d.key === durKey) ?? DURATIONS[3];

  const onList = useCallback(async () => {
    if (!address || !selected || !canList) return;
    setListError(null);
    setListing(true);
    try {
      const conn = getConnectionForCluster(cluster);
      const lamports = BigInt(Math.round(priceNum * LAMPORTS_PER_SOL));
      const owner = new PublicKey(address);
      const ix =
        listingType === "auction"
          ? await ixCreateSolAuction(cluster, owner, selected.name, lamports /* min bid */, 0n /* no reserve */, dur.secs, dur.secs, TREASURY)
          : await ixCreateListingSol(cluster, owner, selected.name, lamports, TREASURY);
      // CreateListing inits the auction account, CPIs the registrar escrow transfer,
      // and pays the listing fee — give it headroom.
      const sig = await signAndSendInstructions({ connection: conn, owner: address, instructions: [ix], computeUnits: 250_000 });
      setListSig(sig);
      setTimeout(() => load(address, cluster), 1500);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListing(false);
    }
  }, [address, selected, canList, cluster, priceNum, listingType, dur.secs, load]);

  return (
    <section className="pt-12 pb-10 sm:pt-16">
      {/* eyebrow — exact v4 pattern */}
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-lime" />
        the .null marketplace ·{" "}
        <span className="text-cyan">list it, the contract holds it, you keep {SELLER_PCT}%</span>
      </span>

      {/* hook */}
      <h1 className="mt-5 max-w-[15ch] font-display text-[clamp(46px,9vw,118px)] font-black leading-[0.84] tracking-[-0.035em] lowercase">
        sell a <span className="text-lime">.null</span> name.
      </h1>

      <p className="mt-6 max-w-[62ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
        list a name you own for a flat{" "}
        <b className="font-semibold text-paper">{LIST_FEE_SOL} SOL</b> toll. while it&apos;s
        listed the name is{" "}
        <b className="font-semibold text-paper">held by the listing contract</b> — off the
        market until it <b className="font-semibold text-paper">sells</b> or you{" "}
        <b className="font-semibold text-paper">delist</b>.{" "}
        <span className="font-semibold text-lime">
          a sale pays you {SELLER_PCT}%, atomically.
        </span>
      </p>

      <div className="mt-9 flex flex-col gap-5">
        {/* ── STEP 1 — pick a name ─────────────────────────────────────────── */}
        <StepShell n={1} title="pick a name to list" sub="read live from your wallet on mainnet">
          {!address ? (
            <ConnectPanel
              connect={connect}
              connecting={connecting}
              phantomAvailable={phantomAvailable}
            />
          ) : loading ? (
            <div className="flex items-center gap-3 px-1 py-3">
              <span className="spinner" />
              <span className="font-mono text-sm text-dim">
                scanning the registrar for names you own…
              </span>
            </div>
          ) : error ? (
            <div className="rounded-web0 border-[1.5px] border-magenta/50 bg-magenta/[0.07] p-5">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-magenta">
                <span className="h-[7px] w-[7px] rounded-full bg-magenta" />
                couldn&apos;t load
              </div>
              <div className="break-words text-sm text-paper">{error}</div>
              <button
                onClick={() => load(address, cluster)}
                className="mt-4 rounded-lg border-[1.5px] border-line px-4 py-2 font-mono text-xs font-bold text-dim transition hover:-translate-y-0.5 hover:border-transparent hover:bg-mint hover:text-ink0"
              >
                retry
              </button>
            </div>
          ) : names && names.length > 0 ? (
            <div className="flex flex-col gap-3.5">
              <div className="flex items-center justify-between font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-dim">
                <span className="inline-flex items-center gap-2 text-mint">
                  <i className="h-[7px] w-[7px] animate-pulsering rounded-full bg-mint" />
                  {names.length} name{names.length === 1 ? "" : "s"} you can list
                </span>
                <span className="text-faint">owner {shortAddr(address)}</span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {names.map((n, i) => {
                  const accent = accents[i % 4];
                  const active = n.pda === picked;
                  return (
                    <button
                      key={n.pda}
                      onClick={() => setPicked(n.pda)}
                      className={`group flex flex-col items-start gap-3 rounded-web0 border-[1.5px] bg-bg2/65 p-5 text-left backdrop-blur-md transition hover:-translate-y-0.5 ${
                        active ? RING[accent] : "border-line hover:border-line2"
                      }`}
                    >
                      <span className="flex w-full items-center justify-between">
                        <span className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
                          <i className={`h-[7px] w-[7px] rounded-full ${DOT[accent]}`} />
                          owned · forever
                        </span>
                        {active && (
                          <span
                            className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-ink0 ${
                              {
                                mint: "bg-mint",
                                lime: "bg-lime",
                                cyan: "bg-cyan",
                                magenta: "bg-magenta",
                              }[accent]
                            }`}
                          >
                            picked
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 font-display text-[clamp(26px,4vw,40px)] font-black leading-[0.9] tracking-[-0.03em] lowercase">
                        <span className="block truncate">{n.name}</span>
                        <span className={NAMECOLOR[accent]}>.null</span>
                      </span>
                      <span className="break-all font-mono text-[11px] text-faint">
                        {shortAddr(n.pda)}
                        {n.name.length <= 3 && (
                          <span className="ml-2 text-lime">· premium {n.name.length}-char</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* ── empty: own nothing yet ─────────────────────────────────── */
            <div className="relative overflow-hidden rounded-web0 border-[1.5px] border-ink0/20 bg-lime p-7 text-ink0 shadow-slab sm:p-8">
              <div className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] opacity-80">
                nothing to sell yet
              </div>
              <div className="mt-2 font-display text-[clamp(28px,5vw,48px)] font-black leading-[0.86] tracking-[-0.035em] lowercase">
                no names owned.
              </div>
              <p className="mt-3 max-w-[46ch] text-[14.5px] font-medium leading-relaxed opacity-80">
                you can only list a name your wallet owns on mainnet — and this
                wallet doesn&apos;t own any <span className="font-mono font-bold">.null</span>{" "}
                accounts yet. register one first, then come back to list it.
              </p>
              <a
                className="group mt-5 inline-flex items-center gap-2.5 rounded-xl bg-ink0 px-5 py-3 font-sans text-[15px] font-bold tracking-tight text-paper transition hover:-translate-y-px"
                href="/"
              >
                register your first name
                <Arrow />
              </a>
            </div>
          )}
        </StepShell>

        {/* ── STEP 2 — choose listing type ─────────────────────────────────── */}
        {selected && (
          <StepShell
            n={2}
            title="choose how it sells"
            sub={`listing ${selected.name}.null`}
          >
            {isPremium ? (
              /* premium 1–3 char → auction-only, show the floor */
              <div className="rounded-web0 border-[1.5px] border-lime/50 bg-lime/[0.05] p-5">
                <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-lime">
                  <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-lime" />
                  premium · {charLen}-char · auction only
                </div>
                <p className="max-w-[56ch] text-sm leading-relaxed text-dim">
                  one-to-three-character names are premium and sell by{" "}
                  <b className="text-paper">sealed auction</b> only. the buyer must
                  lock <b className="text-paper">at least the floor</b> when they
                  open the auction, and the full clearing price goes{" "}
                  <b className="text-paper">100% to the treasury</b>.
                </p>
                <div className="mt-4 inline-flex items-baseline gap-2 rounded-xl border-[1.5px] border-lime/40 bg-black/30 px-4 py-3">
                  <span className="font-mono text-[10px] uppercase tracking-[1px] text-faint">
                    floor for {charLen}-char
                  </span>
                  <span className="font-display text-2xl font-black tracking-tight text-lime">
                    ${floorUsd?.toLocaleString("en-US")}
                  </span>
                </div>
              </div>
            ) : (
              <>
                {/* buy-now / auction toggle */}
                <div className="flex flex-wrap gap-2.5">
                  <TypeChip
                    active={listingType === "buy-now"}
                    label="buy-now"
                    sub="set a fixed SOL price"
                    onClick={() => setListingType("buy-now")}
                  />
                  <TypeChip
                    active={listingType === "auction"}
                    label="auction"
                    sub="open with a starting bid"
                    onClick={() => setListingType("auction")}
                  />
                </div>

                {/* price input */}
                <div className="mt-4 rounded-web0 border-[1.5px] border-line bg-black/20 p-5">
                  <div className="mb-3 font-mono text-[11px] uppercase tracking-[1.5px] text-faint">
                    {listingType === "buy-now" ? "buy-now price" : "starting bid"}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2.5 rounded-xl border-[1.5px] border-line bg-black/30 px-3.5 py-2.5 transition focus-within:border-mint focus-within:shadow-[0_0_0_4px_rgba(61,255,176,0.12)]">
                      <input
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        inputMode="decimal"
                        spellCheck={false}
                        className="w-28 border-none bg-transparent font-mono text-[15px] tracking-tight text-paper outline-none placeholder:text-faint"
                      />
                      <span className="font-mono text-[15px] font-bold text-mint">SOL</span>
                    </div>
                    <div className="flex gap-1.5">
                      {["0.5", "1", "5", "25"].map((a) => (
                        <button
                          key={a}
                          onClick={() => setPrice(a)}
                          className="rounded-full border-[1.5px] border-line bg-paper/[0.03] px-3 py-1.5 font-mono text-[12.5px] font-bold text-dim transition hover:-translate-y-0.5 hover:border-transparent hover:bg-lime hover:text-ink0"
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* auction phase length — sealed commit window then a reveal window */}
                  {listingType === "auction" && (
                    <div className="mt-4 border-t-[1.5px] border-line pt-4">
                      <div className="mb-2.5 font-mono text-[11px] uppercase tracking-[1.5px] text-faint">
                        each phase lasts · sealed bids open after the commit window
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {DURATIONS.map((d) => (
                          <button
                            key={d.key}
                            onClick={() => setDurKey(d.key)}
                            className={`rounded-full border-[1.5px] px-3 py-1.5 font-mono text-[12px] font-bold transition hover:-translate-y-0.5 ${
                              durKey === d.key
                                ? "border-transparent bg-cyan text-ink0"
                                : "border-line bg-paper/[0.03] text-dim hover:border-cyan/60"
                            }`}
                          >
                            {d.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 font-mono text-[11px] text-dim">
                        commit {dur.label.replace(" · test", "")} → reveal {dur.label.replace(" · test", "")} → settle.
                        bidders bid SOL, sealed; highest revealed wins.
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </StepShell>
        )}

        {/* ── STEP 3 — fee breakdown + escrow explainer ─────────────────────── */}
        {selected && (
          <StepShell n={3} title="what you pay, what you keep" sub="no hidden cuts">
            {/* LIME solid panel — the headline economics, v4 shadow-slab */}
            <div className="relative overflow-hidden rounded-web0 border-[1.5px] border-ink0/20 bg-lime p-6 text-ink0 shadow-slab">
              <div className="flex items-center justify-between font-mono text-[12px] font-bold uppercase tracking-[0.12em]">
                <span>your take-home</span>
                <span className="inline-flex items-center gap-1.5">
                  <i className="h-[7px] w-[7px] animate-pulsering rounded-full bg-magenta" />
                  on sale
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-2 font-display text-[clamp(48px,7vw,92px)] font-black leading-[0.82] tracking-[-0.04em]">
                {isPremium ? "100%" : `${SELLER_PCT}%`}
                <span className="self-center font-mono text-[0.2em] font-bold lowercase opacity-70">
                  {isPremium ? "to treasury" : "to you"}
                </span>
              </div>
              <div className="mt-1.5 font-mono text-[12.5px] font-bold opacity-80">
                {isPremium
                  ? "premium clearing price · 100% treasury"
                  : priceNum > 0
                    ? `${fmtSol(netSellerSol)} SOL on a ${fmtSol(priceNum)} SOL sale`
                    : `protocol keeps ${PROTOCOL_PCT}% · seller keeps ${SELLER_PCT}%`}
              </div>
            </div>

            {/* GLASS panel — the line items */}
            <div className="mt-4 overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md">
              <div className="flex items-center gap-2 border-b-[1.5px] border-line px-4 py-3">
                <span className="flex gap-1.5">
                  <b className="h-[11px] w-[11px] rounded-full bg-magenta" />
                  <b className="h-[11px] w-[11px] rounded-full bg-lime" />
                  <b className="h-[11px] w-[11px] rounded-full bg-cyan" />
                </span>
                <span className="ml-1.5 font-mono text-[11.5px] tracking-wide text-faint">
                  web0://marketplace · fee breakdown
                </span>
              </div>
              <div className="divide-y divide-line/60">
                <FeeRow
                  label="list fee"
                  value={`${LIST_FEE_SOL} SOL`}
                  note="flat · NON-REFUNDABLE anti-spam toll · paid now, on no-sale the protocol keeps it"
                  tone="magenta"
                />
                {!isPremium && (
                  <FeeRow
                    label={`protocol cut (${PROTOCOL_PCT}%) on sale`}
                    value={priceNum > 0 ? `${fmtSol(protocolSol)} SOL` : `${PROTOCOL_PCT}%`}
                    note="only charged if it sells — never on a listing that expires"
                    tone="cyan"
                  />
                )}
                <FeeRow
                  label={escrowOptIn ? `escrow-as-a-service (${ESCROW_PCT}%)` : "escrow-as-a-service"}
                  value={
                    escrowOptIn
                      ? priceNum > 0
                        ? `${fmtSol(escrowSol)} SOL`
                        : `${ESCROW_PCT}%`
                      : "off"
                  }
                  note="optional opt-in for OTC deals — off by default; the listing contract covers normal sales"
                  tone="violet"
                  action={
                    !isPremium ? (
                      <button
                        onClick={() => setEscrowOptIn((v) => !v)}
                        className={`rounded-full border-[1.5px] px-3 py-1 font-mono text-[11px] font-bold transition ${
                          escrowOptIn
                            ? "border-transparent bg-violet text-paper"
                            : "border-line text-dim hover:border-violet"
                        }`}
                      >
                        {escrowOptIn ? "on" : "add"}
                      </button>
                    ) : undefined
                  }
                />
                {!isPremium && (
                  <FeeRow
                    label="you receive"
                    value={
                      priceNum > 0 ? `${fmtSol(netSellerSol)} SOL` : `${SELLER_PCT}%`
                    }
                    note={`seller keeps ${SELLER_PCT}%${escrowOptIn ? ` minus the ${ESCROW_PCT}% escrow fee` : ""}`}
                    tone="mint"
                    strong
                  />
                )}
              </div>
            </div>

            {/* ESCROW explainer — the honest trust story */}
            <div className="mt-4 rounded-web0 border-[1.5px] border-mint/50 bg-mint/[0.05] p-5">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">
                <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-mint" />
                custody = the listing contract holds it
              </div>
              <div className="space-y-2.5">
                <Bullet good>
                  when you list, the name is <b className="text-paper">moved into the
                  listing contract</b> (a program PDA) — it&apos;s in escrow, not your
                  wallet, until the listing resolves
                </Bullet>
                <Bullet good>
                  no person can touch it: only <b className="text-paper">a buy or your
                  delist</b> can move it, and a buy is atomic — pay + transfer, or neither
                </Bullet>
                <Bullet good>
                  <b className="text-paper">delist anytime</b> and the contract hands the
                  name straight back to your wallet
                </Bullet>
              </div>
            </div>
          </StepShell>
        )}

        {/* ── STEP 4 — list it on-chain ────────────────────────────────────── */}
        {selected && (
          <StepShell n={4} title="list it" sub="the on-chain step">
            <div className="overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md">
              <div className="flex items-center justify-between border-b-[1.5px] border-line px-5 py-4">
                <div className="flex items-center gap-2">
                  <span className={`h-[7px] w-[7px] rounded-full ${canList ? "animate-pulsering bg-mint" : "bg-steel"}`} />
                  <span className={`font-display text-lg font-black tracking-tight lowercase ${canList ? "text-paper" : "text-dim"}`}>
                    on-chain listing
                  </span>
                </div>
                <span className={`rounded-full border-[1.5px] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] ${canList ? "border-mint/40 text-mint" : "border-line2 text-steel"}`}>
                  {canList ? "live" : "soon"}
                </span>
              </div>
              <div className="px-5 py-5">
                {listSig ? (
                  /* ── success ── */
                  <div className="rounded-web0 border-[1.5px] border-mint/45 bg-mint/[0.06] p-5">
                    <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">
                      <span className="h-[7px] w-[7px] rounded-full bg-mint" />
                      {listingType === "auction" ? "auction opened — name in escrow" : "listed — your name is in escrow"}
                    </div>
                    <p className="text-sm leading-relaxed text-paper">
                      {listingType === "auction" ? (
                        <>
                          <b className="lowercase">{selected.name}.null</b> is up for a sealed-bid
                          auction (start ≥ {fmtSol(priceNum)} SOL, {dur.label.replace(" · test", "")} commit
                          + reveal). bidders commit hidden SOL bids, reveal, and the highest wins — anyone
                          settles after the reveal window.
                        </>
                      ) : (
                        <>
                          <b className="lowercase">{selected.name}.null</b> is now held by the
                          listing contract at {fmtSol(priceNum)} SOL buy-now. it&apos;s off the
                          market until it sells or you delist.
                        </>
                      )}
                    </p>
                    <a
                      href={explorerTx(cluster, listSig)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block font-mono text-[11px] text-cyan underline decoration-line hover:text-mint"
                    >
                      {shortAddr(listSig)} ↗
                    </a>
                  </div>
                ) : canList ? (
                  /* ── wired SOL buy-now OR SOL sealed-bid auction ── */
                  <>
                    <p className="max-w-[62ch] text-sm leading-relaxed text-dim">
                      {listingType === "auction" ? (
                        <>
                          this opens a <b className="text-paper">sealed-bid auction</b> for{" "}
                          {selected.name}.null: it escrows the name + charges the flat {LIST_FEE_SOL} SOL toll.
                          bidders commit a <b className="text-paper">hidden SOL bid</b> (≥ {fmtSol(priceNum)} start)
                          during the {dur.label.replace(" · test", "")} commit window, reveal it in the next
                          window, and the highest revealed bid wins. you receive {SELLER_PCT}%.
                        </>
                      ) : (
                        <>
                          this signs one transaction that <b className="text-paper">moves{" "}
                          {selected.name}.null into the listing contract</b> (escrow), charges the
                          flat {LIST_FEE_SOL} SOL toll, and posts it for{" "}
                          <b className="text-paper">{fmtSol(priceNum)} SOL</b> buy-now. on a sale
                          you receive {SELLER_PCT}% ({fmtSol(sellerSol)} SOL); delist anytime to
                          get the name straight back.
                        </>
                      )}
                    </p>
                    <button
                      onClick={address ? onList : connect}
                      disabled={listing || connecting}
                      className={`mt-5 inline-flex w-full items-center justify-center gap-2.5 rounded-xl px-4 py-3.5 font-sans text-[16.5px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 ${listingType === "auction" ? "bg-cyan" : "bg-mint"}`}
                    >
                      {!address
                        ? "connect phantom to list"
                        : listing
                          ? "confirming…"
                          : listingType === "auction"
                            ? `open auction · ${selected.name}.null ≥ ${fmtSol(priceNum)} SOL`
                            : `list ${selected.name}.null for ${fmtSol(priceNum)} SOL`}
                    </button>
                    {listError && (
                      <div className="mt-3 break-words font-mono text-[11px] text-magenta">{listError}</div>
                    )}
                    <div className="mt-3 font-mono text-[11px] text-faint">
                      one phantom signature · escrowed by the contract · {PROTOCOL_PCT}% protocol fee on sale only
                    </div>
                  </>
                ) : (
                  /* ── premium 1–3 char — auction-only, not yet wired in the portal ── */
                  <>
                    <p className="max-w-[60ch] text-sm leading-relaxed text-dim">
                      1–3 character names are premium — they sell through a sealed-bid auction
                      (100% to treasury). that specific path isn&apos;t wired into the portal yet.
                      Standard buy-now <b className="text-paper">and</b> SOL sealed-bid auctions
                      for 4+ char names are live and devnet-proven.
                    </p>
                    <button
                      disabled
                      className="mt-5 inline-flex w-full cursor-not-allowed items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-line2 bg-paper/[0.02] px-4 py-3.5 font-sans text-[16.5px] font-bold tracking-tight text-faint opacity-70"
                    >
                      premium auction — launching soon
                    </button>
                  </>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px] text-faint">
                  <span>
                    name account{" "}
                    <a
                      className="text-cyan underline decoration-line hover:text-mint"
                      href={solscanAddr(selected.pda)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(selected.pda)} ↗
                    </a>
                  </span>
                </div>
              </div>
            </div>
          </StepShell>
        )}
      </div>

      {/* honesty footer */}
      <p className="mt-8 font-mono text-[11px] lowercase tracking-wide text-faint">
        public beta · capped · unaudited — a listed name is held by the listing contract
        (escrow) until it sells or you delist; sales are atomic, the protocol takes no
        discretionary custody
      </p>
    </section>
  );
}

/* ── building blocks ─────────────────────────────────────────────────────────── */

function StepShell({
  n,
  title,
  sub,
  children,
}: {
  n: number;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3.5 flex items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line bg-bg2/65 font-mono text-[13px] font-bold text-mint">
          {n}
        </span>
        <span className="font-display text-[clamp(20px,2.6vw,26px)] font-black tracking-tight lowercase">
          {title}
        </span>
        <span className="ml-auto hidden font-mono text-[11px] lowercase tracking-wide text-faint sm:block">
          {sub}
        </span>
      </div>
      {children}
    </div>
  );
}

function ConnectPanel({
  connect,
  connecting,
  phantomAvailable,
}: {
  connect: () => void;
  connecting: boolean;
  phantomAvailable: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)]">
      <div className="flex items-center gap-2 border-b-[1.5px] border-line px-3.5 py-3">
        <span className="flex gap-1.5">
          <b className="h-[11px] w-[11px] rounded-full bg-magenta" />
          <b className="h-[11px] w-[11px] rounded-full bg-lime" />
          <b className="h-[11px] w-[11px] rounded-full bg-cyan" />
        </span>
        <span className="ml-1.5 font-mono text-[11.5px] tracking-wide text-faint">
          web0://marketplace · wallet not connected
        </span>
      </div>
      <div className="p-6 sm:p-7">
        <p className="mb-6 max-w-[50ch] text-[15px] leading-relaxed text-dim">
          connect your wallet to read the{" "}
          <span className="font-mono font-semibold text-paper">.null</span> names it
          owns — those are the ones you can list.{" "}
          <span className="font-semibold text-mint">read-only — nothing is signed.</span>
        </p>
        {phantomAvailable ? (
          <button
            onClick={connect}
            disabled={connecting}
            className="group inline-flex items-center gap-2.5 rounded-xl bg-lime px-6 py-3.5 font-sans text-[16px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-mint disabled:opacity-60"
          >
            {connecting ? "connecting…" : "connect phantom to list a name"}
            <Arrow />
          </button>
        ) : (
          <a
            href="https://phantom.app/"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2.5 rounded-xl bg-lime px-6 py-3.5 font-sans text-[16px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-mint"
          >
            get phantom
            <Arrow />
          </a>
        )}
      </div>
    </div>
  );
}

function TypeChip({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex min-w-[160px] flex-1 flex-col items-start gap-1 rounded-web0 border-[1.5px] px-4 py-3.5 text-left transition ${
        active
          ? "border-transparent bg-mint text-ink0"
          : "border-line bg-paper/[0.03] text-dim hover:border-line2"
      }`}
    >
      <span className="font-display text-lg font-black tracking-tight lowercase">
        {label}
      </span>
      <span
        className={`font-mono text-[11.5px] ${active ? "text-ink0/70" : "text-faint"}`}
      >
        {sub}
      </span>
    </button>
  );
}

function FeeRow({
  label,
  value,
  note,
  tone,
  strong,
  action,
}: {
  label: string;
  value: string;
  note: string;
  tone: Accent | "violet";
  strong?: boolean;
  action?: React.ReactNode;
}) {
  const dot = {
    mint: "bg-mint",
    lime: "bg-lime",
    cyan: "bg-cyan",
    magenta: "bg-magenta",
    violet: "bg-violet",
  }[tone];
  const val = {
    mint: "text-mint",
    lime: "text-lime",
    cyan: "text-cyan",
    magenta: "text-magenta",
    violet: "text-violet",
  }[tone];
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <i className={`mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span
            className={`font-sans text-[15px] tracking-tight ${strong ? "font-bold text-paper" : "font-semibold text-paper"}`}
          >
            {label}
          </span>
          <span
            className={`font-mono text-[14px] font-bold ${strong ? "text-mint" : val}`}
          >
            {value}
          </span>
          {action && <span className="ml-auto">{action}</span>}
        </div>
        <div className="mt-1 font-mono text-[11.5px] leading-relaxed text-faint">
          {note}
        </div>
      </div>
    </div>
  );
}

function Bullet({ children, good }: { children: React.ReactNode; good?: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={`mt-[6px] h-[6px] w-[6px] shrink-0 rounded-full ${good ? "bg-mint" : "bg-steel"}`}
      />
      <span className="text-[14px] leading-relaxed text-dim">{children}</span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] transition group-hover:translate-x-1"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/* SOL display — trim trailing zeros, keep it terse. */
function fmtSol(n: number): string {
  return n
    .toFixed(4)
    .replace(/\.?0+$/, "")
    .replace(/^$/, "0");
}
