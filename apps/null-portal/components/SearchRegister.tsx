"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import {
  classifyName,
  ixRegisterNull,
  ixRegisterSol,
  lamportsToSol,
  normalizeName,
  nullAtomicToHuman,
  shortAddr,
  solscanAddr,
  solscanTx,
  type NameCheck,
  type RegistryConfig,
} from "@/lib/null-sdk";
import {
  checkAvailability,
  getConnection,
  getNullBalanceAtomic,
  type Availability,
} from "@/lib/chain";
import { signAndSendInstructions } from "@/lib/wallet";
import { TypedNames } from "./TypedNames";

type Currency = "SOL" | "NULL";

interface ConfigView {
  solFee: bigint;
  nullFee: bigint;
  treasury: string;
}

const DEBOUNCE_MS = 350;

export function SearchRegister() {
  const { address, connect, connecting } = useWallet();
  const [raw, setRaw] = useState("");
  const [check, setCheck] = useState<NameCheck | null>(null);
  const [avail, setAvail] = useState<Availability | null>(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [availError, setAvailError] = useState<string | null>(null);

  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [currency, setCurrency] = useState<Currency>("SOL");
  const [nullBalance, setNullBalance] = useState<bigint | null>(null);

  const [registering, setRegistering] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [registeredName, setRegisteredName] = useState<string | null>(null);
  const [regError, setRegError] = useState<string | null>(null);

  const reqId = useRef(0);

  const name = useMemo(() => normalizeName(raw), [raw]);

  // Load the live registry config once (fees + treasury) — read-only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { readConfig } = await import("@/lib/null-sdk");
        const conn = getConnection();
        const c: RegistryConfig = await readConfig(conn);
        if (!cancelled) {
          setCfg({ solFee: c.solFee, nullFee: c.nullFee, treasury: c.treasury.toBase58() });
        }
      } catch {
        // Non-fatal: the page still works for search; price line shows a fallback.
        if (!cancelled) setCfg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the connected wallet's NULL balance (to enable/disable the NULL option).
  useEffect(() => {
    let cancelled = false;
    if (!address) {
      setNullBalance(null);
      return;
    }
    (async () => {
      try {
        const conn = getConnection();
        const bal = await getNullBalanceAtomic(conn, new PublicKey(address));
        if (!cancelled) setNullBalance(bal);
      } catch {
        if (!cancelled) setNullBalance(0n);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Debounced live availability lookup as the user types.
  useEffect(() => {
    setTxSig(null);
    setRegisteredName(null);
    setRegError(null);

    const c = classifyName(name);
    setCheck(c);
    setAvail(null);
    setAvailError(null);

    if (c.tier !== "registerable") {
      setLoadingAvail(false);
      return;
    }

    const myReq = ++reqId.current;
    setLoadingAvail(true);
    const t = setTimeout(async () => {
      try {
        const conn = getConnection();
        const a = await checkAvailability(conn, name);
        if (reqId.current === myReq) {
          setAvail(a);
          setLoadingAvail(false);
        }
      } catch (e) {
        if (reqId.current === myReq) {
          setAvailError(e instanceof Error ? e.message : String(e));
          setLoadingAvail(false);
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [name]);

  const hasNullAta = nullBalance !== null;
  const enoughNull = cfg !== null && nullBalance !== null && nullBalance >= cfg.nullFee;
  const nullDisabled = !enoughNull;

  // If the chosen currency becomes invalid (e.g. NULL but insufficient), fall back.
  useEffect(() => {
    if (currency === "NULL" && nullDisabled) setCurrency("SOL");
  }, [currency, nullDisabled]);

  const onRegister = useCallback(async () => {
    if (!address || !cfg || !avail || avail.status !== "available") return;
    setRegError(null);
    setRegistering(true);
    try {
      const conn = getConnection();
      const payer = new PublicKey(address);
      const ix =
        currency === "NULL"
          ? await ixRegisterNull(payer, name)
          : await ixRegisterSol(payer, name, new PublicKey(cfg.treasury));
      const sig = await signAndSendInstructions({
        connection: conn,
        owner: address,
        instructions: [ix],
        computeUnits: 120_000,
      });
      setTxSig(sig);
      setRegisteredName(name);
      // Refresh availability so the UI flips to TAKEN (owned by you).
      const a = await checkAvailability(conn, name);
      setAvail(a);
    } catch (e) {
      setRegError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegistering(false);
    }
  }, [address, cfg, avail, currency, name]);

  const fmtSolFee = cfg ? lamportsToSol(cfg.solFee) : "0.007";
  const fmtNullFee = cfg ? nullAtomicToHuman(cfg.nullFee) : "~2,113";

  return (
    <section className="hero-stage pt-14 sm:pt-20 pb-8">
      {/* animated, restrained hero backdrop — pulsing mint glow, drifting grid,
          faint mint starfield + a slow scanline. all reduced-motion guarded. */}
      <div className="hero-glow" aria-hidden />
      <div className="hero-grid" aria-hidden />
      <div className="hero-stars" aria-hidden>
        <span className="s1" />
        <span className="s2" />
        <span className="s3" />
      </div>
      <div className="hero-scan" aria-hidden />

      {/* live status eyebrow */}
      <div className="flex items-center gap-2 mb-6">
        <span className="w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
        <span className="font-mono text-[11px] tracking-[2px] uppercase text-steel">
          live on Solana mainnet
        </span>
        <span className="font-mono text-[11px] tracking-[2px] uppercase text-faint hidden sm:inline">
          · this site runs on Web0
        </span>
      </div>

      {/* the hook */}
      <h1 className="text-[clamp(40px,8.4vw,84px)] font-extrabold tracking-[-3px] leading-[0.92] max-w-[900px]">
        the web,
        <br className="hidden sm:block" /> without the
        <span className="text-acc"> rent.</span>
      </h1>

      <div className="mt-5 font-mono text-[clamp(18px,3vw,30px)] font-bold tracking-[-0.4px] text-ink">
        <span className="text-faint select-none">❯ </span>
        <TypedNames />
        <span className="text-faint">.null</span>
      </div>

      <p className="max-w-[600px] mt-6 text-dim text-[16.5px] leading-relaxed">
        A name that lives as a{" "}
        <strong className="text-ink font-semibold">Solana account</strong> — owned by{" "}
        <strong className="text-ink font-semibold">your wallet</strong>, on mainnet.
        Point it at a site on Arweave and it&apos;s online forever:{" "}
        <strong className="text-ink font-semibold">$0/month</strong>, no host, no DNS, no
        renewals, nobody can take it down. This very page is the proof.
      </p>

      {/* RESOLVER CONSOLE */}
      <div className="mt-9 border border-line rounded-web0 bg-surf overflow-hidden shadow-[0_0_0_1px_rgba(45,212,160,0.04)]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-bg2 font-mono text-xs text-dim">
          <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
          <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
          <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
          <span className="ml-2">
            check <b className="text-steel">any</b> .null name — live, on Solana mainnet
          </span>
          <span className="ml-auto hidden sm:flex items-center gap-1.5 text-faint">
            <span className="w-[6px] h-[6px] rounded-full bg-acc" />
            mainnet
          </span>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-3">
            <span className="text-acc font-mono text-lg">❯</span>
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="yourname"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-transparent border-none outline-none text-ink text-lg font-mono tracking-[0.3px] placeholder:text-faint"
            />
            <span className="font-mono text-faint text-lg hidden sm:inline">.null</span>
          </div>

          {/* suggestions */}
          <div className="flex gap-2 flex-wrap mt-3">
            {["agent", "shop", "news", "vault"].map((s) => (
              <button
                key={s}
                onClick={() => setRaw(s)}
                className="font-mono text-xs text-dim bg-surf2 border border-line rounded-md px-3 py-1.5 hover:text-acc hover:border-line2 transition-colors"
              >
                {s}.null
              </button>
            ))}
          </div>

          {/* result */}
          <div className="mt-4">
            {name.length === 0 ? (
              <div className="font-mono text-xs text-faint">
                type a name to check availability…
              </div>
            ) : (
              <ResultCard
                name={name}
                check={check}
                avail={avail}
                loadingAvail={loadingAvail}
                availError={availError}
                fmtSolFee={fmtSolFee}
                fmtNullFee={fmtNullFee}
                cfgLoaded={!!cfg}
              />
            )}
          </div>
        </div>
      </div>

      {/* REGISTER PANEL — only when AVAILABLE + registerable tier */}
      {check?.tier === "registerable" &&
        avail?.status === "available" &&
        !txSig && (
          <div className="mt-4 border border-acc-d rounded-web0 bg-bg2 p-6">
            <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-4">
              register {name}.null
            </div>

            {!address ? (
              <button
                onClick={connect}
                disabled={connecting}
                className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60"
              >
                {connecting ? "connecting…" : "Connect Phantom to register"}
              </button>
            ) : (
              <>
                {/* currency toggle */}
                <div className="flex gap-2 mb-4">
                  <CurrencyChip
                    label={`Pay ${fmtSolFee} SOL`}
                    active={currency === "SOL"}
                    onClick={() => setCurrency("SOL")}
                    disabled={false}
                  />
                  <CurrencyChip
                    label={`Pay ~${fmtNullFee} NULL (−20%)`}
                    active={currency === "NULL"}
                    onClick={() => setCurrency("NULL")}
                    disabled={nullDisabled}
                  />
                </div>
                {nullDisabled && (
                  <div className="font-mono text-xs text-faint mb-4">
                    {hasNullAta
                      ? `NULL option needs ≥ ${fmtNullFee} NULL in your wallet (you have ${
                          nullBalance !== null ? nullAtomicToHuman(nullBalance) : "0"
                        }).`
                      : "No $NULL token account found in this wallet — pay with SOL, or fund NULL first."}
                  </div>
                )}

                <button
                  onClick={onRegister}
                  disabled={registering}
                  className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60"
                >
                  {registering
                    ? "sign in Phantom…"
                    : `Register ${name}.null with ${currency}`}
                </button>
                <div className="font-mono text-[11px] text-faint mt-3">
                  payer + owner: {shortAddr(address)} · you sign once in Phantom · the name
                  is owned by your wallet
                </div>
                {regError && (
                  <div className="font-mono text-xs text-danger mt-3 break-words">
                    {regError}
                  </div>
                )}
              </>
            )}
          </div>
        )}

      {/* SUCCESS */}
      {txSig && registeredName && (
        <div className="mt-4 border border-acc-d rounded-web0 bg-bg2 p-6">
          <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-3 flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-acc" />
            registered · Solana mainnet
          </div>
          <div className="text-3xl font-extrabold tracking-[-1px] mb-3">
            {registeredName}
            <span className="text-acc">.null</span>
          </div>
          <p className="text-ink/90 max-w-[520px]">
            Owned by your wallet, on-chain, forever. There&apos;s no server to seize and no
            host to call.
          </p>
          <div className="flex gap-3 flex-wrap mt-5">
            <a
              className="rounded-xl bg-acc px-5 py-3 font-bold text-[#062018] text-sm hover:brightness-110 transition"
              href={solscanTx(txSig)}
              target="_blank"
              rel="noreferrer"
            >
              View transaction on Solscan ↗
            </a>
            <a
              className="rounded-xl border border-line2 px-5 py-3 font-semibold text-sm hover:border-acc-d transition"
              href="/my-names"
            >
              My names →
            </a>
          </div>
          <div className="font-mono text-[11px] text-faint mt-4 break-all">
            tx {txSig}
          </div>
        </div>
      )}
    </section>
  );
}

function CurrencyChip({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`font-mono text-xs sm:text-sm rounded-lg px-4 py-2.5 border transition-colors ${
        active
          ? "bg-acc text-[#062018] border-transparent font-bold"
          : "bg-surf text-dim border-line hover:border-line2"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {label}
    </button>
  );
}

function ResultCard({
  name,
  check,
  avail,
  loadingAvail,
  availError,
  fmtSolFee,
  fmtNullFee,
  cfgLoaded,
}: {
  name: string;
  check: NameCheck | null;
  avail: Availability | null;
  loadingAvail: boolean;
  availError: string | null;
  fmtSolFee: string;
  fmtNullFee: string;
  cfgLoaded: boolean;
}) {
  if (!check) return null;

  if (check.tier === "invalid") {
    return (
      <div className="border border-line2 rounded-web0 bg-bg2 px-5 py-4">
        <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2">
          invalid
        </div>
        <div className="text-sm text-ink">{check.reason}</div>
      </div>
    );
  }

  if (check.tier === "premium") {
    return (
      <div className="border border-line2 rounded-web0 bg-bg2 px-5 py-4">
        <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2">
          premium · auction-only
        </div>
        <div className="text-lg font-bold mb-1">
          {name}
          <span className="text-acc">.null</span>
        </div>
        <div className="text-sm text-dim">{check.reason}</div>
      </div>
    );
  }

  // registerable tier — show availability + price.
  return (
    <div
      className={`border rounded-web0 bg-bg2 px-5 py-4 ${
        avail?.status === "available" ? "border-acc-d" : "border-line2"
      }`}
    >
      {loadingAvail || !avail ? (
        <div className="flex items-center gap-3">
          <span className="spinner" />
          <span className="font-mono text-sm text-dim">
            deriving address &amp; querying Solana mainnet…
          </span>
        </div>
      ) : availError ? (
        <div>
          <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2">
            couldn&apos;t reach Solana
          </div>
          <div className="text-sm text-ink break-words">{availError} — try again.</div>
        </div>
      ) : avail.status === "available" ? (
        <>
          <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-2 flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-acc" />
            available · forever
          </div>
          <div className="text-2xl font-extrabold tracking-[-1px] mb-2">
            {name}
            <span className="text-acc">.null</span>
          </div>
          <div className="text-sm text-ink/90">
            Unclaimed. Whoever registers it first owns it — permanently, on Solana.
          </div>
          <div className="font-mono text-xs text-dim mt-3">
            {fmtSolFee} SOL{"  "}or{"  "}~{fmtNullFee} NULL (−20%)
            {!cfgLoaded && (
              <span className="text-faint"> · (target price — live config unavailable)</span>
            )}
          </div>
          <div className="font-mono text-[11px] text-faint mt-2">
            derives to{" "}
            <a
              className="text-steel hover:text-acc"
              href={solscanAddr(avail.pda)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(avail.pda)}
            </a>{" "}
            — computed in your browser, just now
          </div>
        </>
      ) : (
        <>
          <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2 flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-steel" />
            taken · owned on-chain
          </div>
          <div className="text-2xl font-extrabold tracking-[-1px] mb-2">
            {name}
            <span className="text-acc">.null</span>
          </div>
          <div className="text-sm text-dim">
            This name is already registered and owned on Solana mainnet.
          </div>
          <div className="font-mono text-[11px] text-faint mt-3">
            {avail.owner ? (
              <>
                owner{" "}
                <a
                  className="text-steel hover:text-acc"
                  href={solscanAddr(avail.owner)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(avail.owner)}
                </a>{" "}
                ·{" "}
              </>
            ) : null}
            account{" "}
            <a
              className="text-steel hover:text-acc"
              href={solscanAddr(avail.pda)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(avail.pda)}
            </a>
          </div>
        </>
      )}
    </div>
  );
}
