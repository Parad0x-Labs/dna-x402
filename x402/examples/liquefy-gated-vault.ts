/**
 * DNA x402 + Liquefy — Payment-Gated Vault Access
 *
 * An API that requires DNA payment to search or restore Liquefy vaults.
 * Agents pay per query, and all payment data is archived into Liquefy vaults.
 *
 * Architecture:
 *   Agent → DNA Payment → Vault API → Liquefy (search/restore)
 *   DNA Audit Logs → Liquefy Sidecar → .null vault (archived)
 *
 * Run:
 *   RECIPIENT=<your-solana-wallet> LIQUEFY_PATH=/abs/path/to/liquefy npx tsx examples/liquefy-gated-vault.ts
 */
import express from "express";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadSdk } from "./_runtime.js";

const { AuditLogger, LiquefySidecar, dnaPaywall } = await loadSdk();

const app = express();
app.use(express.json());

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name} before running this example.`);
  }
  return value;
}

const RECIPIENT = requireEnv("RECIPIENT");
const LIQUEFY_PATH = process.env.LIQUEFY_PATH ?? "/path/to/liquefy";
const VAULT_PATH = process.env.VAULT_PATH ?? "./vault";
const PYTHON_BIN = process.env.LIQUEFY_PYTHON ?? process.env.PYTHON_BIN ?? "python3";

function runLiquefyTool(args: string[], timeout: number): string {
  return execFileSync(PYTHON_BIN, args, {
    cwd: LIQUEFY_PATH,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const audit = new AuditLogger({ filePath: "./audit-liquefy.ndjson" });

const sidecar = new LiquefySidecar({
  outDir: "./vault-live/dna-payments",
  cluster: "mainnet-beta",
  version: "1.1.0",
});
sidecar.attachAuditLogger(audit);
sidecar.startPeriodicFlush();

app.get("/", (_req, res) => {
  res.json({
    service: "Liquefy Vault Gateway",
    description: "Payment-gated access to compressed AI agent vaults",
    endpoints: {
      "/vault/search":  { price: "$0.001", description: "Search inside vaults" },
      "/vault/restore": { price: "$0.01",  description: "Restore vault contents" },
      "/vault/list":    { price: "free",   description: "List available vaults" },
    },
  });
});

// Free: list vaults
app.get("/vault/list", (_req, res) => {
  try {
    const vaultRoot = path.resolve(VAULT_PATH);
    const vaults = readdirSync(vaultRoot, { withFileTypes: true }).map((entry) => {
      const fullPath = path.join(vaultRoot, entry.name);
      const stats = statSync(fullPath);
      return {
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
        size: stats.size,
      };
    });
    res.json({ vaults });
  } catch {
    res.json({ vaults: [], note: "Configure VAULT_PATH" });
  }
});

// Paid: search inside vaults — $0.001 per query
app.use("/vault/search", dnaPaywall({
  priceAtomic: "1000",
  recipient: RECIPIENT,
  settlement: ["transfer"],
}));

app.get("/vault/search", (req, res) => {
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: "Missing ?q= search query" });
    return;
  }

  audit.record({ kind: "PAYMENT_VERIFIED", meta: { action: "vault_search", query } });

  try {
    const output = runLiquefyTool(
      ["tools/tracevault_search.py", path.resolve(VAULT_PATH), "--query", query, "--json"],
      30000,
    );
    res.json({ query, results: JSON.parse(output) });
  } catch {
    res.json({ query, results: [], note: "Search returned no results or Liquefy not configured" });
  }
});

// Paid: restore vault — $0.01 per restore
app.use("/vault/restore", dnaPaywall({
  priceAtomic: "10000",
  recipient: RECIPIENT,
  settlement: ["transfer"],
}));

app.post("/vault/restore", (req, res) => {
  const { vaultId, outDir } = req.body;
  if (!vaultId) {
    res.status(400).json({ error: "Missing vaultId" });
    return;
  }

  audit.record({ kind: "PAYMENT_VERIFIED", meta: { action: "vault_restore", vaultId } });

  const target = outDir ?? `./restored/${vaultId}`;
  try {
    const output = runLiquefyTool(
      [
        "tools/tracevault_restore.py",
        path.join(path.resolve(VAULT_PATH), String(vaultId)),
        "--out",
        path.resolve(String(target)),
        "--json",
      ],
      60000,
    );
    res.json({ vaultId, restored: true, output: JSON.parse(output) });
  } catch {
    res.json({ vaultId, restored: false, note: "Restore failed or Liquefy not configured" });
  }
});

const PORT = Number(process.env.PORT) || 3002;
app.listen(PORT, () => {
  console.log(`Liquefy Vault Gateway on http://localhost:${PORT}`);
  console.log(`Payment recipient: ${RECIPIENT}`);
  console.log(`Liquefy sidecar: auto-archiving DNA payments to vault`);
});
