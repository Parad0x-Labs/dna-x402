#!/usr/bin/env node
import { createHash } from "node:crypto";

function argValue(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function jsonFetch(url, init = {}, expectedStatus = undefined) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${url} expected ${expectedStatus}, got ${response.status}: ${text}`);
  }
  return { status: response.status, payload };
}

async function proofFor(agentId, quote, settlement) {
  const helperUrl = argValue("--payment-helper-url", undefined);
  if (helperUrl && ["transfer", "stream"].includes(settlement)) {
    const helper = await jsonFetch(helperUrl, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        quoteId: quote.quoteId,
        settlement,
        amountAtomic: quote.totalAtomic,
        recipient: quote.recipient,
        mint: quote.mint,
      }),
    }, 200);
    if (!helper.payload?.paymentProof) {
      throw new Error("payment helper did not return paymentProof");
    }
    return helper.payload.paymentProof;
  }

  const digest = sha256Hex(`${agentId}:${quote.quoteId}:${settlement}`);
  if (settlement === "netting") {
    return {
      settlement: "netting",
      amountAtomic: quote.totalAtomic,
      note: `browser-agent:${agentId}`,
    };
  }
  if (settlement === "stream") {
    return {
      settlement: "stream",
      streamId: `browser-stream-${digest.slice(0, 40)}`,
      amountAtomic: quote.totalAtomic,
    };
  }
  return {
    settlement: "transfer",
    txSignature: `browser-transfer-${digest}`,
    amountAtomic: quote.totalAtomic,
  };
}

async function selectResource(baseUrl, capability) {
  if (!capability) {
    return {
      resource: argValue("--resource", "/programmability/fixed-price"),
      selectedQuote: undefined,
      order: undefined,
    };
  }

  if (hasFlag("--create-order")) {
    const orderBody = {
      capability,
      maxPrice: argValue("--max-price", "1000000"),
      maxLatencyMs: Number(argValue("--max-latency-ms", "5000")),
      expiresAt: new Date(Date.now() + Number(argValue("--order-ttl-ms", "60000"))).toISOString(),
      preferSettlement: argValue("--prefer-settlement", undefined),
    };
    const created = await jsonFetch(`${baseUrl}/market/orders`, {
      method: "POST",
      body: JSON.stringify(orderBody),
    }, 201);
    const polled = await jsonFetch(`${baseUrl}/market/orders/poll`, { method: "POST" }, 200);
    const executed = (polled.payload.executed ?? []).find((row) => row.orderId === created.payload.orderId);
    if (!executed?.chosenQuote) {
      throw new Error(`order did not execute for capability ${capability}`);
    }
    return {
      resource: executed.chosenQuote.path,
      selectedQuote: executed.chosenQuote,
      order: executed,
    };
  }

  const params = new URLSearchParams({
    capability,
    limit: "5",
    maxPrice: argValue("--max-price", "1000000"),
  });
  const quotes = await jsonFetch(`${baseUrl}/market/quotes?${params.toString()}`, {}, 200);
  const selectedQuote = quotes.payload.quotes?.[0];
  if (!selectedQuote) {
    throw new Error(`no market quote for capability ${capability}`);
  }
  return {
    resource: selectedQuote.path,
    selectedQuote,
    order: undefined,
  };
}

async function payResource(baseUrl, resource, agentId, settlementOverride) {
  const resourceUrl = new URL(resource, `${baseUrl}/`).toString();
  const unpaid = await jsonFetch(resourceUrl, {}, 402);
  const requirements = unpaid.payload.paymentRequirements;
  const quote = requirements.quote;
  const settlement = settlementOverride ?? requirements.recommendedMode;
  const payerCommitment32B = sha256Hex(`${agentId}:${quote.quoteId}`);
  const commit = await jsonFetch(requirements.commitEndpoint, {
    method: "POST",
    body: JSON.stringify({
      quoteId: quote.quoteId,
      payerCommitment32B,
    }),
  }, 201);
  const paymentProof = await proofFor(agentId, quote, settlement);
  const finalized = await jsonFetch(requirements.finalizeEndpoint, {
    method: "POST",
    body: JSON.stringify({
      commitId: commit.payload.commitId,
      paymentProof,
    }),
  }, 200);
  const receipt = await jsonFetch(requirements.receiptEndpoint.replace(":receiptId", finalized.payload.receiptId), {}, 200);
  const paid = await jsonFetch(resourceUrl, {
    headers: {
      "x-dnp-commit-id": commit.payload.commitId,
    },
  }, 200);

  const payload = receipt.payload.payload ?? {};
  if (payload.quoteId !== quote.quoteId) {
    throw new Error("receipt quoteId mismatch");
  }
  if (payload.commitId !== commit.payload.commitId) {
    throw new Error("receipt commitId mismatch");
  }
  if (payload.payerCommitment32B !== payerCommitment32B) {
    throw new Error("receipt payer commitment mismatch");
  }

  return {
    settlement,
    quoteId: quote.quoteId,
    commitId: commit.payload.commitId,
    receiptId: finalized.payload.receiptId,
    txSignature: paymentProof.txSignature,
    topupSignature: paymentProof.topupSignature,
    streamId: paymentProof.streamId,
    receiptHash: receipt.payload.receiptHash,
    signerPublicKey: receipt.payload.signerPublicKey,
    fixtureId: paid.payload.fixtureId,
    output: paid.payload.output,
    seller_defined: paid.payload.seller_defined,
    verifiable: paid.payload.verifiable,
  };
}

const baseUrl = argValue("--base-url")?.replace(/\/$/, "");
if (!baseUrl) {
  throw new Error("--base-url is required");
}

const agentId = argValue("--agent-id", "browser-agent");
const capability = argValue("--market-capability", undefined);
const selected = await selectResource(baseUrl, capability);
const paid = await payResource(baseUrl, selected.resource, agentId, argValue("--settlement", undefined));

console.log(JSON.stringify({
  ok: true,
  agentLanguage: "browser-js",
  agentId,
  resource: selected.resource,
  marketQuote: selected.selectedQuote ? {
    shopId: selected.selectedQuote.shopId,
    endpointId: selected.selectedQuote.endpointId,
    price: selected.selectedQuote.price,
    settlementModes: selected.selectedQuote.settlementModes,
  } : undefined,
  order: selected.order ? {
    orderId: selected.order.orderId,
    status: selected.order.status,
  } : undefined,
  ...paid,
}, null, 2));
