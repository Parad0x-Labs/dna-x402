# site-agent

Static front door for `parad0xlabs.com/agent`.

## Commands
- `npm run dev`
- `npm run build`
- `npm run preview`
- `npm run proof:sync`
- `npm run test`

## Base path
Vite base and router basename are set to `/agent`, so built assets work when hosted under `/agent`.

## Routes
- `/agent`
- `/agent/control-room`
- `/agent/how-it-works`
- `/agent/proof`
- `/agent/start`

## Runtime overrides
- Set defaults in `.env.local` (sample in `.env.example`)
- Use the runtime gear on Control Room to override `x402BaseUrl`, `cluster`, `walletUrl`, and poll interval without rebuild.
