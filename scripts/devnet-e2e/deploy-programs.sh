#!/bin/sh
# Deploy (or upgrade) a set of SBF programs with an exact --max-len and record
# the lamports each step costs. Used for the local-validator rehearsal and for
# the devnet run; the only differences are RPC_URL and the key paths.
#
# Env:
#   RPC_URL        cluster RPC (required)
#   DEPLOYER       fee payer and upgrade authority keypair (required)
#   PLAN           file with one line per program: <name> <so path> <program keypair or pubkey> [expected id]
#                  A keypair path deploys a new program; a pubkey upgrades an existing one.
#   OUT            JSON-lines evidence file (required)
#   MAX_LEN_EXTRA  bytes added to the .so size for --max-len (default 0: exact size)
set -eu
: "${RPC_URL:?}" "${DEPLOYER:?}" "${PLAN:?}" "${OUT:?}"
EXTRA="${MAX_LEN_EXTRA:-0}"
DEPLOYER_PK=$(solana-keygen pubkey "$DEPLOYER")
bal() { solana -u "$RPC_URL" balance "$DEPLOYER_PK" --lamports | awk '{print $1}'; }

while read -r name so prog expect; do
  case "$name" in ''|'#'*) continue ;; esac
  size=$(wc -c < "$so" | tr -d ' ')
  sha=$(shasum -a 256 "$so" | awk '{print $1}')
  maxlen=$((size + EXTRA))
  if [ -f "$prog" ]; then
    pid=$(solana-keygen pubkey "$prog")
    mode=deploy
  else
    pid="$prog"
    mode=upgrade
  fi
  if [ -n "${expect:-}" ] && [ "$pid" != "$expect" ]; then
    echo "ABORT: $name program key is $pid, expected $expect" >&2
    exit 1
  fi
  before=$(bal)
  t0=$(date +%s)
  if [ "$mode" = deploy ]; then
    sig=$(solana -u "$RPC_URL" program deploy "$so" --program-id "$prog" --max-len "$maxlen" \
      --upgrade-authority "$DEPLOYER" -k "$DEPLOYER" --use-rpc --output json | sed -n 's/.*"signature": *"\([^"]*\)".*/\1/p')
  else
    sig=$(solana -u "$RPC_URL" program deploy "$so" --program-id "$prog" \
      --upgrade-authority "$DEPLOYER" -k "$DEPLOYER" --use-rpc --output json | sed -n 's/.*"signature": *"\([^"]*\)".*/\1/p')
  fi
  t1=$(date +%s)
  after=$(bal)
  show=$(solana -u "$RPC_URL" program show "$pid" --output json)
  dlen=$(printf '%s' "$show" | sed -n 's/.*"dataLen": *\([0-9]*\).*/\1/p')
  plamports=$(printf '%s' "$show" | sed -n 's/.*"lamports": *\([0-9]*\).*/\1/p')
  auth=$(printf '%s' "$show" | sed -n 's/.*"authority": *"\([^"]*\)".*/\1/p')
  slot=$(printf '%s' "$show" | sed -n 's/.*"lastDeploySlot": *\([0-9]*\).*/\1/p')
  printf '{"name":"%s","mode":"%s","programId":"%s","so_bytes":%s,"so_sha256":"%s","max_len":%s,"data_len":"%s","programdata_lamports":"%s","authority":"%s","last_deploy_slot":"%s","deployer_before":%s,"deployer_after":%s,"spent_lamports":%s,"seconds":%s,"signature":"%s"}\n' \
    "$name" "$mode" "$pid" "$size" "$sha" "$maxlen" "$dlen" "$plamports" "$auth" "$slot" "$before" "$after" "$((before - after))" "$((t1 - t0))" "$sig" | tee -a "$OUT"
done < "$PLAN"
