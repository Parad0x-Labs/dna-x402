# dark_secp256k1_auth: ETH address to Solana agent binding

Source: [`programs/dark_secp256k1_auth/`](../programs/dark_secp256k1_auth/). Devnet:
`7dF2fZgPc9nzSwYroNzUtZGsFTzSbiKsVykcYLc7eiWu` (`ethAuth` in
[`configs/devnet.oss.json`](../configs/devnet.oss.json)), built from `aabb759`, upgraded in place on 2026-10-06
(tx `23ddExeQE77PMdDMfbWzG5KUUjNUSkj8ZcHETk97z7a7VFWH7AbR7vYPi7VD4t2bjar4ghetbtZvVgrwi9phiQP5`, slot 508063592),
deployed bytes SHA-256 `3af9a00dd6ab9d7110da4b4c293a89633c702211f09d9af2ba0469b3f13457b3`
([`evidence/devnet-programs-2026-10-06.json`](../evidence/devnet-programs-2026-10-06.json)). There is no mainnet
deployment; the mainnet pilot ID `AqwBbV13…` was retired on 2026-07-14.

`RegisterEthAgent` creates the record PDA `["eth-agent", eth_address]` that binds one ETH address to one Solana
agent key. The ETH key signs a message that names the program and the agent, and the secp256k1 precompile at
transaction index 0 verifies that signature. The program rebuilds the message and requires the verified message
to equal it, so a signature made for one agent, program or domain cannot register the address for another.

## Binding message (EIP-191 `personal_sign`)

The ETH key signs `body` with `personal_sign`, so MetaMask and other wallets produce the signature directly. The
precompile message is:

```text
"\x19Ethereum Signed Message:\n" || decimal(len(body)) || body
```

`body` is six lines separated by `\n`, with no trailing newline:

```text
dark-secp256k1-auth v1: bind ETH address to Solana agent
program: <base58 program id>
agent: <base58 agent signer>
eth: 0x<ETH address, 20 bytes, lowercase hex>
domain: <domain_hash, lowercase hex>
auth: <auth_hash, lowercase hex>
```

| Line | Value the program uses |
|---|---|
| domain tag | the constant first line (`binding::DOMAIN_TAG`) |
| `program` | the executing program id |
| `agent` | account 1 of the instruction, which must sign the transaction |
| `eth` | the last 20 bytes of `pda_seed` |
| `domain` | `domain_hash` from the instruction, SHA-256 of the domain string |
| `auth` | `auth_hash` from the instruction, SHA-256(`pda_seed` \|\| `"commitment"`) |

`msg_hash` in the instruction must be keccak256 of the precompile-verified message. The reference builders are
[`programs/dark_secp256k1_auth/src/binding.rs`](../programs/dark_secp256k1_auth/src/binding.rs) and, for
clients, [`scripts/passport/lib/eth-agent.mjs`](../scripts/passport/lib/eth-agent.mjs) and the
`null-miner-sdk` identity module (`ETH_AGENT_BINDING_TAG`, `ethPersonalSignMessageBytes`).

### RegisterEthAgent instruction data (194 bytes)

| Offset | Field |
|---|---|
| 0 | discriminant `0x01` |
| 1..33 | `r` |
| 33..65 | `s` |
| 65 | `recovery_id` (0 or 1) |
| 66..98 | `msg_hash` |
| 98..130 | `pda_seed` (last 20 bytes = ETH address) |
| 130..162 | `auth_hash` |
| 162..194 | `domain_hash` |

Accounts: record PDA (writable), agent signer (signer, writable), system program, instructions sysvar.

## Error codes

| Code | Name | Meaning |
|---|---|---|
| 0x5001 | InvalidSignature | the precompile-verified signature differs from `r`/`s`/`recovery_id` |
| 0x5002 | AgentAlreadyRegistered | a record already exists for this ETH address |
| 0x5003 | AddressMismatch | the recovered address does not match `pda_seed` |
| 0x5004 | InvalidInstruction | malformed data or unknown discriminant |
| 0x5005 | AgentNotFound | no record for the ETH address |
| 0x5006 | NotOwner | the caller is not the stored agent key |
| 0x5007 | MalformedPrecompile | the secp256k1 precompile data is malformed |
| 0x5008 | EthAddressMismatch | the precompile-verified ETH address is not the one in `pda_seed` |
| 0x5009 | MessageMismatch | `msg_hash` is not keccak256 of the verified message |
| 0x500A | BindingMessageMismatch | the verified message is not the binding message for this program, agent signer, ETH address, `domain_hash` and `auth_hash` |

0x500A covers a signature replayed by another Solana key and the earlier bare 32-byte message format.

## Devnet runs

Rerun 2 on 2026-10-06 ([`evidence/devnet-2026-10-06/`](../evidence/devnet-2026-10-06/README.md)):

- passport 03, 10/10: register; wrong ETH address 0x5008; `msg_hash` mismatch 0x5009; a funded second Solana key
  replaying the first agent's signature is refused with 0x500A and no record is created; the intended agent then
  registers the same address; the legacy 32-byte message is refused with 0x500A
  ([`dna-passport-03-metamask-rerun2.json`](../evidence/devnet-2026-10-06/dna-passport-03-metamask-rerun2.json));
- bv7x ETH passport, 1/1, using the same message builder
  ([`dna-bv7x-eth-passport-rerun2.json`](../evidence/devnet-2026-10-06/dna-bv7x-eth-passport-rerun2.json)).

Program tests: [`tests/precompile_binding.rs`](../programs/dark_secp256k1_auth/tests/precompile_binding.rs)
covers a signature replayed for another agent, another program id, altered domain and auth hashes, and the
legacy format.
