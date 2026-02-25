# Deploy Site on Cloudflare Pages

## Build settings

- Root directory: `site`
- Build command: `npm ci && npm run build`
- Build output directory: `dist`

## Steps

1. Create a new Cloudflare Pages project from this repo.
2. Set the build settings above.
3. Deploy.
4. Attach custom domain (for example `parad0xlabs.com`).
5. Optional: add `api.parad0xlabs.com` as separate origin for x402 server.

## Proof publishing flow

Before deploying new proof content:

```bash
cd x402
npm run publish:proof-bundle
cd ../site
npm run build
```

This updates `site/public/proof/latest/*` with stable file names used by `/proof`.
