import React, { useState } from 'react';

const templates = [
  {
    id: 'service',
    title: 'Paid Service',
    status: 'Public',
    command: 'npx dna-x402 init agent my-service-agent --template service',
    details: 'Paid API, inference, data, and workflow endpoints with signed manifests.',
  },
  {
    id: 'marketplace',
    title: 'Marketplace Seller',
    status: 'Public',
    command: 'npx dna-x402 init agent my-market-agent --template marketplace',
    details: 'Discovery, quote, and order-planning endpoints for safe service listings.',
  },
  {
    id: 'auction',
    title: 'Auction Tool',
    status: 'Public',
    command: 'npx dna-x402 init agent my-auction-agent --template auction',
    details: 'Auction discovery and bid-planning tools with no custody or wager handling.',
  },
  {
    id: 'trading',
    title: 'Strategy Research',
    status: 'Public',
    command: 'npx dna-x402 init agent my-strategy-agent --template trading',
    details: 'Research reports, backtests, and signal previews. Execution is disabled by default.',
  },
  {
    id: 'restricted-market',
    title: 'Restricted Market',
    status: 'Separate Gate',
    command: 'npx dna-x402 init agent my-restricted-agent --template restricted-market',
    details: 'Compliance shell only. Public betting, wagering, odds, and gambling flows return HTTP 451.',
  },
];

export const Start: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);

  const copyCommand = async (id: string, command: string) => {
    await navigator.clipboard.writeText(command);
    setCopied(id);
  };

  return (
    <section className="panel creator-panel">
      <div className="creator-head">
        <div>
          <h2>/agent/start</h2>
          <p className="lead">Wallet = account. Manifest = shop. Receipt = proof.</p>
        </div>
        <a className="link-btn" href="/docs/ONE_CLICK_AGENT_FACTORY.md" target="_blank" rel="noreferrer">
          Factory Docs
        </a>
      </div>

      <div className="creator-grid">
        {templates.map((template) => (
          <article className="creator-card" key={template.id}>
            <div className="row space-between gap-sm">
              <h3>{template.title}</h3>
              <span className={template.status === 'Public' ? 'status up compact' : 'status down compact'}>
                {template.status}
              </span>
            </div>
            <p>{template.details}</p>
            <code>{template.command}</code>
            <button className="ghost-btn" type="button" onClick={() => copyCommand(template.id, template.command)}>
              {copied === template.id ? 'Copied' : 'Copy Command'}
            </button>
          </article>
        ))}
      </div>

      <ol className="creator-checklist">
        <li>Scaffold one of the public templates.</li>
        <li>Set `RECIPIENT`, `OWNER_PUBKEY`, and mainnet RPC in the generated `.env`.</li>
        <li>Run the paid endpoint locally, then sign and publish the manifest.</li>
        <li>Verify quote signatures, paid receipts, response digests, reputation, and abuse-disable flow.</li>
        <li>Keep restricted categories outside beta scope unless a separate compliance product approves them.</li>
      </ol>

      <div className="links">
        <a href="http://localhost:5173" target="_blank" rel="noreferrer">Open Wallet UI</a>
        <a href="/docs/PUBLIC_AGENT_ONBOARDING.md" target="_blank" rel="noreferrer">Public Onboarding</a>
        <a href="/docs/RESTRICTED_MARKET_POLICY.md" target="_blank" rel="noreferrer">Restricted Policy</a>
      </div>
    </section>
  );
};
