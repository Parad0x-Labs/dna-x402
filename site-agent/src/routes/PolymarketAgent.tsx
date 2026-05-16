import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import proof from "../data/polymarketProof.json";
import { useWallet, WalletMultiButton } from "../lib/wallet";

declare global {
  interface Window {
    ethereum?: {
      request: (payload: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type EvmState = {
  account: string | null;
  chainId: string | null;
  status: "idle" | "connecting" | "ready" | "error";
  error: string | null;
};

type PortfolioTab = "positions" | "orders" | "history";

const POLYGON_CHAIN_ID_HEX = "0x89";
const POLYGON_CHAIN_ID_DECIMAL = 137;

const pnlSeries = [
  { label: "09:00", value: 0 },
  { label: "10:00", value: 4 },
  { label: "11:00", value: 11 },
  { label: "12:00", value: 9 },
  { label: "13:00", value: 18 },
  { label: "14:00", value: 24 },
  { label: "15:00", value: 20 },
  { label: "Now", value: 35 },
];

const positions = [
  {
    market: "Fed cuts rates before July",
    side: "YES",
    avg: "0.41",
    now: "0.56",
    shares: "120.00",
    value: "67.20 pUSD",
    pnl: "+18.00 pUSD",
  },
  {
    market: "BTC above 120k by May 31",
    side: "YES",
    avg: "0.52",
    now: "0.48",
    shares: "80.00",
    value: "38.40 pUSD",
    pnl: "-3.20 pUSD",
  },
  {
    market: "Lakers win Game 6",
    side: "NO",
    avg: "0.61",
    now: "0.68",
    shares: "45.00",
    value: "30.60 pUSD",
    pnl: "+3.15 pUSD",
  },
];

const openOrders = [
  {
    market: "ETH all-time high before July",
    side: "BUY YES",
    price: "0.34",
    size: "40.00 pUSD",
    filled: "0%",
    mode: "Limit",
  },
  {
    market: "US CPI under 3.0% next print",
    side: "SELL NO",
    price: "0.72",
    size: "25.00 pUSD",
    filled: "35%",
    mode: "Maker",
  },
];

const history = [
  {
    time: "21:10:43",
    event: "Deposit wallet deployed",
    market: "Relayer proof",
    amount: "Tx 0x7b2d...3f1a",
    result: "GREEN",
  },
  {
    time: "21:10:18",
    event: "POLY_1271 order signed",
    market: "No-submit fixture",
    amount: "signatureType 3",
    result: "GREEN",
  },
  {
    time: "20:54:22",
    event: "Copied lot closed",
    market: "Fed cuts rates before July",
    amount: "+35.000000 pUSD",
    result: "WIN",
  },
  {
    time: "19:41:09",
    event: "Manual exit finalized",
    market: "BTC above 120k by May 31",
    amount: "-15.000000 pUSD",
    result: "LOSS_NO_FEE",
  },
];

const stops = [
  {
    label: "Fixture wallet pairing",
    state: "green",
    detail: "Phantom EVM connected and switched to Polygon 137.",
  },
  {
    label: "Order signature",
    state: proof.orderSigning.ok ? "green" : "red",
    detail: "POLY_1271 no-submit fixture has zero mismatches.",
  },
  {
    label: "Deposit wallet",
    state: proof.walletCreate.ok ? "green" : "red",
    detail: "Deposit wallet create completed through the relayer without pUSD transfer.",
  },
  {
    label: "Funding and withdrawal",
    state: "scoped",
    detail: "Paper, signal, and user-confirmed intent flows are in beta; autonomous live movement needs a separate safety gate.",
  },
  {
    label: "Copy trading",
    state: "scoped",
    detail: "Paper copy and copied-lot accounting are in beta; live fanout needs a separate safety gate.",
  },
];

const accountingRows = [
  ["Win rate", proof.accountingModel.example.winRate, "12 / 24 closed lots"],
  ["Average entry", proof.accountingModel.example.averageEntryPrice, "Weighted"],
  ["Average exit", proof.accountingModel.example.averageExitPrice, "Weighted"],
  ["24h PnL", proof.accountingModel.example.realizedPnl24h, "Realized"],
  ["7d PnL", proof.accountingModel.example.realizedPnl7d, "Realized"],
  ["30d PnL", proof.accountingModel.example.realizedPnl30d, "Realized"],
  ["All-time PnL", proof.accountingModel.example.realizedPnlAllTime, "Realized"],
  ["Closed Lots", "24", "Total"],
];

const riskRows = [
  ["Max trade size", `$${proof.agentProfileModel.defaultRiskSettings.maxTradeSizePusd}`],
  ["Max daily spend", `$${proof.agentProfileModel.defaultRiskSettings.maxDailySpendPusd}`],
  ["Max daily loss", `$${proof.agentProfileModel.defaultRiskSettings.maxDailyLossPusd}`],
  ["Max market exposure", `$${proof.agentProfileModel.defaultRiskSettings.maxMarketExposurePusd}`],
  ["Max open orders", String(proof.agentProfileModel.defaultRiskSettings.maxOpenOrders)],
  ["Max slippage", `${proof.agentProfileModel.defaultRiskSettings.maxSlippageBps} bps`],
  ["Dry-run mode", String(proof.agentProfileModel.defaultRiskSettings.dryRun)],
  ["Manual approval mode", String(proof.agentProfileModel.defaultRiskSettings.manualApprovalMode)],
  ["Category blacklist", "Politics, Sports, Crypto"],
];

const depositSteps = [
  "Fetch /supported-assets live before choices render",
  "Show Solana USDC first when supported",
  "Warn on wrong chain, unsupported token, NFTs, memecoins, and below minimum",
  "Create deposit address only for the selected asset route",
  "Track bridge /status until pUSD is credited and reconciled",
];

const proofRows = [
  ["Signature proof", "OK"],
  ["Deposit wallet proof", "OK"],
  ["POLY_1271", "OK"],
  ["signatureType = 3", "OK"],
  ["maker = deposit wallet", "OK"],
  ["signer = deposit wallet", "OK"],
  ["builder code attached", "OK"],
  ["Order signing", "No-submit fixture"],
  ["Deposit wallet deployment", "Tx: 0x7b2d...3f1a"],
];

const summaryRows = [
  ["Builder code", "0x100d...a57bb"],
  ["Builder fee", "0 bps"],
  ["DNA notional fee", "Off (V1)"],
  ["Alpha success fee", "2% copied-lot profit only"],
  ["Signature type", "POLY_1271 / 3"],
  ["Relayer", "relayer-v2.polymarket.com"],
  ["CLOB API", "clob.polymarket.com"],
  ["Owner signer", "Browser-local"],
  ["Backend custody", "None"],
];

function short(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 3) {
    return value;
  }
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function cleanAgentSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

async function ensurePolygon(): Promise<string> {
  if (!window.ethereum) {
    throw new Error("No EVM wallet found. Use Phantom EVM, Rabby, or MetaMask.");
  }
  const current = String(await window.ethereum.request({ method: "eth_chainId" }));
  if (current.toLowerCase() === POLYGON_CHAIN_ID_HEX) {
    return current;
  }

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID_HEX }],
    });
  } catch (error: any) {
    if (error?.code !== 4902) {
      throw error;
    }
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: POLYGON_CHAIN_ID_HEX,
        chainName: "Polygon Mainnet",
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        rpcUrls: ["https://polygon-rpc.com"],
        blockExplorerUrls: ["https://polygonscan.com"],
      }],
    });
  }

  return String(await window.ethereum.request({ method: "eth_chainId" }));
}

