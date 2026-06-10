"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
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
  toHex,
  type StealthPayment,
} from "@/lib/nullpay";
import { MEMO_PROGRAM, normalizeName, shortAddr } from "@/lib/null-sdk";
import { signAndSendInstructions } from "@/lib/wallet";
import { explorerAddr, explorerTx } from "@/lib/cluster";

const DEBOUNCE_MS = 400;

type ResolveState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "result"; result: StealthMetaResult };

export function Pay() {
  // NullPay is LIVE on devnet — force the page onto it regardless of the global
  // toggle, but reflect that to the user so the pill + page agree.
  const { cluster, setCluster, config } = useCluster();
  const { address, connect, connecting } = useWallet();

  const [raw, setRaw] = useState("");
  const [resolve, setResolve] = useState<ResolveState>({ kind: "idle" });
  const [derived, setDerived] = useState<StealthPayment | null>(null);
  const [amount, setAmount] = useState("0.02");

  const [sending, setSending] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [paidTo, setPaidTo] = useState<{ name: string; p: string; r: string } | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  const reqId = useRef(0);
  const name = useMemo(() => normalizeName(raw), [raw]);

  // Pin /pay to devnet (where NullPay is live) on mount if we're elsewhere.
  useEffect(() => {
    if (cluster !== "devnet") setCluster("devnet");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const conn = getConnectionForCluster("devnet");
        const r = await resolveStealthMeta(conn, "devnet", name);
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
  }, [name]);

  const lamports = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n * LAMPORTS_PER_SOL);
  }, [amount]);

  const canSend =
    !!address &&
    !!derived &&
    resolve.kind === "result" &&
    resolve.result.status === "found" &&
    lamports > 0 &&
    !sending;

  const onSend = useCallback(async () => {
    if (!address || !derived || lamports <= 0) return;
    if (resolve.kind !== "result" || resolve.result.status !== "found") return;
    setPayError(null);
    setSending(true);
    try {
      const conn = getConnectionForCluster("devnet");
      const stealthPub = new PublicKey(derived.stealthPub);
      const ephemHex = toHex(derived.ephemPub);

      // 1) pay the one-time stealth address P
      const transferIx = SystemProgram.transfer({
        fromPubkey: new PublicKey(address),
        toPubkey: stealthPub,
        lamports,
      });
      // 2) publish the ephemeral R in a memo (the StealthAnnounce the recipient scans)
      const announce = `nullpay:v1:${name}.null:R=${ephemHex}`;
      const memoIx = new TransactionInstruction({
        programId: MEMO_PROGRAM,
        keys: [],
        data: Buffer.from(announce, "utf8"),
      });

      const sig = await signAndSendInstructions({
        connection: conn,
        owner: address,
        instructions: [transferIx, memoIx],
        computeUnits: 80_000,
      });
      setTxSig(sig);
      setPaidTo({ name, p: stealthPub.toBase58(), r: ephemHex });
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [address, derived, lamports, name, resolve]);

  return (
    <section className="pt-14 sm:pt-20 pb-8">
      {/* eyebrow */}
      <div className="flex items-center gap-2 mb-6">
        <span className="w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
        <span className="font-mono text-[11px] tracking-[2px] uppercase text-steel">
          private send · NullPay
        </span>
        <span className="font-mono text-[11px] tracking-[2px] uppercase text-faint hidden sm:inline">
          · live on Solana {config.label}
        </span>
      </div>

      {/* hook */}
      <h1 className="text-[clamp(40px,8vw,76px)] font-extrabold tracking-[-3px] leading-[0.92] max-w-[860px]">
        send to a name.
        <br className="hidden sm:block" /> hide the
        <span className="text-acc"> receiver.</span>
      </h1>

      <p className="max-w-[600px] mt-6 text-dim text-[16.5px] leading-relaxed">
        Pay any <strong className="text-ink font-semibold">.null</strong> name. Your wallet
        derives a fresh{" "}
        <strong className="text-ink font-semibold">one-time address</strong> in your browser —
        the money lands somewhere only the recipient can find and spend. No exchange, no
        intermediary, no link back to their main wallet.
      </p>

      {/* PAY CONSOLE */}
      <div className="mt-9 border border-line rounded-web0 bg-surf overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-bg2 font-mono text-xs text-dim">
          <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
          <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
          <span className="w-[10px] h-[10px] rounded-full bg-[#2a3340]" />
          <span className="ml-2">
            send privately to a <b className="text-steel">.null</b> name
          </span>
          <span className="ml-auto hidden sm:flex items-center gap-1.5 text-faint">
            <span className="w-[6px] h-[6px] rounded-full bg-steel" />
            {config.label}
          </span>
        </div>

        <div className="p-4">
          {/* recipient name */}
          <div className="flex items-center gap-3">
            <span className="text-acc font-mono text-lg select-none">❯</span>
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="recipient name"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-transparent border-none outline-none text-ink text-lg font-mono tracking-[0.3px] placeholder:text-faint"
            />
            <span className="font-mono text-faint text-lg hidden sm:inline">.null</span>
          </div>

          {/* resolve result */}
          <div className="mt-4">
            <ResolvePanel
              name={name}
              resolve={resolve}
              derived={derived}
              cluster="devnet"
            />
          </div>

          {/* amount + send — only when a real stealth address is ready */}
          {resolve.kind === "result" &&
            resolve.result.status === "found" &&
            derived &&
            !txSig && (
              <div className="mt-4 border border-acc-d rounded-web0 bg-bg2 p-6">
                <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-4">
                  send to {name}.null
                </div>

                <div className="flex items-center gap-3 mb-4">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    className="w-28 bg-surf border border-line rounded-lg px-3 py-2 font-mono text-ink outline-none focus:border-acc-d transition-colors"
                  />
                  <span className="font-mono text-sm text-dim">SOL</span>
                  <div className="flex gap-1.5">
                    {["0.01", "0.05", "0.1"].map((a) => (
                      <button
                        key={a}
                        onClick={() => setAmount(a)}
                        className="font-mono text-xs rounded-md border border-line bg-surf px-2.5 py-1.5 text-dim hover:text-acc hover:border-line2 transition-colors"
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
                    className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60"
                  >
                    {connecting ? "connecting…" : "Connect Phantom to send"}
                  </button>
                ) : (
                  <button
                    onClick={onSend}
                    disabled={!canSend}
                    className="rounded-xl bg-acc px-6 py-3 font-bold text-[#062018] hover:brightness-110 transition disabled:opacity-60"
                  >
                    {sending
                      ? "sign in Phantom…"
                      : `Send ${amount} SOL to ${name}.null`}
                  </button>
                )}

                <div className="font-mono text-[11px] text-faint mt-3">
                  {address ? <>from {shortAddr(address)} · </> : null}
                  you sign once in Phantom · funds go to the one-time address, not the name
                </div>
                {payError && (
                  <div className="font-mono text-xs text-danger mt-3 break-words">
                    That didn&apos;t go through — your balance is unchanged. {payError}
                  </div>
                )}
              </div>
            )}

          {/* SUCCESS */}
          {txSig && paidTo && (
            <div className="mt-4 border border-acc-d rounded-web0 bg-bg2 p-6">
              <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-3 flex items-center gap-2">
                <span className="w-[7px] h-[7px] rounded-full bg-acc" />
                sent · {config.label}
              </div>
              <div className="text-2xl font-extrabold tracking-[-1px] mb-3">
                paid {paidTo.name}
                <span className="text-acc">.null</span>
              </div>
              <p className="text-ink/90 max-w-[520px] text-[15px] leading-relaxed">
                The funds landed at a fresh one-time address. Only the recipient&apos;s view
                key can find it, and only their spend key can move it. Their main wallet never
                appears in this transaction.
              </p>
              <div className="mt-4 space-y-2">
                <ProofLine
                  label="one-time address"
                  value={paidTo.p}
                  href={explorerAddr("devnet", paidTo.p)}
                />
                <div className="font-mono text-[11px] text-faint break-all">
                  ephemeral R · {paidTo.r}
                </div>
              </div>
              <div className="flex gap-3 flex-wrap mt-5">
                <a
                  className="rounded-xl bg-acc px-5 py-3 font-bold text-[#062018] text-sm hover:brightness-110 transition"
                  href={explorerTx("devnet", txSig)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction ↗
                </a>
                <button
                  onClick={() => {
                    setRaw("");
                    setTxSig(null);
                    setPaidTo(null);
                  }}
                  className="rounded-xl border border-line2 px-5 py-3 font-semibold text-sm hover:border-acc-d transition"
                >
                  Send another →
                </button>
              </div>
              <div className="font-mono text-[11px] text-faint mt-4 break-all">
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
  cluster: "devnet";
}) {
  if (name.length === 0 || resolve.kind === "idle") {
    return (
      <div className="font-mono text-xs text-faint">
        type a recipient&apos;s .null name to resolve their stealth address…
      </div>
    );
  }
  if (resolve.kind === "loading") {
    return (
      <div className="border border-line2 rounded-web0 bg-bg2 px-5 py-4 flex items-center gap-3">
        <span className="spinner" />
        <span className="font-mono text-sm text-dim">
          resolving {name}.null &amp; reading its stealth meta-address…
        </span>
      </div>
    );
  }
  if (resolve.kind === "error") {
    return (
      <div className="border border-line2 rounded-web0 bg-bg2 px-5 py-4">
        <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2">
          couldn&apos;t reach Solana
        </div>
        <div className="text-sm text-ink break-words">{resolve.message} — try again.</div>
      </div>
    );
  }

  const r = resolve.result;

  if (r.status === "not-found") {
    return (
      <div className="border border-line2 rounded-web0 bg-bg2 px-5 py-4">
        <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2 flex items-center gap-2">
          <span className="w-[7px] h-[7px] rounded-full bg-steel" />
          not registered
        </div>
        <div className="text-2xl font-extrabold tracking-[-1px] mb-2">
          {name}
          <span className="text-acc">.null</span>
        </div>
        <div className="text-sm text-dim">
          No such name on {cluster}. Ask the recipient to register it first.
        </div>
      </div>
    );
  }

  if (r.status === "no-meta") {
    return (
      <div className="border border-line2 rounded-web0 bg-bg2 px-5 py-4">
        <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-2 flex items-center gap-2">
          <span className="w-[7px] h-[7px] rounded-full bg-steel" />
          no stealth address
        </div>
        <div className="text-2xl font-extrabold tracking-[-1px] mb-2">
          {name}
          <span className="text-acc">.null</span>
        </div>
        <div className="text-sm text-dim">
          This name exists but hasn&apos;t published a stealth meta-address yet, so it
          can&apos;t receive a private payment. The owner sets one once from their wallet.
        </div>
      </div>
    );
  }

  // found + derived
  const pBase58 = derived ? new PublicKey(derived.stealthPub).toBase58() : "";
  return (
    <div className="border border-acc-d rounded-web0 bg-bg2 px-5 py-4">
      <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-2 flex items-center gap-2">
        <span className="w-[7px] h-[7px] rounded-full bg-acc" />
        stealth address ready
      </div>
      <div className="text-2xl font-extrabold tracking-[-1px] mb-2">
        {name}
        <span className="text-acc">.null</span>
      </div>
      <p className="text-sm text-ink/90 max-w-[520px]">
        Derived a fresh one-time address for this payment. It changes every time — two
        payments to the same name never share an address on-chain.
      </p>
      {derived && (
        <div className="mt-4">
          <ProofLine
            label="pays to"
            value={pBase58}
            href={explorerAddr("devnet", pBase58)}
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
      <div className="font-mono text-[10px] tracking-[1px] uppercase text-steel mb-1">
        {label}
      </div>
      <div className="font-mono text-[11px] break-all text-steel bg-bg border border-line rounded-lg p-[9px]">
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
        <a
          className="font-mono text-[11px] text-acc hover:brightness-110"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          View on Solana Explorer →
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
      <div className="border border-acc-d rounded-web0 bg-bg2 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-acc-d/40">
          <div className="flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-acc" />
            <span className="font-extrabold tracking-[-0.5px] text-lg">basic · live</span>
          </div>
          <span className="font-mono text-[10px] tracking-[1px] text-acc border border-acc-d rounded-md px-[9px] py-[4px]">
            LIVE
          </span>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Row good>
            recipient is <b className="text-ink">hidden</b> — funds go to a fresh one-time
            address, never their main wallet
          </Row>
          <Row good>two payments to the same name share no on-chain address</Row>
          <Row good>no exchange, no mixer, no custodian — pure wallet-to-key math</Row>
          <Row>
            <span className="text-steel">sender is still visible</span> — your wallet is the
            on-chain payer. That&apos;s normal for a basic send.
          </Row>
        </div>
      </div>

      {/* max private — the shielded-pool route (stub) */}
      <div className="border border-line rounded-web0 bg-surf overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-steel" />
            <span className="font-extrabold tracking-[-0.5px] text-lg text-dim">
              max private
            </span>
          </div>
          <span className="font-mono text-[10px] tracking-[1px] text-steel border border-line2 rounded-md px-[9px] py-[4px]">
            SOON
          </span>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Row>
            route through the <b className="text-ink">shielded pool</b> so the{" "}
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
              className="font-mono text-xs rounded-md border border-line2 bg-surf px-3 py-1.5 text-faint cursor-not-allowed opacity-60"
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
        className={`mt-[6px] w-[6px] h-[6px] rounded-full shrink-0 ${
          good ? "bg-acc" : "bg-steel"
        }`}
      />
      <span className="text-[14px] text-dim leading-relaxed">{children}</span>
    </div>
  );
}
