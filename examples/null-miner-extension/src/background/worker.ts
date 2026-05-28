/**
 * NULL Miner Extension — Background Service Worker
 *
 * Runs continuously in the background (Manifest V3 service worker).
 * Executes the agent loop: scan tasks → claim → execute → earn USDC.
 *
 * Communicates with popup via chrome.runtime.sendMessage.
 */

// Note: imported from null-miner-sdk which is bundled by vite at build time
// In dev: npm link null-miner-sdk or use workspace protocol
import { createBrowserMiner } from "null-miner-sdk/browser";
import type { BrowserMiner } from "null-miner-sdk/browser";
import type { MinerStats, TaskResult } from "null-miner-sdk";

// ── State ─────────────────────────────────────────────────────────────────────

let miner: BrowserMiner | null = null;
let lastStats: MinerStats | null = null;

// ── Init on install / startup ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log("[NullMiner] Extension installed");
  initMiner();
  chrome.alarms.create("heartbeat", { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
  initMiner();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") {
    if (!miner) initMiner();
  }
});

// ── Miner init ────────────────────────────────────────────────────────────────

async function initMiner() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  if (miner) {
    miner.stop();
    miner = null;
  }

  miner = await createBrowserMiner({
    rpcUrl:     settings.rpcUrl,
    platformId: settings.platformId,
    dryRun:     settings.dryRun,
    allowedTasks: settings.allowedTasks,
    minRewardUsdc: settings.minRewardUsdc,
    onEarn:     (result: TaskResult) => {
      lastStats = miner?.getStats() ?? null;
      notifyEarn(result);
      broadcastStats();
    },
    onError:    (err: Error) => {
      console.error("[NullMiner]", err.message);
    },
  });

  await miner.start();
  lastStats = miner.getStats();
  broadcastStats();
}

// ── Message handler (popup ↔ background) ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: WorkerMessage, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true; // async response
});

type WorkerMessage =
  | { type: "GET_STATS" }
  | { type: "TOGGLE"; enabled: boolean }
  | { type: "GET_SETTINGS" }
  | { type: "UPDATE_SETTINGS"; settings: Partial<MinerSettings> };

async function handleMessage(msg: WorkerMessage): Promise<unknown> {
  switch (msg.type) {
    case "GET_STATS":
      return miner?.getStats() ?? lastStats ?? defaultStats();

    case "TOGGLE": {
      const settings = await getSettings();
      settings.enabled = msg.enabled;
      await saveSettings(settings);
      if (msg.enabled) {
        await initMiner();
      } else {
        miner?.stop();
        miner = null;
      }
      return { ok: true, enabled: msg.enabled };
    }

    case "GET_SETTINGS":
      return getSettings();

    case "UPDATE_SETTINGS": {
      const current = await getSettings();
      const updated  = { ...current, ...msg.settings };
      await saveSettings(updated);
      if (updated.enabled) await initMiner(); // restart with new settings
      return { ok: true };
    }

    default:
      return { error: "unknown message type" };
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

function notifyEarn(result: TaskResult) {
  if (result.usdcEarned < 0.005) return; // Don't spam for tiny tasks

  chrome.notifications.create({
    type:    "basic",
    iconUrl: "../icons/icon48.png",
    title:   `NULL Miner: +$${result.usdcEarned.toFixed(4)} USDC`,
    message: `Task completed: ${result.proof.kind.replace(/_/g, " ")} | +${result.nullYield.toFixed(6)} NULL`,
    priority: 0,
  });
}

function broadcastStats() {
  const stats = miner?.getStats() ?? defaultStats();
  chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats }).catch(() => {
    // Popup not open — ignore
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────

interface MinerSettings {
  enabled:       boolean;
  rpcUrl:        string;
  platformId:    string;
  dryRun:        boolean;
  allowedTasks:  string[];
  minRewardUsdc: number;
}

const DEFAULT_SETTINGS: MinerSettings = {
  enabled:       true,
  rpcUrl:        "https://api.devnet.solana.com",
  platformId:    "null-miner-extension",
  dryRun:        true, // safe default — users explicitly enable real mode
  allowedTasks:  ["residential_relay", "app_store_snapshot", "protocol_maintenance"],
  minRewardUsdc: 0.001,
};

async function getSettings(): Promise<MinerSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get("miner_settings", (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...((result["miner_settings"] as Partial<MinerSettings>) ?? {}) });
    });
  });
}

async function saveSettings(settings: MinerSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ miner_settings: settings }, resolve);
  });
}

function defaultStats() {
  return {
    tasksCompleted: 0,
    usdcEarned:     0,
    nullEarned:     0,
    uptime:         0,
    currentTier:    "bronze" as const,
    reputationScore: 0,
  };
}
