/**
 * SSRF guard for server-side fetches of caller-supplied URLs (e.g. order
 * `callbackUrl`). Literal/lexical checks only — no DNS resolution — so a
 * hostname that merely RESOLVES to a private address is not caught here;
 * prefer literal IPs or egress filtering in production.
 */

const BLOCKED_IPV4 = [
  { net: "0.0.0.0", bits: 8 }, // "this network"
  { net: "10.0.0.0", bits: 8 }, // private
  { net: "100.64.0.0", bits: 10 }, // carrier-grade NAT
  { net: "127.0.0.0", bits: 8 }, // loopback
  { net: "169.254.0.0", bits: 16 }, // link-local (cloud metadata)
  { net: "172.16.0.0", bits: 12 }, // private
  { net: "192.168.0.0", bits: 16 }, // private
];

function ipv4ToUint32(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    out = out * 256 + n;
  }
  return out;
}

function isBlockedIpv4(ip: string): boolean {
  const addr = ipv4ToUint32(ip);
  if (addr === undefined) return false;
  return BLOCKED_IPV4.some(({ net, bits }) => {
    const base = ipv4ToUint32(net);
    if (base === undefined) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (base & mask);
  });
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (h.startsWith("fc") || h.startsWith("fd")) {
    return true; // fc00::/7 unique-local
  }
  // IPv4-mapped ::ffff:a.b.c.d — apply the IPv4 rules to the embedded address.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

export type SafeUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * Check whether `rawUrl` is safe for a server-side fetch: must be http(s),
 * carry no credentials, and not target localhost/private/link-local/internal
 * hosts by literal inspection.
 */
export function checkSafeFetchUrl(rawUrl: string): SafeUrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in URL are not allowed" };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "missing hostname" };
  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, reason: `blocked host "${host}"` };
  }
  // WHATWG URL normalizes numeric IPv4 forms (e.g. 2130706433) to dotted quad,
  // so a single dotted-quad check covers the obfuscated variants too.
  if (ipv4ToUint32(host) !== undefined && isBlockedIpv4(host)) {
    return { ok: false, reason: `blocked IP range "${host}"` };
  }
  if (host.includes(":") && isBlockedIpv6(host)) {
    return { ok: false, reason: `blocked IP range "${host}"` };
  }
  return { ok: true };
}

/** Throwing variant for request-validation call sites. */
export function assertSafeFetchUrl(rawUrl: string): void {
  const check = checkSafeFetchUrl(rawUrl);
  if (!check.ok) {
    throw new Error(`unsafe_callback_url: ${check.reason}`);
  }
}
