#!/usr/bin/env node
// Hardened static server for the Face ID browser test page.
//
// SECURITY: serves ONLY the single test page, loaded once at startup. There is
// no per-request filesystem access and no path joining from user input, so this
// is safe to expose via a tunnel — it cannot return any other file on the host.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);
const PAGE = readFileSync(join(DIR, "faceid-browser-test.html")); // read ONCE, in-memory

createServer((req, res) => {
  // Always return the single page (or 404 for favicon etc.). No fs access per request.
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  const path = (req.url || "/").split("?")[0];
  if (path === "/" || path === "/faceid-browser-test.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, () => {
  console.log(`\nFace ID test page (single-file, hardened):  http://localhost:${PORT}/`);
  console.log("Safe to tunnel — this server can only ever return that one page.\n");
});
