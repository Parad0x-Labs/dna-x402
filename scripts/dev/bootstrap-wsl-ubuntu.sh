#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TOOLS_ROOT="${REPO_ROOT}/.tools/wsl"
CACHE_ROOT="${TOOLS_ROOT}/cache"
PLAYWRIGHT_BROWSERS="${TOOLS_ROOT}/playwright-browsers"
NPM_CACHE="${TOOLS_ROOT}/npm-cache"
NODE_VERSION="${NODE_VERSION:-22.21.1}"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
NODE_ARCHIVE="${CACHE_ROOT}/${NODE_DIST}.tar.xz"
NODE_ROOT="${TOOLS_ROOT}/${NODE_DIST}"
USE_TOOLS="${SCRIPT_DIR}/use-tools-wsl.sh"
APT_WAIT_TIMEOUT_SEC="${APT_WAIT_TIMEOUT_SEC:-300}"
APT_WAIT_SLEEP_SEC="${APT_WAIT_SLEEP_SEC:-5}"
RUN_VERIFY=0

for arg in "$@"; do
  case "$arg" in
    --verify)
      RUN_VERIFY=1
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

step() {
  echo
  echo "==> $1"
}

wait_for_apt() {
  local deadline=$((SECONDS + APT_WAIT_TIMEOUT_SEC))
  local lock_files=(
    /var/lib/dpkg/lock-frontend
    /var/lib/dpkg/lock
    /var/lib/apt/lists/lock
    /var/cache/apt/archives/lock
  )
  local has_fuser=0

  if command -v fuser >/dev/null 2>&1; then
    has_fuser=1
  fi

  show_blockers() {
    if (( has_fuser == 0 )); then
      echo "apt/dpkg lock timeout reached; install psmisc for precise lock holder reporting" >&2
      ps -ef | grep -E 'apt|dpkg|unattended' | grep -v grep >&2 || true
      return
    fi

    local pids=()
    local lock_file
    for lock_file in "${lock_files[@]}"; do
      if [[ -e "${lock_file}" ]]; then
        while IFS= read -r pid; do
          [[ -n "${pid}" ]] && pids+=("${pid}")
        done < <(fuser "${lock_file}" 2>/dev/null | tr ' ' '\n' | sed '/^$/d')
      fi
    done

    if (( ${#pids[@]} == 0 )); then
      echo "apt/dpkg lock timeout reached, but no active lock holder was found" >&2
      return
    fi

    echo "apt/dpkg lock timeout reached; blocking processes:" >&2
    ps -fp "$(printf '%s,' "${pids[@]}" | sed 's/,$//')" >&2 || true
  }

  while true; do
    if (( has_fuser == 1 )); then
      if ! fuser "${lock_files[@]}" >/dev/null 2>&1; then
        return 0
      fi
    elif ! pgrep -x apt >/dev/null 2>&1 \
      && ! pgrep -x apt-get >/dev/null 2>&1 \
      && ! pgrep -x dpkg >/dev/null 2>&1 \
      && ! pgrep -x unattended-upgr >/dev/null 2>&1; then
      return 0
    fi

    if (( SECONDS >= deadline )); then
      show_blockers
      return 1
    fi

    echo "waiting for apt/dpkg lock holders to exit..."
    sleep "${APT_WAIT_SLEEP_SEC}"
  done
}

retry() {
  local attempts="$1"
  shift
  local try=1
  until "$@"; do
    if (( try >= attempts )); then
      return 1
    fi
    echo "retry ${try}/${attempts} failed; sleeping before retry..."
    sleep 10
    try=$((try + 1))
    wait_for_apt
  done
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

mkdir -p "${TOOLS_ROOT}" "${CACHE_ROOT}" "${PLAYWRIGHT_BROWSERS}" "${NPM_CACHE}"

step "Installing Ubuntu prerequisites"
wait_for_apt
sudo env DEBIAN_FRONTEND=noninteractive apt-get update
wait_for_apt
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl build-essential pkg-config psmisc python3 xz-utils git

step "Installing Rust with rustup"
export CARGO_HOME="${TOOLS_ROOT}/cargo"
export RUSTUP_HOME="${TOOLS_ROOT}/rustup"
export PATH="${CARGO_HOME}/bin:${PATH}"
if ! command -v cargo >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y --no-modify-path
fi

step "Installing local Node ${NODE_VERSION}"
if [[ ! -x "${NODE_ROOT}/bin/node" ]]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz" -o "${NODE_ARCHIVE}"
  rm -rf "${NODE_ROOT}"
  tar -xJf "${NODE_ARCHIVE}" -C "${TOOLS_ROOT}"
fi

cat > "${USE_TOOLS}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export CODEX_DNA_TOOLS_ROOT="${TOOLS_ROOT}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS}"
export npm_config_cache="${NPM_CACHE}"
export CARGO_HOME="${TOOLS_ROOT}/cargo"
export RUSTUP_HOME="${TOOLS_ROOT}/rustup"
export PATH="${NODE_ROOT}/bin:\${CARGO_HOME}/bin:\$PATH"
EOF
chmod +x "${USE_TOOLS}"
source "${USE_TOOLS}"

step "Checking toolchain"
require_command node
require_command npm
require_command npx
require_command cargo
require_command rustc
node -v
npm -v
rustc -V
cargo -V

step "Installing workspace dependencies"
( cd "${REPO_ROOT}/x402" && npm ci --no-audit --no-fund )
( cd "${REPO_ROOT}/site-agent" && npm ci --no-audit --no-fund )

step "Installing Playwright browsers"
wait_for_apt
(
  cd "${REPO_ROOT}/site-agent"
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS}" retry 3 npx playwright install-deps chromium
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS}" npx playwright install chromium
)

if [[ "${RUN_VERIFY}" == "1" ]]; then
  step "Running cumulative verification"
  "${SCRIPT_DIR}/verify-wsl-ubuntu.sh"
fi

step "Bootstrap complete"
echo "Source ${USE_TOOLS} in WSL shells before running repo commands."
