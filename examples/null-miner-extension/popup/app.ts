/**
 * NULL Miner Extension — Popup App
 *
 * Communicates with the background service worker to display live stats.
 */

interface MinerStats {
  tasksCompleted: number;
  usdcEarned:     number;
  nullEarned:     number;
  uptime:         number;
  currentTier:    "bronze" | "silver" | "gold" | "elite";
  reputationScore: number;
}

interface BackgroundMessage {
  type:    "STATS_UPDATE";
  stats:   MinerStats;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

const statusDot    = $("status-dot");
const statusText   = $("status-text");
const toggleInput  = $("enabled-toggle") as HTMLInputElement;
const toggleLabel  = $("toggle-label");
const usdcEarned   = $("usdc-earned");
const nullEarned   = $("null-earned");
const tasksCount   = $("tasks-count");
const uptimeEl     = $("uptime");
const repScore     = $("rep-score");
const repBar       = $("rep-bar");
const repNextLabel = $("rep-next-label");
const repPct       = $("rep-pct");
const tierBadge    = $("tier-badge");
const taskFeed     = $("task-feed");
const dryrunNotice = $("dryrun-notice");
const passportLink = $("passport-link");

// ── Recent tasks ring buffer ───────────────────────────────────────────────────

interface FeedEntry {
  kind:      string;
  usdc:      number;
  ts:        number;
}

const feedEntries: FeedEntry[] = [];

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Get current settings + stats from background
  const settings = await sendMessage<{ enabled: boolean; dryRun: boolean }>({ type: "GET_SETTINGS" });
  toggleInput.checked = settings.enabled;
  updateToggleUI(settings.enabled);

  if (settings.dryRun) {
    dryrunNotice.style.display = "block";
  }

  const stats = await sendMessage<MinerStats>({ type: "GET_STATS" });
  if (stats) updateStatsUI(stats);

  // Listen for live stats updates from background
  chrome.runtime.onMessage.addListener((msg: BackgroundMessage) => {
    if (msg.type === "STATS_UPDATE") updateStatsUI(msg.stats);
  });
}

// ── Stats UI ──────────────────────────────────────────────────────────────────

function updateStatsUI(stats: MinerStats) {
  // Earnings
  usdcEarned.textContent = stats.usdcEarned.toFixed(4);
  nullEarned.textContent = stats.nullEarned.toFixed(6);

  // Stats row
  tasksCount.textContent = String(stats.tasksCompleted);
  uptimeEl.textContent   = formatUptime(stats.uptime);
  repScore.textContent   = String(stats.reputationScore);

  // Reputation bar
  const score   = stats.reputationScore;
  const tierMap = [
    { tier: "bronze", min: 0,   max: 200, label: "→ Silver at 200" },
    { tier: "silver", min: 200, max: 500, label: "→ Gold at 500"   },
    { tier: "gold",   min: 500, max: 800, label: "→ Elite at 800"  },
    { tier: "elite",  min: 800, max: 1000, label: "ELITE MAX"      },
  ];
  const current = tierMap.find(t => score < t.max) ?? tierMap[3];
  const pct     = Math.min(100, ((score - current.min) / (current.max - current.min)) * 100);

  repBar.style.width     = `${pct.toFixed(1)}%`;
  repNextLabel.textContent = current.label;
  repPct.textContent     = `${pct.toFixed(0)}%`;

  // Tier badge
  tierBadge.textContent  = stats.currentTier.toUpperCase();
  tierBadge.className    = `tier-badge ${stats.currentTier}`;

  // Status
  if (stats.uptime > 0) {
    statusDot.className   = "status-dot active";
    statusText.className  = "status-text active";
    statusText.textContent = `Agent active · ${stats.tasksCompleted} tasks completed`;
  } else {
    statusDot.className   = "status-dot";
    statusText.textContent = "Agent starting...";
  }
}

// ── Feed ──────────────────────────────────────────────────────────────────────

function addFeedEntry(kind: string, usdc: number) {
  feedEntries.unshift({ kind, usdc, ts: Date.now() });
  if (feedEntries.length > 5) feedEntries.pop();

  taskFeed.innerHTML = "";
  for (const entry of feedEntries) {
    const item    = document.createElement("div");
    item.className = "feed-item";
    item.innerHTML = `
      <div class="feed-dot"></div>
      <div class="feed-kind">${entry.kind.replace(/_/g, " ")}</div>
      <div class="feed-usdc">+$${entry.usdc.toFixed(4)}</div>
    `;
    taskFeed.appendChild(item);
  }
}

// ── Toggle ────────────────────────────────────────────────────────────────────

toggleInput.addEventListener("change", async () => {
  const enabled = toggleInput.checked;
  updateToggleUI(enabled);
  await sendMessage({ type: "TOGGLE", enabled });
  if (!enabled) {
    statusDot.className    = "status-dot";
    statusText.className   = "status-text";
    statusText.textContent = "Agent stopped";
  }
});

function updateToggleUI(enabled: boolean) {
  toggleLabel.textContent = enabled ? "ON" : "OFF";
}

// ── Passport link ─────────────────────────────────────────────────────────────

passportLink.addEventListener("click", async () => {
  const stats = await sendMessage<MinerStats & { passportId?: string }>({ type: "GET_STATS" });
  const pid   = stats?.passportId ?? "unknown";
  alert(`Passport ID:\n${pid}\n\nThis is your anonymous ZK identity — never exposes your wallet address.`);
});

// ── Message helper ────────────────────────────────────────────────────────────

function sendMessage<T>(msg: object): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

init().catch(console.error);

// Poll stats every 5 seconds (background may not push updates while popup is open)
setInterval(async () => {
  const stats = await sendMessage<MinerStats>({ type: "GET_STATS" });
  if (stats) updateStatsUI(stats);
}, 5000);

// Listen for earn events from chrome.storage changes (last resort sync)
chrome.storage.onChanged.addListener((changes) => {
  if (changes["null_miner_stats"]) {
    try {
      const stats = JSON.parse(changes["null_miner_stats"].newValue as string) as MinerStats;
      updateStatsUI(stats);
    } catch { /* ignore */ }
  }
});
