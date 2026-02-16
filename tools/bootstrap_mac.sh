#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

install_rust() {
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    echo "Rust/Cargo already installed"
    return
  fi
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
}

install_solana() {
  if command -v solana >/dev/null 2>&1; then
    echo "Solana CLI already installed"
    return
  fi
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
}

install_nvm_node() {
  export NVM_DIR="$HOME/.nvm"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm alias default 20
}

persist_shell_paths() {
  touch "$HOME/.zprofile"
  if ! grep -q '\. "$HOME/.cargo/env"' "$HOME/.zprofile"; then
    echo '. "$HOME/.cargo/env"' >> "$HOME/.zprofile"
  fi
  if ! grep -q 'solana/install/active_release/bin' "$HOME/.zprofile"; then
    echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.zprofile"
  fi
  if ! grep -q 'NVM_DIR="$HOME/.nvm"' "$HOME/.zprofile"; then
    cat >> "$HOME/.zprofile" <<'EOF'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
EOF
  fi
  if ! grep -q 'Library/Python/3.9/bin' "$HOME/.zprofile"; then
    echo 'export PATH="$HOME/Library/Python/3.9/bin:$PATH"' >> "$HOME/.zprofile"
  fi
}

install_python_deps() {
  python3 -m pip install --user --upgrade \
    pip setuptools wheel pytest pytest-asyncio solders solana zstandard
}

install_project_deps() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 20 >/dev/null

  npm install --prefix "$ROOT_DIR/circuits"
  npm install --prefix "$ROOT_DIR/extension"
  PUPPETEER_SKIP_DOWNLOAD=1 npm install --prefix "$ROOT_DIR/wallet" --no-audit --no-fund
}

configure_solana_keys() {
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
  mkdir -p "$HOME/.config/solana"
  [[ -f "$HOME/.config/solana/devnet-deployer.json" ]] || \
    solana-keygen new --silent --no-bip39-passphrase --outfile "$HOME/.config/solana/devnet-deployer.json"
  [[ -f "$HOME/.config/solana/mainnet-deployer.json" ]] || \
    solana-keygen new --silent --no-bip39-passphrase --outfile "$HOME/.config/solana/mainnet-deployer.json"
  solana config set \
    --url https://api.devnet.solana.com \
    --keypair "$HOME/.config/solana/devnet-deployer.json" \
    --commitment confirmed >/dev/null
}

main() {
  install_rust
  install_solana
  install_nvm_node
  persist_shell_paths
  install_python_deps
  install_project_deps
  configure_solana_keys

  export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
  echo "=== Toolchain Ready ==="
  rustc --version
  cargo --version
  solana --version
  node -v
  npm -v
  python3 --version
}

main "$@"

