import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTelegramBotUsername,
  redactTelegramChatId,
  redactTelegramToken,
  sendTelegramStatusDigest,
  type TelegramStatusMetrics,
} from "../../src/monitoring/telegramAlert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const reportRoot = path.join(repoRoot, "reports", "monitoring");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function timestampForPath(date = new Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Telegram status digest`);
  }
  return value;
}

function readParseMode(): "HTML" | "MarkdownV2" {
  const mode = process.env.X402_ALERT_TELEGRAM_PARSE_MODE ?? "HTML";
  if (mode !== "HTML" && mode !== "MarkdownV2") {
    throw new Error("X402_ALERT_TELEGRAM_PARSE_MODE must be HTML or MarkdownV2");
  }
  return mode;
}

function parseMetricText(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(line);
    if (!match) {
      continue;
    }
    metrics.set(match[1], Number(match[2]));
  }
  return metrics;
}

function metric(metrics: Map<string, number>, name: string): number {
  return metrics.get(name) ?? 0;
}

async function fetchMetrics(metricsUrl: string): Promise<{ online: boolean; text: string }> {
  try {
    const response = await fetch(metricsUrl);
    return {
      online: response.ok,
      text: response.ok ? await response.text() : "",
    };
  } catch {
    return { online: false, text: "" };
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const botToken = requiredEnv("X402_ALERT_TELEGRAM_BOT_TOKEN");
  const chatId = requiredEnv("X402_ALERT_TELEGRAM_CHAT_ID");
  const parseMode = readParseMode();
  const metricsUrl = argValue("metrics-url")
    ?? process.env.X402_ALERT_TELEGRAM_STATUS_METRICS_URL
    ?? "http://127.0.0.1:8080/metrics";
  const period = (argValue("period") ?? "manual") as TelegramStatusMetrics["period"];
  if (period !== "30m" && period !== "24h" && period !== "manual") {
    throw new Error("--period must be 30m, 24h, or manual");
  }

  const metricsResponse = await fetchMetrics(metricsUrl);
  const parsed = parseMetricText(metricsResponse.text);
  const metrics: TelegramStatusMetrics = {
    online: metricsResponse.online,
    environment: process.env.X402_ALERT_ENVIRONMENT ?? "staging",
    period,
    metricsUrl,
    quotesCreated: metric(parsed, "x402_quotes_created_total"),
    commitsCreated: metric(parsed, "x402_commits_created_total"),
    finalizeSuccess: metric(parsed, "x402_finalize_success_total"),
    finalizeRejected: metric(parsed, "x402_finalize_rejected_total"),
    receiptsIssued: metric(parsed, "x402_receipts_issued_total"),
    volumeAtomic: metric(parsed, "x402_volume_atomic_total"),
    feeAccruals: metric(parsed, "x402_real_chain_fee_accruals_total"),
    feeAccruedAtomic: metric(parsed, "x402_real_chain_fee_accrued_atomic_total"),
    agentsObserved: metric(parsed, "x402_agents_observed_total"),
    webhookReplayRejected: metric(parsed, "x402_webhook_replays_rejected_total"),
    piiBlocks: metric(parsed, "x402_pii_blocks_total"),
    emergencyPauseActive: metric(parsed, "x402_emergency_pause_active"),
    adminActions: metric(parsed, "x402_admin_actions_total"),
    dbErrors: metric(parsed, "x402_db_errors_total"),
    verifierErrors: metric(parsed, "x402_verifier_errors_total"),
    settlementUnavailable: metric(parsed, "x402_settlement_unavailable_total"),
    generatedAt: new Date().toISOString(),
  };
  const result = await sendTelegramStatusDigest({
    config: {
      botToken,
      chatId,
      parseMode,
      environment: metrics.environment,
    },
    metrics,
  });
  const botUsername = await getTelegramBotUsername(botToken);
  const reportDir = path.join(reportRoot, `${timestampForPath()}-telegram-status`);
  await fs.mkdir(reportDir, { recursive: true });
  const summary = {
    status: result.ok ? "SENT" : "FAILED",
    generatedAt: new Date().toISOString(),
    botUsername: botUsername ?? "UNKNOWN",
    botToken: redactTelegramToken(botToken),
    chatId: redactTelegramChatId(chatId),
    metricsUrl,
    period,
    metrics,
    delivery: result,
  };
  await writeJson(path.join(reportDir, "telegram-status-summary.redacted.json"), summary);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  if (!result.ok) {
    throw new Error(`Telegram status digest failed; see ${reportDir}`);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
