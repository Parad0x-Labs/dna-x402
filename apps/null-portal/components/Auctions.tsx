"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey, LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { useCluster } from "./ClusterProvider";
import { getConnectionForCluster, getOwnedNames, readEnglishAuctions, type EnglishView } from "@/lib/chain";
import {
  ixCreateEnglishAuction, ixPlaceBidEnglish, ixSettleEnglish, ixCancelEnglish,
  englishMinNextBid, auctionRegistrarFor, lamportsToSol, shortAddr,
} from "@/lib/null-sdk";
import { explorerTx } from "@/lib/cluster";
import { signAndSendInstructions } from "@/lib/wallet";

const DURATIONS: { label: string; secs: bigint }[] = [
  { label: "1h", secs: 3_600n }, { label: "6h", secs: 21_600n },
  { label: "24h", secs: 86_400n }, { label: "3d", secs: 259_200n },
];

function timeLeft(endTs: number): string {
  const s = endTs - Math.floor(Date.now() / 1000);
  if (s <= 0) return "ended";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : m > 0 ? `${m}m ${s % 60}s left` : `${s}s left`;
}

/**
 * Auctions — open ascending ("English") .null name auctions. List one of your names with a
 * start price + clock; bidders bid up openly, an outbid bidder is refunded instantly, the
 * clock anti-snipes, and at the end the top bidder wins (95% to you / 5% treasury).
 */
