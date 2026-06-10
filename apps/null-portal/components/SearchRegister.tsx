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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const name = useMemo(() => normalizeName(raw), [raw]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { readConfig } = await import("@/lib/null-sdk");
        const conn = getConnection();
        const c: RegistryConfig = await readConfig(conn);
        if (!cancelled) setCfg({ solFee: c.solFee, nullFee: c.nullFee, treasury: c.treasury.toBase58() });
      } catch {
        if (!cancelled) setCfg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const sig = await signAndSendInstructions({ connection: conn, owner: address, instructions: [ix], computeUnits: 120_000 });
      setTxSig(sig);
      setRegisteredName(name);
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

  const pick = (n: string) => {
    setRaw(n);
    inputRef.current?.focus();
  };

  const isAvailable = check?.tier === "registerable" && avail?.status === "available";
  const isTaken = check?.tier === "registerable" && avail?.status === "taken";

  return (
    <>
      <section className="grid items-stretch gap-6 pt-6 sm:pt-10 lg:grid-cols-[1.5fr_1fr] lg:gap-8">
        {/* LEFT — kinetic hook */}
        <div className="flex flex-col justify-center gap-5">
          <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
            <span className="h-[9px] w-[9px] rounded-full bg-magenta shadow-[0_0_14px_#ff2e7e]" />
            live on solana mainnet · <span className="text-cyan">this site runs on web0</span>
          </span>

          <h1 className="font-display text-[clamp(52px,9.6vw,150px)] font-black leading-[0.84] tracking-[-0.035em] lowercase">
            <span className="block">
              <span className="ghost fill">the</span> <span className="ghost">web,</span>
            </span>
            <span className="block">
              without <span className="accentword">the</span>
            </span>
            <span className="block">
              <span className="rent-wrap">
                <span className="slab" />
                <em>rent.</em>
                <span className="strike" />
              </span>
            </span>
          </h1>

          <div className="flex items-center gap-1 font-mono text-[clamp(16px,2vw,28px)] font-bold tracking-tight text-mint">
            <span className="text-cyan">&gt;</span>
            <TypedNames />
            <span className="text-paper">.null</span>
            <span className="caret" />
          </div>

          <p className="max-w-[60ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
            a name that lives as a <b className="font-semibold text-paper">solana account</b> — owned by your wallet.
            point it at a site on <b className="font-semibold text-paper">arweave</b> and it&apos;s online forever:{" "}
            <b className="font-semibold text-paper">$0/month</b>, no host, no dns, nobody can take it down.{" "}
            <span className="font-semibold text-lime">this page is the proof.</span>
          </p>
        </div>

        {/* RIGHT — stat + live console */}
        <div className="flex flex-col justify-center gap-3.5">
          <div className="relative overflow-hidden rounded-web0 border-[1.5px] border-ink0/20 bg-lime p-5 text-ink0 shadow-slab sm:p-6">
            <div className="flex items-center justify-between font-mono text-[12px] font-bold uppercase tracking-[0.12em]">
              <span>cost to run forever</span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-[7px] w-[7px] animate-pulsering rounded-full bg-magenta" />
                live
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-1 font-display text-[clamp(56px,7.5vw,104px)] font-black leading-[0.82] tracking-[-0.04em]">
              <span className="text-[0.5em]">$</span>0
              <span className="self-center font-mono text-[0.26em] font-bold lowercase opacity-70">/mo</span>
            </div>
            <div className="mt-1.5 font-mono text-[12.5px] font-bold opacity-80">no server · no host · no renewal</div>
          </div>

          <div className="overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)]">
            <div className="flex items-center gap-2 border-b-[1.5px] border-line px-3.5 py-3">
              <span className="flex gap-1.5">
                <b className="h-[11px] w-[11px] rounded-full bg-magenta" />
                <b className="h-[11px] w-[11px] rounded-full bg-lime" />
                <b className="h-[11px] w-[11px] rounded-full bg-cyan" />
              </span>
              <span className="ml-1.5 font-mono text-[11.5px] tracking-wide text-faint">web0://name-registry · mainnet</span>
            </div>

            <div className="p-3.5">
              <div className="flex items-center gap-2.5 rounded-xl border-[1.5px] border-line bg-black/30 px-3.5 py-3 transition focus-within:border-mint focus-within:shadow-[0_0_0_4px_rgba(61,255,176,0.12)]">
                <span className="font-mono text-lg font-bold text-cyan">&gt;</span>
                <input
                  ref={inputRef}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder="check any .null name"
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 border-none bg-transparent font-mono text-[15px] tracking-tight text-paper outline-none placeholder:text-faint"
                />
                <span className="font-mono text-[15px] font-bold text-mint">.null</span>
              </div>

              {/* status */}
              <div className="mt-3 min-h-[1.4em] font-mono text-[12.5px]">
                <StatusLine
                  name={name}
                  check={check}
                  avail={avail}
                  loadingAvail={loadingAvail}
                  availError={availError}
                  fmtSolFee={fmtSolFee}
                  fmtNullFee={fmtNullFee}
                />
              </div>

              {/* suggestion chips */}
              <div className="mt-3 flex flex-wrap gap-2">
                {["agent", "shop", "vault", "parad0x"].map((s, i) => (
                  <button
                    key={s}
                    onClick={() => pick(s)}
                    className={`rounded-full border-[1.5px] border-line bg-paper/[0.03] px-3 py-1.5 font-mono text-[12.5px] font-bold text-dim transition hover:-translate-y-0.5 ${
                      ["hover:bg-mint", "hover:bg-magenta hover:text-paper", "hover:bg-cyan", "hover:bg-lime"][i]
                    } ${i !== 1 ? "hover:text-ink0 hover:border-transparent" : "hover:border-transparent"}`}
                  >
                    {s}.null
                  </button>
                ))}
              </div>

              {/* register affordances */}
              {isAvailable && !txSig && address && (
                <div className="mt-3.5 flex flex-wrap gap-2">
                  <CurrencyChip label={`pay ${fmtSolFee} SOL`} active={currency === "SOL"} onClick={() => setCurrency("SOL")} disabled={false} />
                  <CurrencyChip
                    label={`pay ~${fmtNullFee} NULL (−20%)`}
                    active={currency === "NULL"}
                    onClick={() => setCurrency("NULL")}
                    disabled={nullDisabled}
                  />
                </div>
              )}
              {isAvailable && !txSig && address && nullDisabled && (
                <div className="mt-2 font-mono text-[11px] text-faint">
                  {hasNullAta
                    ? `NULL needs ≥ ${fmtNullFee} (you have ${nullBalance !== null ? nullAtomicToHuman(nullBalance) : "0"}).`
                    : "no $NULL account here — pay with SOL, or fund NULL first."}
                </div>
              )}

              {/* primary CTA */}
              {!txSig && (
                <button
                  onClick={isAvailable ? (address ? onRegister : connect) : () => inputRef.current?.focus()}
                  disabled={registering || connecting}
                  className="group mt-3.5 flex w-full items-center justify-center gap-2.5 rounded-xl bg-mint px-4 py-3.5 font-sans text-[16.5px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-lime disabled:opacity-60"
                >
                  {registering
                    ? "sign in phantom…"
                    : isAvailable
                    ? address
                      ? `register ${name}.null`
                      : "connect phantom to claim"
                    : "claim your name"}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] transition group-hover:translate-x-1">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              )}
              {regError && <div className="mt-3 break-words font-mono text-xs text-danger">{regError}</div>}

              {/* success */}
              {txSig && registeredName && (
                <div className="mt-3.5 rounded-xl border-[1.5px] border-mint/50 bg-mint/[0.06] p-4">
                  <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">
                    <span className="h-[7px] w-[7px] rounded-full bg-mint" />
                    registered · solana mainnet
                  </div>
                  <div className="mb-2 font-display text-2xl font-black tracking-tight">
                    {registeredName}
                    <span className="text-mint">.null</span>
                  </div>
                  <p className="text-[13px] text-dim">owned by your wallet, on-chain, forever. no server to seize, no host to call.</p>
                  <div className="mt-3 flex flex-wrap gap-2.5">
                    <a className="rounded-lg bg-mint px-4 py-2.5 text-[13px] font-bold text-ink0 transition hover:bg-lime" href={solscanTx(txSig)} target="_blank" rel="noreferrer">
                      view on solscan ↗
                    </a>
                    <a className="rounded-lg border-[1.5px] border-line px-4 py-2.5 text-[13px] font-semibold transition hover:border-mint" href="/my-names">
                      my names →
                    </a>
                  </div>
                  <div className="mt-3 break-all font-mono text-[11px] text-faint">tx {txSig}</div>
                </div>
              )}

              <div className="mt-3 font-mono text-[11px] text-faint">
                {address ? `payer + owner: ${shortAddr(address)} · you sign once in phantom` : "non-custodial · the name is owned by your wallet, not us"}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* MARQUEE */}
      <div className="marquee mt-8 sm:mt-12" aria-hidden>
        <Marquee />
      </div>
    </>
  );
}

