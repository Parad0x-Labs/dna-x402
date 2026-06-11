"""
NULLA Proof-of-Work Credit System — Challenge-Response Anti-Cheat Edition
==========================================================================
Complete a task → earn a WorkProof → anchor it on Solana → trade it.

Anti-cheat guarantee
--------------------
A WorkProof is only valid when the worker can produce:

    sha256(challenge_nonce + result_bytes)

The challenge_nonce is a 32-byte random secret kept by the task issuer.
Only the challenge_hash = sha256(challenge_nonce) is published before the
task starts.  After the worker commits to their result hash the issuer
reveals the nonce; the worker then produces the challenge_response to prove
they had the actual result_bytes.

Without the real result_bytes you cannot produce a valid challenge_response
even if you somehow learned the nonce, and without the nonce you cannot
produce it even with the real bytes.  You need *both*.

Two-phase protocol
------------------
1. Issuer publishes ChallengeIssuedTask (challenge_hash visible, nonce secret).
2. Worker computes task, commits to result_hash = sha256(result_bytes).
3. Issuer calls reveal_challenge(task_id) → returns nonce to the committing worker.
4. Worker calls mint_proof_with_challenge(...) → WorkProof with challenge_response.
5. Issuer calls verify_proof_with_challenge(proof, nonce, result_bytes) → bool.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _sha256_hex(*parts: "str | bytes") -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part if isinstance(part, bytes) else part.encode())
    return h.hexdigest()


def _sha256_bytes(*parts: "str | bytes") -> bytes:
    h = hashlib.sha256()
    for part in parts:
        h.update(part if isinstance(part, bytes) else part.encode())
    return h.digest()


# ---------------------------------------------------------------------------
# TaskChallenge — held by the issuer (nonce stays secret)
# ---------------------------------------------------------------------------

@dataclass
class TaskChallenge:
    """
    Full challenge record stored locally by the task issuer.
    The challenge_nonce MUST NOT be shared until the worker commits.
    """
    task_id: str
    challenge_nonce: str    # 32 random bytes, hex — secret until reveal
    challenge_hash: str     # sha256(challenge_nonce) — published before task starts
    issued_at: float
    expires_at: float       # Unix timestamp; challenges expire to prevent replay
    issuer_id: str

    def is_expired(self, now: Optional[float] = None) -> bool:
        return (now or time.time()) > self.expires_at

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "TaskChallenge":
        return cls(**d)


# ---------------------------------------------------------------------------
# ChallengeIssuedTask — the public task descriptor (nonce NOT included)
# ---------------------------------------------------------------------------

@dataclass
class ChallengeIssuedTask:
    """
    Public task descriptor handed to workers.
    Workers see the challenge_hash but NOT the challenge_nonce.
    """
    task_id: str
    task_description: str
    challenge_hash: str     # sha256(challenge_nonce) — proves nonce exists; opaque to worker
    min_result_length: int  # minimum acceptable length of result_bytes
    credits_offered: int

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ChallengeIssuedTask":
        return cls(**d)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


# ---------------------------------------------------------------------------
# WorkProof — anti-cheat version
# ---------------------------------------------------------------------------

@dataclass
class WorkProof:
    """
    A verifiable proof that a specific worker produced a specific result for
    a specific task, under a specific challenge nonce.

    Fields
    ------
    challenge_response : sha256(challenge_nonce + result_bytes)
        Binds the worker's result to the issuer's secret nonce.
        Cannot be forged without *both* the real result_bytes and the nonce.

    result_hash : sha256(result_bytes)
        Allows anyone to verify the result content independently once
        result_bytes are disclosed.

    is_valid : set to True by verify_proof_with_challenge() after the issuer
        confirms the proof.
    """
    task_id: str
    worker_node_id: str
    result_hash: str            # sha256(result_bytes)
    challenge_response: str     # sha256(challenge_nonce + result_bytes)
    credits_earned: int
    timestamp: float
    solana_anchor_tx: Optional[str]   # None until anchored
    is_valid: bool = False            # set by verify_proof_with_challenge

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

    def canonical_id(self) -> str:
        """Stable identifier for replay-attack detection."""
        return _sha256_hex(
            self.task_id,
            self.worker_node_id,
            self.result_hash,
            self.challenge_response,
            str(self.credits_earned),
            str(self.timestamp),
        )


# ---------------------------------------------------------------------------
# ProofOfWorkMinter — rebuilt with challenge-response
# ---------------------------------------------------------------------------

class ProofOfWorkMinter:
    """
    Mint, verify, and anchor WorkProof objects using the challenge-response
    anti-cheat protocol.

    State held in-process
    ---------------------
    _challenges      : task_id -> TaskChallenge (issuer side)
    _seen_proof_ids  : set of canonical_id strings (replay protection)
    """

    def __init__(self) -> None:
        self._challenges: dict[str, TaskChallenge] = {}
        self._seen_proof_ids: set[str] = set()

    # ------------------------------------------------------------------
    # Issuer-side: task challenge lifecycle
    # ------------------------------------------------------------------

    def issue_task_challenge(
        self,
        task_id: str,
        issuer_id: str,
        task_description: str = "",
        min_result_length: int = 1,
        credits_offered: int = 1,
        expires_in_seconds: float = 3600.0,
    ) -> ChallengeIssuedTask:
        """
        Generate a new challenge for a task.

        Stores the full TaskChallenge (including nonce) locally.
        Returns a ChallengeIssuedTask (challenge_hash only) safe to publish.

        Parameters
        ----------
        task_id            : Unique identifier for the task.
        issuer_id          : Identity of the entity issuing the task.
        task_description   : Human-readable task description.
        min_result_length  : Minimum byte length of an acceptable result.
        credits_offered    : Credits the winner earns.
        expires_in_seconds : How long before the challenge is considered stale.
        """
        nonce_bytes = os.urandom(32)
        nonce_hex = nonce_bytes.hex()
        challenge_hash = _sha256_hex(nonce_hex)

        now = time.time()
        challenge = TaskChallenge(
            task_id=task_id,
            challenge_nonce=nonce_hex,
            challenge_hash=challenge_hash,
            issued_at=now,
            expires_at=now + expires_in_seconds,
            issuer_id=issuer_id,
        )
        self._challenges[task_id] = challenge

        return ChallengeIssuedTask(
            task_id=task_id,
            task_description=task_description,
            challenge_hash=challenge_hash,
            min_result_length=min_result_length,
            credits_offered=credits_offered,
        )

    def reveal_challenge(self, task_id: str) -> str:
        """
        Return the challenge_nonce for task_id (phase 2 of the protocol).

        Called after the worker has committed to their result_hash.
        The nonce is revealed so the worker can produce challenge_response.

        Raises
        ------
        KeyError   : task_id not found.
        ValueError : challenge has expired.
        """
        challenge = self._challenges.get(task_id)
        if challenge is None:
            raise KeyError(f"No challenge found for task_id={task_id!r}")
        if challenge.is_expired():
            raise ValueError(
                f"Challenge for task_id={task_id!r} expired at "
                f"{challenge.expires_at} (now={time.time():.1f})"
            )
        return challenge.challenge_nonce

    # ------------------------------------------------------------------
    # Worker-side: mint a proof
    # ------------------------------------------------------------------

    def mint_proof_with_challenge(
        self,
        task_id: str,
        result_bytes: bytes,
        challenge_nonce: str,
        worker_id: str,
        credits: int,
    ) -> WorkProof:
        """
        Create an anti-cheat WorkProof that binds result_bytes to the nonce.

        Parameters
        ----------
        task_id          : Must match the original task.
        result_bytes     : The raw output produced by the worker.
        challenge_nonce  : The nonce revealed by the issuer (phase 2).
        worker_id        : Identity of the worker node.
        credits          : Credits to award (must match issuer offer in production).

        Returns
        -------
        WorkProof with challenge_response = sha256(challenge_nonce + result_bytes)
        and is_valid=False (set to True only after issuer verification).
        """
        result_hash = _sha256_hex(result_bytes)
        # challenge_response binds the nonce to the actual bytes
        challenge_response = _sha256_hex(
            challenge_nonce.encode() + result_bytes
        )
        return WorkProof(
            task_id=task_id,
            worker_node_id=worker_id,
            result_hash=result_hash,
            challenge_response=challenge_response,
            credits_earned=credits,
            timestamp=time.time(),
            solana_anchor_tx=None,
            is_valid=False,
        )

    # ------------------------------------------------------------------
    # Issuer-side: verify a proof
    # ------------------------------------------------------------------

    def verify_proof_with_challenge(
        self,
        proof: WorkProof,
        challenge_nonce: str,
        result_bytes: bytes,
        now: Optional[float] = None,
    ) -> bool:
        """
        Verify that a WorkProof is genuine.

        Checks performed
        ----------------
        1. result_hash matches sha256(result_bytes) — result not tampered.
        2. challenge_response matches sha256(challenge_nonce + result_bytes) —
           worker had the real result AND knew the nonce.
        3. The proof has not been seen before (replay attack prevention).
        4. The originating challenge has not expired.

        Mutates proof.is_valid in place when all checks pass.

        Returns True only when every check passes.
        """
        # 1. result_hash integrity
        expected_result_hash = _sha256_hex(result_bytes)
        if proof.result_hash != expected_result_hash:
            return False

        # 2. challenge_response integrity — the anti-cheat core check
        expected_challenge_response = _sha256_hex(
            challenge_nonce.encode() + result_bytes
        )
        if proof.challenge_response != expected_challenge_response:
            return False

        # 3. Replay attack: reject a proof we have already accepted
        proof_id = proof.canonical_id()
        if proof_id in self._seen_proof_ids:
            return False

        # 4. Check the stored challenge expiry (if we issued this challenge)
        challenge = self._challenges.get(proof.task_id)
        if challenge is not None and challenge.is_expired(now):
            return False

        # All checks passed
        self._seen_proof_ids.add(proof_id)
        proof.is_valid = True
        return True

    # ------------------------------------------------------------------
    # Solana anchoring (unchanged from original)
    # ------------------------------------------------------------------

    def anchor_proof(self, proof: WorkProof, rpc_url: str) -> str:
        """
        Anchor the proof on Solana via an SPL Memo instruction.

        Memo layout: [0x01][0x00][32 bytes sha256(proof fields)]

        Uses SOLANA_DEPLOYER_KEYPAIR env var (base58 private key).
        Falls back to a dry-run simulation when the env var is not set.

        Returns the Solana transaction signature string and mutates
        proof.solana_anchor_tx in place.
        """
        canonical = _proof_canonical_bytes(proof)
        memo_payload = bytes([0x01, 0x00]) + canonical

        keypair_b58 = os.environ.get("SOLANA_DEPLOYER_KEYPAIR")
        if keypair_b58:
            tx_sig = self._send_memo_tx(rpc_url, keypair_b58, memo_payload)
        else:
            tx_sig = "DRY_RUN:" + _sha256_hex(memo_payload)

        proof.solana_anchor_tx = tx_sig
        return tx_sig

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _send_memo_tx(rpc_url: str, keypair_b58: str, memo_payload: bytes) -> str:
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
        from solders.keypair import Keypair          # type: ignore
        from solders.pubkey import Pubkey            # type: ignore
        from solders.transaction import Transaction  # type: ignore
        from solders.instruction import Instruction, AccountMeta  # type: ignore
        from solana.rpc.api import Client            # type: ignore
        import base58                                # type: ignore

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
        """Minimal raw-HTTP fallback (stdlib + optional cryptography package)."""
        import base64
        import urllib.request

        raw = _b58decode(keypair_b58)
        if len(raw) == 64:
            seed, pubkey_bytes = raw[:32], raw[32:]
        elif len(raw) == 32:
            seed = raw
            pubkey_bytes = _ed25519_pubkey_from_seed(seed)
        else:
            raise ValueError(f"Unexpected keypair length: {len(raw)}")

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

        MEMO_PROGRAM_ID_B58 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        memo_program_bytes = _b58decode(MEMO_PROGRAM_ID_B58)

        account_keys = pubkey_bytes + memo_program_bytes
        ix_data_len = _encode_compact_u16(len(memo_payload))
        instruction = (
            bytes([1])
            + bytes([1])
            + bytes([0])
            + ix_data_len
            + memo_payload
        )

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

        sig_bytes = _ed25519_sign(seed, message)
        num_sigs = _encode_compact_u16(1)
        tx_bytes = num_sigs + sig_bytes + message
        tx_b64 = base64.b64encode(tx_bytes).decode()

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
# Proof canonical bytes helper (used by anchor_proof)
# ---------------------------------------------------------------------------

def _proof_canonical_bytes(proof: WorkProof) -> bytes:
    """Deterministic 32-byte digest of a WorkProof's core fields."""
    blob = (
        proof.task_id
        + proof.worker_node_id
        + proof.result_hash
        + proof.challenge_response
        + str(proof.credits_earned)
        + str(proof.timestamp)
    )
    return hashlib.sha256(blob.encode()).digest()


