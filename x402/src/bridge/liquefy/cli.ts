#!/usr/bin/env node
/**
 * DNA x Liquefy Bridge CLI
 *
 * Converts DNA audit export (NDJSON) + receipts into a Liquefy-ready
 * directory that can be packed into a .null vault.
 *
 * Usage:
 *   # Export from a running DNA server
 *   curl -s http://localhost:8080/admin/audit/export | npx tsx src/bridge/liquefy/cli.ts --out ./vault-staging/run-001
 *
 *   # Export with receipts
 *   npx tsx src/bridge/liquefy/cli.ts \
 *     --audit-url http://localhost:8080/admin/audit/export \
 *     --receipts-url http://localhost:8080/admin/receipts \
 *     --out ./vault-staging/run-001
 *
 *   # Then pack with Liquefy
 *   python tools/tracevault_pack.py ./vault-staging/run-001 --org dna --out ./vault/run-001 --json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LiquefyVaultExporter } from "./exporter.js";
import type { AuditEntry } from "../../logging/audit.js";
import type { SignedReceipt } from "../../types.js";

interface CliArgs {
  out: string;
  auditUrl?: string;
  receiptsUrl?: string;
  runId?: string;
  cluster?: string;
  version?: string;
  stdin?: boolean;
  adminToken?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: "./vault-staging/dna-export" };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--out": args.out = argv[++i]; break;
      case "--audit-url": args.auditUrl = argv[++i]; break;
      case "--receipts-url": args.receiptsUrl = argv[++i]; break;
      case "--run-id": args.runId = argv[++i]; break;
      case "--cluster": args.cluster = argv[++i]; break;
      case "--version": args.version = argv[++i]; break;
      case "--stdin": args.stdin = true; break;
      case "--admin-token": args.adminToken = argv[++i]; break;
      case "--help":
        // eslint-disable-next-line no-console
        console.log(`
DNA x Liquefy Bridge CLI

  --out <dir>           Output directory for Liquefy-ready data
  --audit-url <url>     DNA admin audit export endpoint
  --receipts-url <url>  DNA admin receipts endpoint
  --run-id <id>         Custom run ID (default: random UUID)
  --cluster <name>      Cluster name (devnet/mainnet-beta)
  --version <ver>       App version
  --stdin               Read NDJSON audit entries from stdin
  --admin-token <tok>   Admin token for authenticated endpoints
  --help                Show this help
`);
        process.exit(0);
    }
  }

  return args;
}

async function fetchJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers["x-admin-token"] = token;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchNdjson(url: string, token?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (token) headers["x-admin-token"] = token;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => { resolve(data); });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const exporter = new LiquefyVaultExporter({
    outDir: args.out,
    runId: args.runId ?? crypto.randomUUID(),
    cluster: args.cluster ?? "unknown",
    version: args.version ?? "dev",
  });

  exporter.init();
  let auditLines: string[] = [];

  if (args.stdin) {
    const raw = await readStdin();
    auditLines = raw.split("\n").filter(Boolean);
  } else if (args.auditUrl) {
    const raw = await fetchNdjson(args.auditUrl, args.adminToken);
    auditLines = raw.split("\n").filter(Boolean);
  }

  let auditCount = 0;
  for (const line of auditLines) {
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.ts && entry.kind) {
        exporter.writeAuditEvent(entry);
        auditCount++;
      }
    } catch {
      // skip malformed lines
    }
  }

  let receiptCount = 0;
  if (args.receiptsUrl) {
    const data = await fetchJson(args.receiptsUrl, args.adminToken) as { receipts?: unknown[] };
    if (Array.isArray(data.receipts)) {
      // The admin endpoint returns summaries, but we need full signed receipts.
      // If the admin endpoint returns full receipts, use them directly.
      // Otherwise, fall back to fetching each individually.
    }
  }

  // If we have a DNA server URL, try to fetch full receipts from /receipt/:id
  // based on receiptIds found in audit entries
  const receiptIds = new Set<string>();
  for (const line of auditLines) {
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.receiptId) receiptIds.add(entry.receiptId);
    } catch {
      // skip
    }
  }

  if (receiptIds.size > 0 && args.auditUrl) {
    const baseUrl = new URL(args.auditUrl).origin;
    for (const receiptId of receiptIds) {
      try {
        const receipt = await fetchJson(
          `${baseUrl}/receipt/${receiptId}`,
          args.adminToken,
        ) as SignedReceipt;
        if (receipt.payload?.receiptId) {
          exporter.writeReceipt(receipt);
          receiptCount++;
        }
      } catch {
        // receipt may have expired from memory
      }
    }
  }

  const result = exporter.finalize();

  const output = {
    schema_version: "liquefy.dna.bridge.cli.v1",
    tool: "dna-liquefy-bridge",
    command: "export",
    ok: true,
    result: {
      out_dir: args.out,
      run_id: args.runId,
      audit_events_exported: auditCount,
      receipts_exported: receiptCount,
      proof_artifacts: receiptCount,
      files: {
        manifest: result.manifestPath,
        telemetry: result.telemetryPath,
        receipts: result.receiptsPath,
      },
      next_step: `python tools/tracevault_pack.py ${args.out} --org dna --out ./vault/dna-run --json`,
    },
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(output, null, 2));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      schema_version: "liquefy.dna.bridge.cli.v1",
      tool: "dna-liquefy-bridge",
      command: "export",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
