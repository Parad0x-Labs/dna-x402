export type DrillRpcSource =
  | "HELIUS_RPC"
  | "HELIUS_API_KEY"
  | "SOLANA_RPC_URL"
  | "PUBLIC_DEFAULT";

export type DrillRpcResolution = {
  rpcUrl: string;
  source: DrillRpcSource;
  reportValue: string;
  highThroughput: boolean;
};

const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_HELIUS_MAINNET_RPC = "https://mainnet.helius-rpc.com/";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function withApiKey(baseUrl: string, apiKey: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("api-key", apiKey);
  return url.toString();
}

export function redactRpcUrlForReport(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  for (const key of Array.from(url.searchParams.keys())) {
    if (/api[-_]?key|token|secret|password/i.test(key)) {
      url.searchParams.set(key, "<redacted>");
    }
  }

  if (url.hostname.endsWith("helius-rpc.com")) {
    if (!url.searchParams.has("api-key")) {
      return `${url.protocol}//${url.hostname}/<redacted>`;
    }
    return url.toString();
  }

  if (url.toString() === PUBLIC_MAINNET_RPC) {
    return PUBLIC_MAINNET_RPC;
  }

  if (url.search !== "") {
    return url.toString();
  }

  return `${url.protocol}//${url.hostname}${url.pathname === "/" ? "" : "/<redacted>"}`;
}

export function resolveDrillRpcUrl(env: NodeJS.ProcessEnv = process.env): DrillRpcResolution {
  const heliusRpc = clean(env.HELIUS_RPC);
  if (heliusRpc) {
    return {
      rpcUrl: heliusRpc,
      source: "HELIUS_RPC",
      reportValue: redactRpcUrlForReport(heliusRpc),
      highThroughput: true,
    };
  }

  const heliusApiKey = clean(env.HELIUS_API_KEY);
  if (heliusApiKey) {
    const baseUrl = clean(env.HELIUS_RPC_BASE_URL) ?? DEFAULT_HELIUS_MAINNET_RPC;
    const rpcUrl = withApiKey(baseUrl, heliusApiKey);
    return {
      rpcUrl,
      source: "HELIUS_API_KEY",
      reportValue: redactRpcUrlForReport(rpcUrl),
      highThroughput: true,
    };
  }

  const solanaRpc = clean(env.SOLANA_RPC_URL);
  if (solanaRpc) {
    return {
      rpcUrl: solanaRpc,
      source: "SOLANA_RPC_URL",
      reportValue: redactRpcUrlForReport(solanaRpc),
      highThroughput: !solanaRpc.includes("api.mainnet-beta.solana.com"),
    };
  }

  return {
    rpcUrl: PUBLIC_MAINNET_RPC,
    source: "PUBLIC_DEFAULT",
    reportValue: PUBLIC_MAINNET_RPC,
    highThroughput: false,
  };
}
