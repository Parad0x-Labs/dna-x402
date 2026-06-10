"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useCluster } from "./ClusterProvider";
import { useWallet } from "./WalletProvider";
import {
  readMarketplaceListings,
  getConnectionForCluster,
  type MarketListing,
  type MarketSnapshot,
} from "@/lib/chain";
import {
  lamportsToSol, shortAddr, ixBuyNowSol,
  ixCommitBid, ixRevealBidSol, ixSettleSol, ixSettlePremiumSol, ixClaimRefundSol,
  poseidonCommit, freshBlinding,
} from "@/lib/null-sdk";
import { explorerAddr, explorerTx } from "@/lib/cluster";
import { signAndSendInstructions } from "@/lib/wallet";

const LAMPORTS = 1_000_000_000;
const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
function fmtCountdown(secs: number): string {
  if (secs <= 0) return "0s";
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

type Filter = "all" | "buy-now" | "auctions" | "premium";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snap: MarketSnapshot };

const FILTERS: { id: Filter; label: string; accent: string }[] = [
  { id: "all", label: "all", accent: "hover:bg-mint hover:text-ink0" },
  { id: "buy-now", label: "buy now", accent: "hover:bg-cyan hover:text-ink0" },
  { id: "auctions", label: "auctions", accent: "hover:bg-lime hover:text-ink0" },
  { id: "premium", label: "premium", accent: "hover:bg-magenta hover:text-paper" },
];

