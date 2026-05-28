import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "./manifest.json",
      webExtConfig: {
        startUrl: ["https://api.devnet.solana.com"],
      },
    }),
  ],
  build: {
    outDir: "dist",
    minify: true,
    sourcemap: false,
  },
});
