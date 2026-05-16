import React, { useMemo, useState } from "react";

const listings = [
  {
    name: "Fast Research Agent",
    seller: "vector-labs",
    capability: "agent_service",
    price: "2,500 atoms",
    latency: "p95 740ms",
    success: "99.1%",
    dispute: "0.4%",
    proof: ["receipt-bound", "policy-v1", "aggregate stats"],
    category: "workflow_tool",
    status: "LIVE",
  },
  {
    name: "GPU Render Slot",
    seller: "neon-compute",
    capability: "gpu_compute",
    price: "metered cap 25,000",
    latency: "queued",
    success: "98.2%",
    dispute: "1.1%",
    proof: ["output digest", "logs digest", "refund rules"],
    category: "compute_demo",
    status: "GATED",
  },
  {
    name: "Market Data Feed",
    seller: "delta-oracle",
    capability: "market_data",
    price: "stream 100/sec",
    latency: "p95 310ms",
    success: "99.7%",
    dispute: "0.1%",
    proof: ["stream replay-safe", "webhook signed", "receipt chain"],
    category: "data_enrichment",
    status: "LIVE",
  },
  {
    name: "Physical Goods Demo",
    seller: "manual-review",
    capability: "physical_goods",
    price: "not in beta",
    latency: "manual",
    success: "N/A",
    dispute: "N/A",
    proof: ["seller verification required", "separate safety gate", "dispute queue"],
    category: "physical_goods",
    status: "OUT_OF_BETA",
  },
];

const wizardSteps = [
  ["Profile", "seller ID, wallet proof, optional domain"],
  ["Template", "API, data feed, compute, agent service, auction"],
  ["Capability", "tags, endpoint, schemas, SLA"],
  ["Pricing", "fixed, metered, stream, auction, bundle"],
  ["Policy", "PolicyInputV1 pre-check and review queue"],
  ["Manifest", "preview, sign, version, publish"],
];

const controlPlane = [
  ["Policy", "Frozen PolicyInputV1, stable decision hash, audit event"],
  ["Tax", "gross proceeds, refunds, fees, threshold status"],
  ["Privacy", "PII off immutable proof, erasure preserves receipt verification"],
  ["Graph access", "raw pair events private, public stats thresholded"],
  ["Governance", "denylist evidence, appeal queue, versioned rules"],
  ["Mayhem", "quote flood, replay, wash, bundle loop, stale emergency block"],
];

const receiptRows = [
  ["quoteId", "q_7f2...91c"],
  ["commitId", "c_a10...44b"],
  ["manifestHash", "5c41...e0a"],
  ["policyDecisionHash", "9b4f...27e"],
  ["feeWaterfallHash", "31aa...992"],
  ["responseDigest", "valid / bound"],
];

function StatusPill({ status }: { status: string }) {
  return <span className={`mp-status ${status.toLowerCase()}`}>{status}</span>;
}

export const Marketplace: React.FC = () => {
  const [selectedCapability, setSelectedCapability] = useState("all");
  const filtered = useMemo(() => (
    selectedCapability === "all"
      ? listings
      : listings.filter((listing) => listing.capability === selectedCapability)
  ), [selectedCapability]);

  return (
    <section className="marketplace-page">
      <header className="mp-topbar">
        <div>
          <p className="eyebrow">DNA x402 / Commerce Network</p>
          <h1>Marketplace Control Surface</h1>
          <p>
            Discover signed seller capabilities, compare quotes, pay through x402, verify receipts,
            and keep policy, fee, privacy, tax, and governance rules outside the market handler.
          </p>
        </div>
        <div className="mp-actions">
          <button type="button">Create Listing</button>
          <button type="button">Run Sandbox Buy</button>
        </div>
      </header>

      <div className="mp-toolbar">
        <label>
          Capability
          <select value={selectedCapability} onChange={(event) => setSelectedCapability(event.target.value)}>
            <option value="all">All capabilities</option>
            <option value="agent_service">Agent service</option>
            <option value="gpu_compute">GPU compute</option>
            <option value="market_data">Market data</option>
            <option value="physical_goods">Physical goods</option>
          </select>
        </label>
        <label>
          Proof
          <select defaultValue="receipt">
            <option value="receipt">Receipt-bound</option>
            <option value="anchored">Anchored</option>
            <option value="policy">Policy checked</option>
          </select>
        </label>
        <label>
          Settlement
          <select defaultValue="solana">
            <option value="solana">Solana USDC default</option>
            <option value="multi">Multi-chain abstracted</option>
          </select>
        </label>
        <label>
          Risk
          <select defaultValue="low">
            <option value="low">Low-risk public only</option>
            <option value="review">Review queue</option>
          </select>
        </label>
      </div>

      <div className="mp-grid">
        <section className="mp-panel mp-listings">
          <div className="mp-section-head">
            <h2>Buyer Marketplace</h2>
            <span>{filtered.length} listings</span>
          </div>
          <div className="mp-card-grid">
            {filtered.map((listing) => (
              <article className="mp-listing" key={listing.name}>
                <div className="mp-listing-title">
                  <div>
                    <h3>{listing.name}</h3>
                    <p>{listing.seller} / {listing.category}</p>
                  </div>
                  <StatusPill status={listing.status} />
                </div>
                <dl>
                  <div><dt>Capability</dt><dd>{listing.capability}</dd></div>
                  <div><dt>Price</dt><dd>{listing.price}</dd></div>
                  <div><dt>Latency</dt><dd>{listing.latency}</dd></div>
                  <div><dt>Success</dt><dd>{listing.success}</dd></div>
                  <div><dt>Dispute</dt><dd>{listing.dispute}</dd></div>
                </dl>
                <div className="mp-tags">
                  {listing.proof.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
                <div className="mp-listing-actions">
                  <button type="button">Compare Quote</button>
                  <button type="button" disabled={listing.status !== "LIVE"}>Checkout</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="mp-panel">
          <h2>Quote Comparison</h2>
          <div className="mp-quote-box">
            <strong>Best route</strong>
            <span>Market Data Feed</span>
            <span>100 atoms/sec / Solana USDC / no bridge</span>
            <span>Policy: ALLOW / version policy-v1</span>
          </div>
          <div className="mp-quote-box warn">
            <strong>Not in beta scope</strong>
            <span>Physical goods public listing</span>
            <span>Reason: separate safety gate required before launch</span>
          </div>
          <h2>Receipt Viewer</h2>
          <div className="mp-receipt">
            {receiptRows.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <div className="mp-grid lower">
        <section className="mp-panel">
          <div className="mp-section-head">
            <h2>Seller Wizard</h2>
            <span>manifest versioning</span>
          </div>
          <ol className="mp-wizard">
            {wizardSteps.map(([title, detail], index) => (
              <li key={title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mp-panel">
          <div className="mp-section-head">
            <h2>Control Plane</h2>
            <span>rules outside market</span>
          </div>
          <div className="mp-control-grid">
            {controlPlane.map(([title, detail]) => (
              <div key={title}>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
};
