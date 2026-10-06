// Grades the transactions of an existing e2e script from the ledger.
// Reads a script's stdout log, extracts every transaction signature, reads each
// one back with getTransaction (err, logs, CU, fee) and writes evidence JSON.
//
//   RPC_URL=... PROGRAM_ID=<id> SINCE_SLOT=<slot> \
//   node scripts/devnet-e2e/grade-log.mjs <name> <log file> [exit code] [account to check closed ...]
//
// With PROGRAM_ID, every transaction that touched the program since SINCE_SLOT
// (getSignaturesForAddress) is read back too, so scripts that print no
// signature are still graded from the ledger; failures among those are
// recorded (a script may test a rejection on chain) and counted.
// The run passes when the script exited 0, at least one program transaction
// landed without error, every signature the script printed landed without
// error, and every listed account no longer exists (or holds 0 lamports).

import { readFileSync } from "node:fs";
import * as L from "./lib.mjs";

const [name, logFile, exitCode = "0", ...mustBeClosed] = process.argv.slice(2);
if (!name || !logFile) throw new Error("usage: grade-log.mjs <name> <log file> [exit code] [accounts...]");
const text = readFileSync(logFile, "utf8");
const printed = [...new Set(text.match(/\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g) ?? [])];
const PROGRAM_ID = process.env.PROGRAM_ID;
const since = BigInt(process.env.SINCE_SLOT ?? 0);
const fromProgram = [];
if (PROGRAM_ID) {
  const page = await L.rpc("getSignaturesForAddress", [PROGRAM_ID, { limit: 1000, commitment: "confirmed" }]);
  for (const x of page.reverse()) if (BigInt(x.slot) >= since && !printed.includes(x.signature)) fromProgram.push(x.signature);
}
const sigs = [...printed, ...fromProgram];
const ev = new L.Evidence(name, { source: logFile, scriptExit: Number(exitCode), programId: PROGRAM_ID, sinceSlot: since, printedSignatures: printed.length, programSignatures: fromProgram.length });
ev.check(`${name}: script exited 0`, exitCode === "0", { exit: exitCode });
ev.check(`${name}: transactions found on the ledger`, sigs.length > 0, { printed: printed.length, program: fromProgram.length });
const cu = {};
let okCount = 0;
let failedOnChain = 0;
for (const s of sigs) {
  let g;
  try {
    g = await L.readTx(s);
  } catch (e) {
    ev.check(`${name}: ${s.slice(0, 12)} found on the ledger`, false, { error: String(e.message ?? e) });
    continue;
  }
  const label = (g.logs.find((l) => /^Program log: /.test(l)) ?? "tx").replace(/^Program log: /, "").slice(0, 80);
  ev.step(label, g, { keepLogs: true, printedByScript: printed.includes(s) });
  if (g.err === null) okCount++;
  else failedOnChain++;
  if (printed.includes(s)) ev.check(`${name}: ${s.slice(0, 12)} (${label})`, g.err === null, { cu: g.cu, fee: g.fee, err: g.err });
  else console.log(`${g.err === null ? "ok  " : "err "} ${s.slice(0, 12)} ${label} cu=${g.cu} fee=${g.fee}${g.err ? " " + JSON.stringify(g.err) : ""}`);
  for (const x of g.ixCu) (cu[label] ??= []).push(x.cu);
}
for (const a of mustBeClosed) {
  const acc = await L.getAccount(a);
  ev.check(`${name}: account ${a} closed`, !acc || acc.lamports === 0n, { lamports: acc?.lamports ?? 0n });
}
ev.check(`${name}: at least one transaction succeeded on chain`, okCount > 0, { ok: okCount, failedOnChain });
ev.doc.summary = { transactions: sigs.length, ok: okCount, failedOnChain };
ev.doc.cuByStep = cu;
ev.save(`${name}.json`);
process.exit(ev.failures ? 1 : 0);
