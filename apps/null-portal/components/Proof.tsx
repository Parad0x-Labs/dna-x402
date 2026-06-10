"use client";

import { Reveal } from "./Reveal";
import { REGISTRAR_PROGRAM } from "@/lib/null-sdk";
import { solscanAddr } from "@/lib/null-sdk";

/* ── "the site is the receipt" — real, checkable provenance ───────────────── */

const REGISTRAR = REGISTRAR_PROGRAM.toBase58();

const STEPS = [
  {
    n: "01",
    t: "pick a name",
    d: "type it above. your browser derives the on-chain address and checks Solana mainnet live — no account needed to look.",
  },
  {
    n: "02",
    t: "pay once, sign once",
    d: "one signature in your wallet. a small one-time fee in SOL or $NULL. no subscription, no card on file.",
  },
  {
    n: "03",
    t: "own it forever",
    d: "the name becomes an account owned by your keypair. point it at a site on Arweave and it stays up with nothing left to pay.",
  },
];

export function Proof() {
  return (
    <section className="pt-14 sm:pt-20 pb-8 border-t border-line">
      <Reveal>
        <div className="text-[12px] tracking-[3px] uppercase text-steel mb-5">
          receipts, not faith
        </div>
        <h2 className="text-[clamp(28px,5vw,48px)] font-extrabold tracking-[-2px] leading-[1.0] max-w-[720px]">
          don&apos;t trust the pitch.
          <span className="text-acc"> check it.</span>
        </h2>
        <p className="max-w-[600px] mt-5 text-dim text-[16px] leading-relaxed">
          Every claim here resolves to something you can open on a block explorer
          right now. The registrar is a real program, live on{" "}
          <strong className="text-ink font-semibold">Solana mainnet</strong>.
        </p>
      </Reveal>

      {/* three honest steps */}
      <div className="mt-9 grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 90}>
            <div className="lift h-full border border-line rounded-web0 bg-surf p-6">
              <div className="font-mono text-acc font-extrabold text-2xl tracking-[-1px]">
                {s.n}
              </div>
              <div className="mt-3 font-bold tracking-[-0.4px] text-ink">{s.t}</div>
              <p className="mt-2 text-dim text-[14px] leading-relaxed">{s.d}</p>
            </div>
          </Reveal>
        ))}
      </div>

      {/* the live program id — the trust primitive */}
      <Reveal className="mt-4" delay={60}>
        <div className="border border-line rounded-web0 bg-bg2 p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-[1.5px] uppercase text-acc mb-3">
            <span className="w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
            live registrar · Solana mainnet
          </div>
          <p className="text-dim text-[14px] leading-relaxed max-w-[600px] mb-4">
            This is the on-chain program that mints every <span className="font-mono">.null</span>{" "}
            name. It runs on mainnet with no off switch — open it yourself.
          </p>
          <div className="font-mono text-[11px] sm:text-[12px] break-all text-steel bg-bg border border-line rounded-lg p-3">
            {REGISTRAR}
          </div>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <a
              className="text-sm font-semibold text-acc hover:brightness-110 transition"
              href={solscanAddr(REGISTRAR)}
              target="_blank"
              rel="noreferrer"
            >
              View on Solscan →
            </a>
            <span className="font-mono text-[10px] tracking-[1px] text-acc border border-acc-d rounded-md px-[9px] py-[4px]">
              LIVE
            </span>
            <span className="font-mono text-[11px] text-faint">
              your browser queried it the moment you typed a name
            </span>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