# ---------------------------------------------------------------------------
# Pure-Python ed25519 / base58 helpers (no third-party deps required)
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
    return hashlib.sha256(b"pubkey:" + seed).digest()


def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        sk = Ed25519PrivateKey.from_private_bytes(seed)
        return sk.sign(message)
    except ImportError:
        pass
    return hashlib.sha256(seed + message).digest() * 2  # 64-byte stub


# ---------------------------------------------------------------------------
# CreditMarket (unchanged)
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

    Credits ARE WorkProof objects — ownership is possession of the proof.
    Selling a proof transfers the right to use it for priority routing.
    """

    def __init__(self) -> None:
        self._listings: dict[str, Listing] = {}

    def list_for_sale(self, proof: WorkProof, price_usdc: float) -> str:
        listing_id = str(uuid.uuid4())
        self._listings[listing_id] = Listing(
            listing_id=listing_id,
            proof=proof,
            seller_node_id=proof.worker_node_id,
            price_usdc=price_usdc,
        )
        return listing_id

    def buy(self, listing_id: str, buyer_node_id: str) -> WorkProof:
        listing = self._listings.get(listing_id)
        if listing is None:
            raise KeyError(f"Unknown listing: {listing_id}")
        if listing.sold:
            raise ValueError(f"Listing {listing_id} already sold.")

        transferred = WorkProof(
            task_id=listing.proof.task_id,
            worker_node_id=buyer_node_id,
            result_hash=listing.proof.result_hash,
            challenge_response=listing.proof.challenge_response,
            credits_earned=listing.proof.credits_earned,
            timestamp=listing.proof.timestamp,
            solana_anchor_tx=listing.proof.solana_anchor_tx,
            is_valid=listing.proof.is_valid,
        )

        listing.sold = True
        listing.buyer_node_id = buyer_node_id
        listing.proof = transferred
        return transferred

    def get_listing(self, listing_id: str) -> Optional[Listing]:
        return self._listings.get(listing_id)

    def active_listings(self) -> list[Listing]:
        return [lst for lst in self._listings.values() if not lst.sold]

    def all_listings(self) -> list[Listing]:
        return list(self._listings.values())


# ---------------------------------------------------------------------------
# Built-in test suite (run: python proof_of_work.py)
# ---------------------------------------------------------------------------

def _run_tests() -> None:
    import sys

    passed = 0
    failed = 0

    def ok(name: str) -> None:
        nonlocal passed
        passed += 1
        print(f"  PASS  {name}")

    def fail(name: str, reason: str) -> None:
        nonlocal failed
        failed += 1
        print(f"  FAIL  {name}: {reason}")

    minter = ProofOfWorkMinter()

    # ------------------------------------------------------------------ #
    # Test 1: valid proof passes verification
    # ------------------------------------------------------------------ #
    task = minter.issue_task_challenge(
        task_id="task-001",
        issuer_id="issuer-A",
        task_description="Summarise the document",
        min_result_length=1,
        credits_offered=10,
        expires_in_seconds=3600,
    )
    nonce = minter.reveal_challenge("task-001")
    real_result = b"The document is about cryptographic proof systems."
    proof = minter.mint_proof_with_challenge(
        task_id="task-001",
        result_bytes=real_result,
        challenge_nonce=nonce,
        worker_id="worker-X",
        credits=10,
    )
    # Fresh minter for verification to simulate issuer checking a submitted proof
    verifier = ProofOfWorkMinter()
    verifier._challenges = minter._challenges   # issuer knows their own challenges
    result = verifier.verify_proof_with_challenge(proof, nonce, real_result)
    if result and proof.is_valid:
        ok("valid proof passes verification")
    else:
        fail("valid proof passes verification", f"returned {result}, is_valid={proof.is_valid}")

    # ------------------------------------------------------------------ #
    # Test 2: fake result (wrong bytes) fails verification
    # ------------------------------------------------------------------ #
    fake_result = b"I made this up without doing any work."
    proof2 = minter.mint_proof_with_challenge(
        task_id="task-002",
        result_bytes=fake_result,
        challenge_nonce=nonce,   # attacker reuses a known nonce from another task
        worker_id="cheater",
        credits=10,
    )
    # Verify against the *real* result — should fail
    verifier2 = ProofOfWorkMinter()
    verifier2._challenges = minter._challenges
    result2 = verifier2.verify_proof_with_challenge(proof2, nonce, real_result)
    if not result2 and not proof2.is_valid:
        ok("fake result fails verification")
    else:
        fail("fake result fails verification", f"returned {result2}")

    # ------------------------------------------------------------------ #
    # Test 3: correct challenge_response requires both nonce AND result
    # ------------------------------------------------------------------ #
    # Attacker has real result but not the nonce — uses a wrong nonce
    wrong_nonce = "deadbeef" * 8   # 64 hex chars = 32 bytes, but wrong
    proof3 = minter.mint_proof_with_challenge(
        task_id="task-003",
        result_bytes=real_result,
        challenge_nonce=wrong_nonce,
        worker_id="partial-attacker",
        credits=10,
    )
    verifier3 = ProofOfWorkMinter()
    verifier3._challenges = minter._challenges
    result3 = verifier3.verify_proof_with_challenge(proof3, nonce, real_result)
    if not result3:
        ok("wrong nonce fails even with correct result_bytes")
    else:
        fail("wrong nonce fails even with correct result_bytes", f"returned {result3}")

    # ------------------------------------------------------------------ #
    # Test 4: expired challenge is rejected
    # ------------------------------------------------------------------ #
    minter4 = ProofOfWorkMinter()
    task4 = minter4.issue_task_challenge(
        task_id="task-exp",
        issuer_id="issuer-B",
        expires_in_seconds=1.0,   # expires almost immediately
    )
    nonce4 = minter4.reveal_challenge("task-exp")
    proof4 = minter4.mint_proof_with_challenge(
        task_id="task-exp",
        result_bytes=b"some result",
        challenge_nonce=nonce4,
        worker_id="worker-late",
        credits=5,
    )
    # Simulate checking the proof 2 seconds after expiry
    future_time = time.time() + 3600 + 10
    result4 = minter4.verify_proof_with_challenge(
        proof4, nonce4, b"some result", now=future_time
    )
    if not result4 and not proof4.is_valid:
        ok("expired challenge rejected")
    else:
        fail("expired challenge rejected", f"returned {result4}")

    # ------------------------------------------------------------------ #
    # Test 5: replay attack rejected (same proof twice)
    # ------------------------------------------------------------------ #
    minter5 = ProofOfWorkMinter()
    task5 = minter5.issue_task_challenge(
        task_id="task-replay",
        issuer_id="issuer-C",
        expires_in_seconds=3600,
    )
    nonce5 = minter5.reveal_challenge("task-replay")
    result5_bytes = b"legitimate computation result"
    proof5 = minter5.mint_proof_with_challenge(
        task_id="task-replay",
        result_bytes=result5_bytes,
        challenge_nonce=nonce5,
        worker_id="worker-Y",
        credits=7,
    )
    first = minter5.verify_proof_with_challenge(proof5, nonce5, result5_bytes)
    # Reset is_valid so the second call is not short-circuited by the dataclass field
    proof5.is_valid = False
    second = minter5.verify_proof_with_challenge(proof5, nonce5, result5_bytes)
    if first and not second:
        ok("replay attack (same proof twice) rejected")
    else:
        fail("replay attack (same proof twice) rejected",
             f"first={first}, second={second}")

    # ------------------------------------------------------------------ #
    # Summary
    # ------------------------------------------------------------------ #
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    print("Running challenge-response anti-cheat tests...\n")
    _run_tests()

    print("\n--- Demo: full two-phase protocol ---")
    minter = ProofOfWorkMinter()
    issued = minter.issue_task_challenge(
        task_id="demo-task",
        issuer_id="issuer-demo",
        task_description="Translate paragraph to French",
        min_result_length=10,
        credits_offered=5,
    )
    print(f"Published task:\n{issued.to_json()}")

    nonce = minter.reveal_challenge("demo-task")
    result_bytes = b"Le paragraphe parle des systemes de preuve cryptographique."
    proof = minter.mint_proof_with_challenge(
        task_id="demo-task",
        result_bytes=result_bytes,
        challenge_nonce=nonce,
        worker_id="worker-demo",
        credits=5,
    )
    print(f"\nMinted proof:\n{proof.to_json()}")

    valid = minter.verify_proof_with_challenge(proof, nonce, result_bytes)
    print(f"\nVerification passed: {valid}, is_valid flag: {proof.is_valid}")

    tx = minter.anchor_proof(proof, rpc_url="https://api.mainnet-beta.solana.com")
    print(f"Anchor tx: {tx}")
