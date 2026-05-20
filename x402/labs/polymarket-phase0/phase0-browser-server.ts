import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { createServer } from "vite";
import {
  LAB_DIR,
  REPO_ROOT,
  assertPhase0BrowserEnvReady,
  getPhase0EnvReadiness,
  loadPhase0Env,
  optionalEnv,
  requireEnv,
} from "./phase0-env.js";

const nodeRequire = createRequire(import.meta.url);
const bufferPolyfillPath = nodeRequire.resolve("buffer/");

function readBody(req: any): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: any, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function assertRedactedSnapshot(value: unknown): void {
  const stack: Array<{ path: string; value: unknown }> = [{ path: "$", value }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => stack.push({ path: `${current.path}[${index}]`, value: entry }));
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      continue;
    }
    for (const [key, nested] of Object.entries(current.value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (lower.includes("private") || lower.includes("secret") || lower.includes("passphrase") || lower.includes("seed")) {
        throw new Error(`Snapshot contains forbidden key ${current.path}.${key}`);
      }
      if (lower === "signature" && typeof nested === "string" && !nested.startsWith("[redacted:")) {
        throw new Error(`Snapshot contains unredacted signature at ${current.path}.${key}`);
      }
      stack.push({ path: `${current.path}.${key}`, value: nested });
    }
  }
}

function writeSnapshot(payload: unknown): string {
  assertRedactedSnapshot(payload);
  const outDir = resolve(optionalEnv("POLYMARKET_PHASE0_OUT_DIR", resolve(REPO_ROOT, "reports", "polymarket-phase0")));
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-browser-local.json`);
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

function phase0Plugin(token: string, builderConfig: BuilderConfig) {
  return {
    name: "phase0-browser-guard",
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: () => void) => {
        try {
          if (!req.url) {
            return next();
          }
          const url = new URL(req.url, "http://127.0.0.1");
          if (url.pathname === "/phase0-config" && req.method === "GET") {
            return sendJson(res, 200, {
              relayerUrl: requireEnv("POLYMARKET_RELAYER_URL"),
              clobApiUrl: requireEnv("POLYMARKET_CLOB_API_URL"),
              rpcUrl: requireEnv("POLYMARKET_RPC_URL"),
              ownerSignerSource: requireEnv("POLYMARKET_OWNER_SIGNER_SOURCE"),
              builderCode: requireEnv("POLYMARKET_BUILDER_CODE"),
              builderSignUrl: "/builder-sign",
              builderSignToken: token,
              chainId: 137,
              expectedSignatureType: 3,
            });
          }

          if (url.pathname === "/builder-sign" && req.method === "POST") {
            if (req.headers.authorization !== `Bearer ${token}`) {
              return sendJson(res, 401, { ok: false, error: "unauthorized" });
            }
            const body = JSON.parse(await readBody(req));
            const headers = await builderConfig.generateBuilderHeaders(body.method, body.path, body.body, body.timestamp);
            return sendJson(res, 200, headers ?? {});
          }

          if (url.pathname === "/phase0-snapshot" && req.method === "POST") {
            const body = JSON.parse(await readBody(req));
            const snapshotPath = writeSnapshot(body);
            return sendJson(res, 200, { ok: true, snapshotPath });
          }
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return next();
      });
    },
  };
}

async function main(): Promise<void> {
  const loadedEnvPath = loadPhase0Env();
  assertPhase0BrowserEnvReady();
  if (process.env.POLYMARKET_PHASE0_ENVIRONMENT !== "safe") {
    throw new Error("Refusing browser harness unless POLYMARKET_PHASE0_ENVIRONMENT=safe.");
  }
  if (process.env.POLYMARKET_OWNER_SIGNER_SOURCE !== "browser-local") {
    throw new Error("Browser harness requires POLYMARKET_OWNER_SIGNER_SOURCE=browser-local.");
  }

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: requireEnv("POLYMARKET_BUILDER_API_KEY"),
      secret: requireEnv("POLYMARKET_BUILDER_SECRET"),
      passphrase: requireEnv("POLYMARKET_BUILDER_PASSPHRASE"),
    },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  const port = Number(optionalEnv("POLYMARKET_PHASE0_BROWSER_PORT", "4573"));
  const server = await createServer({
    root: resolve(LAB_DIR, "browser"),
    clearScreen: false,
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: [
        { find: "buffer", replacement: bufferPolyfillPath },
        { find: "node:buffer", replacement: bufferPolyfillPath },
      ],
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
    plugins: [phase0Plugin(token, builderConfig)],
  });
  await server.listen();
  const readiness = getPhase0EnvReadiness();
  console.log(JSON.stringify({
    ok: true,
    loadedEnvPath,
    url: `http://127.0.0.1:${port}/`,
    moneyMovement: "user-confirmed-browser-only",
    backendWalletSigning: "forbidden",
    backendBuilderHeaders: "local_lab_only",
    readiness: {
      browserHarnessReady: readiness.browserHarness.every((entry) => entry.present),
      liveOrderFlowExtraMissing: readiness.liveOrderFlowExtras
        .filter((entry) => !entry.present)
        .map((entry) => entry.canonicalName),
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
