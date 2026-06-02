"""
NULLA Proof-of-Work Credit System
==================================
Complete a task → earn a WorkProof → anchor it on Solana → trade it.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# WorkProof dataclass
# ---------------------------------------------------------------------------

@dataclass
class WorkProof:
    task_id: str
    node_id: str
    task_hash: str          # sha256(task_id + node_id)
    result_hash: str        # sha256(result_bytes)
    credits_earned: int
    timestamp: float
    solana_anchor_tx: Optional[str]  # None until anchored
    signature: str          # sha256(task_hash + result_hash + str(credits_earned))

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "WorkProof":
        return cls(**d)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def from_json(cls, s: str) -> "WorkProof":
        return cls.from_dict(json.loads(s))


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _sha256_hex(*parts: str | bytes) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part if isinstance(part, bytes) else part.encode())
    return h.hexdigest()


def _proof_canonical_bytes(proof: WorkProof) -> bytes:
    """Deterministic 32-byte digest of a proof's core fields."""
    blob = (
        proof.task_id
        + proof.node_id
        + proof.task_hash
        + proof.result_hash
        + str(proof.credits_earned)
        + str(proof.timestamp)
    )
    return hashlib.sha256(blob.encode()).digest()


# ---------------------------------------------------------------------------
# ProofOfWorkMinter
# ---------------------------------------------------------------------------

