#!/usr/bin/env bash
set -euo pipefail

# Upgrade authority transfer checklist — prints current authorities and
# the exact commands needed to transfer to a Squads multisig.
#
# DRY RUN by default. Set CONFIRM_TRANSFER=YES to execute.
#
# Usage:
#   bash scripts/post-mainnet/09-transfer-authority-checklist.sh
#   CONFIRM_TRANSFER=YES NEW_AUTHORITY=<SQUADS_VAULT_PUBKEY> bash scripts/post-mainnet/09-transfer-authority-checklist.sh

CLUSTER_URL="https://api.mainnet-beta.solana.com"
DOCS_DIR="docs"
DOCS_FILE="${DOCS_DIR}/UPGRADE_AUTHORITY.md"

# The 8 deployed program IDs
declare -A PROGRAMS=(
  [dark_semaphore]="Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p"
  [dark_secp256r1_vault]="3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi"
  [dark_secp256k1_auth]="AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B"
  [null_token_hook]="14ivonrNRmaMbJMQkGdHVVTcqZYhNvchULWxveazhW2g"
  [null_lottery]="3t5c2Trk4SFK7hvKVjsmmC2xQtasFnK9pJQRdwPHqxbG"
  [null_mint_gate]="5jduvBZggszFeE7uxxNrvZAp8pJxzqtgzBGqg12fKhC1"
  [receipt_anchor]="6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN"
  [dark_proof_gate_lite]="PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2"
)

# Order for consistent output
PROGRAM_ORDER=(
  dark_semaphore
  dark_secp256r1_vault
  dark_secp256k1_auth
  null_token_hook
  null_lottery
  null_mint_gate
  receipt_anchor
  dark_proof_gate_lite
)

mkdir -p "$DOCS_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "=== Upgrade Authority Checklist ==="
echo "Cluster: $CLUSTER_URL"
echo "Timestamp: $TIMESTAMP"
echo ""

# Print current authorities
echo "Current authorities:"
echo ""
CURRENT_AUTHS=()
for PROG in "${PROGRAM_ORDER[@]}"; do
  ID="${PROGRAMS[$PROG]}"
  AUTHORITY=$(solana program show "$ID" -u mainnet-beta 2>/dev/null | grep -i "ProgramData Address\|Authority\|upgrade authority" | head -1 | awk '{print $NF}' || echo "unknown")
  echo "  $PROG ($ID)"
  echo "    Authority: $AUTHORITY"
  CURRENT_AUTHS+=("$PROG:$AUTHORITY")
done

echo ""
echo "=== Transfer Commands (DRY RUN — not executed unless CONFIRM_TRANSFER=YES) ==="
echo ""
echo "PREREQUISITE: Set NEW_AUTHORITY to your Squads vault address:"
echo "  export NEW_AUTHORITY=<SQUADS_VAULT_PUBKEY>"
echo ""

NEW_AUTH="${NEW_AUTHORITY:-<NOT_SET__SET_NEW_AUTHORITY_env_var>}"

for PROG in "${PROGRAM_ORDER[@]}"; do
  ID="${PROGRAMS[$PROG]}"
  echo "# Transfer $PROG"
  echo "solana program set-upgrade-authority $ID --new-upgrade-authority $NEW_AUTH -u mainnet-beta"
  echo ""
done

echo "=== Verification Commands (run after transfer) ==="
echo ""
for PROG in "${PROGRAM_ORDER[@]}"; do
  ID="${PROGRAMS[$PROG]}"
  echo "solana program show $ID -u mainnet-beta | grep -i authority"
done

echo ""

# ── Execute if confirmed ──────────────────────────────────────────────────────
if [ "${CONFIRM_TRANSFER:-}" = "YES" ]; then
  if [ -z "${NEW_AUTHORITY:-}" ]; then
    echo "ERROR: CONFIRM_TRANSFER=YES but NEW_AUTHORITY not set."
    echo "Set NEW_AUTHORITY to your Squads vault pubkey and re-run."
    exit 1
  fi

  echo "=== EXECUTING AUTHORITY TRANSFER ==="
  echo "New authority: $NEW_AUTHORITY"
  echo ""

  FAILURES=0
  for PROG in "${PROGRAM_ORDER[@]}"; do
    ID="${PROGRAMS[$PROG]}"
    echo "Transferring $PROG ($ID) to $NEW_AUTHORITY..."
    if solana program set-upgrade-authority "$ID" --new-upgrade-authority "$NEW_AUTHORITY" -u mainnet-beta; then
      # Verify immediately after each transfer
      ACTUAL_AUTH=$(solana program show "$ID" -u mainnet-beta 2>/dev/null | grep -i "Authority" | head -1 | awk '{print $NF}' || echo "unknown")
      if [ "$ACTUAL_AUTH" = "$NEW_AUTHORITY" ]; then
        echo "  OK: Authority confirmed = $ACTUAL_AUTH"
      else
        echo "  WARNING: Expected $NEW_AUTHORITY, got $ACTUAL_AUTH — verify manually"
        FAILURES=$((FAILURES + 1))
      fi
    else
      echo "  ERROR: Transfer failed for $PROG"
      FAILURES=$((FAILURES + 1))
    fi
    echo ""
  done

  if [ "$FAILURES" -gt 0 ]; then
    echo "WARNING: $FAILURES transfer(s) had issues — verify all authorities before proceeding."
    exit 1
  fi
  echo "All authorities transferred successfully."
fi

# ── Write UPGRADE_AUTHORITY.md ────────────────────────────────────────────────
cat > "$DOCS_FILE" <<MDEOF
# Upgrade Authority Status

_Generated: ${TIMESTAMP}_

## Current State

| Program | Program ID | Current Authority |
|---------|-----------|------------------|
$(for PROG in "${PROGRAM_ORDER[@]}"; do
  ID="${PROGRAMS[$PROG]}"
  AUTH=$(solana program show "$ID" -u mainnet-beta 2>/dev/null | grep -i "Authority" | head -1 | awk '{print $NF}' || echo "not queried")
  echo "| \`$PROG\` | \`$ID\` | \`$AUTH\` |"
done)

## Planned Migration

Transfer all upgrade authorities to a **Squads multisig** vault after external audit completion.

### Steps

1. Create Squads multisig at [app.squads.so](https://app.squads.so) with protocol signers.
2. Note the vault pubkey (not the squad address — the vault that holds upgrade authority).
3. Run with confirmation:
   \`\`\`bash
   NEW_AUTHORITY=<SQUADS_VAULT_PUBKEY> CONFIRM_TRANSFER=YES bash scripts/post-mainnet/09-transfer-authority-checklist.sh
   \`\`\`
4. Verify each program's authority using \`solana program show\`.
5. Test upgrade path in devnet with new authority before mainnet.

### Safety Notes

- **NEVER** run \`solana program close <PROGRAM_ID>\` — destroys programs
- Transfer to multisig before expanded public use
- Keep a hot-wallet emergency keypair accessible for critical patches (until multisig operational)
MDEOF

echo "Docs: $DOCS_FILE"
echo ""
echo "=== Checklist Complete (DRY RUN) ==="
echo "To execute: CONFIRM_TRANSFER=YES NEW_AUTHORITY=<SQUADS_VAULT> bash $0"
