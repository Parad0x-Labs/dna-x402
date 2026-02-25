function pretty(value) {
  return JSON.stringify(value, null, 2);
}

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return response.json();
}

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return response.text();
}

async function main() {
  const programmabilityEl = document.getElementById('programmability');
  const singleBytesEl = document.getElementById('singleBytes');
  const batchBytesEl = document.getElementById('batchBytes');
  const fastVerifiedEl = document.getElementById('fastVerified');
  const statusBox = document.getElementById('statusBox');

  try {
    const data = await readJson('/proof/latest/programmable_devnet.json');
    singleBytesEl.textContent = String(data.txMetrics?.singleBytes ?? '-');
    batchBytesEl.textContent = String(data.txMetrics?.batch32Bytes ?? '-');
    fastVerifiedEl.textContent = `${data.invariants?.fastCount ?? '-'} / ${data.invariants?.verifiedCount ?? '-'}`;
    programmabilityEl.textContent = pretty({
      generatedAt: data.generatedAt,
      overallPass: data.overallPass,
      verifiedDefinition: data.invariants?.verifiedDefinition,
      primitives: (data.primitives || []).map((row) => ({
        primitiveId: row.primitiveId,
        pass: row.pass,
        paymentTxSignature: row.paymentTxSignature,
        anchorTxSignature: row.anchorTxSignature,
      })),
    });
  } catch (error) {
    programmabilityEl.textContent = `Failed to load programmable_devnet.json: ${String(error)}`;
  }

  const params = new URLSearchParams(window.location.search);
  const apiBase = params.get('api');
  if (!apiBase) {
    return;
  }

  try {
    const status = await readJson(`${apiBase.replace(/\/$/, '')}/status`);
    statusBox.textContent = pretty(status);
  } catch (error) {
    statusBox.textContent = `Failed to load /status from API: ${String(error)}`;
  }

  try {
    await readText('/proof/latest/footprint.md');
  } catch {
    // optional for now
  }
}

main();
