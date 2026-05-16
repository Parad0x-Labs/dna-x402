import crypto from "node:crypto";
import { z } from "zod";

export const telegramParseModeSchema = z.enum(["HTML", "MarkdownV2"]);

const alertRecordSchema = z.object({
  status: z.string().optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  fingerprint: z.string().optional(),
}).passthrough();

export const alertmanagerWebhookPayloadSchema = z.object({
  receiver: z.string().optional(),
  status: z.string().optional(),
  groupLabels: z.record(z.string()).optional(),
  commonLabels: z.record(z.string()).optional(),
  commonAnnotations: z.record(z.string()).optional(),
  externalURL: z.string().optional(),
  alerts: z.array(alertRecordSchema).default([]),
}).passthrough();

export type TelegramParseMode = z.infer<typeof telegramParseModeSchema>;
export type AlertmanagerWebhookPayload = z.infer<typeof alertmanagerWebhookPayloadSchema>;
export type AlertmanagerAlertRecord = z.infer<typeof alertRecordSchema>;

export interface TelegramAlertConfig {
  botToken: string;
  chatId: string;
  parseMode?: TelegramParseMode;
  environment?: string;
}

export interface TelegramCommandAccessConfig {
  commandsEnabled: boolean;
  allowedUserIds: string[];
  allowedAdminIds?: string[];
  allowedChatIds: string[];
}

export interface TelegramUpdateAccessDecision {
  ok: boolean;
  reason?: "commands_disabled" | "missing_user" | "user_not_allowed" | "missing_chat" | "chat_not_allowed";
  userId?: string;
  chatId?: string;
  role?: "owner" | "admin";
}

export interface TelegramDeliveryResult {
  ok: boolean;
  status: number;
  alertName: string;
  chatIdRedacted: string;
  messageId?: number;
  telegramOk?: boolean;
  description?: string;
  deliveredAt: string;
}

export interface TelegramRelayResult {
  ok: boolean;
  delivered: TelegramDeliveryResult[];
  failed: TelegramDeliveryResult[];
}

export interface TelegramStatusMetrics {
  online: boolean;
  environment: string;
  period: "30m" | "24h" | "manual";
  metricsUrl: string;
  quotesCreated: number;
  commitsCreated: number;
  finalizeSuccess: number;
  finalizeRejected: number;
  receiptsIssued: number;
  volumeAtomic: number;
  feeAccruals: number;
  feeAccruedAtomic: number;
  agentsObserved: number;
  webhookReplayRejected: number;
  piiBlocks: number;
  emergencyPauseActive: number;
  adminActions: number;
  dbErrors: number;
  verifierErrors: number;
  settlementUnavailable: number;
  generatedAt?: string;
}

function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function redactTelegramToken(value: string | undefined): string {
  if (!value) {
    return "REDACTED";
  }
  return `REDACTED:${hashSecret(value)}`;
}

export function redactTelegramChatId(value: string | undefined): string {
  if (!value) {
    return "REDACTED";
  }
  const trimmed = value.trim();
  if (trimmed.length <= 6) {
    return `REDACTED:${hashSecret(trimmed)}`;
  }
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}:${hashSecret(trimmed)}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function alertAction(alertName: string): string {
  switch (alertName) {
    case "X402EmergencyPauseActive":
      return "Check admin panel and confirm ACK.";
    case "X402PiiBlock":
      return "Confirm immutable write was blocked and review the audit trail.";
    case "X402BackupFailure":
      return "Check backup job, storage, and restore drill status.";
    case "X402MonitoringRouteTest":
      return "Confirm the external Telegram operator route is reachable.";
    default:
      return "Check monitoring dashboard and acknowledge.";
  }
}

function alertTime(alert: AlertmanagerAlertRecord): string {
  return alert.startsAt || new Date().toISOString();
}

export function alertNameFromRecord(alert: AlertmanagerAlertRecord): string {
  return alert.labels?.alertname || "X402MonitoringRouteTest";
}

function updateUserId(update: unknown): string | undefined {
  const item = update as {
    message?: { from?: { id?: number | string } };
    callback_query?: { from?: { id?: number | string } };
  };
  const raw = item.message?.from?.id ?? item.callback_query?.from?.id;
  return raw === undefined ? undefined : String(raw);
}