function StatusLine({
  name,
  check,
  avail,
  loadingAvail,
  availError,
  fmtSolFee,
  fmtNullFee,
}: {
  name: string;
  check: NameCheck | null;
  avail: Availability | null;
  loadingAvail: boolean;
  availError: string | null;
  fmtSolFee: string;
  fmtNullFee: string;
}) {
  if (name.length === 0) return <span className="text-faint">type a name to check availability on-chain</span>;
  if (check?.tier === "invalid") return <Badge tone="taken" label="invalid" text={check.reason} />;
  if (check?.tier === "premium") return <Badge tone="taken" label="premium" text={`${check.reason}`} />;
  if (loadingAvail || !avail)
    return (
      <span className="flex items-center gap-2.5 text-dim">
        <span className="spinner" /> deriving address &amp; querying mainnet…
      </span>
    );
  if (availError) return <Badge tone="taken" label="error" text={`${availError} — try again`} />;
  if (avail.status === "available")
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md bg-mint px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink0">open</span>
        <span className="text-paper">
          {name}.null — claimable, {fmtSolFee} SOL or ~{fmtNullFee} NULL
        </span>
        <a className="text-faint underline decoration-line hover:text-mint" href={solscanAddr(avail.pda)} target="_blank" rel="noreferrer">
          {shortAddr(avail.pda)} — derived in your browser
        </a>
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="rounded-md bg-magenta px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-paper">taken</span>
      <span className="text-dim">{name}.null is already an account on mainnet</span>
      {avail.owner && (
        <a className="text-faint underline decoration-line hover:text-cyan" href={solscanAddr(avail.owner)} target="_blank" rel="noreferrer">
          owner {shortAddr(avail.owner)}
        </a>
      )}
    </span>
  );
}

