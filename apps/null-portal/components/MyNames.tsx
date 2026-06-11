"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { getOwnedNames, type OwnedName } from "@/lib/chain";
import { shortAddr, solscanAddr } from "@/lib/null-sdk";
import Link from "next/link";

export function MyNames() {
  const { address, connect, connecting, phantomAvailable } = useWallet();
  const [names, setNames] = useState<OwnedName[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (owner: string) => {
    setLoading(true);
    setError(null);
    try {
      const owned = await getOwnedNames("mainnet", new PublicKey(owner));
      setNames(owned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (address) load(address);
    else setNames(null);
  }, [address, load]);

  return (
    <section className="pt-12 sm:pt-16 pb-10">
      {/* header */}
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-mint" />
        your .null names · <span className="text-cyan">read live from mainnet</span>
      </span>

      <h1 className="mt-4 font-display text-[clamp(48px,9vw,128px)] font-black leading-[0.84] tracking-[-0.035em] lowercase">
        your <span className="text-mint">names.</span>
      </h1>

      <p className="mt-4 max-w-[60ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
        every <span className="font-mono font-semibold text-paper">.null</span> account whose on-chain
        owner is your connected wallet, read straight from{" "}
        <b className="font-semibold text-paper">solana mainnet</b>. yours forever —{" "}
        <span className="font-semibold text-lime">no renewals, nothing to lose.</span>
      </p>

      <div className="mt-9">
        {!address ? (
          /* ── not connected ───────────────────────────────────────── */
          <div className="overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)]">
            <div className="flex items-center gap-2 border-b-[1.5px] border-line px-3.5 py-3">
              <span className="flex gap-1.5">
                <b className="h-[11px] w-[11px] rounded-full bg-magenta" />
                <b className="h-[11px] w-[11px] rounded-full bg-lime" />
                <b className="h-[11px] w-[11px] rounded-full bg-cyan" />
              </span>
              <span className="ml-1.5 font-mono text-[11.5px] tracking-wide text-faint">
                web0://my-names · wallet not connected
              </span>
            </div>
            <div className="p-6 sm:p-7">
              <p className="mb-6 max-w-[48ch] text-[15px] leading-relaxed text-dim">
                connect your wallet to read the{" "}
                <span className="font-mono font-semibold text-paper">.null</span> names it owns,
                straight from mainnet.{" "}
                <span className="font-semibold text-mint">read-only — nothing is signed.</span>
              </p>
              {phantomAvailable ? (
                <button
                  onClick={connect}
                  disabled={connecting}
                  className="group inline-flex items-center gap-2.5 rounded-xl bg-mint px-6 py-3.5 font-sans text-[16px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-lime disabled:opacity-60"
                >
                  {connecting ? "connecting…" : "connect phantom to see your names"}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] transition group-hover:translate-x-1">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              ) : (
                <a
                  href="https://phantom.app/"
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex items-center gap-2.5 rounded-xl bg-mint px-6 py-3.5 font-sans text-[16px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-lime"
                >
                  get phantom
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] transition group-hover:translate-x-1">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </a>
              )}
            </div>
          </div>
        ) : loading ? (
          /* ── loading ─────────────────────────────────────────────── */
          <div className="flex items-center gap-3 rounded-web0 border-[1.5px] border-line bg-bg2/65 p-6 backdrop-blur-md">
            <span className="spinner" />
            <span className="font-mono text-sm text-dim">
              scanning the registrar for accounts you own…
            </span>
          </div>
        ) : error ? (
          /* ── error ───────────────────────────────────────────────── */
          <div className="rounded-web0 border-[1.5px] border-magenta/50 bg-magenta/[0.07] p-6">
            <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-magenta">
              <span className="h-[7px] w-[7px] rounded-full bg-magenta" />
              couldn&apos;t load
            </div>
            <div className="break-words text-sm text-paper">{error}</div>
            <button
              onClick={() => load(address)}
              className="mt-4 rounded-lg border-[1.5px] border-line px-4 py-2 font-mono text-xs font-bold text-dim transition hover:-translate-y-0.5 hover:border-transparent hover:bg-mint hover:text-ink0"
            >
              retry
            </button>
          </div>
        ) : names && names.length > 0 ? (
          /* ── owned names ─────────────────────────────────────────── */
          <div className="flex flex-col gap-3.5">
            <div className="flex items-center justify-between font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-dim">
              <span className="inline-flex items-center gap-2 text-mint">
                <i className="h-[7px] w-[7px] animate-pulsering rounded-full bg-mint" />
                {names.length} name{names.length === 1 ? "" : "s"} owned
              </span>
              <span className="text-faint">owner {shortAddr(address)}</span>
            </div>

            <div className="grid gap-3.5 sm:grid-cols-2">
              {names.map((n, i) => {
                // cycle the loud accents across the cards
                const accent = ["mint", "lime", "cyan", "magenta"][i % 4] as
                  | "mint"
                  | "lime"
                  | "cyan"
                  | "magenta";
                const dot = {
                  mint: "bg-mint",
                  lime: "bg-lime",
                  cyan: "bg-cyan",
                  magenta: "bg-magenta",
                }[accent];
                const nameColor = {
                  mint: "text-mint",
                  lime: "text-lime",
                  cyan: "text-cyan",
                  magenta: "text-magenta",
                }[accent];
                return (
                  <div
                    key={n.pda}
                    className="group flex flex-col justify-between gap-4 rounded-web0 border-[1.5px] border-line bg-bg2/65 p-5 backdrop-blur-md transition hover:-translate-y-0.5 hover:border-line2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
                        <i className={`h-[7px] w-[7px] rounded-full ${dot}`} />
                        owned · forever
                      </span>
                      <span
                        className="cursor-not-allowed rounded-full border-[1.5px] border-line px-3 py-1 font-mono text-[10.5px] font-bold text-faint"
                        title="Manage / set content / auction — phase 2"
                      >
                        manage · soon
                      </span>
                    </div>

                    <div className="min-w-0 font-display text-[clamp(28px,4.4vw,46px)] font-black leading-[0.9] tracking-[-0.03em] lowercase">
                      <span className="block truncate">{n.name}</span>
                      <span className={nameColor}>.null</span>
                    </div>

                    <a
                      className="inline-flex w-max items-center gap-1.5 break-all font-mono text-[12px] text-cyan underline decoration-cyan/40 underline-offset-2 transition hover:decoration-cyan"
                      href={solscanAddr(n.pda)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      account {shortAddr(n.pda)} ↗
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* ── empty ───────────────────────────────────────────────── */
          <div className="relative overflow-hidden rounded-web0 border-[1.5px] border-ink0/20 bg-lime p-7 text-ink0 shadow-slab sm:p-8">
            <div className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] opacity-80">
              nothing here yet
            </div>
            <div className="mt-2 font-display text-[clamp(30px,5vw,52px)] font-black leading-[0.86] tracking-[-0.035em] lowercase">
              no names owned.
            </div>
            <p className="mt-3 max-w-[44ch] text-[14.5px] font-medium leading-relaxed opacity-80">
              this wallet doesn&apos;t own any <span className="font-mono font-bold">.null</span> accounts
              on mainnet yet. claim one and it&apos;s yours, on-chain, forever.
            </p>
            <Link
              className="group mt-5 inline-flex items-center gap-2.5 rounded-xl bg-ink0 px-5 py-3 font-sans text-[15px] font-bold tracking-tight text-paper transition hover:-translate-y-px"
              href="/"
            >
              register your first name
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] transition group-hover:translate-x-1">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
          </div>
        )}
      </div>

      {/* honesty footer */}
      <p className="mt-6 font-mono text-[11px] lowercase tracking-wide text-faint">
        public beta · capped · unaudited · non-custodial — names are owned by your wallet, not us
      </p>
    </section>
  );
}
