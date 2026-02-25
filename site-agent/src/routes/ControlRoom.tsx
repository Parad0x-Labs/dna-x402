import React, { useMemo, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import { AgentApiClient, parsePaymentRequirements } from "../lib/api";
import { payQuoteViaSplTransfer } from "../lib/payments";
import { usePolling } from "../lib/polling";
import { verifySignedReceipt } from "../lib/receipt";
import { clusterRpc, explorerClusterParam, loadRuntimeConfig, saveRuntimeConfig } from "../lib/runtimeConfig";
import {
  AnchoredReceiptResponse,
  ControlLog,
  DemoTimelineStep,
  LogChannel,
  MarketMetricsResponse,
  RuntimeConfig,
  SettlementMode,
} from "../lib/types";

const SAFE_CATEGORY_KEYS = new Set([
  "ai_inference",
  "image_generation",
  "data_enrichment",
  "workflow_tool",
  "inference",
  "resource_access",
]);

const INITIAL_STEPS: DemoTimelineStep[] = [
  { id: "step-402", title: "Step 1: 402 received", state: "pending" },
  { id: "step-payment", title: "Step 2: Payment submitted", state: "pending" },
  { id: "step-finalize", title: "Step 3: Finalize accepted", state: "pending" },
  { id: "step-retry", title: "Step 4: Retry returns 200", state: "pending" },
  { id: "step-receipt", title: "Step 5: Receipt signature verified", state: "pending" },
  { id: "step-anchor", title: "Step 6: Anchoring confirmed", state: "pending" },
];

function short(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 3) {
    return value;
  }
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function randomCommitment32B(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function channelColor(channel: LogChannel): string {
  if (channel === "health") {
    return "#44e0ff";
  }
  if (channel === "market") {
    return "#6fffb0";
  }
  if (channel === "anchoring") {
    return "#ffd166";
  }
  return "#ffa3d1";
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findSafeRows(metrics: MarketMetricsResponse | null): Array<{ key: string; value: number }> {
  if (!metrics?.results) {
    return [];
  }
  return metrics.results
    .filter((row) => {
      const key = row.key.toLowerCase();
      return Array.from(SAFE_CATEGORY_KEYS).some((safeKey) => key.includes(safeKey));
    })
    .slice(0, 4)
    .map((row) => ({ key: row.key, value: row.value }));
}

export const ControlRoom: React.FC = () => {
  const wallet = useWallet();
  const [config, setConfig] = useState<RuntimeConfig>(() => loadRuntimeConfig());
  const [draftConfig, setDraftConfig] = useState<RuntimeConfig>(config);
  const [configOpen, setConfigOpen] = useState(false);
  const [runningDemo, setRunningDemo] = useState(false);
  const [demoMode, setDemoMode] = useState<"idle" | "simulated" | "wallet">("idle");
  const [steps, setSteps] = useState<DemoTimelineStep[]>(INITIAL_STEPS);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ControlLog[]>([]);
  const [filters, setFilters] = useState<Record<LogChannel, boolean>>({
    health: true,
    market: true,
    anchoring: true,
    demo: true,
  });
  const [demoArtifacts, setDemoArtifacts] = useState<{
    paymentSig?: string;
    receiptId?: string;
    anchorSig?: string;
    anchorBucketId?: string;
    retryStatus?: number;
  }>({});

  const healthLogCounter = useRef(0);
  const marketLogCounter = useRef(0);

  const api = useMemo(() => new AgentApiClient(config.x402BaseUrl), [config.x402BaseUrl]);
  const rpcEndpoint = useMemo(() => clusterRpc(config.cluster), [config.cluster]);
  const chainConnection = useMemo(() => new Connection(rpcEndpoint, "confirmed"), [rpcEndpoint]);

  const appendLog = (channel: LogChannel, message: string, data?: unknown): void => {
    setLogs((previous) => {
      const next: ControlLog = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: nowIso(),
        channel,
        message,
        data,
      };
      return [...previous, next].slice(-50);
    });
  };

  const updateStep = (id: string, patch: Partial<DemoTimelineStep>) => {
    setSteps((previous) => previous.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  };

  const setRunningStep = (id: string, detail?: string) => {
    updateStep(id, { state: "running", detail });
  };

  const setSuccessStep = (id: string, detail?: string, payload?: unknown) => {
    updateStep(id, { state: "success", detail, payload });
  };

  const setErrorStep = (id: string, detail?: string, payload?: unknown) => {
    updateStep(id, { state: "error", detail, payload });
  };

  const setSkippedStep = (id: string, detail?: string) => {
    updateStep(id, { state: "skipped", detail });
  };

  const health = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.health(),
    onSuccess: (data) => {
      healthLogCounter.current += 1;
      if (healthLogCounter.current % 8 === 0) {
        appendLog("health", "Health poll success", {
          cluster: data.cluster,
          pauseFlags: data.pauseFlags,
          programId: data.anchoring?.programId,
        });
      }
    },
    onError: (error) => {
      appendLog("health", `Health poll failed: ${error.message}`);
    },
  });

  const snapshot = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.marketSnapshot(),
    onSuccess: (data) => {
      marketLogCounter.current += 1;
      if (marketLogCounter.current % 8 === 0) {
        appendLog("market", "Snapshot update", {
          fast: data.fastCount24h,
          verified: data.verifiedCount24h,
        });
      }
    },
    onError: (error) => {
      appendLog("market", `Snapshot poll failed: ${error.message}`);
    },
  });

  const topSelling = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.topSelling("FAST"),
  });

  const trending = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.trending("FAST"),
  });

  const onSale = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.onSale(),
  });

  const anchoring = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.anchoringStatus(),
    onSuccess: (data) => {
      appendLog("anchoring", "Anchoring status", {
        queueDepth: data.queueDepth,
        lastAnchorSig: data.lastAnchorSig,
      });
    },
    onError: (error) => {
      appendLog("anchoring", `Anchoring status failed: ${error.message}`);
    },
  });

  const ping = usePolling({
    intervalMs: config.pollIntervalMs,
    deps: [api.baseUrl],
    fetcher: () => api.ping(),
  });

  const visibleLogs = useMemo(
    () => logs.filter((log) => filters[log.channel]),
    [logs, filters],
  );

  const fastCount = snapshot.data?.fastCount24h ?? 0;
  const verifiedCount = snapshot.data?.verifiedCount24h ?? 0;

  const runDemo = async () => {
    setRunningDemo(true);
    setDemoError(null);
    setDemoArtifacts({});
    setSteps(INITIAL_STEPS);

    const isWalletMode = Boolean(wallet.connected && wallet.publicKey && wallet.sendTransaction);
    setDemoMode(isWalletMode ? "wallet" : "simulated");
    appendLog("demo", isWalletMode ? "Starting live wallet demo" : "Starting simulated demo (no wallet)");

    let receiptId = "";

    try {
      setRunningStep("step-402", "Requesting paid resource");
      const resource = await api.resource();
      const requirements = parsePaymentRequirements(resource);
      setSuccessStep("step-402", `HTTP ${resource.status} payment_required`, {
        headers: resource.headers,
        quoteId: requirements.quote.quoteId,
      });

      const beforeAnchor = await api.anchoringStatus().catch(() => null);
      const commit = await api.commit(requirements.quote.quoteId, randomCommitment32B());

      if (isWalletMode) {
        setRunningStep("step-payment", "Signing and sending SPL transfer");
        const transfer = await payQuoteViaSplTransfer({
          wallet: {
            publicKey: wallet.publicKey ?? null,
            sendTransaction: wallet.sendTransaction,
          },
          connection: chainConnection,
          quote: requirements.quote,
        });

        setDemoArtifacts((current) => ({ ...current, paymentSig: transfer.signature }));
        setSuccessStep("step-payment", `Transfer confirmed: ${short(transfer.signature)}`, transfer);

        setRunningStep("step-finalize", "Submitting transfer proof");
        const finalized = await api.finalize({
          commitId: commit.commitId,
          settlement: "transfer",
          txSignature: transfer.signature,
          amountAtomic: requirements.quote.totalAtomic,
        });

        receiptId = finalized.receiptId;
        setDemoArtifacts((current) => ({ ...current, receiptId: finalized.receiptId }));
        setSuccessStep("step-finalize", `Finalize ok, receipt ${short(finalized.receiptId)}`, finalized);
      } else {
        setRunningStep("step-payment", "Simulating payment via netting path");
        const simulatedFinalize = await api.finalize({
          commitId: commit.commitId,
          settlement: "netting",
          amountAtomic: requirements.quote.totalAtomic,
          note: "site-agent-simulated",
        });

        receiptId = simulatedFinalize.receiptId;
        setDemoArtifacts((current) => ({ ...current, receiptId: simulatedFinalize.receiptId }));
        setSuccessStep("step-payment", "Simulated payment proof accepted", {
          mode: "SIMULATED",
          receiptId: simulatedFinalize.receiptId,
        });
        setSuccessStep("step-finalize", `Finalize ok, receipt ${short(simulatedFinalize.receiptId)}`, simulatedFinalize);
      }

      setRunningStep("step-retry", "Retrying resource with commit id");
      const retry = await api.resource(commit.commitId);
      setDemoArtifacts((current) => ({ ...current, retryStatus: retry.status }));

      if (retry.status !== 200) {
        throw new Error(`Retry returned ${retry.status}`);
      }
      setSuccessStep("step-retry", "Retry returned 200", retry.body);

      setRunningStep("step-receipt", "Verifying signed receipt in browser");
      const receipt = await api.receipt(receiptId);
      const verified = await verifySignedReceipt(receipt);
      if (!verified) {
        throw new Error("Receipt signature verification failed in browser");
      }
      setSuccessStep("step-receipt", "Receipt verified: true", receipt);

      setRunningStep("step-anchor", "Waiting for anchor confirmation");
      let anchoredRecord: AnchoredReceiptResponse["anchored"] | null = null;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const anchored = await api.anchoringReceipt(receiptId);
          anchoredRecord = anchored.anchored;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        }
      }

      if (!anchoredRecord) {
        setSkippedStep("step-anchor", "Anchor not confirmed yet (queue may still be pending)");
      } else {
        const afterAnchor = await api.anchoringStatus().catch(() => null);
        const delta = beforeAnchor && afterAnchor && beforeAnchor.lastBucketId === afterAnchor.lastBucketId
          && beforeAnchor.lastBucketCount != null && afterAnchor.lastBucketCount != null
          ? afterAnchor.lastBucketCount - beforeAnchor.lastBucketCount
          : null;

        setDemoArtifacts((current) => ({
          ...current,
          anchorSig: anchoredRecord?.signature,
          anchorBucketId: anchoredRecord?.bucketId,
        }));

        setSuccessStep("step-anchor", `Anchored in bucket ${anchoredRecord.bucketId}${delta != null ? ` (delta ${delta})` : ""}`, {
          anchored: anchoredRecord,
          statusAfter: afterAnchor,
        });
      }

      appendLog("demo", "Demo completed", {
        mode: isWalletMode ? "wallet" : "simulated",
        receiptId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDemoError(message);
      appendLog("demo", `Demo failed: ${message}`);
      setSteps((current) => {
        const runningStep = current.find((step) => step.state === "running")?.id ?? "step-402";
        return current.map((step) => (step.id === runningStep ? { ...step, state: "error", detail: message } : step));
      });
    } finally {
      setRunningDemo(false);
    }
  };

  const saveConfig = () => {
    saveRuntimeConfig(draftConfig);
    setConfig(draftConfig);
    setConfigOpen(false);
    appendLog("health", "Runtime config updated", draftConfig);
  };

  const resetConfig = () => {
    const loaded = loadRuntimeConfig();
    setDraftConfig(loaded);
  };

  const explorerCluster = explorerClusterParam(config.cluster);
  const explorerTx = (sig?: string) => {
    if (!sig) {
      return "";
    }
    const suffix = explorerCluster ? `?cluster=${explorerCluster}` : "";
    return `https://explorer.solana.com/tx/${sig}${suffix}`;
  };

  const copyToClipboard = async (value: string) => {
    await navigator.clipboard.writeText(value);
    appendLog("demo", "Copied value to clipboard", { value: short(value) });
  };

  return (
    <section className="control-room-wrap">
      <div className="control-room-topbar">
        <div>
          <h2>/agent/control-room</h2>
          <p className="muted">
            Live status board for 402 - pay - retry with receipts and anchoring. Mode: {demoMode === "idle" ? "standby" : demoMode.toUpperCase()}
          </p>
          <p className="muted">
            Base URL: <strong>{config.x402BaseUrl}</strong> | Cluster: <strong>{config.cluster}</strong>
          </p>
        </div>
        <div className="control-room-actions">
          <WalletMultiButton />
          <button type="button" className="ghost-btn" onClick={() => setConfigOpen((open) => !open)}>
            ⚙ Runtime Config
          </button>
        </div>
      </div>

      {configOpen && (
        <div className="panel config-panel">
          <h3>Runtime override</h3>
          <label>
            x402 base URL
            <input
              value={draftConfig.x402BaseUrl}
              onChange={(event) => setDraftConfig((current) => ({ ...current, x402BaseUrl: event.target.value }))}
            />
          </label>
          <label>
            Wallet URL
            <input
              value={draftConfig.walletUrl}
              onChange={(event) => setDraftConfig((current) => ({ ...current, walletUrl: event.target.value }))}
            />
          </label>
          <label>
            Cluster
            <select
              value={draftConfig.cluster}
              onChange={(event) => setDraftConfig((current) => ({
                ...current,
                cluster: event.target.value as RuntimeConfig["cluster"],
              }))}
            >
              <option value="devnet">devnet</option>
              <option value="mainnet-beta">mainnet-beta</option>
              <option value="localnet">localnet</option>
            </select>
          </label>
          <label>
            Poll interval (ms)
            <input
              type="number"
              min={250}
              step={50}
              value={draftConfig.pollIntervalMs}
              onChange={(event) => setDraftConfig((current) => ({
                ...current,
                pollIntervalMs: Number.parseInt(event.target.value, 10) || 1500,
              }))}
            />
          </label>
          <div className="row gap-sm">
            <button type="button" className="btn-primary" onClick={saveConfig}>Apply</button>
            <button type="button" className="ghost-btn" onClick={resetConfig}>Reset</button>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <article className="panel">
          <h3>Health</h3>
          <p className={`status ${health.error ? "down" : "up"}`}>
            {health.error ? "Offline" : "Online"}
          </p>
          <ul className="compact-list">
            <li>Cluster: {health.data?.cluster ?? config.cluster}</li>
            <li>Build: {health.data?.build?.version ?? "n/a"} ({health.data?.build?.commit ?? "no-commit"})</li>
            <li>Program (payment): {health.data?.programs?.paymentProgramId ?? "n/a"}</li>
            <li>Program (receipt anchor): {health.data?.programs?.receiptAnchorProgramId ?? health.data?.anchoring?.programId ?? "n/a"}</li>
            <li>Pause flags: market={String(health.data?.pauseFlags?.market ?? false)} orders={String(health.data?.pauseFlags?.orders ?? false)} finalize={String(health.data?.pauseFlags?.finalize ?? false)}</li>
            <li>Health p95 latency: {health.p95LatencyMs ?? "-"} ms</li>
            <li>Health error rate: {(health.errorRate * 100).toFixed(1)}%</li>
          </ul>
        </article>

        <article className="panel">
          <h3>Market snapshot</h3>
          <div className="proof-grid two-col">
            <div className="proof-block">
              <span>FAST count (24h)</span>
              <strong>{fastCount}</strong>
            </div>
            <div className="proof-block">
              <span>VERIFIED count (24h)</span>
              <strong>{verifiedCount}</strong>
            </div>
            <div className="proof-block">
              <span>Snapshot p95 latency</span>
              <strong>{snapshot.p95LatencyMs ?? "-"} ms</strong>
            </div>
            <div className="proof-block">
              <span>Snapshot error rate</span>
              <strong>{(snapshot.errorRate * 100).toFixed(1)}%</strong>
            </div>
          </div>

          <div className="subgrid">
            <div>
                <h4>Trending (safe)</h4>
                <ul className="compact-list">
                  {findSafeRows(trending.data).map((row) => (
                    <li key={row.key}>{row.key}{" -> "}{row.value.toFixed(2)}</li>
                  ))}
                  {findSafeRows(trending.data).length === 0 && <li>No data</li>}
                </ul>
              </div>
              <div>
                <h4>On sale</h4>
                <ul className="compact-list">
                  {(onSale.data?.results ?? []).slice(0, 4).map((row) => (
                    <li key={row.key}>{row.key}{" -> "}{(row.value * 100).toFixed(2)}% drop</li>
                  ))}
                  {(onSale.data?.results ?? []).length === 0 && <li>No data</li>}
                </ul>
              </div>
              <div>
                <h4>Top selling</h4>
                <ul className="compact-list">
                  {(topSelling.data?.results ?? []).slice(0, 4).map((row) => (
                    <li key={row.key}>{row.key}{" -> "}{row.value.toFixed(0)} fills</li>
                  ))}
                  {(topSelling.data?.results ?? []).length === 0 && <li>No data</li>}
                </ul>
              </div>
          </div>
        </article>

        <article className="panel timeline-panel">
          <h3>402 demo timeline</h3>
          <p className="muted">
            {wallet.connected
              ? "LIVE mode: wallet-signed payment + verify + retry"
              : "SIMULATED mode: no wallet, netting path for timeline rehearsal"}
          </p>
          <div className="row gap-sm">
            <button type="button" className="btn-primary" disabled={runningDemo} onClick={runDemo}>
              {runningDemo ? "Running..." : "Run Live Demo"}
            </button>
            <a className="ghost-btn link-btn" href={config.walletUrl} target="_blank" rel="noreferrer">
              Open Wallet App
            </a>
          </div>
          {demoError && <p className="status down">{demoError}</p>}

          <ol className="timeline">
            {steps.map((step) => (
              <li key={step.id} className={`timeline-step ${step.state}`}>
                <div className="timeline-head">
                  <strong>{step.title}</strong>
                  <span>{step.state.toUpperCase()}</span>
                </div>
                {step.detail && <p>{step.detail}</p>}
                {step.payload != null && <pre>{formatJson(step.payload)}</pre>}
              </li>
            ))}
          </ol>

          <div className="artifact-actions">
            {demoArtifacts.paymentSig && (
              <div className="artifact-row">
                <span>Payment tx: {short(demoArtifacts.paymentSig)}</span>
                <button type="button" onClick={() => void copyToClipboard(demoArtifacts.paymentSig as string)}>Copy</button>
                <a href={explorerTx(demoArtifacts.paymentSig)} target="_blank" rel="noreferrer">Explorer</a>
              </div>
            )}
            {demoArtifacts.receiptId && (
              <div className="artifact-row">
                <span>Receipt: {short(demoArtifacts.receiptId)}</span>
                <button type="button" onClick={() => void copyToClipboard(demoArtifacts.receiptId as string)}>Copy</button>
              </div>
            )}
            {demoArtifacts.anchorSig && (
              <div className="artifact-row">
                <span>Anchor tx: {short(demoArtifacts.anchorSig)}</span>
                <button type="button" onClick={() => void copyToClipboard(demoArtifacts.anchorSig as string)}>Copy</button>
                <a href={explorerTx(demoArtifacts.anchorSig)} target="_blank" rel="noreferrer">Explorer</a>
              </div>
            )}
          </div>
        </article>

        <article className="panel">
          <h3>Anchoring queue</h3>
          <ul className="compact-list">
            <li>Enabled: {String(anchoring.data?.enabled ?? false)}</li>
            <li>Queue depth: {anchoring.data?.queueDepth ?? 0}</li>
            <li>Anchored count: {anchoring.data?.anchoredCount ?? 0}</li>
            <li>Last flush: {anchoring.data?.lastFlushAt ?? "-"}</li>
            <li>Last bucket id: {anchoring.data?.lastBucketId ?? "-"}</li>
            <li>Last bucket count: {anchoring.data?.lastBucketCount ?? "-"}</li>
            <li>Last anchor sig: {anchoring.data?.lastAnchorSig ? short(anchoring.data.lastAnchorSig) : "-"}</li>
            <li>Ping latency p95: {ping.p95LatencyMs ?? "-"} ms</li>
          </ul>
        </article>
      </div>

      <article className="panel log-console">
        <div className="row space-between">
          <h3>Live log console (last 50)</h3>
          <div className="row gap-sm">
            {(Object.keys(filters) as LogChannel[]).map((channel) => (
              <button
                key={channel}
                type="button"
                className={`chip ${filters[channel] ? "active" : ""}`}
                onClick={() => setFilters((current) => ({ ...current, [channel]: !current[channel] }))}
              >
                {channel}
              </button>
            ))}
          </div>
        </div>

        <div className="log-lines">
          {visibleLogs.slice().reverse().map((log) => (
            <div key={log.id} className="log-line">
              <span className="log-channel" style={{ color: channelColor(log.channel) }}>{log.channel.toUpperCase()}</span>
              <span className="log-time">{new Date(log.ts).toLocaleTimeString()}</span>
              <span className="log-message">{log.message}</span>
              {log.data != null && <pre>{formatJson(log.data)}</pre>}
            </div>
          ))}
          {visibleLogs.length === 0 && <p className="muted">No logs for selected filters.</p>}
        </div>
      </article>
    </section>
  );
};
