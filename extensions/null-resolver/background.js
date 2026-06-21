// Null Resolver — background service worker
// Intercepts .null domain navigation and resolves via the Solana
// null_registrar program. Pure codec/helpers live in codec.js, which is shared
// verbatim with the Node test suite (test/codec.test.js).

importScripts("codec.js"); // provides base58Encode, buildDomainFilters, decodeContentHash, ...

// ---------------------------------------------------------------------------
// Config (overridable via chrome.storage.sync)
// ---------------------------------------------------------------------------

// Live null_registrar program ID on Solana mainnet-beta. Canonical source is
// configs/mainnet.commercial.json (programs.nullRegistrar) — keep this in sync.
// Overridable at runtime via chrome.storage.sync.
const DEFAULT_PROGRAM_ID = "NXgQhepFpDCu935H1D4g34g59ZYbo1jR4tBCZWhV8Np"; // mainnet null_registrar
// Public RPC that accepts a browser-extension Origin. api.mainnet-beta.solana.com
// answers extension requests with HTTP 403 (Origin header), so it can't be used here.
const DEFAULT_RPC = "https://solana-rpc.publicnode.com";
const ARWEAVE_GATEWAY = "https://arweave.net";

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        rpcUrl: DEFAULT_RPC,
        programId: DEFAULT_PROGRAM_ID,
        arweaveGateway: ARWEAVE_GATEWAY,
      },
      (items) => resolve(items)
    );
  });
}

// ---------------------------------------------------------------------------
// Solana RPC
// ---------------------------------------------------------------------------

async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error("RPC HTTP error: " + res.status);
  const json = await res.json();
  if (json.error) throw new Error("RPC error: " + JSON.stringify(json.error));
  return json.result;
}

// Find the NullDomain account for `name` by matching its stored bytes directly
// (getProgramAccounts + memcmp). No client-side PDA derivation required.
// Returns the base64 account data, or null if not registered.
async function fetchDomainAccount(name, rpcUrl, programId) {
  const filters = buildDomainFilters(name);
  if (!filters) return null; // name too long for the 64-byte field
  const accounts = await rpc(rpcUrl, "getProgramAccounts", [
    programId,
    { encoding: "base64", filters },
  ]);
  if (!accounts || accounts.length === 0) return null;
  const data = accounts[0].account && accounts[0].account.data;
  return Array.isArray(data) ? data[0] : data;
}

async function resolveNullDomain(name) {
  const { rpcUrl, programId, arweaveGateway } = await getConfig();

  // No registrar configured — nothing to resolve against.
  if (!programId) return null;

  const base64Data = await fetchDomainAccount(name, rpcUrl, programId);
  if (!base64Data) return null; // not registered

  const contentHash = decodeContentHash(base64Data);
  if (!contentHash) return null; // malformed account

  const arweaveTxId = base58Encode(contentHash);
  return `${arweaveGateway}/${arweaveTxId}`;
}

// ---------------------------------------------------------------------------
// Navigation interception
// ---------------------------------------------------------------------------

function isNullDomain(url) {
  try {
    const u = new URL(url);
    // Match http(s)://something.null/* or just something.null in the hostname
    return u.hostname.endsWith(".null");
  } catch (_) {
    // Raw typed input like "parad0x.null" won't parse as a URL; check raw string
    return /^[a-zA-Z0-9-]+\.null(\/.*)?$/.test(url);
  }
}

function extractName(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname; // e.g. "parad0x.null"
    return hostname.replace(/\.null$/, "");
  } catch (_) {
    return url.replace(/\.null.*$/, "");
  }
}

function notFoundUrl(name) {
  return chrome.runtime.getURL("null-resolver-page.html") + "?domain=" + encodeURIComponent(name);
}

async function handleNavigation(details) {
  const { url, tabId } = details;

  if (!isNullDomain(url)) return;

  const name = extractName(url);
  if (!name) return;

  try {
    const resolved = await resolveNullDomain(name);

    if (resolved) {
      chrome.tabs.update(tabId, { url: resolved });
    } else {
      chrome.tabs.update(tabId, { url: notFoundUrl(name) });
    }
  } catch (err) {
    console.error("[Null Resolver] Error resolving", name, err);
    chrome.tabs.update(tabId, { url: notFoundUrl(name) });
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(handleNavigation);

// Also handle address-bar typed .null entries before they hit the network
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (isNullDomain(details.url)) {
      // Redirect is handled by webNavigation; returning {} avoids double redirect
      return {};
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);
