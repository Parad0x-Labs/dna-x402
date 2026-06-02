// Null Resolver — popup script

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

// ---------------------------------------------------------------------------
// Current tab domain detection
// ---------------------------------------------------------------------------

function isNullDomain(url) {
  try {
    return new URL(url).hostname.endsWith(".null");
  } catch (_) {
    return false;
  }
}

function extractName(url) {
  try {
    return new URL(url).hostname.replace(/\.null$/, "");
  } catch (_) {
    return "";
  }
}

async function updateCurrentTabStatus() {
  const dot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const domainEl = document.getElementById("current-domain");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    if (isNullDomain(tab.url)) {
      const name = extractName(tab.url);
      dot.classList.remove("idle");
      dot.classList.add("active");
      statusText.textContent = ".null domain detected";
      domainEl.textContent = name + ".null";
    } else {
      dot.classList.remove("active");
      dot.classList.add("idle");
      statusText.textContent = "Not a .null domain";
      domainEl.textContent = "";
    }
  } catch (err) {
    statusText.textContent = "Unable to read tab";
  }
}

// ---------------------------------------------------------------------------
// Advanced panel toggle
// ---------------------------------------------------------------------------

document.getElementById("toggle-advanced").addEventListener("click", () => {
  const panel = document.getElementById("advanced-panel");
  const arrow = document.getElementById("toggle-arrow");
  const isOpen = panel.classList.toggle("open");
  arrow.innerHTML = isOpen ? "&#9660;" : "&#9654;";
});

// ---------------------------------------------------------------------------
// RPC URL setting
// ---------------------------------------------------------------------------

async function loadRpcUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ rpcUrl: DEFAULT_RPC }, (items) => {
      resolve(items.rpcUrl);
    });
  });
}

async function initRpcInput() {
  const input = document.getElementById("rpc-input");
  input.value = await loadRpcUrl();
}

document.getElementById("save-rpc").addEventListener("click", () => {
  const input = document.getElementById("rpc-input");
  const savedEl = document.getElementById("rpc-saved");
  const url = input.value.trim() || DEFAULT_RPC;

  chrome.storage.sync.set({ rpcUrl: url }, () => {
    savedEl.textContent = "Saved.";
    setTimeout(() => {
      savedEl.textContent = "";
    }, 2000);
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

updateCurrentTabStatus();
initRpcInput();