function updateChatId(update: unknown): string | undefined {
  const item = update as {
    message?: { chat?: { id?: number | string } };
    callback_query?: { message?: { chat?: { id?: number | string } } };
  };
  const raw = item.message?.chat?.id ?? item.callback_query?.message?.chat?.id;
  return raw === undefined ? undefined : String(raw);
}

export function isTelegramUpdateAllowed(
  update: unknown,
  access: TelegramCommandAccessConfig,
): TelegramUpdateAccessDecision {
  if (!access.commandsEnabled) {
    return { ok: false, reason: "commands_disabled" };
  }
  const userId = updateUserId(update);
  if (!userId) {
    return { ok: false, reason: "missing_user" };
  }
  const chatId = updateChatId(update);
  if (!chatId) {
    return { ok: false, reason: "missing_chat", userId };
  }
  if (!access.allowedChatIds.includes(chatId)) {
    return { ok: false, reason: "chat_not_allowed", userId, chatId };
  }
  if (access.allowedUserIds.includes(userId)) {
    return { ok: true, userId, chatId, role: "owner" };
  }
  if ((access.allowedAdminIds ?? []).includes(userId)) {
    return { ok: true, userId, chatId, role: "admin" };
  }
  return { ok: false, reason: "user_not_allowed", userId, chatId };
}

export function formatTelegramAlertMessage(input: {
  alert: AlertmanagerAlertRecord;
  environment?: string;
}): string {
  const alertName = alertNameFromRecord(input.alert);
  const severity = input.alert.labels?.severity || "warning";
  const environment = input.alert.labels?.environment || input.environment || "staging";
  const summary = input.alert.annotations?.summary || input.alert.annotations?.description || `${alertName} fired.`;

  return [
    "🚨 <b>DNA x402 Alert</b>",
    "",
    `<b>Alert:</b> ${escapeHtml(alertName)}`,
    `<b>Severity:</b> ${escapeHtml(severity)}`,
    `<b>Environment:</b> ${escapeHtml(environment)}`,
    `<b>Time:</b> ${escapeHtml(alertTime(input.alert))}`,
    `<b>Summary:</b> ${escapeHtml(summary)}`,
    `<b>Action:</b> ${escapeHtml(alertAction(alertName))}`,
    "",
    "Reply in this group:",
    "<code>ACK</code> - handling",
    "<code>STATUS</code> - investigation update",
    "<code>DONE</code> - resolved / false alarm",
  ].join("\n");
}

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

export async function sendTelegramTextMessage(input: {
  config: TelegramAlertConfig;
  text: string;
  alertName?: string;
  fetchImpl?: typeof fetch;
}): Promise<TelegramDeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(telegramApiUrl(input.config.botToken, "sendMessage"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: input.config.chatId,
      text: input.text,
      parse_mode: input.config.parseMode ?? "HTML",
      disable_web_page_preview: true,
    }),
  });
  const body = await response.json().catch(() => undefined) as {
    ok?: boolean;
    description?: string;
    result?: {
      message_id?: number;
    };
  } | undefined;

  return {
    ok: response.ok && body?.ok === true,
    status: response.status,
    alertName: input.alertName ?? "X402TelegramMessage",
    chatIdRedacted: redactTelegramChatId(input.config.chatId),
    messageId: body?.result?.message_id,
    telegramOk: body?.ok,
    description: body?.description,
    deliveredAt: new Date().toISOString(),
  };
}

export async function getTelegramBotUsername(botToken: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetchImpl(telegramApiUrl(botToken, "getMe"));
  const body = await response.json().catch(() => undefined) as { ok?: boolean; result?: { username?: string } } | undefined;
  if (!response.ok || !body?.ok) {
    return undefined;
  }
  return body.result?.username;
}

export async function sendTelegramAlert(input: {
  config: TelegramAlertConfig;
  alert: AlertmanagerAlertRecord;
  fetchImpl?: typeof fetch;
}): Promise<TelegramDeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const alertName = alertNameFromRecord(input.alert);
  const message = formatTelegramAlertMessage({
    alert: input.alert,
    environment: input.config.environment,
  });
  const response = await fetchImpl(telegramApiUrl(input.config.botToken, "sendMessage"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: input.config.chatId,
      text: message,
      parse_mode: input.config.parseMode ?? "HTML",
      disable_web_page_preview: true,
    }),
  });
  const body = await response.json().catch(() => undefined) as {
    ok?: boolean;
    description?: string;
    result?: {
      message_id?: number;
    };
  } | undefined;

  return {
    ok: response.ok && body?.ok === true,
    status: response.status,
    alertName,
    chatIdRedacted: redactTelegramChatId(input.config.chatId),
    messageId: body?.result?.message_id,
    telegramOk: body?.ok,
    description: body?.description,
    deliveredAt: new Date().toISOString(),
  };
}

