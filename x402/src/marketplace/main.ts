import "dotenv/config";
import { createMarketplaceApp } from "./server.js";

function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARKETPLACE_PORT ?? env.PORT ?? "8090";
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid MARKETPLACE_PORT/PORT value: ${raw}`);
  }
  return port;
}

export async function startMarketplaceServer(): Promise<void> {
  const port = resolvePort();
  const { app } = createMarketplaceApp();
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`x402 marketplace listening on http://localhost:${port}`);
      resolve();
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMarketplaceServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
