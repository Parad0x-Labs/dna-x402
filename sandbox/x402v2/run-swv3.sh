#!/usr/bin/env bash
# Sandboxed differential pipeline — shielded_withdraw_v3 hardening.
# Compiles the VULN (git HEAD) + FIXED circuits, single-party devnet setup for each
# (shared ptau), then runs the held-out adversarial benchmark. Runs with --network none;
# the container never sees host keys. Mounts:
#   /mnt/fixed (ro) — fixed shielded_withdraw_v3.circom
#   /mnt/vuln  (ro) — vulnerable (HEAD) shielded_withdraw_v3.circom
#   /mnt/build (ro) — build/zk/shielded-withdraw-harden-bench.mjs
#   /out       (rw) — artifacts + fixed VK out
set -euo pipefail
cd /work
mkdir -p circuits build/zk out art/fixed art/vuln
cp /mnt/fixed/shielded_withdraw_v3.circom circuits/shielded_withdraw_v3_fixed.circom
cp /mnt/vuln/shielded_withdraw_v3.circom  circuits/shielded_withdraw_v3_vuln.circom
cp /mnt/build/zk/shielded-withdraw-harden-bench.mjs build/zk/

ENTROPY=$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')
SJ="node node_modules/snarkjs/build/cli.cjs"

echo "== powers-of-tau (pot14, generated locally — no download) =="
$SJ powersoftau new bn128 14 pot_0.ptau >/dev/null
$SJ powersoftau contribute pot_0.ptau pot_1.ptau --name=devnet -e="$ENTROPY" >/dev/null
$SJ powersoftau prepare phase2 pot_1.ptau pot.ptau >/dev/null
echo "   pot14 ready"

build_circuit () {
  local src=$1 outdir=$2
  echo "== compile $src =="
  circom "circuits/$src.circom" --r1cs --wasm --sym -l /work -o out/ | sed 's/^/   /'
  echo "== groth16 setup $src (single-party, devnet) =="
  $SJ groth16 setup "out/$src.r1cs" pot.ptau "out/${src}_0.zkey" >/dev/null
  $SJ zkey contribute "out/${src}_0.zkey" "out/${src}_final.zkey" --name="devnet-$src" -e="$ENTROPY-$src" >/dev/null
  $SJ zkey export verificationkey "out/${src}_final.zkey" "out/${src}_vk.json" >/dev/null
  cp "out/${src}_js/${src}.wasm" "$outdir/shielded_withdraw_v3.wasm"
  cp "out/${src}_final.zkey"     "$outdir/shielded_withdraw_v3_final.zkey"
  cp "out/${src}_vk.json"        "$outdir/shielded_withdraw_v3_vk.json"
}
build_circuit shielded_withdraw_v3_fixed art/fixed
build_circuit shielded_withdraw_v3_vuln  art/vuln

echo ""
echo "== HELD-OUT DIFFERENTIAL BENCHMARK =="
set +e
ART_FIXED=/work/art/fixed ART_VULN=/work/art/vuln node build/zk/shielded-withdraw-harden-bench.mjs
rc=$?
set -e

cp out/shielded_withdraw_v3_fixed_vk.json /out/shielded_withdraw_v3_vk.json 2>/dev/null || true
cp -r art /out/art 2>/dev/null || true
exit $rc
