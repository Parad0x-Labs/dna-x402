import React from "react";
import { Link } from "react-router-dom";

const useCases = [
  {
    title: "Agent services",
    capability: "agent_service",
    examples: "research, scraping, automation, moderation, support",
    primitive: "fixed, metered, bundle",
  },
  {
    title: "GPU / compute",
    capability: "gpu_compute",
    examples: "rendering, inference, training jobs, model hosting",
    primitive: "stream, metered, prepaid job",
  },
  {
    title: "Data feeds",
    capability: "market_data",
    examples: "prices, signals, crawlers, API snapshots, alerts",
    primitive: "subscription stream, usage metered",
  },
  {
    title: "Physical goods",
    capability: "physical_goods",
    examples: "merch, collectibles, hardware, custom inventory",
    primitive: "fixed price, escrow intent, receipt",
  },
  {
    title: "Auctions",
    capability: "auction_sale",
    examples: "English, Dutch, reverse, sealed bid",
    primitive: "seller-defined auction state",
  },
  {
    title: "Alpha / copy agents",
    capability: "copy_agent",
    examples: "paid signals, public PnL profile, success fees",
    primitive: "lot ledger, receipts, fee assessment",
  },
];

const primitives = [
  ["Fixed price", "One quote, one payment, one receipt.", "GREEN"],
  ["Usage metered", "Amount scales by units without changing the rail.", "GREEN"],
  ["Streaming payments", "Funded time windows and top-up style access.", "GREEN"],
  ["Netting", "Bilateral accrual for trusted low-value flows.", "GATED"],
  ["Auctions", "Seller-defined English, Dutch, reverse, and sealed-bid state.", "GREEN"],
  ["Bundles", "One paid SKU can fan out into upstream paid tools.", "GREEN"],
  ["Marketplace quotes", "Signed competing quotes by capability, price, latency, reputation.", "GREEN"],
  ["Receipts", "Signed, hash-chained, response-bound payment evidence.", "GREEN"],
  ["Anchoring", "Receipts can be anchored for stronger external proof.", "GATED"],
  ["Revenue splits", "Provider/platform/alpha fee accounting by policy.", "PARTIAL"],
];

const attackMatrix = [
  ["Quote tampering", "Signed quotes and receipt binding", "covered"],
  ["Replay / double spend", "Tx and stream replay store, concurrent retry tests", "covered"],
  ["Underpay", "Verifier rejects below quote total", "covered"],
  ["Wrong mint / recipient", "Verifier maps wrong payment target to x402 errors", "covered"],
  ["Expired quote", "Finalize fails closed after TTL", "covered"],
  ["Response swap", "Receipt response digest binds paid payload", "covered"],
  ["Commit reuse", "Finalized commit is consumed after protected delivery", "covered"],
  ["Stream reuse", "Stream IDs cannot be reused across commits", "covered"],
  ["Unsafe netting", "Disabled unless explicit trusted-bilateral config", "gated"],
  ["Malicious listing", "Policy denylist, unsafe category block, abuse reports", "covered"],
  ["Seller disappears", "Reputation, receipt trail, disable/report flow", "partial"],
  ["Physical goods fraud", "Needs shipping/dispute ops before production", "manual ops"],
  ["Spam / quote flood", "Rate limits and marketplace disable controls", "partial"],
  ["Secrets leakage", "Secret scan rejects env/key/wallet dump patterns", "covered"],
  ["Admin abuse", "Admin auth and audit log required", "covered"],
];

const discoverySteps = [
  ["1", "Seller creates agent", "Wallet owns agent profile and public listing namespace."],
  ["2", "Listing manifest is signed", "Capability tags, price model, endpoint, settlement modes, and policy metadata are machine-readable."],
  ["3", "Registry indexes it", "/market/search and /market/quotes expose discoverable listings to humans and agents."],
  ["4", "Buyer agent compares quotes", "Price, latency, reputation, supported settlement, and proof tier decide route."],
  ["5", "x402 pay -> retry", "Quote, commit, finalize, signed receipt, then protected result delivery."],
  ["6", "Proof/reputation updates", "Receipts, events, reports, and fulfillment results update public trust signals."],
];

