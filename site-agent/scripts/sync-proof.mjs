import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..');
const docsFootprint = path.join(root, 'docs', 'FOOTPRINT.md');
const target = path.join(process.cwd(), 'src', 'data', 'proof.json');

const fallback = {
  txBytesSingle: 244,
  ixBytes: 34,
  batch32TxBytes: 1230,
  cuSingle: 13600,
  cuBatch32: 19434,
  verifiedDefinition: 'anchored on-chain + fulfilled + verified receipt',
};

let payload = { ...fallback };
if (fs.existsSync(docsFootprint)) {
  const content = fs.readFileSync(docsFootprint, 'utf8');
  const singleTx = content.match(/single[^\n]*?(\d{2,4})\s*bytes/i);
  const ixBytes = content.match(/instruction[^\n]*?(\d{1,3})\s*bytes/i);
  if (singleTx) {
    payload.txBytesSingle = Number.parseInt(singleTx[1], 10);
  }
  if (ixBytes) {
    payload.ixBytes = Number.parseInt(ixBytes[1], 10);
  }
}

fs.writeFileSync(target, JSON.stringify(payload, null, 2));
console.log(`synced proof data -> ${target}`);
