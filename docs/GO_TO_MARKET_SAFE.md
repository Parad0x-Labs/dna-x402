# Go-To-Market (Safe)

## Positioning
- SAFE categories only: `ai_inference`, `image_generation`, `data_enrichment`, `workflow_tool`.
- Wallet-native account model: wallet address is identity, no email/password.
- Seller-defined logic, verifiable payment rails.

## Hard blocks
- Server blocks publish when category is outside SAFE enum.
- Server blocks denylist terms (vpn/proxy/remote desktop/malware/betting patterns).
- Disabled shops are not routable.

## Local launch flow
1. `cd x402 && npm run dev:market`
2. `cd wallet && npm run dev`
3. `cd site-agent && npm run dev`

## Build for /agent
- `npm run site-agent:build` from repo root.
- Host `site-agent/dist/` at `parad0xlabs.com/agent`.