function PnlChart() {
  const width = 720;
  const height = 210;
  const padX = 22;
  const padY = 24;
  const values = pnlSeries.map((point) => point.value);
  const min = Math.min(...values, -5);
  const max = Math.max(...values, 40);
  const range = Math.max(1, max - min);
  const coords = pnlSeries.map((point, index) => {
    const x = padX + (index / (pnlSeries.length - 1)) * (width - padX * 2);
    const y = padY + (1 - (point.value - min) / range) * (height - padY * 2);
    return { ...point, x, y };
  });
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`;

  return (
    <svg className="pnl-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live PnL tracker chart">
      <defs>
        <linearGradient id="pnlArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#21d184" stopOpacity="0.38" />
          <stop offset="70%" stopColor="#1187ff" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#03111d" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pnlLine" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#1b9cff" />
          <stop offset="100%" stopColor="#29f2a4" />
        </linearGradient>
      </defs>
      <g className="chart-grid">
        {[0, 1, 2, 3].map((row) => (
          <line
            key={row}
            x1={padX}
            x2={width - padX}
            y1={padY + row * ((height - padY * 2) / 3)}
            y2={padY + row * ((height - padY * 2) / 3)}
          />
        ))}
      </g>
      <polygon points={area} fill="url(#pnlArea)" />
      <polyline points={line} fill="none" stroke="url(#pnlLine)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((point) => (
        <circle key={point.label} cx={point.x} cy={point.y} r="4" />
      ))}
    </svg>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="proof-row">
      <span className="ok-dot" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ValueTile({ label, value, note }: { label: string; value: string; note?: string }) {
  const positive = value.startsWith("+");
  const negative = value.startsWith("-");
  return (
    <div className={`value-tile ${positive ? "positive" : negative ? "negative" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export const PolymarketAgent: React.FC = () => {
  const solanaWallet = useWallet();
  const [evm, setEvm] = useState<EvmState>({
    account: null,
    chainId: null,
    status: "idle",
    error: null,
  });
  const [agentName, setAgentName] = useState("sharp-money-desk");
  const [lockedName, setLockedName] = useState<string | null>(null);
  const [portfolioTab, setPortfolioTab] = useState<PortfolioTab>("positions");

  const slug = useMemo(() => cleanAgentSlug(lockedName ?? agentName), [agentName, lockedName]);
  const ownerSetupReady = Boolean(solanaWallet.connected && evm.status === "ready" && lockedName);

  const connectEvm = async () => {
    setEvm((current) => ({ ...current, status: "connecting", error: null }));
    try {
      if (!window.ethereum) {
        throw new Error("No EVM wallet found. Use Phantom EVM, Rabby, or MetaMask.");
      }
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      const chainId = await ensurePolygon();
      if (chainId.toLowerCase() !== POLYGON_CHAIN_ID_HEX) {
        throw new Error(`Wallet must be on Polygon ${POLYGON_CHAIN_ID_DECIMAL}; got ${chainId}.`);
      }
      setEvm({
        account: accounts[0] ?? null,
        chainId,
        status: "ready",
        error: null,
      });
    } catch (error) {
      setEvm({
        account: null,
        chainId: null,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const createAgent = () => {
    const cleaned = cleanAgentSlug(agentName);
    if (!cleaned) {
      return;
    }
    setLockedName(cleaned);
  };

  return (
    <section className="polymarket-terminal" aria-label="DNA x402 Polymarket agent desk">
      <header className="terminal-topbar">
        <Link className="terminal-brand" to="/">
          <span className="brand-mark">DX</span>
          <span>DNA x402</span>
        </Link>
        <nav className="terminal-nav" aria-label="Polymarket desk navigation">
          <Link to="/control-room">Control Room</Link>
          <Link to="/start">Create Agents</Link>
          <Link to="/programmable-payments">Programmable Payments</Link>
          <Link className="active" to="/polymarket">Polymarket Agent</Link>
          <Link to="/proof">Proof</Link>
        </nav>
        <div className="terminal-actions">
          <span className="system-pill"><span className="ok-dot" />System Online</span>
          <span className="beta-pill">Beta</span>
          <select aria-label="Agent profile selector" value={slug || "sharp-money-desk"} disabled>
            <option value={slug || "sharp-money-desk"}>{slug || "sharp-money-desk"}</option>
          </select>
        </div>
      </header>

      <div className="terminal-shell">
        <aside className="terminal-sidebar" aria-label="Agent desk sections">
          {["Control Room", "Agents", "Markets", "Positions", "Copy Trading", "Funding", "Audit Log", "Alpha Profiles", "Settings"].map((item) => (
            <a href={`#${item.toLowerCase().replace(/\s+/g, "-")}`} key={item}>
              <span className="rail-icon">{item.slice(0, 1)}</span>
              <span>{item}</span>
            </a>
          ))}
          <div className="rail-status">
            <span><span className="ok-dot" />All Systems Go</span>
            <small>May 15, 2026<br />00:42 UTC+3</small>
          </div>
        </aside>

        <main className="terminal-main">
          <section className="terminal-titlebar">
            <div>
              <h1>/agent/polymarket</h1>
              <p>One wallet-led setup for Solana funding, Polymarket deposit-wallet trading, portfolio PnL, and copy-agent controls.</p>
            </div>
            <div className="titlebar-status">
              <span className="status up">Signature proof green</span>
              <span className="status up">Deposit wallet proof green</span>
            </div>
          </section>

          <div className="desk-grid desk-grid-top">
            <article className="desk-card wallet-card" id="agents">
              <h2>Wallet & Identity</h2>
              <div className="identity-card">
                <span>Solana Owner (Phantom)</span>
                <strong>{solanaWallet.publicKey ? short(solanaWallet.publicKey.toBase58()) : "Not connected"}</strong>
                <small>{solanaWallet.connected ? "Connected via Phantom" : "Connect owner wallet for funding identity"}</small>
                <WalletMultiButton />
              </div>
              <div className="identity-card">
                <span>Phantom EVM (Polygon)</span>
                <strong>{evm.account ? `${short(evm.account)} on Polygon` : "Not connected"}</strong>
                <small>{evm.status === "ready" ? "Connected via Phantom EVM" : "Required for browser-local POLY_1271 signing"}</small>
                <button type="button" className="desk-button" onClick={connectEvm} disabled={evm.status === "connecting"}>
                  {evm.status === "connecting" ? "Connecting..." : "Connect Phantom EVM"}
                </button>
                {evm.error && <small className="status down">{evm.error}</small>}
              </div>
            </article>

            <article className="desk-card agent-card">
              <h2>Agent Creation</h2>
              <label className="field-stack">
                Agent name (immutable)
                <input
                  value={agentName}
                  disabled={Boolean(lockedName)}
                  onChange={(event) => setAgentName(event.target.value)}
                  placeholder="sharp-money-desk"
                />
              </label>
              <button type="button" className="lock-button" disabled={Boolean(lockedName) || !slug} onClick={createAgent}>
                {lockedName ? "Agent name locked" : "Lock agent name"}
              </button>
              <div className="agent-url-preview">/agent/polymarket/{slug || "name-required"}</div>
              {lockedName && (
                <Link className="link-btn" to={`/polymarket/${lockedName}`}>
                  Open public alpha page
                </Link>
              )}
              <div className="agent-meta">
                <span>Created<br /><strong>May 14, 2026 21:05 UTC+3</strong></span>
                <span>Status<br /><strong className="positive-text">Active</strong></span>
              </div>
              <p className="muted">Names lock because public alpha pages and copied-lot ledgers depend on stable agent IDs.</p>
            </article>

            <article className="desk-card proof-card" id="audit-log">
              <h2>Live Proof Evidence (Phase 0)</h2>
              <div className="proof-list">
                {proofRows.map(([label, value]) => <StatusRow key={label} label={label} value={value} />)}
              </div>
              <div className="proof-footer">
                <span>Proof snapshots</span>
                <strong>2 saved</strong>
                <button type="button" className="desk-button">View Proofs</button>
              </div>
            </article>

            <article className="desk-card funding-card" id="funding">
              <h2>Funding Model</h2>
              <div className="asset-row usd">
                <span className="asset-icon">$</span>
                <div><strong>pUSD / USD</strong><small>Source of truth</small></div>
              </div>
              <div className="asset-row solana">
                <span className="asset-icon">US</span>
                <div><strong>Solana USDC</strong><small>Default deposit & withdrawal</small></div>
              </div>
              <div className="asset-row sol">
                <span className="asset-icon">S</span>
                <div><strong>SOL</strong><small>Quote-only display</small></div>
              </div>
              <p className="guard-copy">No production trading.<br />No backend wallet signing.<br />No private keys, no seed phrases, no signing</p>
            </article>
          </div>

          <section className="portfolio-row" id="positions">
            <article className="portfolio-card">
              <div className="portfolio-card-head">
                <div>
                  <h2>Balances and positions</h2>
                  <span>Portfolio</span>
                </div>
                <strong>pUSD primary</strong>
              </div>
              <div className="portfolio-value">136.20 pUSD</div>
              <p className="positive-text">+35.000000 pUSD past day</p>
              <div className="balance-strip">
                <span>pUSD available <strong>0.000000</strong></span>
                <span>pUSD reserved <strong>0.000000</strong></span>
                <span>Conditional positions <strong>3 markets</strong></span>
                <span>Alpha fee payable <strong>{proof.accountingModel.example.alphaFeeAssessed}</strong></span>
              </div>
              <div className="portfolio-actions">
                <button type="button" className="deposit-button" disabled>Deposit disabled until bridge gate</button>
                <button type="button" className="desk-button" disabled>Withdraw disabled until pUSD gate</button>
              </div>
            </article>

            <article className="pnl-card">
              <div className="portfolio-card-head">
                <div>
                  <span>Profit/Loss</span>
                  <strong className="positive-text">+35.000000 pUSD</strong>
                </div>
                <div className="range-tabs" aria-label="PnL chart range">
                  {["1D", "1W", "1M", "1Y", "ALL"].map((range, index) => (
                    <button key={range} type="button" className={index === 0 ? "active" : ""}>{range}</button>
                  ))}
                </div>
              </div>
              <PnlChart />
            </article>
          </section>

          <section className="portfolio-table-card">
            <div className="portfolio-tabs" role="tablist" aria-label="Portfolio views">
              {[
                ["positions", "Positions"],
                ["orders", "Open orders"],
                ["history", "History"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={portfolioTab === key ? "active" : ""}
                  aria-pressed={portfolioTab === key}
                  onClick={() => setPortfolioTab(key as PortfolioTab)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="portfolio-filter-row">
              <input aria-label="Portfolio search" value="Search markets, tickers, event id..." readOnly />
              <button type="button" className="desk-button">Current value</button>
            </div>
            {portfolioTab === "positions" && (
              <table className="portfolio-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th>Avg to Now</th>
                    <th>Shares</th>
                    <th>Value</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((row) => (
                    <tr key={row.market}>
                      <td data-label="Market">{row.market}</td>
                      <td data-label="Side">{row.side}</td>
                      <td data-label="Avg to Now">{row.avg} to {row.now}</td>
                      <td data-label="Shares">{row.shares}</td>
                      <td data-label="Value">{row.value}</td>
                      <td data-label="PnL" className={row.pnl.startsWith("+") ? "positive-text" : "negative-text"}>{row.pnl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {portfolioTab === "orders" && (
              <table className="portfolio-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th>Limit</th>
                    <th>Size</th>
                    <th>Filled</th>
                    <th>Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.map((row) => (
                    <tr key={row.market}>
                      <td data-label="Market">{row.market}</td>
                      <td data-label="Side">{row.side}</td>
                      <td data-label="Limit">{row.price}</td>
                      <td data-label="Size">{row.size}</td>
                      <td data-label="Filled">{row.filled}</td>
                      <td data-label="Mode">{row.mode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {portfolioTab === "history" && (
              <table className="portfolio-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Market</th>
                    <th>Amount</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={`${row.time}-${row.event}`}>
                      <td data-label="Time">{row.time}</td>
                      <td data-label="Event">{row.event}</td>
                      <td data-label="Market">{row.market}</td>
                      <td data-label="Amount">{row.amount}</td>
                      <td data-label="Result">{row.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <div className="desk-grid desk-grid-mid">
            <article className="desk-card pnl-metrics">
              <h2>PnL and Win Tracking (Copied-Lot Accounting)</h2>
              <div className="stat-mosaic">
                {accountingRows.map(([label, value, note]) => (
                  <ValueTile key={label} label={label} value={value} note={note} />
                ))}
              </div>
              <ul className="compact-list">
                <li>Average entry: {proof.accountingModel.averageEntryFormula}</li>
                <li>Average exit: {proof.accountingModel.averageExitFormula}</li>
                <li>Success fee: {proof.accountingModel.successFeeFormula}</li>
                <li>Manual follower exits close copied lots and finalize PnL against the copied alpha source.</li>
              </ul>
            </article>

            <article className="desk-card risk-card">
              <h2>Agent profile and risk controls</h2>
              <div className="risk-list">
                {riskRows.map(([label, value]) => (
                  <div key={label}><span>{label}</span><strong>{value}</strong></div>
                ))}
              </div>
              <ul className="compact-list">
                <li>Agent slug is immutable after creation</li>
                <li>Default withdrawal: {proof.agentProfileModel.defaultWithdrawal}</li>
                <li>Different recipient requires admin approval, reason, and audit log id</li>
              </ul>
              <p className="muted">Applies to manual, auto, and copy trading.</p>
            </article>

            <article className="desk-card bridge-card">
              <h2>Bridge and withdrawal state machines</h2>
              <div className="machine-row ready">
                <span className="ok-dot" />
                <div><strong>Deposit Intent</strong><small>{proof.stateMachines.depositIntent}</small></div>
                <em>READY</em>
              </div>
              <div className="machine-row ready">
                <span className="ok-dot" />
                <div><strong>Withdrawal Intent</strong><small>{proof.stateMachines.withdrawalIntent}</small></div>
                <em>READY</em>
              </div>
              <div className="machine-row blocked">
                <span className="warn-dot" />
                <div><strong>Live Money Movement</strong><small>{proof.stateMachines.liveMoneyMovement}</small></div>
                <em>OUT OF BETA</em>
              </div>
            </article>

            <article className="desk-card beta-card">
              <h2>Public Beta Controls</h2>
              <button type="button" className="beta-control" disabled>Solana USDC deposit requires bridge gate <span>Not in beta</span></button>
              <button type="button" className="beta-control" disabled>Manual order requires bridge gate <span>Not in beta</span></button>
              <button type="button" className="beta-control" disabled>Withdrawal intent requires pUSD transfer gate <span>Not in beta</span></button>
              <button type="button" className="beta-control" disabled>Live copy requires lot reconciliation gate <span>Not in beta</span></button>
              <p className="guard-copy">Active-session only. No hosted trading in V1.</p>
            </article>
          </div>

          <div className="desk-grid desk-grid-bottom">
            <article className="desk-card alpha-preview" id="alpha-profiles">
              <h2>Public Alpha Profile Preview</h2>
              <div className="alpha-card">
                <span className="avatar">SM</span>
                <div>
                  <strong>sharp-money-desk <span>Public</span></strong>
                  <small>https://dnax402.app/alpha/sharp-money-desk</small>
                  <p>Prediction markets trader. Copy my best ideas with full transparency.</p>
                </div>
              </div>
              <div className="mini-stats">
                <span>Win Rate <strong>12 wins / 24 lots</strong></span>
                <span>7d PnL <strong>positive 20 pUSD</strong></span>
                <span>30d PnL <strong>positive 20 pUSD</strong></span>
                <span>All-Time PnL <strong>positive 20 pUSD</strong></span>
                <span>Closed Lots <strong>24</strong></span>
              </div>
            </article>

            <article className="desk-card copy-card" id="copy-trading">
              <h2>Copy trading setup</h2>
              <div className="summary-list">
                <div><span>Alpha source</span><strong>public profile /alpha/sharp-money-desk</strong></div>
                <div><span>Follow scope</span><strong>all markets or selected categories</strong></div>
                <div><span>Success fee</span><strong>{proof.accountingModel.successFeeFormula}</strong></div>
              </div>
              <button type="button" className="copy-control" disabled>Auto copy <span>Not in beta</span></button>
              <button type="button" className="copy-control" disabled>Follow sells <span>Paper beta</span></button>
              <button type="button" className="copy-control" disabled>DCA mode <span>Not in beta</span></button>
              <button type="button" className="copy-control" disabled>TP / SL <span>Paper beta</span></button>
              <button type="button" className="copy-control" disabled>Enable active-session copy requires live fanout gate</button>
              <button type="button" className="copy-control" disabled>Category filters require market sync gate</button>
              <button type="button" className="copy-control" disabled>TP / SL requires order submit gate</button>
              <p className="muted">Requires live fanout gate.</p>
            </article>

            <article className="desk-card activity-card">
              <h2>Recent Activity</h2>
              <ol className="activity-list">
                {history.concat([
                  { time: "21:07:44", event: "Derived deposit wallet", market: "Phase 0", amount: "hash saved", result: "GREEN" },
                  { time: "21:05:10", event: "Agent name locked", market: "sharp-money-desk", amount: "immutable slug", result: "GREEN" },
                ]).map((row) => (
                  <li key={`${row.time}-${row.event}`}>
                    <span className={row.result === "LOSS_NO_FEE" ? "warn-dot" : "ok-dot"} />
                    <time>{row.time}</time>
                    <p>{row.event} <strong>{row.market}</strong></p>
                  </li>
                ))}
              </ol>
            </article>

            <article className="desk-card summary-card">
              <h2>System & Proof Summary</h2>
              <div className="summary-list">
                {summaryRows.map(([label, value]) => (
                  <div key={label}><span>{label}</span><strong>{value}</strong></div>
                ))}
              </div>
            </article>

            <article className="desk-card operations-card">
              <h2>Operations and safety</h2>
              <div className="summary-list">
                <div><span>Global trading kill switch</span><strong>armed</strong></div>
                <div><span>Per-user pause</span><strong>available</strong></div>
                <div><span>Per-agent pause</span><strong>available</strong></div>
                <div><span>Per-market disable list</span><strong>available</strong></div>
                <div><span>Bridge outage mode</span><strong>available</strong></div>
                <div><span>Polymarket API degraded mode</span><strong>available</strong></div>
                <div><span>Quote provider degraded mode</span><strong>available</strong></div>
                <div><span>Reconciliation queue</span><strong>required before unlock</strong></div>
                <div><span>Admin audit log</span><strong>required for emergency changes</strong></div>
              </div>
            </article>
          </div>

          <div className="desk-grid desk-grid-final">
            <article className="desk-card">
              <h2>Deposit flow</h2>
              <div className="trade-ticket-grid">
                <label className="field-stack">
                  Source chain
                  <select value="solana" disabled><option value="solana">Solana</option></select>
                </label>
                <label className="field-stack">
                  Source token
                  <select value="usdc" disabled><option value="usdc">USDC</option><option value="sol">SOL quote-only</option></select>
                </label>
                <label className="field-stack">
                  Amount
                  <input value="10.00" disabled readOnly />
                </label>
                <button type="button" className="desk-button" disabled>Fetch supported assets requires bridge gate</button>
                <button type="button" className="desk-button" disabled>Create deposit address requires asset gate</button>
              </div>
              <ol className="compact-list">
                {depositSteps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </article>

            <article className="desk-card" id="markets">
              <h2>Market browser and order ticket</h2>
              <div className="trade-ticket-grid market-ticket">
                <label className="field-stack wide-field">
                  Market search
                  <input value="Lakers, BTC, election, event id..." disabled readOnly />
                </label>
                <label className="field-stack">
                  Side
                  <select value="yes" disabled><option value="yes">YES</option><option value="no">NO</option></select>
                </label>
                <label className="field-stack">
                  Order type
                  <select value="limit" disabled><option value="limit">Limit</option><option value="marketable">Marketable limit</option></select>
                </label>
                <label className="field-stack">
                  Price
                  <input value="0.53" disabled readOnly />
                </label>
                <label className="field-stack">
                  Size
                  <input value="10.00 pUSD" disabled readOnly />
                </label>
                <button type="button" className="desk-button" disabled>Validate order requires live market gate</button>
                <button type="button" className="desk-button" disabled>Sign order requires active local signer</button>
              </div>
            </article>

            <article className="desk-card">
              <h2>Withdrawal intent flow</h2>
              <div className="summary-list two-col">
                <div><span>Quote preview</span><strong>No withdrawal address created</strong></div>
                <div><span>Final confirmation</span><strong>Binds amount, chain, token, recipient, min received</strong></div>
                <div><span>Default recipient</span><strong>{proof.agentProfileModel.defaultWithdrawal}</strong></div>
                <div><span>Emergency recipient</span><strong>admin audit approval required</strong></div>
                <div><span>Bridge lag state</span><strong>pUSD confirmed while destination remains pending</strong></div>
              </div>
              <div className="beta-controls">
                <button type="button" className="desk-button" disabled>Preview quote requires withdrawal quote gate</button>
                <button type="button" className="desk-button" disabled>Final confirm creates withdrawal address</button>
                <button type="button" className="desk-button" disabled>Sign pUSD transfer requires wallet confirmation</button>
              </div>
            </article>

            <article className="desk-card">
              <h2>Build Stops</h2>
              <ol className="timeline">
                {stops.map((stop) => (
                  <li key={stop.label} className={`timeline-step ${stop.state === "green" ? "success" : stop.state === "red" ? "error" : "skipped"}`}>
                    <div className="timeline-head">
                      <strong>{stop.label}</strong>
                      <span>{stop.state === "green" ? "GREEN" : stop.state === "red" ? "RED" : "OUT OF BETA"}</span>
                    </div>
                    <p>{stop.detail}</p>
                  </li>
                ))}
              </ol>
              <p className="muted">
                Owner setup ready: {ownerSetupReady ? "yes" : "no"}. Autonomous money movement is not in beta scope until its live tests pass.
              </p>
            </article>
          </div>
        </main>
      </div>

      <footer className="terminal-footer">
        <span>DNA x402 Polymarket Agent V1 Beta</span>
        <span>Non-custodial</span>
        <span>Active-session only</span>
        <span>Proof-first</span>
        <span>No unattended live trading</span>
      </footer>
    </section>
  );
};
