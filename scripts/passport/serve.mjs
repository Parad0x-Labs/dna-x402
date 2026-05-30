#!/usr/bin/env node
// Tiny static server for the Face ID browser test page.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8799);
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json" };

createServer(async (req, res) => {
  let path = decodeURIComponent((req.url || "/").split("?")[0]);
  if (path === "/" || path === "") path = "/faceid-browser-test.html";
  try {
    const body = await readFile(join(DIR, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`\nFace ID test page:  http://localhost:${PORT}/faceid-browser-test.html`);
  console.log("Open it with Phantom set to DEVNET. Ctrl+C to stop.\n");
});
