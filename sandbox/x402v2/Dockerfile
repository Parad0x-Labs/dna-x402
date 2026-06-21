# Sandboxed ZK toolchain for the x402 access-gate hardening (build-host ≠ key-host).
# Native arch (arm64 on Apple Silicon). circom is built from source (no arm64 prebuilt);
# snarkjs/circomlib/poseidon-lite are pure JS. Network used ONLY at build; the grade runs
# with `docker run --network none` and the container never sees host keys.

# ── stage 1: build circom from source (pinned) ──────────────────────────────────────
FROM rust:1-bookworm AS circom
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v2.1.9 https://github.com/iden3/circom.git /src \
    && cd /src && cargo build --release \
    && install -m0755 target/release/circom /usr/local/bin/circom

# ── stage 2: node + circom + JS ZK deps ─────────────────────────────────────────────
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends xxd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=circom /usr/local/bin/circom /usr/local/bin/circom
RUN circom --version
WORKDIR /work
RUN npm init -y >/dev/null 2>&1 \
    && npm install --ignore-scripts --no-audit --no-fund \
       circomlib@2.0.5 poseidon-lite@0.3.0 snarkjs@0.7.5 @solana/web3.js@1.95.3
COPY run.sh /work/run.sh
ENTRYPOINT ["bash", "/work/run.sh"]
