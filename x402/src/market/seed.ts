import bs58 from "bs58";
import nacl from "tweetnacl";
import { createSignedManifest } from "./manifest.js";
import { createReferenceShops } from "./templates/index.js";

const baseUrl = (process.env.X402_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function marketEvent(params: {
  type: "QUOTE_ISSUED" | "PAYMENT_VERIFIED" | "REQUEST_FULFILLED";
  shopId: string;
  endpointId: string;
  capability: string;
  priceAmount: string;
  receiptId?: string;
  minutesAgo: number;
  anchor32?: string;
}): Record<string, unknown> {
  return {
    type: params.type,
    ts: new Date(Date.now() - params.minutesAgo * 60_000).toISOString(),
    shopId: params.shopId,
    endpointId: params.endpointId,
    capabilityTags: [params.capability],
    priceAmount: params.priceAmount,
    mint: "USDC",
    settlementMode: params.type === "QUOTE_ISSUED" ? undefined : "transfer",
    latencyMs: params.type === "REQUEST_FULFILLED" ? 650 + Math.round(Math.random() * 500) : undefined,
    statusCode: params.type === "REQUEST_FULFILLED" ? 200 : undefined,
    receiptId: params.receiptId,
    anchor32: params.anchor32,
    receiptValid: params.type === "QUOTE_ISSUED" ? undefined : true,
  };
}

async function registerReferenceShops(): Promise<{ ownerPubkey: string; ownerSecret: string; shopIds: string[] }> {
  const owner = nacl.sign.keyPair();
  const ownerPubkey = bs58.encode(owner.publicKey);
  const ownerSecret = bs58.encode(owner.secretKey);

  const manifests = createReferenceShops(ownerPubkey);
  const shopIds: string[] = [];

  for (const manifest of manifests) {
    const signed = createSignedManifest(manifest, ownerSecret);
    const response = await post("/market/shops", signed);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`failed to register ${manifest.shopId}: ${response.status} ${body}`);
    }
    shopIds.push(manifest.shopId);
  }

  return { ownerPubkey, ownerSecret, shopIds };
}

async function seedHeartbeats(shopIds: string[]): Promise<void> {
  const picked = shopIds.slice(0, 6);
  for (let i = 0; i < picked.length; i += 1) {
    await post("/market/heartbeat", {
      shopId: picked[i],
      inflight: 2 + i * 3,
      queueDepth: 5 + i * 7,
      p95LatencyMs: 500 + i * 180,
      errorRate: Math.min(0.08, i * 0.01),
    });
  }
}

async function seedQuotesTraffic(): Promise<void> {
  const capabilities = [
    "web_search_with_citations",
    "pdf_fetch_extract",
    "summarize_with_quotes",
    "classify_fast",
    "dedupe_normalize",
    "entity_extract",
    "send_email_stub",
    "calendar_book_stub",
    "form_fill_stub",
    "tool_gateway_stream_access",
  ];

  for (const capability of capabilities) {
    await fetch(`${baseUrl}/market/quotes?capability=${encodeURIComponent(capability)}&maxPrice=100000&limit=5`);
  }
}

async function seedEvents(shopIds: string[]): Promise<void> {
  const events: Record<string, unknown>[] = [];
  const capabilitiesByShop = [
    "web_search_with_citations",
    "pdf_fetch_extract",
    "summarize_with_quotes",
    "classify_fast",
    "dedupe_normalize",
    "entity_extract",
    "send_email_stub",
    "calendar_book_stub",
    "form_fill_stub",
    "tool_gateway_stream_access",
  ];

  for (let i = 0; i < shopIds.length; i += 1) {
    const shopId = shopIds[i];
    const capability = capabilitiesByShop[i] ?? "generic";
    const endpointId = capability;
    const price = (700 + i * 120).toString(10);
    const receiptId = `seed-${shopId}-r1`;
    const anchor = `${(i + 10).toString(16).padStart(2, "0")}`.repeat(32);

    events.push(marketEvent({ type: "QUOTE_ISSUED", shopId, endpointId, capability, priceAmount: (Number(price) + 120).toString(10), minutesAgo: 90 - i * 2 }));
    events.push(marketEvent({ type: "QUOTE_ISSUED", shopId, endpointId, capability, priceAmount: price, minutesAgo: 20 - Math.min(i, 10) }));
    events.push(marketEvent({ type: "PAYMENT_VERIFIED", shopId, endpointId, capability, priceAmount: price, receiptId, anchor32: anchor, minutesAgo: 15 - Math.min(i, 8) }));
    events.push(marketEvent({ type: "REQUEST_FULFILLED", shopId, endpointId, capability, priceAmount: price, receiptId, anchor32: anchor, minutesAgo: 14 - Math.min(i, 7) }));
  }

  const ingest = await post("/market/dev/events", { events });
  if (!ingest.ok) {
    // eslint-disable-next-line no-console
    console.warn("seeded shops/quotes only. enable MARKET_ALLOW_DEV_INGEST=1 for synthetic sales telemetry.");
  }
}

async function main(): Promise<void> {
  const { shopIds } = await registerReferenceShops();
  await seedHeartbeats(shopIds);
  await seedQuotesTraffic();
  await seedEvents(shopIds);

  const snapshot = await fetch(`${baseUrl}/market/snapshot`).then((response) => response.json());
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, baseUrl, shopsRegistered: shopIds.length, snapshot }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
