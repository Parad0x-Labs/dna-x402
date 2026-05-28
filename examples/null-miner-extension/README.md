# null-miner-extension

> **Reference client** — Chrome/Firefox browser extension powered by `null-miner-sdk`.
>
> This is an example integration, not part of the core SDK. Use it as a starting
> point for building browser-based mining agents.

## Status

Devnet reference client. Not published to Chrome Web Store.

## What it does

Runs the `null-miner-sdk/browser` agent loop in a Chrome Extension Manifest V3
service worker. Users earn USDC passively while browsing. Shows earnings in a
dark minimal popup.

## Build

```bash
npm install
npm run build    # outputs to dist/
```

Load `dist/` as an unpacked extension in Chrome:
`chrome://extensions` → Developer mode → Load unpacked → select `dist/`

## Architecture

```
src/background/worker.ts    Service worker — runs AgentLoop
src/popup/index.html        Popup UI — earnings, tier, toggle
src/popup/app.ts            Popup logic — polls background for stats
```

## Core SDK

The agent logic lives in [`null-miner-sdk`](../../packages/null-miner-sdk) —
this extension is just a shell that wraps it for the browser extension context.
Install the SDK in your own app:

```bash
npm install null-miner-sdk
```