export function Auctions() {
  const { address, connect } = useWallet();
  const { cluster } = useCluster();

  const [auctions, setAuctions] = useState<EnglishView[] | null>(null);
  const [owned, setOwned] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const [name, setName] = useState("");
  const [start, setStart] = useState("1");
  const [durKey, setDurKey] = useState("24h");
  const [bid, setBid] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setErr(null);
    try {
      const snap = await readEnglishAuctions(cluster);
      if (snap.rpcError) setErr(snap.rpcError);
      setAuctions(snap.auctions);
      if (address) setOwned((await getOwnedNames(cluster, new PublicKey(address), auctionRegistrarFor(cluster))).map((n) => n.name));
      else setOwned([]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [cluster, address]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => forceTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  const run = async (build: () => Promise<TransactionInstruction>) => {
    if (!address) { connect(); return; }
    setErr(null); setBusy(true);
    try {
      const ix = await build();
      const s = await signAndSendInstructions({ connection: getConnectionForCluster(cluster), owner: address, instructions: [ix], computeUnits: 300_000 });
      setSig(s);
      setTimeout(() => void load(), 1800);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const onCreate = () => {
    const nm = name.trim().toLowerCase().replace(/\.null$/, "").replace(/[^a-z0-9-]/g, "");
    const s = Number(start);
    if (!nm || !(s > 0)) { setErr("pick a name and a start price"); return; }
    const dur = DURATIONS.find((d) => d.label === durKey)!.secs;
    run(() => ixCreateEnglishAuction(cluster, new PublicKey(address!), nm, BigInt(Math.round(s * LAMPORTS_PER_SOL)), dur));
  };

  const onBid = (a: EnglishView) => {
    const amt = Number(bid[a.pda]);
    const min = englishMinNextBid(a.highBid, a.startPrice);
    if (!(amt > 0)) { setErr("enter a bid"); return; }
    const lamports = BigInt(Math.round(amt * LAMPORTS_PER_SOL));
    if (lamports < min) { setErr(`bid must be ≥ ${lamportsToSol(min)} SOL`); return; }
    const prev = a.highBidder ? new PublicKey(a.highBidder) : new PublicKey(address!);
    run(() => ixPlaceBidEnglish(cluster, new PublicKey(address!), a.name, lamports, prev));
  };

  const card = "rounded-web0 border-[1.5px] border-line bg-bg2/60 p-5 backdrop-blur-md";

  return (
    <section className="pt-12 sm:pt-16">
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-lime" />
        auctions · <span className="text-lime">open ascending · highest bid wins</span>
      </span>
      <h2 className="mt-2 font-display text-[clamp(30px,5vw,52px)] font-black leading-[0.92] tracking-[-0.03em] lowercase">english auctions.</h2>
      <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-dim">
        list a name you own with a starting price and a clock. bids go <b className="text-paper">up</b>, in the open — outbid and
        you&apos;re refunded instantly, a late bid pushes the clock, and at zero the top bid wins. <b className="text-paper">95% to you, 5% protocol.</b>
      </p>

      {/* create */}
      <div className={`mt-6 ${card}`}>
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[1.5px] text-faint">list one of your names</div>
        <div className="flex flex-wrap items-center gap-3">
          {owned.length > 0 ? (
            <select value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2.5 font-mono text-[14px] text-paper outline-none">
              <option value="">pick a name…</option>
              {owned.map((n) => <option key={n} value={n}>{n}.null</option>)}
            </select>
          ) : (
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="yourname" className="w-40 rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2.5 font-mono text-[14px] text-paper outline-none placeholder:text-faint" />
          )}
          <div className="flex items-center gap-2 rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2.5">
            <input value={start} onChange={(e) => setStart(e.target.value)} inputMode="decimal" className="w-20 border-none bg-transparent font-mono text-[14px] text-paper outline-none" />
            <span className="font-mono text-[13px] font-bold text-mint">SOL start</span>
          </div>
          <div className="flex gap-1.5">
            {DURATIONS.map((d) => (
              <button key={d.label} onClick={() => setDurKey(d.label)} className={`rounded-full border-[1.5px] px-3 py-1.5 font-mono text-[12px] font-bold transition ${durKey === d.label ? "border-transparent bg-cyan text-ink0" : "border-line text-dim hover:border-cyan/60"}`}>{d.label}</button>
            ))}
          </div>
          <button onClick={onCreate} disabled={busy} className="rounded-xl bg-lime px-5 py-2.5 font-sans text-[14px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-50">
            {busy ? "…" : "open auction"}
          </button>
        </div>
        {owned.length === 0 && address && <p className="mt-2 font-mono text-[11px] text-faint">you don&apos;t own any names on this cluster yet — register one first.</p>}
      </div>

      {err && <p className="mt-4 break-words font-mono text-[12px] text-magenta">{err}</p>}
      {sig && <p className="mt-2 font-mono text-[12px] text-mint">✓ <a href={explorerTx(cluster, sig)} target="_blank" rel="noreferrer" className="underline">{shortAddr(sig)}</a></p>}

      {/* live auctions */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {auctions === null && <p className="font-mono text-[12px] text-faint">loading auctions…</p>}
        {auctions !== null && auctions.length === 0 && <p className="font-mono text-[12px] text-faint">no live auctions — open the first one above.</p>}
        {(auctions ?? []).map((a) => {
          const ended = a.endTs - Math.floor(Date.now() / 1000) <= 0;
          const isSeller = address != null && a.seller === address;
          const min = englishMinNextBid(a.highBid, a.startPrice);
          return (
            <div key={a.pda} className={card}>
              <div className="flex items-baseline justify-between">
                <span className="font-display text-[22px] font-black tracking-tight">{a.name || shortAddr(a.domainPda)}<span className="text-dim">.null</span></span>
                <span className={`font-mono text-[11px] ${ended ? "text-magenta" : "text-cyan"}`}>{timeLeft(a.endTs)}</span>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-display text-3xl font-black text-lime">{a.highBid > 0n ? lamportsToSol(a.highBid) : lamportsToSol(a.startPrice)}</span>
                <span className="font-mono text-[11px] text-faint">SOL · {a.highBid > 0n ? `${a.numBids} bid${a.numBids === 1 ? "" : "s"} · high ${shortAddr(a.highBidder)}` : "no bids yet (start)"}</span>
              </div>
              {!ended ? (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2">
                    <input value={bid[a.pda] ?? ""} onChange={(e) => setBid((b) => ({ ...b, [a.pda]: e.target.value }))} inputMode="decimal" placeholder={lamportsToSol(min)} className="w-20 border-none bg-transparent font-mono text-[13px] text-paper outline-none placeholder:text-faint" />
                    <span className="font-mono text-[12px] font-bold text-mint">SOL</span>
                  </div>
                  <button onClick={() => onBid(a)} disabled={busy} className="rounded-xl bg-mint px-4 py-2 font-sans text-[13px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-50">bid</button>
                  <span className="font-mono text-[10px] text-faint">min {lamportsToSol(min)}</span>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => run(() => ixSettleEnglish(cluster, new PublicKey(address!), a.name, new PublicKey(a.seller)))} disabled={busy} className="rounded-xl bg-lime px-4 py-2 font-sans text-[13px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-50">settle</button>
                  <span className="font-mono text-[11px] text-dim">{a.highBid > 0n ? "→ name to winner, you get paid" : "→ no bids, name returns to seller"}</span>
                </div>
              )}
              {isSeller && a.highBid === 0n && !ended && (
                <button onClick={() => run(() => ixCancelEnglish(cluster, new PublicKey(address!), a.name))} disabled={busy} className="mt-2 font-mono text-[11px] text-faint underline hover:text-magenta">cancel (no bids)</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
