"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./WalletProvider";
import { useCluster } from "./ClusterProvider";
import {
  getConnectionForCluster,
  resolveStealthMeta,
  type StealthMetaResult,
} from "@/lib/chain";
import {
  derive,
  randomSeed32,
  type StealthPayment,
} from "@/lib/nullpay";
import { normalizeName, shortAddr } from "@/lib/null-sdk";
import { signAndSendInstructions } from "@/lib/wallet";
import { explorerAddr, explorerTx, type Cluster } from "@/lib/cluster";
import { buildPrivatePayment, resolveIxFor, toAtomic, type Asset } from "@/lib/stealth";

const DEBOUNCE_MS = 400;

type ResolveState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "result"; result: StealthMetaResult };

export function Pay() {
  // Private pay runs on the ACTIVE cluster (mainnet by default) — the stealth meta
  // lives on the cluster's sha256 registrar, same code path mainnet↔devnet.
  const { cluster, config } = useCluster();
  const { address, connect, connecting } = useWallet();

  const [raw, setRaw] = useState("");
  const [resolve, setResolve] = useState<ResolveState>({ kind: "idle" });
  const [derived, setDerived] = useState<StealthPayment | null>(null);
  const [asset, setAsset] = useState<Asset>("USDC");
  const [amount, setAmount] = useState("1.00");

  const [sending, setSending] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [paidTo, setPaidTo] = useState<{ name: string; p: string; r: string } | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  const reqId = useRef(0);
  const name = useMemo(() => normalizeName(raw), [raw]);

  // Debounced resolve of the recipient name -> stealth meta.
  useEffect(() => {
    setTxSig(null);
    setPaidTo(null);
    setPayError(null);
    setDerived(null);

    if (name.length < 1) {
      setResolve({ kind: "idle" });
      return;
    }
    const myReq = ++reqId.current;
    setResolve({ kind: "loading" });
    const t = setTimeout(async () => {
      try {
        const conn = getConnectionForCluster(cluster);
        const r = await resolveStealthMeta(conn, cluster, name);
        if (reqId.current !== myReq) return;
        setResolve({ kind: "result", result: r });
        // If a meta exists, derive a fresh one-time address right away (browser-only).
        if (r.status === "found") {
          const payment = derive(r.meta, randomSeed32());
          setDerived(payment);
        }
      } catch (e) {
        if (reqId.current === myReq) {
          setResolve({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [name, cluster]);

  const amountAtomic = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return toAtomic(n, asset);
  }, [amount, asset]);

  const canSend =
    !!address &&
    !!derived &&
    resolve.kind === "result" &&
    resolve.result.status === "found" &&
    amountAtomic > 0n &&
    !sending;

  const onSend = useCallback(async () => {
    if (!address || amountAtomic <= 0n) return;
    if (resolve.kind !== "result" || resolve.result.status !== "found") return;
    setPayError(null);
    setSending(true);
    try {
      const conn = getConnectionForCluster(cluster);
      // Build the private payment: derive a fresh one-time address P, pay SOL or
      // USDC to it, announce R, and reference the domain PDA (Resolve) so the
      // recipient can find it. A fresh P every send — never reused.
      const resolveIx = await resolveIxFor(cluster, name);
      const built = buildPrivatePayment({
        cluster,
        sender: new PublicKey(address),
        name,
        meta64: resolve.result.meta,
        asset,
        amountAtomic,
        resolveIx,
      });
      const sig = await signAndSendInstructions({
        connection: conn,
        owner: address,
        instructions: built.instructions,
        computeUnits: built.computeUnits,
      });
      setTxSig(sig);
      setPaidTo({ name, p: built.stealthPub, r: built.ephemHex });
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [address, amountAtomic, asset, cluster, name, resolve]);

  return (
    <section className="pt-12 sm:pt-16 pb-8">
      {/* eyebrow */}
      <span className="flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-wide text-dim">
        <span className="h-[9px] w-[9px] animate-pulsering rounded-full bg-mint" />
        private send · nullpay
        <span className="hidden text-cyan sm:inline">
          · live on solana {config.label}
        </span>
      </span>

      {/* hook */}
      <h1 className="mt-5 max-w-[14ch] font-display text-[clamp(46px,9vw,116px)] font-black leading-[0.84] tracking-[-0.035em] lowercase">
        pay anyone
        <br className="hidden sm:block" /> by name.{" "}
        <span className="text-mint">privately.</span>
      </h1>

      <p className="mt-6 max-w-[62ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
        send to any <b className="font-semibold text-paper">.null</b> name. your wallet
        derives a fresh{" "}
        <b className="font-semibold text-paper">one-time address</b> right here in your
        browser — the money lands somewhere only the recipient can find and spend.{" "}
        <span className="font-semibold text-lime">no exchange, no middleman, no link back to their main wallet.</span>
      </p>

      {/* PAY CONSOLE — v4 glass */}
      <div className="mt-9 overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)]">
        <div className="flex items-center gap-2 border-b-[1.5px] border-line px-3.5 py-3">
          <span className="flex gap-1.5">
            <b className="h-[11px] w-[11px] rounded-full bg-magenta" />
            <b className="h-[11px] w-[11px] rounded-full bg-lime" />
            <b className="h-[11px] w-[11px] rounded-full bg-cyan" />
          </span>
          <span className="ml-1.5 font-mono text-[11.5px] tracking-wide text-faint">
            web0://nullpay · {config.label}
          </span>
          <span className="ml-auto hidden items-center gap-1.5 font-mono text-[11.5px] text-faint sm:flex">
            <span className="h-[6px] w-[6px] animate-pulsering rounded-full bg-mint" />
            live
          </span>
        </div>

        <div className="p-3.5 sm:p-4">
          {/* recipient name */}
          <div className="flex items-center gap-2.5 rounded-xl border-[1.5px] border-line bg-black/30 px-3.5 py-3 transition focus-within:border-mint focus-within:shadow-[0_0_0_4px_rgba(61,255,176,0.12)]">
            <span className="select-none font-mono text-lg font-bold text-cyan">&gt;</span>
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="recipient name"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 border-none bg-transparent font-mono text-[15px] tracking-tight text-paper outline-none placeholder:text-faint"
            />
            <span className="font-mono text-[15px] font-bold text-mint">.null</span>
          </div>

          {/* resolve result */}
          <div className="mt-3.5">
            <ResolvePanel
              name={name}
              resolve={resolve}
              derived={derived}
              cluster={cluster}
            />
          </div>

          {/* amount + send — only when a real stealth address is ready */}
          {resolve.kind === "result" &&
            resolve.result.status === "found" &&
            derived &&
            !txSig && (
              <div className="mt-3.5 rounded-web0 border-[1.5px] border-mint/50 bg-mint/[0.06] p-5 sm:p-6">
                <div className="mb-4 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">
                  send to {name}.null
                </div>

                {/* asset selector */}
                <div className="mb-3 flex gap-1.5">
                  {(["USDC", "SOL"] as Asset[]).map((a) => (
                    <button
                      key={a}
                      onClick={() => {
                        setAsset(a);
                        setAmount(a === "USDC" ? "1.00" : "0.05");
                      }}
                      className={`rounded-lg border-[1.5px] px-3.5 py-1.5 font-mono text-[12.5px] font-bold transition ${
                        asset === a ? "border-mint bg-mint text-ink0" : "border-line text-dim hover:border-mint"
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>

                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    className="w-28 rounded-xl border-[1.5px] border-line bg-black/30 px-3.5 py-2.5 font-mono text-paper outline-none transition focus:border-mint focus:shadow-[0_0_0_4px_rgba(61,255,176,0.12)]"
                  />
                  <span className="font-mono text-sm font-bold text-paper">{asset}</span>
                  <div className="flex gap-1.5">
                    {(asset === "USDC" ? ["1", "5", "25"] : ["0.01", "0.05", "0.1"]).map((a) => (
                      <button
                        key={a}
                        onClick={() => setAmount(a)}
                        className="rounded-full border-[1.5px] border-line bg-paper/[0.03] px-3 py-1.5 font-mono text-[12.5px] font-bold text-dim transition hover:-translate-y-0.5 hover:border-transparent hover:bg-mint hover:text-ink0"
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </div>

                {!address ? (
                  <button
                    onClick={connect}
                    disabled={connecting}
                    className="rounded-xl bg-mint px-6 py-3.5 font-sans text-[16.5px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-lime disabled:opacity-60"
                  >
                    {connecting ? "connecting…" : "connect phantom to send"}
                  </button>
                ) : (
                  <button
                    onClick={onSend}
                    disabled={!canSend}
                    className="rounded-xl bg-mint px-6 py-3.5 font-sans text-[16.5px] font-bold tracking-tight text-ink0 transition hover:-translate-y-px hover:bg-lime disabled:opacity-60"
                  >
                    {sending
                      ? "sign in phantom…"
                      : `send ${amount} ${asset} to ${name}.null`}
                  </button>
                )}

                <div className="mt-3 font-mono text-[11px] text-faint">
                  {address ? <>from {shortAddr(address)} · </> : null}
                  you sign once in phantom · funds go to the one-time address, not the name
                </div>
                {payError && (
                  <div className="mt-3 break-words font-mono text-xs text-danger">
                    that didn&apos;t go through — your balance is unchanged. {payError}
                  </div>
                )}
              </div>
            )}

          {/* SUCCESS */}
          {txSig && paidTo && (
            <div className="mt-3.5 rounded-web0 border-[1.5px] border-mint/50 bg-mint/[0.06] p-5 sm:p-6">
              <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">
                <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-mint" />
                sent · solana {config.label}
              </div>
              <div className="mb-3 font-display text-[clamp(28px,4vw,40px)] font-black leading-[0.92] tracking-[-0.02em] lowercase">
                paid {paidTo.name}
                <span className="text-mint">.null</span>
              </div>
              <p className="max-w-[58ch] text-[15px] leading-relaxed text-dim">
                the funds landed at a fresh one-time address. only the recipient&apos;s view
                key can find it, and only their spend key can move it. their main wallet never
                appears in this transaction.
              </p>
              <div className="mt-4 space-y-2">
                <ProofLine
                  label="one-time address"
                  value={paidTo.p}
                  href={explorerAddr(cluster, paidTo.p)}
                />
                <div className="break-all font-mono text-[11px] text-faint">
                  ephemeral R · {paidTo.r}
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2.5">
                <a
                  className="rounded-lg bg-mint px-5 py-2.5 text-[13px] font-bold text-ink0 transition hover:bg-lime"
                  href={explorerTx(cluster, txSig)}
                  target="_blank"
                  rel="noreferrer"
                >
                  view transaction ↗
                </a>
                <button
                  onClick={() => {
                    setRaw("");
                    setTxSig(null);
                    setPaidTo(null);
                  }}
                  className="rounded-lg border-[1.5px] border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-mint"
                >
                  send another →
                </button>
              </div>
              <div className="mt-4 break-all font-mono text-[11px] text-faint">
                tx {txSig}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* BURNER-DISCIPLINE / PRIVACY TIERS */}
      <PrivacyTiers />
    </section>
  );
}

function ResolvePanel({
  name,
  resolve,
  derived,
  cluster,
}: {
  name: string;
  resolve: ResolveState;
  derived: StealthPayment | null;
  cluster: Cluster;
}) {
  if (name.length === 0 || resolve.kind === "idle") {
    return (
      <div className="font-mono text-[12.5px] text-faint">
        type a recipient&apos;s .null name to resolve their stealth address…
      </div>
    );
  }
  if (resolve.kind === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-web0 border-[1.5px] border-line bg-black/30 px-5 py-4">
        <span className="spinner" />
        <span className="font-mono text-sm text-dim">
          resolving {name}.null &amp; reading its stealth meta-address…
        </span>
      </div>
    );
  }
  if (resolve.kind === "error") {
    return (
      <div className="rounded-web0 border-[1.5px] border-magenta/50 bg-magenta/[0.06] px-5 py-4">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-magenta">
          <span className="h-[7px] w-[7px] rounded-full bg-magenta" />
          couldn&apos;t reach solana
        </div>
        <div className="break-words text-sm text-paper">{resolve.message} — try again.</div>
      </div>
    );
  }

  const r = resolve.result;

  if (r.status === "not-found") {
    return (
      <div className="rounded-web0 border-[1.5px] border-magenta/50 bg-magenta/[0.06] px-5 py-4">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-magenta">
          <span className="h-[7px] w-[7px] rounded-full bg-magenta" />
          not registered
        </div>
        <div className="mb-2 font-display text-2xl font-black tracking-tight lowercase">
          {name}
          <span className="text-magenta">.null</span>
        </div>
        <div className="text-sm text-dim">
          no such name on {cluster}. ask the recipient to register it first.
        </div>
      </div>
    );
  }

  if (r.status === "no-meta") {
    return (
      <div className="rounded-web0 border-[1.5px] border-line2 bg-black/30 px-5 py-4">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-steel">
          <span className="h-[7px] w-[7px] rounded-full bg-steel" />
          no stealth address
        </div>
        <div className="mb-2 font-display text-2xl font-black tracking-tight lowercase">
          {name}
          <span className="text-steel">.null</span>
        </div>
        <div className="text-sm text-dim">
          this name exists but hasn&apos;t published a stealth meta-address yet, so it
          can&apos;t receive a private payment. the owner sets one once from their wallet.
        </div>
      </div>
    );
  }

  // found + derived
  const pBase58 = derived ? new PublicKey(derived.stealthPub).toBase58() : "";
  return (
    <div className="rounded-web0 border-[1.5px] border-mint/50 bg-mint/[0.06] px-5 py-4">
      <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-mint">
        <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-mint" />
        stealth address ready
      </div>
      <div className="mb-2 font-display text-2xl font-black tracking-tight lowercase">
        {name}
        <span className="text-mint">.null</span>
      </div>
      <p className="max-w-[58ch] text-sm text-dim">
        derived a fresh one-time address for this payment. it changes every time — two
        payments to the same name never share an address on-chain.
      </p>
      {derived && (
        <div className="mt-4">
          <ProofLine
            label="pays to"
            value={pBase58}
            href={explorerAddr(cluster, pBase58)}
            note="computed in your browser, just now"
          />
        </div>
      )}
    </div>
  );
}

function ProofLine({
  label,
  value,
  href,
  note,
}: {
  label: string;
  value: string;
  href: string;
  note?: string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[1px] text-faint">
        {label}
      </div>
      <div className="break-all rounded-lg border-[1.5px] border-line bg-black/30 p-[9px] font-mono text-[11px] text-cyan">
        {value}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <a
          className="font-mono text-[11px] text-cyan underline decoration-line hover:text-mint"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          view on solana explorer →
        </a>
        {note && <span className="font-mono text-[10px] text-faint">· {note}</span>}
      </div>
    </div>
  );
}

/* ── burner discipline: what's hidden, what isn't, what's next ─────────────── */

function PrivacyTiers() {
  return (
    <div className="mt-10 grid gap-4 md:grid-cols-2">
      {/* basic tier — what you get today */}
      <div className="overflow-hidden rounded-web0 border-[1.5px] border-mint/50 bg-mint/[0.04]">
        <div className="flex items-center justify-between border-b-[1.5px] border-mint/30 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-mint" />
            <span className="font-display text-lg font-black tracking-tight lowercase">basic · live</span>
          </div>
          <span className="rounded-full bg-mint px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-ink0">
            LIVE
          </span>
        </div>
        <div className="space-y-3 px-5 py-4">
          <Row good>
            recipient is <b className="text-paper">hidden</b> — funds go to a fresh one-time
            address, never their main wallet
          </Row>
          <Row good>two payments to the same name share no on-chain address</Row>
          <Row good>no exchange, no mixer, no custodian — pure wallet-to-key math</Row>
          <Row>
            <span className="text-steel">sender is still visible</span> — your wallet is the
            on-chain payer. that&apos;s normal for a basic send.
          </Row>
        </div>
      </div>

      {/* max private — the shielded-pool route (stub) */}
      <div className="overflow-hidden rounded-web0 border-[1.5px] border-line bg-bg2/65 backdrop-blur-md">
        <div className="flex items-center justify-between border-b-[1.5px] border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] rounded-full bg-steel" />
            <span className="font-display text-lg font-black tracking-tight lowercase text-dim">
              max private
            </span>
          </div>
          <span className="rounded-full border-[1.5px] border-line2 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-steel">
            SOON
          </span>
        </div>
        <div className="space-y-3 px-5 py-4">
          <Row>
            route through the <b className="text-paper">shielded pool</b> so the{" "}
            <span className="text-steel">sender</span> is hidden too
          </Row>
          <Row>break the link between your wallet and the payment entirely</Row>
          <Row>
            privacy settlement on devnet; mainnet is gated on the final trusted setup + an
            audit
          </Row>
          <div className="pt-1">
            <button
              disabled
              className="cursor-not-allowed rounded-full border-[1.5px] border-line2 bg-paper/[0.02] px-3.5 py-1.5 font-mono text-xs text-faint opacity-60"
            >
              route through shielded pool — coming
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ children, good }: { children: React.ReactNode; good?: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={`mt-[6px] h-[6px] w-[6px] shrink-0 rounded-full ${
          good ? "bg-mint" : "bg-steel"
        }`}
      />
      <span className="text-[14px] leading-relaxed text-dim">{children}</span>
    </div>
  );
}