function atomicUsdc(value: number): string {
  return (value / 1_000_000).toFixed(6);
}

export function formatTelegramStatusDigest(metrics: TelegramStatusMetrics): string {
  const title = metrics.period === "24h" ? "DNA x402 Daily Ops Digest" : "DNA x402 Engine Status";
  const generatedAt = metrics.generatedAt ?? new Date().toISOString();
  const status = metrics.online && metrics.emergencyPauseActive === 0 ? "ONLINE" : metrics.online ? "PAUSED" : "DOWN";
  return [
    `📊 <b>${escapeHtml(title)}</b>`,
    "",
    `<b>Status:</b> ${escapeHtml(status)}`,
    `<b>Environment:</b> ${escapeHtml(metrics.environment)}`,
    `<b>Period:</b> ${escapeHtml(metrics.period)}`,
    `<b>Time:</b> ${escapeHtml(generatedAt)}`,
    "",
    `<b>Volume:</b> ${escapeHtml(atomicUsdc(metrics.volumeAtomic))} USDC atomic-equivalent`,
    `<b>Fee accrual:</b> ${escapeHtml(atomicUsdc(metrics.feeAccruedAtomic))} USDC (${escapeHtml(metrics.feeAccruals)} accruals, not collected)`,
    `<b>Agents observed:</b> ${escapeHtml(metrics.agentsObserved)}`,
    `<b>Quotes / commits:</b> ${escapeHtml(metrics.quotesCreated)} / ${escapeHtml(metrics.commitsCreated)}`,
    `<b>Finalized / rejected:</b> ${escapeHtml(metrics.finalizeSuccess)} / ${escapeHtml(metrics.finalizeRejected)}`,
    `<b>Receipts:</b> ${escapeHtml(metrics.receiptsIssued)}`,
    "",
    `<b>Emergency pause:</b> ${escapeHtml(metrics.emergencyPauseActive ? "ACTIVE" : "clear")}`,
    `<b>PII blocks:</b> ${escapeHtml(metrics.piiBlocks)}`,
    `<b>Webhook replays rejected:</b> ${escapeHtml(metrics.webhookReplayRejected)}`,
    `<b>Admin actions:</b> ${escapeHtml(metrics.adminActions)}`,
    `<b>DB / verifier / settlement errors:</b> ${escapeHtml(metrics.dbErrors)} / ${escapeHtml(metrics.verifierErrors)} / ${escapeHtml(metrics.settlementUnavailable)}`,
  ].join("\n");
}

export async function sendTelegramStatusDigest(input: {
  config: TelegramAlertConfig;
  metrics: TelegramStatusMetrics;
  fetchImpl?: typeof fetch;
}): Promise<TelegramDeliveryResult> {
  return sendTelegramTextMessage({
    config: input.config,
    text: formatTelegramStatusDigest(input.metrics),
    alertName: input.metrics.period === "24h" ? "X402DailyOpsDigest" : "X402EngineStatus",
    fetchImpl: input.fetchImpl,
  });
}

export async function relayAlertmanagerToTelegram(input: {
  config: TelegramAlertConfig;
  payload: AlertmanagerWebhookPayload;
  fetchImpl?: typeof fetch;
}): Promise<TelegramRelayResult> {
  const alerts = input.payload.alerts.length > 0
    ? input.payload.alerts
    : [{
      status: input.payload.status ?? "firing",
      labels: input.payload.commonLabels ?? { alertname: "X402MonitoringRouteTest" },
      annotations: input.payload.commonAnnotations ?? { summary: "Monitoring route test alert." },
      startsAt: new Date().toISOString(),
    }];

  const delivered: TelegramDeliveryResult[] = [];
  const failed: TelegramDeliveryResult[] = [];
  for (const alert of alerts) {
    const result = await sendTelegramAlert({
      config: input.config,
      alert,
      fetchImpl: input.fetchImpl,
    });
    if (result.ok) {
      delivered.push(result);
    } else {
      failed.push(result);
    }
  }

  return {
    ok: failed.length === 0,
    delivered,
    failed,
  };
}
