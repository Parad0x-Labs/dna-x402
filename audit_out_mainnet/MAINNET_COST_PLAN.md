# MAINNET COST PLAN

## Inputs
- Cluster: mainnet-beta
- Source: RPC-backed `solana rent` queries
- ProgramData bytes:
  - pdx_dark_protocol: 178440
  - receipt_anchor: 85496

## Exact Rent (ProgramData)
- pdx_dark_protocol: 1242833280 lamports (1.242833280 SOL)
- receipt_anchor: 595943040 lamports (0.595943040 SOL)
- Total ProgramData rent deposit: 1838776320 lamports (1.838776320 SOL)

## Deploy Contingency
- Temporary buffer contingency (one buffer per program):
  - pdx_dark_protocol buffer: 1242833280 lamports
  - receipt_anchor buffer: 595943040 lamports
- Transaction fee budget (estimate): 500000 lamports
- Total with contingency: 3678052640 lamports (3.678052640 SOL)

## Reclaimability
- Reclaimable:
  - Deploy buffers (close immediately after deploy).
- Not reclaimable while program remains live:
  - ProgramData rent deposits.
- Destructive reclaim (break-glass only):
  - Closing a program recovers deposit but permanently disables that program id.

## Break-Glass Commands
`solana program show <PROGRAM_ID> -u mainnet-beta`
`solana program close --buffers -u mainnet-beta`
`solana program close <PROGRAM_ID> -u mainnet-beta --bypass-warning`
