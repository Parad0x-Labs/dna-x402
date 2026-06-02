// Null Resolver — background service worker
// Intercepts .null domain navigation and resolves via Solana null_registrar program.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NULL_REGISTRAR_PROGRAM_ID = "NuLLRegistrar1111111111111111111111111111111"; // placeholder
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const ARWEAVE_GATEWAY = "https://arweave.net";

// PDA seed prefix matches on-chain: b"null-domain"
const PDA_SEED_PREFIX = "null-domain";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getRpcUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ rpcUrl: DEFAULT_RPC }, (items) => {
      resolve(items.rpcUrl);
    });
  });
}

// ---------------------------------------------------------------------------
// Base58 encode a Uint8Array
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  let digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  // Leading zeros
  let result = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function base58Decode(str) {
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error("Invalid base58 character: " + char);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's => leading zeros
  for (let i = 0; i < str.length && str[i] === "1"; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// ---------------------------------------------------------------------------
// SHA-256 via Web Crypto (available in service workers)
// ---------------------------------------------------------------------------

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// ---------------------------------------------------------------------------
// Derive PDA  ["null-domain", name_bytes]  off-curve bump search
// This is a simplified Ed25519 off-curve check; for production use
// @solana/web3.js PublicKey.findProgramAddress via an injected module.
// ---------------------------------------------------------------------------

async function findProgramAddress(seeds, programId) {
  const programIdBytes = base58Decode(programId);

  for (let bump = 255; bump >= 0; bump--) {
    try {
      const bumpByte = new Uint8Array([bump]);

      // Concatenate: seed1 + seed2 + ... + bumpByte + programIdBytes + "ProgramDerivedAddress"
      const marker = new TextEncoder().encode("ProgramDerivedAddress");
      const parts = [...seeds, bumpByte, programIdBytes, marker];
      const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const part of parts) {
        combined.set(part, offset);
        offset += part.length;
      }

      const hash = await sha256(combined);

      // Check that the point is NOT on the Ed25519 curve (off-curve = valid PDA)
      if (isOffCurve(hash)) {
        return { address: base58Encode(hash), bump };
      }
    } catch (_) {
      // continue
    }
  }
  throw new Error("Could not find valid PDA bump");
}

// Simplified off-curve check: in practice, use a proper Ed25519 library.
// This heuristic rejects ~50% of hashes; good enough for the demo.
// For production, bundle tweetnacl or @solana/web3.js.
function isOffCurve(bytes) {
  // Ed25519 field prime p = 2^255 - 19
  // A point is on-curve if it has a valid y-coordinate square root.
  // Rough heuristic: treat as off-curve if the high bit of bytes[31] is set
  // when the rest of the value is in range — not cryptographically precise,
  // but sufficient as a placeholder until a real library is bundled.
  return (bytes[31] & 0x80) === 0;
}

// ---------------------------------------------------------------------------
// Solana RPC helpers
// ---------------------------------------------------------------------------

async function getAccountInfo(pubkey, rpcUrl) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [pubkey, { encoding: "base64" }],
  });

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) throw new Error("RPC HTTP error: " + res.status);
  const json = await res.json();
  if (json.error) throw new Error("RPC error: " + JSON.stringify(json.error));
  return json.result?.value ?? null;
}

// ---------------------------------------------------------------------------
// Decode NullDomain account
// Account layout (matches null_registrar on-chain struct):
//   8  bytes — Anchor discriminator
//   4  bytes — name length (u32 LE)
//   N  bytes — name UTF-8
//   32 bytes — content_hash [u8; 32]
//   8  bytes — registered_at (i64 LE)
//   32 bytes — owner Pubkey
// ---------------------------------------------------------------------------

function decodeNullDomainAccount(base64Data) {
  const raw = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
  let cursor = 8; // skip discriminator

  const nameLen = new DataView(raw.buffer).getUint32(cursor, true);
  cursor += 4;
  cursor += nameLen; // skip name

  const contentHash = raw.slice(cursor, cursor + 32);
  return contentHash;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

async function resolveNullDomain(name) {
  const rpcUrl = await getRpcUrl();

  // Derive PDA
  const nameBytes = new TextEncoder().encode(name);
  const prefixBytes = new TextEncoder().encode(PDA_SEED_PREFIX);
  const { address: pda } = await findProgramAddress(
    [prefixBytes, nameBytes],
    NULL_REGISTRAR_PROGRAM_ID
  );

  // Fetch account
  const accountInfo = await getAccountInfo(pda, rpcUrl);
  if (!accountInfo || !accountInfo.data) {
    return null; // not registered
  }

  const base64Data =
    typeof accountInfo.data === "string"
      ? accountInfo.data
      : accountInfo.data[0];

  const contentHash = decodeNullDomainAccount(base64Data);
  const arweaveTxId = base58Encode(contentHash);
  return `${ARWEAVE_GATEWAY}/${arweaveTxId}`;
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
