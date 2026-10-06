#!/bin/sh
# Runs the six Dark NULL integration e2e scripts (Dark-Null-Protocol
# scripts/e2e-*.mjs) and grades every transaction they print from the ledger.
#
# Env:
#   RPC_URL       cluster RPC (the scripts read RPC_URL; unpatched copies use devnet)
#   DN_DIR        Dark-Null-Protocol checkout (or a copy) with the program ids in
#                 programs/<name>/.program-id and node_modules available
#   HOME          must hold .config/solana/id.json (the funded payer the scripts use)
#   EVIDENCE_DIR  output directory
set -u
: "${RPC_URL:?}" "${DN_DIR:?}" "${EVIDENCE_DIR:?}"
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$EVIDENCE_DIR"
fail=0
slot() { node -e 'fetch(process.env.RPC_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot",params:[{commitment:"confirmed"}]})}).then(r=>r.json()).then(j=>console.log(j.result))'; }
for n in accumulator fiat-oracle inference payment-stream silent-pay threshold-fed; do
  log="$EVIDENCE_DIR/darknull-$n.log"
  since=$(slot)
  (cd "$DN_DIR" && node "scripts/e2e-$n.mjs") > "$log" 2>&1
  code=$?
  pid=$(tr -d ' \n' < "$DN_DIR/programs/$n/.program-id")
  extra=""
  if [ "$n" = payment-stream ]; then
    extra=$(sed -n 's/^Channel PDA: \([1-9A-HJ-NP-Za-km-z]*\).*/\1/p' "$log" | head -1)
  fi
  PROGRAM_ID=$pid SINCE_SLOT=$since node "$HERE/grade-log.mjs" "darknull-$n" "$log" "$code" $extra > "$log.grade" 2>&1 || fail=1
  tail -1 "$log.grade"
  [ "$code" -eq 0 ] || fail=1
done
exit $fail
