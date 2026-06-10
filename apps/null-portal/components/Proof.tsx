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
    accent: "cyan",
  },
  {
    n: "02",
    t: "pay once, sign once",
    d: "one signature in your wallet. a small one-time fee in SOL or $NULL. no subscription, no card on file.",
    accent: "mint",
  },
  {
    n: "03",
    t: "own it forever",
    d: "the name becomes an account owned by your keypair. point it at a site on Arweave and it stays up with nothing left to pay.",
    accent: "lime",
  },
] as const;

const ACCENT: Record<
  (typeof STEPS)[number]["accent"],
  { num: string; bar: string }
> = {
  cyan: { num: "text-cyan", bar: "bg-cyan" },
  mint: { num: "text-mint", bar: "bg-mint" },
  lime: { num: "text-lime", bar: "bg-lime" },
};

export function Proof() {
  return (
    <section className="pt-14 sm:pt-20 pb-8 border-t border-line">
      <Reveal>
        <div className="flex w-max items-center gap-2 font-mono text-[12px] lowercase tracking-[0.18em] text-magenta">
          <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-magenta" />
          receipts, not faith
        </div>
        <h2 className="mt-4 max-w-[820px] font-display text-[clamp(38px,6.8vw,86px)] font-black lowercase leading-[0.84] tracking-[-0.035em]">
          don&apos;t trust the pitch.
          <span className="text-mint"> check it.</span>
        </h2>
        <p className="mt-5 max-w-[620px] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
          every claim here resolves to something you can open on a block explorer
          right now. the registrar is a real program, live on{" "}
          <b className="font-semibold text-paper">solana mainnet</b>.
        </p>
      </Reveal>

      {/* three honest steps — bold numbered receipt panels */}
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => {
          const a = ACCENT[s.accent];
          return (
            <Reveal key={s.n} delay={i * 90}>
              <div className="group relative flex h-full flex-col rounded-web0 border-[1.5px] border-line bg-bg2/65 p-6 backdrop-blur-md transition hover:-translate-y-1 hover:border-line2 hover:shadow-slab">
                <span className={`absolute left-0 top-6 h-9 w-[3px] rounded-full ${a.bar}`} />
                <div className={`font-display text-[clamp(44px,5vw,64px)] font-black leading-[0.8] tracking-[-0.04em] ${a.num}`}>
                  {s.n}
                </div>
                <div className="mt-3 font-display text-[22px] font-black lowercase tracking-[-0.03em] text-paper">
                  {s.t}
                </div>
                <p className="mt-2 text-[14px] leading-relaxed text-dim">{s.d}</p>
              </div>
            </Reveal>
          );
        })}
      </div>

      {/* the live program id — the trust primitive · loud lime slab */}
      <Reveal className="mt-4" delay={60}>
        <div className="relative overflow-hidden rounded-web0 border-[1.5px] border-ink0/20 bg-lime p-6 text-ink0 shadow-slab sm:p-7">
          <div className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.12em]">
            <i className="h-[7px] w-[7px] animate-pulsering rounded-full bg-magenta" />
            live registrar · solana mainnet
          </div>
          <p className="mt-3 max-w-[620px] text-[14px] font-semibold leading-relaxed opacity-80">
            this is the on-chain program that mints every{" "}
            <span className="font-mono font-bold">.null</span> name. it runs on
            mainnet with no off switch — open it yourself.
          </p>
          <div className="mt-4 break-all rounded-lg border-[1.5px] border-ink0/25 bg-ink0/10 p-3 font-mono text-[11px] font-bold tracking-tight sm:text-[12px]">
            {REGISTRAR}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a
              className="inline-flex items-center gap-1.5 rounded-full bg-ink0 px-4 py-2 font-sans text-[13.5px] font-bold text-mint transition hover:-translate-y-0.5 hover:bg-bg2"
              href={solscanAddr(REGISTRAR)}
              target="_blank"
              rel="noreferrer"
            >
              view on solscan
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            </a>
            <span className="rounded-full border-[1.5px] border-ink0/40 px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em]">
              live
            </span>
            <span className="font-mono text-[11px] font-semibold opacity-70">
              your browser queried it the moment you typed a name
            </span>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
