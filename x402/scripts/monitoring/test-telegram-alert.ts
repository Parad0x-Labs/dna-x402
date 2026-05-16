import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  alertmanagerWebhookPayloadSchema,
  getTelegramBotUsername,
  redactTelegramChatId,
  redactTelegramToken,
  relayAlertmanagerToTelegram,
  type AlertmanagerWebhookPayload,
  type TelegramDeliveryResult,
} from "../../src/monitoring/telegramAlert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const reportRoot = path.join(repoRoot, "reports", "monitoring");

type AlertSpec = {
  key: "test" | "emergency-pause" | "pii-block" | "backup-failure";
  alertName: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  fileName: string;
};

const ALERTS: AlertSpec[] = [
  {
    key: "test",
    alertName: "X402MonitoringRouteTest",
    severity: "info",
    summary: "External Telegram route test alert.",
    fileName: "telegram-test-alert-response.redacted.json",
  },
  {
    key: "emergency-pause",
    alertName: "X402EmergencyPauseActive",
    severity: "critical",
    summary: "Emergency pause is active.",
    fileName: "telegram-emergency-pause-alert-response.redacted.json",
  },
  {
    key: "pii-block",
    alertName: "X402PiiBlock",
    severity: "critical",
    summary: "Immutable PII write was blocked.",
    fileName: "telegram-pii-block-alert-response.redacted.json",
  },
  {
    key: "backup-failure",
    alertName: "X402BackupFailure",
    severity: "critical",
    summary: "Backup failure alert drill.",
    fileName: "telegram-backup-failure-alert-response.redacted.json",
  },
];

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Telegram alert drill`);
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

function makePayload(spec: AlertSpec): AlertmanagerWebhookPayload {
  return alertmanagerWebhookPayloadSchema.parse({
    receiver: "telegram-ops",
    status: "firing",
    alerts: [{
      status: "firing",
      labels: {
        alertname: spec.alertName,
        severity: spec.severity,
        environment: process.env.X402_ALERT_ENVIRONMENT ?? "staging",
      },
      annotations: {
        summary: spec.summary,
      },
      startsAt: new Date().toISOString(),
      fingerprint: `${spec.alertName.toLowerCase()}-manual-drill`,
    }],
  });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function sendViaRelay(input: {
  relayUrl: string;
  relaySecret: string;
  payload: AlertmanagerWebhookPayload;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(input.relayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-alert-relay-secret": input.relaySecret,
    },
    body: JSON.stringify(input.payload),
  });
  const body = await response.json().catch(() => undefined);
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function summarizeDelivery(results: Array<{ spec: AlertSpec; result: TelegramDeliveryResult | { ok: boolean; status: number; body: unknown } }>) {
  return results.map(({ spec, result }) => ({
    alertName: spec.alertName,
    ok: result.ok,
    status: result.status,
  }));
}

async function main(): Promise<void> {
  const botToken = requiredEnv("X402_ALERT_TELEGRAM_BOT_TOKEN");
  const chatId = requiredEnv("X402_ALERT_TELEGRAM_CHAT_ID");
  const parseMode = readParseMode();
  const relayUrl = process.env.X402_ALERT_TELEGRAM_RELAY_URL?.trim();
  const relaySecret = process.env.X402_ALERT_TELEGRAM_RELAY_SECRET?.trim();
  const humanSeen = process.argv.includes("--human-seen");
  const reportDir = path.join(reportRoot, `${timestampForPath()}-telegram-route`);
  await fs.mkdir(reportDir, { recursive: true });
  const botUsername = await getTelegramBotUsername(botToken);
  const results: Array<{
    spec: AlertSpec;
    result: TelegramDeliveryResult | { ok: boolean; status: number; body: unknown };
  }> = [];

  for (const spec of ALERTS) {
    const payload = makePayload(spec);
    let result: TelegramDeliveryResult | { ok: boolean; status: number; body: unknown };
    if (relayUrl) {
      result = await sendViaRelay({
        relayUrl,
        relaySecret: relaySecret || requiredEnv("X402_ALERT_TELEGRAM_RELAY_SECRET"),
        payload,
      });
    } else {
      const relayResult = await relayAlertmanagerToTelegram({
        config: {
          botToken,
          chatId,
          parseMode,
          environment: process.env.X402_ALERT_ENVIRONMENT ?? "staging",
        },
        payload,
      });
      result = relayResult.delivered[0] ?? relayResult.failed[0] ?? {
        ok: false,
        status: 0,
        body: { error: "telegram_delivery_missing" },
      };
    }

    results.push({ spec, result });
    await writeJson(path.join(reportDir, spec.fileName), {
      alertName: spec.alertName,
      token: redactTelegramToken(botToken),
      botUsername: botUsername ?? "UNKNOWN",
      chatId: redactTelegramChatId(chatId),
      delivery: result,
    });
  }

  const allDelivered = results.every(({ result }) => result.ok);
  const summary = {
    status: allDelivered && humanSeen ? "PASSED_EXTERNAL_HUMAN_ROUTE" : "PENDING_HUMAN_CONFIRMATION",
    generatedAt: new Date().toISOString(),
    groupName: "DNA x402 Ops Alerts",
    botUsername: botUsername ?? "UNKNOWN",
    botToken: "REDACTED",
    chatId: redactTelegramChatId(chatId),
    relayMode: relayUrl ? "x402_internal_alert_relay" : "direct_telegram_api_drill",
    relayUrl: relayUrl ?? null,
    humanSeen,
    deliveryResults: summarizeDelivery(results),
    reportDir,
  };
  await writeJson(path.join(reportDir, "telegram-route-summary.json"), summary);

  if (!allDelivered) {
    throw new Error(`Telegram route drill failed; see ${reportDir}`);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
