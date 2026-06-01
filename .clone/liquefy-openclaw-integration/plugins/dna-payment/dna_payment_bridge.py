"""
DNA x402 Payment Bridge Plugin — reference implementation.
Archives x402 payment receipts into Liquefy TraceVaults and anchors on Solana.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Program addresses
# ---------------------------------------------------------------------------

DNA_PAYMENT_PROGRAMS: dict[str, str] = {
    "x402_receipt_anchor": "x4o2RcptAnCHoRPaYmEnTsXXXXXXXXXXXXXXXXXXXX",
    "x402_fee_collector": "FEEcLcTrVaULTXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
}

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class PaymentReceiptEvent:
    tx_signature: str
    sender: str
    receiver: str
    amount_usdc: float
    slot: int
    timestamp: float


# ---------------------------------------------------------------------------
# Internal helpers (shared vault utilities)
# ---------------------------------------------------------------------------

def _derive_aes_key(secret: bytes | None = None) -> bytes:
    """Derive a 32-byte AES-256 key from the provided secret, or from an
    environment variable, falling back to a deterministic dev-only key."""
    if secret is not None:
        return hashlib.sha256(secret).digest()
    env_key = os.environ.get("LIQUEFY_VAULT_KEY")
    if env_key:
        return hashlib.sha256(env_key.encode()).digest()
    # Dev fallback — must be replaced in production
    return hashlib.sha256(b"liquefy-openclaw-dev-only-insecure").digest()


def tracevault_pack(records: list[dict], vault_path: Path, aes_key: bytes) -> None:
    """Compress and AES-256-GCM encrypt *records* into *vault_path*."""
    import sys

    # Try to import liquefy from the sibling clone; fall back to sys.path
    _liquefy_src = Path(__file__).resolve().parents[3] / ".clone" / "liquefy" / "src"
    _liquefy_engines = Path(__file__).resolve().parents[3] / ".clone" / "liquefy" / "engines"
    for _p in (_liquefy_src, _liquefy_engines,
               _liquefy_engines / "json_codec", _liquefy_engines / "security"):
        if _p.exists() and str(_p) not in sys.path:
            sys.path.insert(0, str(_p))

    from liquefy import compress_encrypted  # type: ignore

    jsonl = "\n".join(json.dumps(r, separators=(",", ":")) for r in records)
    blob = compress_encrypted(jsonl.encode("utf-8"), aes_key)
    vault_path.parent.mkdir(parents=True, exist_ok=True)
    vault_path.write_bytes(blob)


def liquefy_vault_anchor(vault_path: Path, rpc_url: str | None = None) -> str:
    """Anchor the SHA-256 hash of the vault file on Solana.

    Returns the transaction signature string.  Requires *solders* and a funded
    payer keypair in SOLANA_PAYER_KEYPAIR_PATH (base58 JSON array).
    """
    import base64

    vault_hash = hashlib.sha256(vault_path.read_bytes()).digest()

    # Build a minimal memo-program instruction carrying the vault hash
    try:
        from solders.hash import Hash  # type: ignore
        from solders.keypair import Keypair  # type: ignore
        from solders.pubkey import Pubkey  # type: ignore
        from solders.transaction import Transaction  # type: ignore
        from solders.instruction import Instruction, AccountMeta  # type: ignore
        import urllib.request, urllib.parse

        MEMO_PROGRAM = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
        keypair_path = os.environ.get(
            "SOLANA_PAYER_KEYPAIR_PATH", str(Path.home() / ".config" / "solana" / "id.json")
        )
        secret = json.loads(Path(keypair_path).read_text())
        payer = Keypair.from_bytes(bytes(secret))

        rpc = rpc_url or os.environ.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

        # Fetch recent blockhash
        payload = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "getLatestBlockhash",
            "params": [{"commitment": "finalized"}]
        }).encode()
        req = urllib.request.Request(rpc, data=payload, headers={"Content-Type": "application/json"})
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        blockhash = Hash.from_string(resp["result"]["value"]["blockhash"])

        memo_data = base64.b64encode(vault_hash).decode()
        ix = Instruction(
            MEMO_PROGRAM,
            memo_data.encode("utf-8"),
            [AccountMeta(payer.pubkey(), is_signer=True, is_writable=False)],
        )
        tx = Transaction([payer], [ix], blockhash)

        send_payload = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "sendTransaction",
            "params": [base64.b64encode(bytes(tx)).decode(), {"encoding": "base64"}]
        }).encode()
        req2 = urllib.request.Request(rpc, data=send_payload,
                                       headers={"Content-Type": "application/json"})
        resp2 = json.loads(urllib.request.urlopen(req2, timeout=10).read())
        return resp2["result"]

    except Exception as exc:
        raise RuntimeError(f"vault anchor failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Plugin commands
# ---------------------------------------------------------------------------

def cmd_archive(
    events_dir: str,
    output_dir: str,
    anchor: bool = False,
    aes_key: bytes | None = None,
) -> dict:
    events_path = Path(events_dir) / "dna_payment_events.jsonl"
    records: list[dict] = []
    with events_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    mapped = [
        {
            "schema": "liquefy.dna-payment.telemetry.v1",
            "tx_signature": r.get("tx_signature", ""),
            "sender": r.get("sender", ""),
            "receiver": r.get("receiver", ""),
            "amount_usdc": r.get("amount_usdc", 0),
            "slot": r.get("slot", 0),
            "timestamp": r.get("timestamp", 0.0),
        }
        for r in records
    ]

    key = _derive_aes_key(aes_key)
    vault_name = f"dna_payment_{int(time.time())}.vault"
    vault_path = Path(output_dir) / vault_name
    tracevault_pack(mapped, vault_path, key)

    result: dict = {"vault_path": str(vault_path), "event_count": len(mapped)}
    if anchor:
        result["anchor_tx"] = liquefy_vault_anchor(vault_path)
    return result


# ---------------------------------------------------------------------------
# Plugin manifest
# ---------------------------------------------------------------------------

PLUGIN_MANIFEST: dict = {
    "plugin_id": "dna-payment",
    "version": "0.1.0",
    "schema_namespace": "liquefy.dna-payment.telemetry.v1",
    "description": "Archives DNA x402 payment receipts into encrypted Liquefy TraceVaults.",
    "commands": {
        "archive": "cmd_archive",
    },
    "programs": DNA_PAYMENT_PROGRAMS,
    "requires": ["liquefy", "solders"],
}