export function Browse() {
  const { cluster, config } = useCluster();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async (c: typeof cluster) => {
    setState({ kind: "loading" });
    try {
      const snap = await readMarketplaceListings(c);
      setState({ kind: "ready", snap });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    load(cluster);
  }, [cluster, load]);

  const listings: MarketListing[] =
    state.kind === "ready" ? state.snap.listings : [];

  const filtered = useMemo(() => {
    if (filter === "all") return listings;
    if (filter === "buy-now") return listings.filter((l) => l.kind === "buy-now");
    if (filter === "auctions") return listings.filter((l) => l.kind === "auction");
    return listings.filter((l) => l.kind === "premium");
  }, [listings, filter]);

  const hasLive = filtered.length > 0;

  return (
    <section className="pt-12 pb-12 sm:pt-16">
      {/* eyebrow */}
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-magenta" />
        the .null marketplace ·{" "}
        <span className="text-cyan">read live from solana {config.label}</span>
      </span>

      {/* hook */}
      <h1 className="mt-5 font-display text-[clamp(46px,9vw,128px)] font-black leading-[0.84] tracking-[-0.035em] lowercase">
        browse <span className="text-magenta">.null</span> names.
      </h1>

      {/* economics intro — bold, terse */}
      <p className="mt-6 max-w-[64ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
        a listed name is <b className="font-semibold text-paper">held by the listing
        contract</b> — escrowed by a program, not a person. the only ways out are a{" "}
        <b className="font-semibold text-paper">sale</b> or the seller&apos;s{" "}
        <b className="font-semibold text-paper">delist</b>, and a buy is atomic: pay +
        transfer, or neither.{" "}
        <span className="font-semibold text-lime">0.01 SOL to list</span>,{" "}
        <span className="font-semibold text-paper">5% on sale</span>, delist anytime.
      </p>

      {/* economics strip — the exact numbers, laid out clearly */}
      <div className="mt-7 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="list fee" value="0.01 SOL" note="flat · non-refundable toll" dot="cyan" />
        <Stat label="on sale" value="5% / 95%" note="protocol / seller" dot="mint" />
        <Stat label="custody" value="escrowed" note="held by the listing contract" dot="lime" />
        <Stat label="settlement" value="atomic" note="pay + transfer, or neither" dot="magenta" />
      </div>

      {/* CONSOLE — v4 glass */}
      <div className="mt-9 overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)] backdrop-blur-md">
        <div className="flex items-center gap-2 border-b-[1.5px] border-line px-3.5 py-3">
          <span className="flex gap-1.5">
            <b className="h-[11px] w-[11px] rounded-full bg-magenta" />
            <b className="h-[11px] w-[11px] rounded-full bg-lime" />
            <b className="h-[11px] w-[11px] rounded-full bg-cyan" />
          </span>
          <span className="ml-1.5 font-mono text-[11.5px] tracking-wide text-faint">
            web0://marketplace · {config.label}
          </span>
          <span className="ml-auto hidden items-center gap-1.5 font-mono text-[11.5px] text-faint sm:flex">
            <span
              className={`h-[6px] w-[6px] rounded-full ${
                state.kind === "loading" ? "bg-steel" : "animate-pulsering bg-mint"
              }`}
            />
            {state.kind === "loading" ? "reading…" : "live"}
          </span>
        </div>

        <div className="p-3.5 sm:p-5">
          {/* filter pills — v4 chips */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full border-[1.5px] px-3.5 py-1.5 font-mono text-[12.5px] font-bold transition hover:-translate-y-0.5 ${
                    active
                      ? "border-transparent bg-paper text-ink0"
                      : `border-line bg-paper/[0.03] text-dim hover:border-transparent ${f.accent}`
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
            <span className="ml-auto hidden font-mono text-[11px] text-faint sm:inline">
              {state.kind === "ready"
                ? `${state.snap.programAccounts ?? "—"} program accounts on ${config.label}`
                : ""}
            </span>
          </div>

          {/* body */}
          {state.kind === "loading" ? (
            <div className="flex items-center gap-3 rounded-web0 border-[1.5px] border-line bg-black/30 px-5 py-5">
              <span className="spinner" />
              <span className="font-mono text-sm text-dim">
                probing the marketplace program on {config.label}…
              </span>
            </div>
          ) : state.kind === "error" ? (
            <div className="rounded-web0 border-[1.5px] border-magenta/50 bg-magenta/[0.06] p-6">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-magenta">
                <span className="h-[7px] w-[7px] rounded-full bg-magenta" />
                couldn&apos;t reach solana
              </div>
              <div className="break-words text-sm text-paper">{state.message}</div>
              <button
                onClick={() => load(cluster)}
                className="mt-4 rounded-lg border-[1.5px] border-line px-4 py-2 font-mono text-xs font-bold text-dim transition hover:-translate-y-0.5 hover:border-transparent hover:bg-mint hover:text-ink0"
              >
                retry
              </button>
            </div>
          ) : state.kind === "ready" && state.snap.rpcError ? (
            /* scan ran but the RPC refused getProgramAccounts (public nodes block it on
               mainnet) — show the real reason, NOT a misleading "no listings". */
            <div className="rounded-web0 border-[1.5px] border-magenta/50 bg-magenta/[0.06] p-6">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-magenta">
                <span className="h-[7px] w-[7px] rounded-full bg-magenta" />
                marketplace rpc unavailable
              </div>
              <div className="break-words text-sm text-paper">{state.snap.rpcError}</div>
              <button
                onClick={() => load(cluster)}
                className="mt-4 rounded-lg border-[1.5px] border-line px-4 py-2 font-mono text-xs font-bold text-dim transition hover:-translate-y-0.5 hover:border-transparent hover:bg-mint hover:text-ink0"
              >
                retry
              </button>
            </div>
          ) : hasLive ? (
            /* ── live listings (renders the moment a listing layout is wired) ── */
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((l, i) =>
                l.kind === "auction" || l.kind === "premium" ? (
                  <AuctionCard key={l.pda} listing={l} cluster={cluster} accentIndex={i} onChanged={() => load(cluster)} />
                ) : (
                  <LiveCard key={l.pda} listing={l} cluster={cluster} accentIndex={i} onBought={() => load(cluster)} />
                ),
              )}
            </div>
          ) : (
            /* ── honest empty / launching state + illustrative cards ── */
            <EmptyMarket cluster={config.label} />
          )}
        </div>
      </div>

      {/* honesty footer */}
      <p className="mt-6 font-mono text-[11px] lowercase tracking-wide text-faint">
        public beta · capped · unaudited — a listed name is escrowed by the listing contract
        until it sells or the seller delists; sales are atomic, no person holds custody
      </p>
    </section>
  );
}

/* ── economics stat tile ─────────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  note,
  dot,
}: {
  label: string;
  value: string;
  note: string;
  dot: "mint" | "lime" | "cyan" | "magenta";
}) {
  const dotc = { mint: "bg-mint", lime: "bg-lime", cyan: "bg-cyan", magenta: "bg-magenta" }[dot];
  return (
    <div className="rounded-web0 border-[1.5px] border-line bg-bg2/65 px-4 py-3.5 backdrop-blur-md">
      <div className="flex items-center gap-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] text-faint">
        <i className={`h-[6px] w-[6px] rounded-full ${dotc}`} />
        {label}
      </div>
      <div className="mt-1.5 font-display text-[clamp(22px,2.4vw,30px)] font-black leading-none tracking-[-0.02em] text-paper">
        {value}
      </div>
      <div className="mt-1 font-mono text-[11px] text-dim">{note}</div>
    </div>
  );
}

/* ── EMPTY / LAUNCHING state ──────────────────────────────────────────────────── */

function EmptyMarket({ cluster }: { cluster: string }) {
  return (
    <div className="flex flex-col gap-6">
      {/* the loud "be the first" panel — solid lime + shadow-slab signature */}
      <div className="relative overflow-hidden rounded-web0 border-[1.5px] border-ink0/20 bg-lime p-7 text-ink0 shadow-slab sm:p-9">
        <div className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.12em] opacity-80">
          <i className="h-[7px] w-[7px] animate-pulsering rounded-full bg-magenta" />
          marketplace launching
        </div>
        <div className="mt-2 font-display text-[clamp(30px,5.4vw,60px)] font-black leading-[0.86] tracking-[-0.035em] lowercase">
          no live listings yet.
        </div>
        <p className="mt-3 max-w-[52ch] text-[14.5px] font-medium leading-relaxed opacity-80">
          no .null name is listed on {cluster} right now. the marketplace settles atomically —
          a listed name is <b>held by the listing contract</b> until it sells or the seller
          delists. be the first to list and set the floor.
        </p>
        <div className="mt-5 flex flex-wrap gap-2.5">
          <a
            href="/sell"
            className="group inline-flex items-center gap-2.5 rounded-xl bg-ink0 px-5 py-3 font-sans text-[15px] font-bold tracking-tight text-paper transition hover:-translate-y-px"
          >
            list a name — be the first
            <Arrow />
          </a>
          <a
            href="/my-names"
            className="inline-flex items-center rounded-xl border-[1.5px] border-ink0/30 px-5 py-3 font-sans text-[15px] font-bold tracking-tight text-ink0 transition hover:border-ink0"
          >
            see names you own →
          </a>
        </div>
      </div>

      {/* what a card looks like — clearly watermarked EXAMPLES, never real prices */}
      <div>
        <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          <span className="h-[6px] w-[6px] rounded-full bg-steel" />
          example cards · illustrative only — not real listings
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {EXAMPLES.map((ex) => (
            <ExampleCard key={ex.name} ex={ex} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── illustrative example cards (NON-INTERACTIVE, watermarked) ───────────────── */

type Example = {
  name: string;
  accent: "mint" | "lime" | "cyan" | "magenta";
  kind: "buy-now" | "auction" | "premium";
  priceLabel: string;
  subLabel: string;
  cta: string;
};

const EXAMPLES: Example[] = [
  {
    name: "vault",
    accent: "mint",
    kind: "buy-now",
    priceLabel: "buy now · 4.20 SOL",
    subLabel: "seller keeps 95% · 3.99 SOL",
    cta: "buy now",
  },
  {
    name: "agent",
    accent: "cyan",
    kind: "auction",
    priceLabel: "auction · current bid 1.10 SOL",
    subLabel: "ends in 11h · 7 bids",
    cta: "place bid",
  },
  {
    name: "x",
    accent: "magenta",
    kind: "premium",
    priceLabel: "premium · floor 33 SOL",
    subLabel: "1-char · sealed SOL auction · 100% to treasury",
    cta: "open premium auction",
  },
];

const ACCENT = {
  mint: { dot: "bg-mint", text: "text-mint", btn: "bg-mint text-ink0", ring: "border-mint/40" },
  lime: { dot: "bg-lime", text: "text-lime", btn: "bg-lime text-ink0", ring: "border-lime/40" },
  cyan: { dot: "bg-cyan", text: "text-cyan", btn: "bg-cyan text-ink0", ring: "border-cyan/40" },
  magenta: {
    dot: "bg-magenta",
    text: "text-magenta",
    btn: "bg-magenta text-paper",
    ring: "border-magenta/40",
  },
} as const;

function ExampleCard({ ex }: { ex: Example }) {
  const a = ACCENT[ex.accent];
  return (
    <div
      className={`group relative overflow-hidden rounded-web0 border-[1.5px] ${a.ring} bg-bg2/65 p-5 backdrop-blur-md`}
      aria-hidden
    >
      {/* corner watermark — unmistakably an example */}
      <span className="absolute right-3 top-3 select-none rounded-full border-[1.5px] border-line2 bg-black/40 px-2.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.16em] text-faint">
        example
      </span>
      {/* diagonal "EXAMPLE" ghost wash */}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="rotate-[-18deg] font-display text-[clamp(30px,6vw,56px)] font-black uppercase tracking-[0.2em] text-paper/[0.04]">
          example
        </span>
      </span>

      <div className="relative">
        <div className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
          <i className={`h-[6px] w-[6px] rounded-full ${a.dot}`} />
          {ex.kind === "buy-now" ? "buy now" : ex.kind === "auction" ? "auction" : "premium"}
        </div>

        <div className="mt-3 min-w-0 font-display text-[clamp(30px,4.6vw,48px)] font-black leading-[0.9] tracking-[-0.03em] lowercase">
          <span className="block truncate">{ex.name}</span>
          <span className={a.text}>.null</span>
        </div>

        <div className="mt-4 font-mono text-[13px] font-bold text-paper">{ex.priceLabel}</div>
        <div className="mt-1 font-mono text-[11px] text-dim">{ex.subLabel}</div>

        <div className="mt-4 flex items-center gap-2">
          <span
            className={`inline-flex cursor-not-allowed items-center gap-2 rounded-xl px-4 py-2.5 font-sans text-[14px] font-bold tracking-tight opacity-90 ${a.btn}`}
          >
            {ex.cta}
          </span>
          <span className="font-mono text-[10.5px] text-faint">5% fee on sale</span>
        </div>
      </div>
    </div>
  );
}

/* ── live listing card (used the instant a real listing layout is wired) ─────── */

function LiveCard({
  listing,
  cluster,
  accentIndex,
  onBought,
}: {
  listing: MarketListing;
  cluster: "mainnet" | "devnet";
  accentIndex: number;
  onBought: () => void;
}) {
  const accent = (["mint", "cyan", "lime", "magenta"] as const)[accentIndex % 4];
  const a = ACCENT[accent];
  const price = lamportsToSol(listing.lamports);
  const isAuction = listing.kind === "auction";
  const { address, connect, connecting } = useWallet();

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const ownListing = address != null && address === listing.seller;

  const onBuy = useCallback(async () => {
    if (!address) {
      connect();
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const conn = getConnectionForCluster(cluster);
      const ix = await ixBuyNowSol(
        cluster,
        new PublicKey(address),
        new PublicKey(listing.seller),
        listing.name,
        new PublicKey(listing.treasury),
      );
      // BuyNow does a registrar CPI + two system transfers — give it headroom.
      const s = await signAndSendInstructions({ connection: conn, owner: address, instructions: [ix], computeUnits: 200_000 });
      setSig(s);
      // let the chain settle, then refresh the board so the sold name drops off.
      setTimeout(onBought, 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [address, connect, cluster, listing.seller, listing.name, listing.treasury, onBought]);

  return (
    <div
      className={`group flex flex-col gap-4 rounded-web0 border-[1.5px] ${a.ring} bg-bg2/65 p-5 backdrop-blur-md transition hover:-translate-y-0.5`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
          <i className={`h-[6px] w-[6px] rounded-full ${a.dot}`} />
          {listing.kind === "buy-now" ? "buy now" : isAuction ? "auction · buy now" : "premium"}
        </span>
        <a
          href={explorerAddr(cluster, listing.pda)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10.5px] text-faint underline decoration-line hover:text-cyan"
        >
          {shortAddr(listing.pda)} ↗
        </a>
      </div>

      <div className="min-w-0 font-display text-[clamp(30px,4.6vw,48px)] font-black leading-[0.9] tracking-[-0.03em] lowercase">
        <span className="block truncate">{listing.name}</span>
        <span className={a.text}>.null</span>
      </div>

      <div>
        <div className="font-mono text-[13px] font-bold text-paper">buy now · {price} SOL</div>
        <div className="mt-1 font-mono text-[11px] text-dim">
          seller {shortAddr(listing.seller)} · keeps 95% ({lamportsToSol((listing.lamports * 95n) / 100n)} SOL)
        </div>
      </div>

      {sig ? (
        <div className="mt-auto rounded-xl border-[1.5px] border-mint/40 bg-mint/[0.06] px-4 py-3">
          <div className="font-mono text-[12px] font-bold text-mint">bought — name transferring to you</div>
          <a href={explorerTx(cluster, sig)} target="_blank" rel="noreferrer" className="font-mono text-[10.5px] text-dim underline hover:text-cyan">
            {shortAddr(sig)} ↗
          </a>
        </div>
      ) : (
        <button
          onClick={onBuy}
          disabled={busy || connecting || ownListing}
          className={`mt-auto inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-sans text-[15px] font-bold tracking-tight transition hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 ${a.btn}`}
        >
          {ownListing
            ? "your listing"
            : busy
              ? "confirming…"
              : !address
                ? `connect to buy`
                : `buy ${listing.name}.null`}
          {!busy && !ownListing && <Arrow />}
        </button>
      )}
      {err && <div className="break-words font-mono text-[10.5px] text-magenta">{err}</div>}
      <div className="font-mono text-[10.5px] text-faint">
        atomic · pay + transfer or neither · 5% protocol fee
      </div>
    </div>
  );
}

/* ── auction card — sealed-bid lifecycle: commit → reveal → settle ─────────── */

function AuctionCard({
  listing,
  cluster,
  accentIndex,
  onChanged,
}: {
  listing: MarketListing;
  cluster: "mainnet" | "devnet";
  accentIndex: number;
  onChanged: () => void;
}) {
  const accent = (["cyan", "lime", "magenta", "mint"] as const)[accentIndex % 4];
  const a = ACCENT[accent];
  const { address, connect, connecting } = useWallet();

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const phase: "commit" | "reveal" | "ended" =
    now < listing.commitEnd ? "commit" : now < listing.revealEnd ? "reveal" : "ended";
  const remaining = phase === "commit" ? listing.commitEnd - now : phase === "reveal" ? listing.revealEnd - now : 0;

  // the sealed bid (amount + blinding) is kept in this browser — the blinding is REQUIRED
  // to reveal, so it is written BEFORE the commit tx is sent (losing it = unrevealable bid).
  // PER-WALLET key: the bid belongs to the BIDDER, not just the auction. Keyed only by
  // (cluster, auction) every wallet in this browser shared ONE slot, so a 2nd wallet's bid
  // made the 1st + 3rd see "you already bid". The on-chain commit PDA is per-bidder too, so
  // the local record must be as well. (Disconnected → "anon" bucket; reconnect loads yours.)
  const storeKey = `web0.null:bid:${cluster}:${listing.pda}:${address ?? "anon"}`;
  const [myBid, setMyBid] = useState<{ bid: string; blinding: string; revealed?: boolean } | null>(null);
  useEffect(() => {
    try { const v = localStorage.getItem(storeKey); setMyBid(v ? JSON.parse(v) : null); } catch {}
  }, [storeKey]);

  const [bidStr, setBidStr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const minBidSol = lamportsToSol(listing.minBid);
  const ownAuction = address != null && address === listing.seller;
  // A premium (PRIMARY 'P') auction mints an UNOWNED 1–3 char name to the winner and pays
  // 100% to the treasury — its settle takes the 10-account mint path, not the resale split.
  const isPrimary = listing.kind === "premium";

  const run = async (build: () => Promise<import("@solana/web3.js").TransactionInstruction>, after?: () => void): Promise<boolean> => {
    if (!address) { connect(); return false; }
    setErr(null); setBusy(true);
    try {
      const ix = await build();
      const conn = getConnectionForCluster(cluster);
      const s = await signAndSendInstructions({ connection: conn, owner: address, instructions: [ix], computeUnits: 260_000 });
      setSig(s); after?.(); return true;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };

  const onCommit = async () => {
    if (!address) { connect(); return; }
    const bidLamports = BigInt(Math.round(Number(bidStr) * LAMPORTS));
    if (!bidStr || bidLamports < listing.minBid) { setErr(`bid must be ≥ ${minBidSol} SOL`); return; }
    const blinding = freshBlinding();
    const entry = { bid: bidLamports.toString(), blinding: toHex(blinding) };
    // Persist the secret BEFORE sending — a CONFIRMED commit whose blinding we lost is
    // unrevealable. But if the tx is rejected/fails it never went on-chain, so roll the
    // optimistic record back, or the card would falsely claim a sealed bid was placed.
    localStorage.setItem(storeKey, JSON.stringify(entry)); setMyBid(entry);
    const ok = await run(() => ixCommitBid(cluster, new PublicKey(address!), listing.name, poseidonCommit(bidLamports, blinding)));
    if (!ok) { localStorage.removeItem(storeKey); setMyBid(null); }
  };
  const onReveal = () =>
    myBid &&
    run(
      () => ixRevealBidSol(cluster, new PublicKey(address!), listing.name, BigInt(myBid.bid), fromHex(myBid.blinding)),
      () => { const e = { ...myBid, revealed: true }; localStorage.setItem(storeKey, JSON.stringify(e)); setMyBid(e); },
    );
  const onSettle = () =>
    run(
      () =>
        isPrimary
          ? ixSettlePremiumSol(cluster, new PublicKey(address!), listing.name, new PublicKey(listing.treasury))
          : ixSettleSol(cluster, new PublicKey(address!), listing.name, new PublicKey(listing.seller), new PublicKey(listing.treasury)),
      () => setTimeout(onChanged, 1800),
    );
  const onRefund = () =>
    run(() => ixClaimRefundSol(cluster, new PublicKey(address!), listing.name), () => { localStorage.removeItem(storeKey); setMyBid(null); });

  return (
    <div className={`group flex flex-col gap-3.5 rounded-web0 border-[1.5px] ${a.ring} bg-bg2/65 p-5 backdrop-blur-md`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
          <i className={`h-[6px] w-[6px] rounded-full ${a.dot}`} />
          {isPrimary ? "premium" : "auction"} · {phase === "commit" ? "sealed bidding" : phase === "reveal" ? "reveal phase" : "ended"}
        </span>
        <a href={explorerAddr(cluster, listing.pda)} target="_blank" rel="noreferrer" className="font-mono text-[10.5px] text-faint underline decoration-line hover:text-cyan">
          {shortAddr(listing.pda)} ↗
        </a>
      </div>

      <div className="min-w-0 font-display text-[clamp(28px,4.4vw,44px)] font-black leading-[0.9] tracking-[-0.03em] lowercase">
        <span className="block truncate">{listing.name}</span>
        <span className={a.text}>.null</span>
      </div>

      <div className="flex items-center justify-between font-mono text-[12px]">
        <span className="text-dim">min bid <b className="text-paper">{minBidSol} SOL</b></span>
        <span className="text-dim">{Number(listing.numReveals)} revealed</span>
      </div>
      {phase !== "ended" && (
        <div className={`font-mono text-[12px] ${a.text}`}>
          {phase === "commit" ? "commit closes in " : "reveal closes in "}<b>{fmtCountdown(remaining)}</b>
        </div>
      )}

      {sig && (
        <a href={explorerTx(cluster, sig)} target="_blank" rel="noreferrer" className="rounded-xl border-[1.5px] border-mint/40 bg-mint/[0.06] px-4 py-2.5 font-mono text-[12px] text-mint">
          submitted — {shortAddr(sig)} ↗
        </a>
      )}

      {phase === "ended" ? (
        /* Auction over → SETTLE (permissionless, anyone can crank). For the seller with 0
           reveals this RETURNS the escrowed name to their wallet; with bids it finalizes the
           sale + transfer. The seller MUST be able to crank this — it's how an unsold name
           comes back. (Was previously hidden behind the ownAuction "can't bid" branch.) */
        <div className="mt-auto flex flex-col gap-2">
          <button onClick={onSettle} disabled={busy} className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-sans text-[15px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-60 ${a.btn}`}>
            {busy ? "settling…" : ownAuction && Number(listing.numReveals) === 0 ? `settle & reclaim ${listing.name}.null` : "settle auction"}
          </button>
          {ownAuction && Number(listing.numReveals) === 0 && (
            <span className="font-mono text-[10.5px] text-faint">no bids were placed — settling returns the name to your wallet (you pay only the network fee)</span>
          )}
          {myBid?.revealed && (
            <button onClick={onRefund} disabled={busy} className="inline-flex items-center justify-center rounded-xl border-[1.5px] border-line px-4 py-2.5 font-mono text-[12px] font-bold text-dim transition hover:border-cyan/60">
              claim my bid back (if I didn&apos;t win)
            </button>
          )}
        </div>
      ) : ownAuction ? (
        <div className="mt-auto font-mono text-[11px] text-faint">your auction · you can&apos;t bid on it (settle to reclaim once it ends)</div>
      ) : phase === "commit" ? (
        myBid ? (
          <div className="mt-auto rounded-xl border-[1.5px] border-line bg-black/30 px-4 py-3 font-mono text-[12px] text-dim">
            ✓ sealed bid placed — return in the reveal window to open it
          </div>
        ) : (
          <div className="mt-auto flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2">
              <input value={bidStr} onChange={(e) => setBidStr(e.target.value)} inputMode="decimal" placeholder={`≥ ${minBidSol}`} className="w-full border-none bg-transparent font-mono text-[14px] text-paper outline-none placeholder:text-faint" />
              <span className={`font-mono text-[13px] font-bold ${a.text}`}>SOL</span>
            </div>
            <button onClick={onCommit} disabled={busy || connecting} className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-sans text-[15px] font-bold text-ink0 transition hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 ${a.btn}`}>
              {!address ? "connect to bid" : busy ? "sealing…" : "commit sealed bid"}
            </button>
            <span className="font-mono text-[10.5px] text-faint">hidden until you reveal · the secret is saved in this browser</span>
          </div>
        )
      ) : (
        myBid && !myBid.revealed ? (
          <button onClick={onReveal} disabled={busy} className={`mt-auto inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-sans text-[15px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-60 ${a.btn}`}>
            {busy ? "revealing…" : `reveal your ${lamportsToSol(BigInt(myBid.bid))} SOL bid`}
          </button>
        ) : myBid?.revealed ? (
          <div className="mt-auto font-mono text-[11px] text-mint">✓ revealed {lamportsToSol(BigInt(myBid.bid))} SOL — settle after the window closes</div>
        ) : (
          <div className="mt-auto font-mono text-[11px] text-faint">reveal phase — you have no bid here</div>
        )
      )}
      {err && <div className="break-words font-mono text-[10.5px] text-magenta">{err}</div>}
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
      className="h-[17px] w-[17px] transition group-hover:translate-x-1"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