function Badge({ tone, label, text }: { tone: "ok" | "taken"; label: string; text: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${tone === "ok" ? "bg-mint text-ink0" : "bg-magenta text-paper"}`}>{label}</span>
      <span className="text-dim">{text}</span>
    </span>
  );
}

function CurrencyChip({ label, active, onClick, disabled }: { label: string; active: boolean; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border-[1.5px] px-3.5 py-2 font-mono text-xs transition ${
        active ? "border-transparent bg-mint font-bold text-ink0" : "border-line bg-paper/[0.03] text-dim hover:border-line2"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      {label}
    </button>
  );
}

function Marquee() {
  const names = ["agent", "vault", "shop", "parad0x", "dao", "mint", "swap", "wallet", "node", "oracle", "gm", "degen", "art", "pay", "solana"];
  // two identical halves → the -50% scroll loops seamlessly. unique keys per half.
  const half = (copy: number) =>
    names.flatMap((n, i) => {
      const els = [
        <span key={`${copy}-${n}-${i}`} className={i % 3 === 2 ? "text-transparent [-webkit-text-stroke:1.5px_rgba(244,240,230,0.4)]" : "text-paper"}>
          {n}
          <span className="text-mint">.null</span>
        </span>,
        <span key={`${copy}-star-${i}`} className="text-magenta">
          ✦
        </span>,
      ];
      return els;
    });
  return <div className="mq-track">{[...half(0), ...half(1)]}</div>;
}
