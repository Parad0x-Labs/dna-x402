// Writes throwaway keypair files (Solana CLI format, mode 600) for the e2e
// wallets that only need to exist for one run: payees, buyers, entrants.
// Existing files are kept, so a rerun reuses the same wallets.
//
//   node scripts/devnet-e2e/make-keys.mjs <dir> <name> [name ...]

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshKey, keyFromSecret } from "./lib.mjs";
import { readFileSync } from "node:fs";

const [dir, ...names] = process.argv.slice(2);
if (!dir || names.length === 0) throw new Error("usage: make-keys.mjs <dir> <name> [name ...]");
mkdirSync(dir, { recursive: true });
for (const n of names) {
  const p = join(dir, `${n}.json`);
  if (!existsSync(p)) {
    const k = freshKey();
    writeFileSync(p, JSON.stringify([...k.secretKey]));
    chmodSync(p, 0o600);
  }
  console.log(`${n} ${keyFromSecret(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")))).pk}`);
}
