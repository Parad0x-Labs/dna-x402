/**
 * NULL Miner Task Marketplace API — Server entrypoint
 *
 * Run with: tsx src/index.ts  OR  npm start
 * For tests use src/app.ts directly (no listen).
 */

import app from "./app.js";

const PORT = process.env["PORT"] ?? 3742;

app.listen(PORT, () => {
  console.log(`[NullMiner Marketplace] Listening on http://localhost:${PORT}`);
  console.log(`[NullMiner Marketplace] GET /tasks — agents connect here`);
  console.log(`[NullMiner Marketplace] Task pool auto-refreshes every 5 min`);
});
