#!/usr/bin/env node
// Hardened static server for the Face ID / passkey test pages.
//
// SECURITY: serves ONLY an explicit whitelist of pages, each read once at
// startup. No per-request filesystem access and no path joining from user
// input — safe to expose via a tunnel; it cannot return any other host file.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);

const chrome  = readFileSync(join(DIR, "faceid-chrome-test.html"));
const phantom = readFileSync(join(DIR, "faceid-browser-test.html"));
const prfEd25519 = readFileSync(join(DIR, "05-prf-ed25519-browser-test.html"));

// path -> in-memory page. The Chrome (no-wallet) page is the default.
const ROUTES = {
  "/": chrome,
  "/faceid-chrome-test.html": chrome,
  "/faceid-browser-test.html": phantom,
  "/05-prf-ed25519-browser-test.html": prfEd25519,
  "/prf": prfEd25519,
};

createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  const path = (req.url || "/").split("?")[0];
  const page = ROUTES[path];
  if (page) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, () => {
  console.log(`\nDefault (Chrome, no wallet):  http://localhost:${PORT}/`);
  console.log(`Phantom version:              http://localhost:${PORT}/faceid-browser-test.html`);
  console.log(`PRF → Ed25519 (no MPC):       http://localhost:${PORT}/prf`);
  console.log("Safe to tunnel — only these whitelisted pages are served.\n");
});
