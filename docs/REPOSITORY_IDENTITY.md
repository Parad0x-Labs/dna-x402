# Repository Identity

Canonical public repository:

```txt
https://github.com/Parad0x-Labs/dna-x402
```

Legacy mirror:

```txt
https://github.com/Parad0x-Labs/x402-dna
```

Use `dna-x402` for public links, package metadata, builder docs, issue references, and install instructions.

`x402-dna` exists only as a legacy mirror for older internal handoffs and remote continuity. Its `main` branch should mirror the canonical `dna-x402` main branch. New public docs must not direct users to `x402-dna`.

## Required Public Commands

```bash
git clone https://github.com/Parad0x-Labs/dna-x402
cd dna-x402/x402
npm ci
npm run build
npm test
npx --no-install dna-x402
```

## Related Public Repos

- Dark Null Protocol: `https://github.com/Parad0x-Labs/Dark-Null-Protocol`
- DNA x402 Builders: `https://github.com/Parad0x-Labs/dna-x402-builders`
