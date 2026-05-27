#!/usr/bin/env bash
set -euo pipefail

export DNA_TOOLS_ROOT="/mnt/g/DNA x402/.tools/wsl"
export PLAYWRIGHT_BROWSERS_PATH="/mnt/g/DNA x402/.tools/wsl/playwright-browsers"
export npm_config_cache="/mnt/g/DNA x402/.tools/wsl/npm-cache"
export CARGO_HOME="/mnt/g/DNA x402/.tools/wsl/cargo"
export RUSTUP_HOME="/mnt/g/DNA x402/.tools/wsl/rustup"
export PATH="/mnt/g/DNA x402/.tools/wsl/node-v22.21.1-linux-x64/bin:${CARGO_HOME}/bin:$PATH"
