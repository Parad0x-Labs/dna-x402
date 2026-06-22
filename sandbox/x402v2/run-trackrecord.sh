#!/usr/bin/env bash
# Sandboxed recompile + single-party devnet setup for track_record (epoch now PUBLIC).
# Emits a fresh track_record_vk.json (nPublic must be 7). Runs with --network none.
# Mounts: /mnt/circuits (ro) the .circom, /out (rw) the vk json.
set -euo pipefail
cd /work
mkdir -p circuits out
cp /mnt/circuits/track_record.circom circuits/

ENTROPY=$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')
SJ="node node_modules/snarkjs/build/cli.cjs"

echo "== compile track_record =="
circom circuits/track_record.circom --r1cs --wasm --sym -l /work -o out/ | sed 's/^/   /'

echo "== powers-of-tau (pot15, local, no download) =="
$SJ powersoftau new bn128 15 pot_0.ptau >/dev/null
$SJ powersoftau contribute pot_0.ptau pot_1.ptau --name=devnet -e="$ENTROPY" >/dev/null
$SJ powersoftau prepare phase2 pot_1.ptau pot.ptau >/dev/null
echo "   pot15 ready"

echo "== groth16 setup (single-party, devnet pilot — NOT trustless) =="
$SJ groth16 setup out/track_record.r1cs pot.ptau out/track_record_0.zkey >/dev/null
$SJ zkey contribute out/track_record_0.zkey out/track_record_final.zkey --name=devnet-tr -e="$ENTROPY-tr" >/dev/null
$SJ zkey export verificationkey out/track_record_final.zkey out/track_record_vk.json >/dev/null

node -e "const vk=require('/work/out/track_record_vk.json'); console.log('   VK nPublic:', vk.nPublic, ' IC entries:', vk.IC.length); if(vk.nPublic!==7){console.error('EXPECTED nPublic=7');process.exit(1)}"
cp out/track_record_vk.json /out/
echo "DONE — vk.json (nPublic=7) in /out"
