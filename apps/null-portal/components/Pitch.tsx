"use client";

import { Reveal } from "./Reveal";

/* ── the emotional core: what you stop paying, forever ────────────────────── */

const WEB2 = [
  { k: "server / hosting", v: "$20–200 / mo", note: "billed monthly, forever" },
  { k: "domain renewal", v: "$12–40 / yr", note: "miss it once, lose the name" },
  { k: "who holds it", v: "the registrar", note: "they can suspend or seize it" },
  { k: "can be taken down", v: "yes", note: "host, registrar, or court order" },
  { k: "if you stop paying", v: "it's gone", note: "site dark, name released" },
];

const WEB0 = [
  { k: "server / hosting", v: "$0 / mo", note: "no server exists to bill" },
  { k: "domain renewal", v: "$0 / yr", note: "paid once, no renewals, ever" },
  { k: "who holds it", v: "your wallet", note: "a key only you control" },
  { k: "can be taken down", v: "no", note: "nothing central to revoke" },
  { k: "if you stop paying", v: "still online", note: "there's nothing to stop paying" },
];

export function Pitch() {
  return (
    <section className="border-t-[1.5px] border-line pt-16 pb-10 sm:pt-24">
      <Reveal>
        <div className="mb-5 flex w-max items-center gap-2.5 font-mono text-[12px] lowercase tracking-[0.12em] text-dim">
          <span className="h-[7px] w-[7px] animate-pulsering rounded-full bg-magenta" />
          the part nobody tells you
        </div>
        <h2 className="max-w-[16ch] font-display text-[clamp(34px,6.4vw,82px)] font-black lowercase leading-[0.84] tracking-[-0.035em]">
          a web2 site costs money{" "}
          <span className="text-magenta">every month</span>. this one costs{" "}
          <span className="text-mint">nothing</span>.
        </h2>
        <p className="mt-6 max-w-[62ch] text-[clamp(14px,1.15vw,17px)] leading-relaxed text-dim">
          you&apos;re looking at the proof. this page has{" "}
          <b className="font-semibold text-paper">no server</b>, no dns bill, no
          landlord. it was paid for <b className="font-semibold text-paper">once</b>,
          lives on arweave, and is owned by a wallet — so it stays online whether
          anyone&apos;s watching or not.{" "}
          <span className="font-semibold text-lime">rented vs owned, line by line:</span>
        </p>
      </Reveal>

      {/* the side-by-side — the star of this section */}
      <div className="mt-10 grid gap-5 md:grid-cols-2">
        <Reveal delay={60}>
          <ComparePanel
            label="the old web"
            tone="web2"
            rows={WEB2}
            kicker="web2 · rented"
          />
        </Reveal>
        <Reveal delay={140}>
          <ComparePanel
            label="web0"
            tone="web0"
            rows={WEB0}
            kicker="web0 · owned"
          />
        </Reveal>
      </div>

      {/* kill-chips — signature positioning move */}
      <Reveal className="mt-7" delay={120}>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-full border-[1.5px] border-line bg-paper/[0.03] px-3.5 py-1.5 font-mono text-[12.5px] font-bold text-faint line-through decoration-magenta decoration-2">
            not a monthly bill
          </span>
          <span className="rounded-full border-[1.5px] border-line bg-paper/[0.03] px-3.5 py-1.5 font-mono text-[12.5px] font-bold text-faint line-through decoration-magenta decoration-2">
            not someone else&apos;s server
          </span>
          <span className="rounded-full border-[1.5px] border-line bg-paper/[0.03] px-3.5 py-1.5 font-mono text-[12.5px] font-bold text-faint line-through decoration-magenta decoration-2">
            not revocable
          </span>
          <span className="rounded-full border-[1.5px] border-transparent bg-lime px-3.5 py-1.5 font-mono text-[12.5px] font-bold text-ink0">
            paid once · yours forever
          </span>
        </div>
      </Reveal>

      <Reveal className="mt-6" delay={160}>
        <div className="font-mono text-[11px] lowercase tracking-[0.1em] text-faint">
          public beta · capped · unaudited · non-custodial
        </div>
      </Reveal>
    </section>
  );
}

/* ── one comparison column ────────────────────────────────────────────────── */

function ComparePanel({
  label,
  kicker,
  tone,
  rows,
}: {
  label: string;
  kicker: string;
  tone: "web2" | "web0";
  rows: { k: string; v: string; note: string }[];
}) {
  const web0 = tone === "web0";
  return (
    <div
      className={`lift h-full overflow-hidden rounded-web0 ${
        web0
          ? "border-[1.5px] border-mint/40 bg-bg2/65 shadow-slab backdrop-blur-md"
          : "border-[1.5px] border-line bg-surf/70"
      }`}
    >
      <div
        className={`flex items-center justify-between border-b-[1.5px] px-5 py-4 ${
          web0 ? "border-mint/30 bg-mint/[0.05]" : "border-line"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <span
            className={`h-[8px] w-[8px] rounded-full ${
              web0 ? "animate-pulsering bg-mint" : "bg-magenta"
            }`}
          />
          <span
            className={`font-display text-xl font-black lowercase tracking-[-0.02em] ${
              web0 ? "text-paper" : "text-dim"
            }`}
          >
            {label}
          </span>
        </div>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
            web0 ? "text-mint" : "text-magenta"
          }`}
        >
          {kicker}
        </span>
      </div>

      <div>
        {rows.map((r, i) => (
          <div
            key={r.k}
            className={`grid grid-cols-[1fr_auto] items-baseline gap-3 px-5 py-3.5 ${
              i !== rows.length - 1 ? "border-b-[1.5px] border-line" : ""
            }`}
          >
            <div className="min-w-0">
              <div
                className={`font-mono text-[13px] ${web0 ? "text-paper" : "text-dim"}`}
              >
                {r.k}
              </div>
              <div className="mt-0.5 text-[11px] text-faint">{r.note}</div>
            </div>
            <div
              className={`whitespace-nowrap font-mono text-sm font-bold ${
                web0 ? "text-mint" : "text-magenta"
              }`}
            >
              {r.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