const localProof = [
  ["Programmability fixtures", "10 primitives through x402 pay flow"],
  ["Polyglot agents", "Python, Rust, browser JS all buy paid resources"],
  ["Marketplace", "signed shop manifests, search, quotes, limit orders"],
  ["Streams", "stream create/top-up/state wrapper and replay protection"],
  ["Receipts", "request/response digest binding and hash-chain verification"],
  ["Safety", "restricted listing blocks, abuse report reputation drop"],
  ["Polymarket", "local signer, pUSD dashboard, portfolio/copy gates"],
];

function Badge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  return <span className={`pp-badge ${normalized.replace(/[^a-z]+/g, "-")}`}>{value}</span>;
}

export const ProgrammablePayments: React.FC = () => (
  <section className="programmable-page">
    <header className="pp-hero">
      <div>
        <p className="eyebrow">DNA x402 / Universal Payment Rail</p>
        <h1>Programmable Payments Command Center</h1>
        <p>
          One money language for humans, agents, APIs, services, compute, auctions, subscriptions,
          bundles, physical goods, and proof-based commerce.
        </p>
      </div>
      <div className="pp-hero-actions">
        <Link className="btn-primary" to="/start">Create seller agent</Link>
        <Link className="ghost-btn" to="/marketplace">Browse marketplace</Link>
      </div>
    </header>

    <div className="pp-grid pp-top">
      <article className="pp-card pp-pitch-card">
        <h2>What we are actually selling</h2>
        <p>
          DNA x402 is not only a betting or marketplace page. It is a programmable commerce layer:
          every seller exposes a capability, every buyer can ask for quotes, every payment creates
          a receipt, and every paid result can be verified.
        </p>
        <div className="pp-command-lines">
          <code>GET /market/search?capability=gpu_compute</code>
          <code>GET /market/quotes?capability=agent_service&maxPrice=5000</code>
          <code>POST /commit to POST /finalize to GET paid result</code>
        </div>
      </article>

      <article className="pp-card">
        <h2>Discovery server</h2>
        <ol className="pp-steps">
          {discoverySteps.map(([step, title, detail]) => (
            <li key={step}>
              <span>{step}</span>
              <div><strong>{title}</strong><p>{detail}</p></div>
            </li>
          ))}
        </ol>
      </article>
    </div>

    <section className="pp-card">
      <div className="pp-section-head">
        <h2>What people can sell</h2>
        <p>Each listing becomes both a human marketplace card and a machine-readable capability quote.</p>
      </div>
      <div className="pp-usecase-grid">
        {useCases.map((item) => (
          <article className="pp-usecase" key={item.capability}>
            <h3>{item.title}</h3>
            <code>{item.capability}</code>
            <p>{item.examples}</p>
            <strong>{item.primitive}</strong>
          </article>
        ))}
      </div>
    </section>

    <div className="pp-grid pp-mid">
      <article className="pp-card">
        <h2>Programmable payment primitives</h2>
        <div className="pp-table">
          {primitives.map(([name, detail, status]) => (
            <div className="pp-table-row" key={name}>
              <strong>{name}</strong>
              <span>{detail}</span>
              <Badge value={status} />
            </div>
          ))}
        </div>
      </article>

      <article className="pp-card">
        <h2>Local proof map</h2>
        <div className="pp-proof-list">
          {localProof.map(([title, detail]) => (
            <div key={title}>
              <span className="ok-dot" />
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          ))}
        </div>
      </article>
    </div>

    <section className="pp-card">
      <div className="pp-section-head">
        <h2>Cheat / attack angle matrix</h2>
        <p>Pitch is only defensible if these are tested, scoped, gated, or called out as manual ops.</p>
      </div>
      <div className="pp-attack-grid">
        {attackMatrix.map(([attack, control, status]) => (
          <div key={attack}>
            <strong>{attack}</strong>
            <span>{control}</span>
            <Badge value={status} />
          </div>
        ))}
      </div>
    </section>

    <section className="pp-card">
      <h2>Local deploy target</h2>
      <div className="pp-deploy-grid">
        <div><span>Human marketplace</span><strong>/agent/marketplace</strong></div>
        <div><span>Seller factory</span><strong>/agent/start</strong></div>
        <div><span>Agent search API</span><strong>/market/search</strong></div>
        <div><span>Quote API</span><strong>/market/quotes</strong></div>
        <div><span>Payment rail</span><strong>/quote /commit /finalize /receipt</strong></div>
        <div><span>Proof cockpit</span><strong>/agent/control-room</strong></div>
      </div>
    </section>
  </section>
);
