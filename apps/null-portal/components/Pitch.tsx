"use client";

import { Reveal } from "./Reveal";
import { useCountUp } from "./useCountUp";

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
    <section className="pt-14 sm:pt-20 pb-8 border-t border-line">
      <Reveal>
        <div className="text-[12px] tracking-[3px] uppercase text-steel mb-5">
          the part nobody tells you
        </div>
        <h2 className="text-[clamp(30px,5.6vw,54px)] font-extrabold tracking-[-2px] leading-[0.98] max-w-[760px]">
          a real website normally costs money
          <span className="text-acc"> every single month</span>. this one costs
          <span className="text-acc"> nothing</span>.
        </h2>
        <p className="max-w-[620px] mt-5 text-dim text-[16px] leading-relaxed">
          You&apos;re looking at the proof. This page has{" "}
          <strong className="text-ink font-semibold">no server</strong>, no DNS bill,
          no landlord. It was paid for{" "}
          <strong className="text-ink font-semibold">once</strong>, lives on Arweave,
          and is owned by a wallet — so it stays online whether anyone&apos;s watching
          or not.
        </p>
      </Reveal>

      {/* the animated cost ledger */}
      <Reveal className="mt-10" delay={80}>
        <CostLedger />
      </Reveal>

      {/* the side-by-side */}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
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
            label="Web0"
            tone="web0"
            rows={WEB0}
            kicker="web0 · owned"
          />
        </Reveal>
      </div>

      {/* kill-chips — signature positioning move */}
      <Reveal className="mt-6" delay={120}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs rounded-md border border-line bg-surf px-3 py-1.5 text-faint line-through decoration-line2">
            not a monthly bill
          </span>
          <span className="font-mono text-xs rounded-md border border-line bg-surf px-3 py-1.5 text-faint line-through decoration-line2">
            not someone else&apos;s server
          </span>
          <span className="font-mono text-xs rounded-md border border-line bg-surf px-3 py-1.5 text-faint line-through decoration-line2">
            not revocable
          </span>
          <span className="font-mono text-xs rounded-md border border-transparent bg-acc px-3 py-1.5 font-bold text-[#062018]">
            paid once · yours forever
          </span>
        </div>
      </Reveal>
    </section>
  );
}

/* ── the $0.00 / mo counter — the headline number, animated ───────────────── */

function CostLedger() {
  const [mo, moRef] = useCountUp(0, { from: 87, duration: 1500 });
  const [yr, yrRef] = useCountUp(0, { from: 1044, duration: 1700 });

  return (
    <div className="border border-acc-d rounded-web0 bg-bg2 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-bg font-mono text-xs text-dim">
        <span className="w-[7px] h-[7px] rounded-full bg-acc shadow-[0_0_0_3px_rgba(45,212,160,0.15)]" />
        what this website costs to keep online
      </div>
      <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-line">
        <div className="p-6 sm:p-8">
          <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-3">
            per month
          </div>
          <div
            ref={moRef as never}
            className="tabnum text-acc font-extrabold tracking-[-2px] leading-none text-[clamp(44px,9vw,78px)]"
          >
            ${mo.toFixed(2)}
          </div>
          <div className="font-mono text-xs text-faint mt-3">
            <span className="line-through decoration-line2">$87.00</span> on a normal host
            — now zero
          </div>
        </div>
        <div className="p-6 sm:p-8">
          <div className="font-mono text-[11px] tracking-[1.5px] uppercase text-steel mb-3">
            per year
          </div>
          <div
            ref={yrRef as never}
            className="tabnum text-acc font-extrabold tracking-[-2px] leading-none text-[clamp(44px,9vw,78px)]"
          >
            ${yr.toFixed(0)}
          </div>
          <div className="font-mono text-xs text-faint mt-3">
            no hosting, no domain renewal, no surprise invoice
          </div>
        </div>
      </div>
    </div>
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
      className={`lift h-full border rounded-web0 overflow-hidden ${
        web0 ? "border-acc-d bg-bg2" : "border-line bg-surf"
      }`}
    >
      <div
        className={`flex items-center justify-between px-5 py-4 border-b ${
          web0 ? "border-acc-d/40" : "border-line"
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`w-[7px] h-[7px] rounded-full ${web0 ? "bg-acc" : "bg-steel"}`}
          />
          <span
            className={`font-extrabold tracking-[-0.5px] text-lg ${
              web0 ? "text-ink" : "text-dim"
            }`}
          >
            {label}
          </span>
        </div>
        <span className="font-mono text-[10px] tracking-[1px] uppercase text-faint">
          {kicker}
        </span>
      </div>

      <div>
        {rows.map((r, i) => (
          <div
            key={r.k}
            className={`grid grid-cols-[1fr_auto] items-baseline gap-3 px-5 py-3.5 ${
              i !== rows.length - 1 ? "border-b border-line" : ""
            }`}
          >
            <div className="min-w-0">
              <div
                className={`font-mono text-[13px] ${web0 ? "text-ink" : "text-dim"}`}
              >
                {r.k}
              </div>
              <div className="text-[11px] text-faint mt-0.5">{r.note}</div>
            </div>
            <div
              className={`font-mono text-sm font-bold whitespace-nowrap ${
                web0 ? "text-acc" : "text-steel"
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
