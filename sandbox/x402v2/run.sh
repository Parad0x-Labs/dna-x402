#!/usr/bin/env bash
# Sandboxed pipeline: compile v1 (defect) + v2 (fix), single-party devnet setup, then run
# the held-out adversarial benchmark. Runs with no network. Mounts:
#   /mnt/circuits  (ro) — the .circom sources
#   /mnt/build     (ro) — build/zk/x402-access-harden-bench.mjs
#   /out           (rw) — artifacts + vk.json out
set -euo pipefail
cd /work
mkdir -p circuits build/zk out art/v1 art/v2
cp /mnt/circuits/x402_access.circom /mnt/circuits/x402_access_v2.circom circuits/
cp /mnt/build/zk/x402-access-harden-bench.mjs build/zk/

ENTROPY=$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')
SJ="node node_modules/snarkjs/build/cli.cjs"

echo "== powers-of-tau (pot14, generated locally — no download) =="
$SJ powersoftau new bn128 14 pot_0.ptau >/dev/null
$SJ powersoftau contribute pot_0.ptau pot_1.ptau --name=devnet -e="$ENTROPY" >/dev/null
$SJ powersoftau prepare phase2 pot_1.ptau pot.ptau >/dev/null
echo "   pot14 ready"

build_circuit () {
  local name=$1 outdir=$2
  echo "== compile $name =="
  circom "circuits/$name.circom" --r1cs --wasm --sym -l /work -o out/ | sed 's/^/   /'
  echo "== groth16 setup $name (single-party, devnet) =="
  $SJ groth16 setup "out/$name.r1cs" pot.ptau "out/${name}_0.zkey" >/dev/null
  $SJ zkey contribute "out/${name}_0.zkey" "out/${name}_final.zkey" --name="devnet-$name" -e="$ENTROPY-$name" >/dev/null
  $SJ zkey export verificationkey "out/${name}_final.zkey" "out/${name}_vk.json" >/dev/null
  cp "out/${name}_js/${name}.wasm" "$outdir/${name}.wasm"
  cp "out/${name}_final.zkey"      "$outdir/${name}_final.zkey"
  cp "out/${name}_vk.json"         "$outdir/${name}_vk.json"
  echo "   $name: $(grep -o 'non-linear constraints: [0-9]*' <<<"$(circom "circuits/$name.circom" --r1cs -l /work -o /tmp 2>&1)" || true) artifacts ready"
}
build_circuit x402_access    art/v1
build_circuit x402_access_v2 art/v2

echo ""
echo "== HELD-OUT ADVERSARIAL BENCHMARK =="
ART_V1=/work/art/v1 ART_V2=/work/art/v2 node build/zk/x402-access-harden-bench.mjs
rc=$?

# persist v2 VK for the on-chain gate step (task 6)
cp out/x402_access_v2_vk.json /out/ 2>/dev/null || true
cp -r art /out/art 2>/dev/null || true
exit $rc
