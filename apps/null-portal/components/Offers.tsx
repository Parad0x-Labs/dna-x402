"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { useCluster } from "./ClusterProvider";
import { getConnectionForCluster, getOwnedNames, readOffers, type OfferView } from "@/lib/chain";
import { ixMakeOfferSol, ixAcceptOfferSol, ixCancelOfferSol, auctionRegistrarFor, lamportsToSol, shortAddr } from "@/lib/null-sdk";
import { explorerTx } from "@/lib/cluster";
import { signAndSendInstructions } from "@/lib/wallet";

/**
 * Offers — the make-offer marketplace (replaces sealed auctions). A buyer escrows a
 * standing SOL offer on any registered name; the owner accepts (95% / 5%, name → buyer)
 * or the buyer cancels. No timers, no reveal, no settle dance.
 */
export function Offers() {
  const { address, connect, connecting } = useWallet();
  const { cluster } = useCluster();

  const [offers, setOffers] = useState<OfferView[] | null>(null);
  const [myNames, setMyNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState<string | null>(null);

  const [offerName, setOfferName] = useState("");
  const [offerAmt, setOfferAmt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const snap = await readOffers(cluster);
      if (snap.rpcError) setErr(snap.rpcError);
      setOffers(snap.offers);
      if (address) {
        const owned = await getOwnedNames(cluster, new PublicKey(address), auctionRegistrarFor(cluster));
        setMyNames(new Set(owned.map((n) => n.name)));
      } else {
        setMyNames(new Set());
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cluster, address]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (build: () => Promise<import("@solana/web3.js").TransactionInstruction>) => {
    if (!address) { connect(); return; }
    setErr(null); setBusy(true);
    try {
      const conn = getConnectionForCluster(cluster);
      const ix = await build();
      const s = await signAndSendInstructions({ connection: conn, owner: address, instructions: [ix], computeUnits: 220_000 });
      setSig(s);
      setTimeout(() => void load(), 1600);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const myOffers = useMemo(() => (offers ?? []).filter((o) => address != null && o.buyer === address), [offers, address]);
  const incoming = useMemo(() => (offers ?? []).filter((o) => o.name !== "" && myNames.has(o.name)), [offers, myNames]);

  const onMake = () => {
    const amt = Number(offerAmt);
    const nm = offerName.trim().toLowerCase().replace(/\.null$/, "").replace(/[^a-z0-9-]/g, "");
    if (!nm || !(amt > 0)) { setErr("enter a name and a SOL amount"); return; }
    run(() => ixMakeOfferSol(cluster, new PublicKey(address!), nm, BigInt(Math.round(amt * LAMPORTS_PER_SOL))));
  };

  return (
    <section className="pt-12 sm:pt-16">
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-cyan" />
        offers · <span className="text-cyan">name your price on any .null name</span>
      </span>
      <h2 className="mt-2 font-display text-[clamp(30px,5vw,52px)] font-black leading-[0.92] tracking-[-0.03em] lowercase">
        make an offer.
      </h2>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-dim">
        escrow a SOL offer on any registered name. the owner can accept it anytime — 95% to them, 5% protocol —
        and the name transfers to you atomically. changed your mind? cancel for a full refund. no timers, no bidding war.
      </p>

      {/* make an offer */}
      <div className="mt-5 grid gap-2.5 rounded-web0 border-[1.5px] border-line bg-bg2/60 p-4 backdrop-blur-md sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <div className="flex items-center gap-2 rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2.5">
          <span className="font-mono text-[15px] font-bold text-cyan">&gt;</span>
          <input value={offerName} onChange={(e) => setOfferName(e.target.value)} placeholder="name" spellCheck={false}
            className="w-full border-none bg-transparent font-mono text-[15px] text-paper outline-none placeholder:text-faint" />
          <span className="font-mono text-[14px] font-bold text-mint">.null</span>
        </div>
        <div className="flex items-center gap-2 rounded-xl border-[1.5px] border-line bg-black/30 px-3 py-2.5">
          <input value={offerAmt} onChange={(e) => setOfferAmt(e.target.value)} inputMode="decimal" placeholder="0.5"
            className="w-[90px] border-none bg-transparent text-right font-mono text-[15px] text-paper outline-none placeholder:text-faint" />
          <span className="font-mono text-[13px] font-bold text-cyan">SOL</span>
        </div>
        <button onClick={address ? onMake : connect} disabled={busy || connecting}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan px-5 py-3 font-sans text-[15px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-60">
          {busy ? "signing…" : !address ? "connect to offer" : "make offer"}
        </button>
      </div>
      {sig && (
        <a href={explorerTx(cluster, sig)} target="_blank" rel="noreferrer" className="mt-2 inline-block font-mono text-[11.5px] text-mint">
          submitted — {shortAddr(sig)} ↗
        </a>
      )}
      {err && <div className="mt-2 break-words font-mono text-[11.5px] text-magenta">{err}</div>}

      {/* incoming offers (on names you own) */}
      <div className="mt-8">
        <h3 className="font-mono text-[12px] uppercase tracking-[1.5px] text-faint">offers on your names</h3>
        {!address ? (
          <p className="mt-2 font-mono text-[12px] text-faint">connect to see offers on names you own.</p>
        ) : loading && offers === null ? (
          <p className="mt-2 flex items-center gap-2 font-mono text-[12px] text-dim"><span className="spinner" /> reading offers…</p>
        ) : incoming.length === 0 ? (
          <p className="mt-2 font-mono text-[12px] text-faint">no offers on your names yet.</p>
        ) : (
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {incoming.map((o) => (
              <div key={o.pda} className="flex items-center justify-between gap-3 rounded-web0 border-[1.5px] border-mint/40 bg-mint/[0.05] px-4 py-3">
                <div className="min-w-0">
                  <div className="font-display text-lg font-black tracking-tight lowercase">{o.name}<span className="text-mint">.null</span></div>
                  <div className="font-mono text-[11px] text-dim">{lamportsToSol(o.amount)} SOL from {shortAddr(o.buyer)}</div>
                </div>
                <button onClick={() => run(() => ixAcceptOfferSol(cluster, new PublicKey(address!), o.name, new PublicKey(o.buyer)))} disabled={busy}
                  className="shrink-0 rounded-xl bg-mint px-4 py-2.5 font-sans text-[13.5px] font-bold text-ink0 transition hover:-translate-y-px disabled:opacity-60">
                  accept · get {lamportsToSol(o.amount * 95n / 100n)} SOL
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* your open offers */}
      <div className="mt-8">
        <h3 className="font-mono text-[12px] uppercase tracking-[1.5px] text-faint">your open offers</h3>
        {!address ? null : myOffers.length === 0 ? (
          <p className="mt-2 font-mono text-[12px] text-faint">you have no open offers.</p>
        ) : (
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {myOffers.map((o) => (
              <div key={o.pda} className="flex items-center justify-between gap-3 rounded-web0 border-[1.5px] border-line bg-bg2/60 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-display text-lg font-black tracking-tight lowercase">{o.name || shortAddr(o.domainPda)}<span className="text-cyan">.null</span></div>
                  <div className="font-mono text-[11px] text-dim">you offered {lamportsToSol(o.amount)} SOL (escrowed)</div>
                </div>
                <button onClick={() => run(() => ixCancelOfferSol(cluster, new PublicKey(address!), o.name))} disabled={busy || o.name === ""}
                  className="shrink-0 rounded-xl border-[1.5px] border-line px-4 py-2.5 font-mono text-[12.5px] font-bold text-dim transition hover:border-magenta/60 disabled:opacity-60">
                  cancel · refund
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