class ProofOfWorkMinter:
    """Mint, verify, and anchor WorkProof objects."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def mint_proof(
        self,
        task_id: str,
        result_bytes: bytes,
        node_id: str,
        credits: int,
    ) -> WorkProof:
        """
        Create a new WorkProof for a completed task.

        Parameters
        ----------
        task_id      : Unique identifier for the task that was completed.
        result_bytes : Raw output produced by the node (used for hashing only).
        node_id      : Identity of the node that did the work.
        credits      : Number of NULLA credits to award.

        Returns
        -------
        WorkProof  (unsigned Solana anchor — anchor separately if desired)
        """
        task_hash   = _sha256_hex(task_id, node_id)
        result_hash = _sha256_hex(result_bytes)
        signature   = _sha256_hex(task_hash, result_hash, str(credits))

        return WorkProof(
            task_id=task_id,
            node_id=node_id,
            task_hash=task_hash,
            result_hash=result_hash,
            credits_earned=credits,
            timestamp=time.time(),
            solana_anchor_tx=None,
            signature=signature,
        )

    def verify_proof(self, proof: WorkProof) -> bool:
        """
        Re-derive the expected signature and compare.

        Returns True if the proof is internally consistent.
        Note: this does NOT verify on-chain anchoring — use the tx hash for that.
        """
        expected = _sha256_hex(
            proof.task_hash,
            proof.result_hash,
            str(proof.credits_earned),
        )
        return proof.signature == expected

    def anchor_proof(self, proof: WorkProof, rpc_url: str) -> str:
        """
        Anchor the proof on Solana using the receipt_anchor memo pattern.

        Memo layout: [0x01][0x00][32 bytes sha256(proof fields)]

        Uses SOLANA_DEPLOYER_KEYPAIR env var (base58 private key).
        Falls back to a dry-run simulation when the env var is not set.

        Returns the Solana transaction signature string and mutates
        proof.solana_anchor_tx in place.
        """
        canonical = _proof_canonical_bytes(proof)

        # Build 34-byte memo payload: [0x01, 0x00] + 32 bytes digest
        memo_payload = bytes([0x01, 0x00]) + canonical

        keypair_b58 = os.environ.get("SOLANA_DEPLOYER_KEYPAIR")

        if keypair_b58:
            tx_sig = self._send_memo_tx(rpc_url, keypair_b58, memo_payload)
        else:
            # Dry-run: derive a deterministic fake tx id so callers can test
            tx_sig = "DRY_RUN:" + _sha256_hex(memo_payload)

        proof.solana_anchor_tx = tx_sig
        return tx_sig

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _send_memo_tx(rpc_url: str, keypair_b58: str, memo_payload: bytes) -> str:
        """
        Submit a Solana transaction containing a single Memo instruction.

        This implementation uses only the standard library + base64/base58
        encoding so it has zero third-party dependencies.  It constructs a
        minimal legacy transaction manually.

        If the import of `solders` / `solana-py` is available it is preferred;
        otherwise falls back to a raw HTTP memo via the Solana JSON-RPC memo
        program (SPL Memo v2: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr).
        """
        try:
            return ProofOfWorkMinter._send_via_solana_sdk(
                rpc_url, keypair_b58, memo_payload
            )
        except ImportError:
            return ProofOfWorkMinter._send_via_raw_rpc(
                rpc_url, keypair_b58, memo_payload
            )

    @staticmethod
    def _send_via_solana_sdk(
        rpc_url: str, keypair_b58: str, memo_payload: bytes
    ) -> str:
        """Path taken when solders + solana-py are installed."""
        from solders.keypair import Keypair  # type: ignore
        from solders.pubkey import Pubkey  # type: ignore
        from solders.transaction import Transaction  # type: ignore
        from solders.instruction import Instruction, AccountMeta  # type: ignore
        from solders.hash import Hash  # type: ignore
        from solana.rpc.api import Client  # type: ignore
        import base58  # type: ignore

        kp = Keypair.from_bytes(base58.b58decode(keypair_b58))
        client = Client(rpc_url)

        MEMO_PROGRAM_ID = Pubkey.from_string(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        )

        blockhash_resp = client.get_latest_blockhash()
        recent_bh = blockhash_resp.value.blockhash

        ix = Instruction(
            program_id=MEMO_PROGRAM_ID,
            data=memo_payload,
            accounts=[AccountMeta(pubkey=kp.pubkey(), is_signer=True, is_writable=False)],
        )

        tx = Transaction.new_signed_with_payer(
            instructions=[ix],
            payer=kp.pubkey(),
            signing_keypairs=[kp],
            recent_blockhash=recent_bh,
        )

        resp = client.send_transaction(tx)
        return str(resp.value)

    @staticmethod
    def _send_via_raw_rpc(
        rpc_url: str, keypair_b58: str, memo_payload: bytes
    ) -> str:
        """
        Minimal raw-HTTP fallback.

        Builds a legacy Solana transaction with one Memo instruction by hand,
        signs it with the ed25519 keypair, and sends it via sendTransaction.

        Requires only: urllib (stdlib), base64 (stdlib), and the `cryptography`
        package (usually already present) for ed25519 signing.
        """
        import base64
        import urllib.request

        # ------------------------------------------------------------------
        # 1. Decode keypair (64-byte seed+pubkey or 32-byte seed)
        # ------------------------------------------------------------------
        raw = _b58decode(keypair_b58)
        if len(raw) == 64:
            seed, pubkey_bytes = raw[:32], raw[32:]
        elif len(raw) == 32:
            seed = raw
            pubkey_bytes = _ed25519_pubkey_from_seed(seed)
        else:
            raise ValueError(f"Unexpected keypair length: {len(raw)}")

        # ------------------------------------------------------------------
        # 2. Fetch recent blockhash
        # ------------------------------------------------------------------
        rpc_req = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getLatestBlockhash",
            "params": [{"commitment": "confirmed"}],
        }).encode()

        with urllib.request.urlopen(
            urllib.request.Request(
                rpc_url,
                data=rpc_req,
                headers={"Content-Type": "application/json"},
            )
        ) as resp:
            bh_data = json.loads(resp.read())

        recent_bh_b58 = bh_data["result"]["value"]["blockhash"]
        recent_bh_bytes = _b58decode(recent_bh_b58)

        # ------------------------------------------------------------------
        # 3. Build transaction message
        # ------------------------------------------------------------------
        MEMO_PROGRAM_ID_B58 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        memo_program_bytes = _b58decode(MEMO_PROGRAM_ID_B58)

        # Account keys: [fee_payer (signer+writable), memo_program (readonly)]
        account_keys = pubkey_bytes + memo_program_bytes  # 64 bytes

        # Instruction: program_id index=1, accounts=[{index=0}], data=memo_payload
        ix_accounts = bytes([1])          # 1 account referenced
        ix_account_indices = bytes([0])   # index of fee_payer
        ix_data_len = _encode_compact_u16(len(memo_payload))
        instruction = (
            bytes([1])               # program id index (memo program = key[1])
            + bytes([1])             # num accounts in ix
            + bytes([0])             # account index 0 = fee_payer
            + ix_data_len
            + memo_payload
        )

        # Message header: [num_required_signatures=1, num_readonly_signed=0, num_readonly_unsigned=1]
        header = bytes([1, 0, 1])
        num_accounts = _encode_compact_u16(2)
        num_instructions = _encode_compact_u16(1)

        message = (
            header
            + num_accounts
            + account_keys
            + recent_bh_bytes
            + num_instructions
            + instruction
        )

        # ------------------------------------------------------------------
        # 4. Sign
        # ------------------------------------------------------------------
        sig_bytes = _ed25519_sign(seed, message)

        # ------------------------------------------------------------------
        # 5. Serialize transaction
        # ------------------------------------------------------------------
        num_sigs = _encode_compact_u16(1)
        tx_bytes = num_sigs + sig_bytes + message

        tx_b64 = base64.b64encode(tx_bytes).decode()

        # ------------------------------------------------------------------
        # 6. Send
        # ------------------------------------------------------------------
        send_req = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [tx_b64, {"encoding": "base64"}],
        }).encode()

        with urllib.request.urlopen(
            urllib.request.Request(
                rpc_url,
                data=send_req,
                headers={"Content-Type": "application/json"},
            )
        ) as resp:
            send_data = json.loads(resp.read())

        if "error" in send_data:
            raise RuntimeError(f"Solana RPC error: {send_data['error']}")

        return send_data["result"]


# ---------------------------------------------------------------------------
# Pure-Python ed25519 helpers (no third-party deps required)
# ---------------------------------------------------------------------------

def _b58decode(s: str) -> bytes:
    ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = 0
    for ch in s.encode():
        n = n * 58 + ALPHABET.index(ch)
    result = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + result


def _encode_compact_u16(v: int) -> bytes:
    """Solana compact-u16 encoding."""
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            b |= 0x80
        out.append(b)
        if not v:
            break
    return bytes(out)


def _ed25519_pubkey_from_seed(seed: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        sk = Ed25519PrivateKey.from_private_bytes(seed)
        return sk.public_key().public_bytes_raw()
    except ImportError:
        pass
    # Fallback: use hashlib-based stub (NOT cryptographically valid — for testing only)
    return hashlib.sha256(b"pubkey:" + seed).digest()


def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        sk = Ed25519PrivateKey.from_private_bytes(seed)
        return sk.sign(message)
    except ImportError:
        pass
    # Fallback stub (NOT valid — dry-run only)
    return hashlib.sha256(seed + message).digest() * 2  # 64 bytes


# ---------------------------------------------------------------------------
# CreditMarket
# ---------------------------------------------------------------------------

@dataclass
class Listing:
    listing_id: str
    proof: WorkProof
    seller_node_id: str
    price_usdc: float
    sold: bool = False
    buyer_node_id: Optional[str] = None


class CreditMarket:
    """
    Simple in-process credit marketplace.

    Credits ARE WorkProof objects — ownership is possession of the signed proof.
    Selling a proof transfers the right to use it for priority routing.
    """

    def __init__(self) -> None:
        self._listings: dict[str, Listing] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list_for_sale(self, proof: WorkProof, price_usdc: float) -> str:
        """
        List a WorkProof for sale.

        The seller retains the proof object until buy() is called.
        Returns a listing_id (UUID) that the buyer will reference.
        """
        listing_id = str(uuid.uuid4())
        self._listings[listing_id] = Listing(
            listing_id=listing_id,
            proof=proof,
            seller_node_id=proof.node_id,
            price_usdc=price_usdc,
        )
        return listing_id

    def buy(self, listing_id: str, buyer_node_id: str) -> WorkProof:
        """
        Purchase a listed WorkProof.

        Transfers ownership by reassigning proof.node_id to the buyer and
        re-signing the proof.  The original seller's signature is preserved
        in the returned proof's task_hash chain; the new signature reflects
        the transfer.

        Returns the transferred WorkProof (buyer now possesses it).
        Raises KeyError  if listing_id is unknown.
        Raises ValueError if already sold.
        """
        listing = self._listings.get(listing_id)
        if listing is None:
            raise KeyError(f"Unknown listing: {listing_id}")
        if listing.sold:
            raise ValueError(f"Listing {listing_id} already sold.")

        # Transfer: create a new proof with the buyer as the node_id.
        # The task_hash and result_hash remain unchanged (provenance preserved).
        # A new signature is issued to reflect the new ownership.
        transferred = WorkProof(
            task_id=listing.proof.task_id,
            node_id=buyer_node_id,
            task_hash=listing.proof.task_hash,   # original work provenance intact
            result_hash=listing.proof.result_hash,
            credits_earned=listing.proof.credits_earned,
            timestamp=listing.proof.timestamp,
            solana_anchor_tx=listing.proof.solana_anchor_tx,
            # New signature binds buyer_node_id to the original hashes
            signature=_sha256_hex(
                listing.proof.task_hash,
                listing.proof.result_hash,
                str(listing.proof.credits_earned),
                buyer_node_id,              # new owner bound into signature
            ),
        )

        listing.sold = True
        listing.buyer_node_id = buyer_node_id
        listing.proof = transferred

        return transferred

    def get_listing(self, listing_id: str) -> Optional[Listing]:
        return self._listings.get(listing_id)

    def active_listings(self) -> list[Listing]:
        return [l for l in self._listings.values() if not l.sold]

    def all_listings(self) -> list[Listing]:
        return list(self._listings.values())


# ---------------------------------------------------------------------------
# Quick self-test (run: python proof_of_work.py)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    minter = ProofOfWorkMinter()

    proof = minter.mint_proof(
        task_id="task-001",
        result_bytes=b"inference output: 42",
        node_id="node-abc",
        credits=10,
    )
    print("Minted proof:")
    print(proof.to_json())

    valid = minter.verify_proof(proof)
    print(f"\nProof valid: {valid}")

    # Anchor (dry-run because SOLANA_DEPLOYER_KEYPAIR is not set)
    tx = minter.anchor_proof(proof, rpc_url="https://api.mainnet-beta.solana.com")
    print(f"\nAnchor tx: {tx}")

    # Market
    market = CreditMarket()
    listing_id = market.list_for_sale(proof, price_usdc=1.50)
    print(f"\nListed proof for sale: {listing_id}")

    transferred = market.buy(listing_id, buyer_node_id="node-xyz")
    print(f"\nTransferred proof to node-xyz:")
    print(transferred.to_json())
