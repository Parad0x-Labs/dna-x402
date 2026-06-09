"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { getConnection, getOwnedNames, type OwnedName } from "@/lib/chain";
import { shortAddr, solscanAddr } from "@/lib/null-sdk";

export function MyNames() {
  const { address, connect, connecting, phantomAvailable } = useWallet();
  const [names, setNames] = useState<OwnedName[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (owner: string) => {
    setLoading(true);
    setError(null);
    try {
      const conn = getConnection();
      const owned = await getOwnedNames(conn, new PublicKey(owner));
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
    <section className="pt-12 sm:pt-16 pb-8">
      <div className="text-[12px] tracking-[3px] uppercase text-steel mb-5">
        your .null names
      </div>
      <h1 className="text-[clamp(32px,6vw,52px)] font-extrabold tracking-[-2px] leading-none">
        names you<span className="text-acc"> own</span>
      </h1>
      <p className="max-w-[560px] mt-4 text-dim text-[15px] leading-relaxed">
        Every <span className="font-mono">.null</span> domain account whose on-chain owner
        is your connected wallet, read live from Solana mainnet.
      </p>

      <div className="mt-8">
        {!address ? (
          <div className="border border-line rounded-web0 bg-surf p-6">
            {phantomAvailable ? (
              <button
                onClick={connect}
                disabled={connecting}
                className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60"
              >
                {connecting ? "connecting…" : "Connect Phantom to see your names"}
              </button>
            ) : (
              <a
                href="https://phantom.app/"
                target="_blank"
                rel="noreferrer"
                className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition inline-block"
              >
                Get Phantom →
              </a>
            )}
          </div>
        ) : loading ? (
          <div className="flex items-center gap-3 border border-line rounded-web0 bg-surf p-6">
            <span className="spinner" />
            <span className="font-mono text-sm text-dim">
              scanning the registrar for accounts you own…
            </span>
          </div>
        ) : error ? (
          <div className="border border-line2 rounded-web0 bg-bg2 p-6">
            <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2">
              couldn&apos;t load
            </div>
            <div className="text-sm text-ink break-words">{error}</div>
            <button
              onClick={() => load(address)}
              className="mt-4 rounded-lg border border-line2 px-4 py-2 text-sm hover:border-acc-d transition"
            >
              retry
            </button>
          </div>
        ) : names && names.length > 0 ? (
          <div className="border border-line rounded-web0 bg-surf overflow-hidden">
            <div className="px-4 py-3 border-b border-line bg-bg2 font-mono text-xs text-dim flex justify-between">
              <span>{names.length} name{names.length === 1 ? "" : "s"} owned</span>
              <span className="text-faint">owner {shortAddr(address)}</span>
            </div>
            {names.map((n) => (
              <div
                key={n.pda}
                className="flex items-center justify-between gap-3 px-4 py-4 border-b border-line last:border-b-0"
              >
                <div className="min-w-0">
                  {/* The on-chain record stores sha256(name), not the plaintext
                      name, so we identify each domain by its account address.
                      Plaintext-name resolution is a phase-2 indexer feature. */}
                  <div className="font-mono text-sm text-ink truncate">
                    <a
                      className="hover:text-acc"
                      href={solscanAddr(n.pda)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(n.pda)}
                    </a>
                    <span className="text-faint"> · .null domain account</span>
                  </div>
                </div>
                <span
                  className="font-mono text-[11px] text-faint border border-line rounded-md px-3 py-1.5 cursor-not-allowed"
                  title="Manage / set content / auction — phase 2"
                >
                  manage · soon
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="border border-line rounded-web0 bg-surf p-6">
            <div className="font-mono text-sm text-dim">
              No <span className="text-ink">.null</span> names owned by this wallet yet.{" "}
              <a className="text-acc" href="/">
                Register one →
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
