#!/usr/bin/env bash
set -euo pipefail

# Check for orphaned program buffers on mainnet-beta.
# Orphaned buffers waste SOL — close them before redeploying.
#
# IMPORTANT SAFETY NOTE:
#   To recover SOL from buffers, run:
#     solana program close --buffers -u mainnet-beta
#
#   That command closes BUFFER accounts only (temporary upload scratch space).
#
#   NEVER run: solana program close <PROGRAM_ID> --bypass-warning
#   That command would close a deployed PROGRAM account, destroying the program
#   and making its ID permanently unusable. It cannot be undone.

echo "=== Checking for Orphaned Buffers on mainnet-beta ==="
echo ""

BUFFER_OUTPUT=$(solana program show --buffers -u mainnet-beta 2>/dev/null || true)
echo "$BUFFER_OUTPUT"
echo ""

# Count non-empty, non-header lines
BUFFER_COUNT=$(echo "$BUFFER_OUTPUT" | grep -v "Buffer Address" | grep -vc "^[[:space:]]*$" || true)

if [ "${BUFFER_COUNT:-0}" -gt 0 ]; then
  echo "WARNING: ${BUFFER_COUNT} orphaned buffer account(s) found!"
  echo ""
  echo "These buffers are wasting SOL. To recover:"
  echo "  solana program close --buffers -u mainnet-beta"
  echo ""
  echo "DO NOT RUN: solana program close <PROGRAM_ID> --bypass-warning"
  echo "  (closes programs, not buffers — irreversible and destructive)"
  exit 1
fi

echo "NO ORPHAN BUFFERS — clean"
