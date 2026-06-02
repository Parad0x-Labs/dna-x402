"""
core.mesh.task_router
=====================
Peer-to-peer task routing for the NULLA local LLM mesh.

Design
------
* No central server.  Every node is both a task poster and a potential worker.
* A poster broadcasts a TASK_OFFER envelope to discovered peers.
* Peers reply with TaskBid envelopes (credits_requested in NULL credit units).
* The poster picks the winning bid (lowest cost / best latency / highest trust).
* The winning node executes the task locally, then calls submit_result().
* Proof-of-work = SHA-256(task_id + result_text + node_id).  The receipt is
  anchored via the existing receipt_anchor / contribution_proof pattern.

Integration points
------------------
* network.signer          — get_local_peer_id(), sign_payload()
* network.peer_manager    — PeerManager.mark_seen(), trust_score
* core.discovery_index    — endpoint_for_peer(), register_peer_endpoint()
* core.contribution_proof — append_contribution_proof_receipt()
* core.credit_ledger      — award_credits(), burn_credits()
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class TaskBid:
    """A bid submitted by a peer node in response to a TASK_OFFER broadcast."""

    task_id: str
    """UUID identifying the task that was offered."""

    bidder_node_id: str
    """Peer ID of the bidding node (from network.signer.get_local_peer_id)."""

    bidder_endpoint: str
    """HTTP(S) or raw TCP address where the bidder can be reached, e.g.
    ``http://192.168.1.42:8765``."""

    model_name: str
    """Local model the bidder will use, e.g. ``qwen2.5:14b`` or ``llama3.2:3b``."""

    estimated_tokens: int
    """Rough token budget estimate for completing the task (output tokens)."""

    credits_requested: float
    """NULL credits the bidder wants in exchange for completing the task."""

    signature: str
    """Ed25519 / secp256k1 hex signature over the canonical JSON of the other
    fields.  Produced by network.signer.sign_payload()."""

    received_at: float = field(default_factory=time.time)
    """Wall-clock timestamp (UNIX epoch) when this bid arrived at the poster."""

    def canonical_payload(self) -> str:
        """Deterministic JSON string used for signature verification."""
        d = {
            "task_id": self.task_id,
            "bidder_node_id": self.bidder_node_id,
            "bidder_endpoint": self.bidder_endpoint,
            "model_name": self.model_name,
            "estimated_tokens": self.estimated_tokens,
            "credits_requested": self.credits_requested,
        }
        return json.dumps(d, sort_keys=True, separators=(",", ":"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Mesh task router
# ---------------------------------------------------------------------------


class MeshTaskRouter:
    """
    High-level coordinator that handles the full lifecycle of a mesh task:
    broadcast → bid collection → assignment → result submission → verification.

    Parameters
    ----------
    node_registry:
        The local node registry used to discover peers.  If *None* a fresh
        :class:`LocalNodeRegistry` is created.
    bid_timeout_seconds:
        How long to wait for peer bids before closing the auction.
    """

    def __init__(
        self,
        node_registry: "LocalNodeRegistry | None" = None,
        *,
        bid_timeout_seconds: float = 4.0,
    ) -> None:
        self._registry = node_registry or LocalNodeRegistry()
        self._bid_timeout = float(bid_timeout_seconds)
        # In-memory store of active task bids keyed by task_id.
        # In production this can be replaced by a shared DB or Redis.
        self._bids: dict[str, list[TaskBid]] = {}
        self._assignments: dict[str, TaskBid] = {}
        self._results: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Broadcast
    # ------------------------------------------------------------------

    def broadcast_task(
        self,
        task: dict[str, Any],
        credits_offered: int,
        *,
        task_id: str | None = None,
    ) -> list[TaskBid]:
        """
        Send a task offer to all known mesh peers and collect their bids.

        Parameters
        ----------
        task:
            Arbitrary dict describing the work.  Must contain at least a
            ``"prompt"`` key.
        credits_offered:
            Maximum NULL credits the poster is willing to pay.
        task_id:
            Optional stable ID.  A UUID is generated when omitted.

        Returns
        -------
        list[TaskBid]
            All valid bids received within *bid_timeout_seconds*, sorted by
            ``credits_requested`` ascending (cheapest first).
        """
        tid = str(task_id or uuid.uuid4())
        task = dict(task)
        task.setdefault("task_id", tid)

        offer_payload = {
            "task_id": tid,
            "task": task,
            "credits_offered": credits_offered,
            "poster_node_id": self._registry.local_node_id,
            "poster_endpoint": self._registry.local_endpoint,
            "timestamp": time.time(),
        }

        peers = self._registry.discover_peers()
        logger.info(
            "mesh:broadcast task_id=%s credits_offered=%d peers=%d",
            tid,
            credits_offered,
            len(peers),
        )

        bids: list[TaskBid] = []
        for peer in peers:
            try:
                bid = self._solicit_bid(peer, offer_payload)
                if bid is not None:
                    bids.append(bid)
            except Exception as exc:  # pragma: no cover
                logger.debug("mesh:bid_error peer=%s err=%s", peer.get("endpoint"), exc)

        # Sort cheapest-first so accept_bid() can just take [0].
        bids.sort(key=lambda b: b.credits_requested)
        self._bids[tid] = bids
        return bids

    def _solicit_bid(
        self,
        peer: dict[str, Any],
        offer_payload: dict[str, Any],
    ) -> TaskBid | None:
        """
        Send a TASK_OFFER HTTP POST to a single peer and parse the TaskBid reply.

        Falls back gracefully when the peer is unreachable or returns an invalid
        response — returns *None* in that case.
        """
        endpoint = str(peer.get("endpoint") or "").rstrip("/")
        if not endpoint:
            return None

        try:
            import requests  # type: ignore[import]

            resp = requests.post(
                f"{endpoint}/mesh/bid",
                json=offer_payload,
                timeout=self._bid_timeout,
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
        except Exception as exc:
            logger.debug("mesh:solicit_bid failed endpoint=%s err=%s", endpoint, exc)
            return None

        # Validate required fields.
        required = {"task_id", "bidder_node_id", "bidder_endpoint", "model_name",
                    "estimated_tokens", "credits_requested", "signature"}
        if not required.issubset(data.keys()):
            logger.debug("mesh:bid_incomplete endpoint=%s keys=%s", endpoint, list(data.keys()))
            return None

        bid = TaskBid(
            task_id=str(data["task_id"]),
            bidder_node_id=str(data["bidder_node_id"]),
            bidder_endpoint=str(data["bidder_endpoint"]),
            model_name=str(data["model_name"]),
            estimated_tokens=int(data["estimated_tokens"]),
            credits_requested=float(data["credits_requested"]),
            signature=str(data["signature"]),
        )

        # Sanity guard: reject bids for other tasks.
        if bid.task_id != offer_payload["task_id"]:
            return None

        return bid

    # ------------------------------------------------------------------
    # Assignment
    # ------------------------------------------------------------------

    def accept_bid(self, bid: TaskBid) -> dict[str, Any]:
        """
        Accept a peer's bid and formally assign the task.

        Side-effects
        ------------
        * Escrows the required credits in the local CreditLedger.
        * Notifies the winning peer via ``POST /mesh/assign``.
        * Records the assignment in ``self._assignments``.

        Returns
        -------
        dict  Assignment confirmation, including ``"assigned"`` bool.
        """
        tid = bid.task_id
        self._assignments[tid] = bid

        # Escrow credits so they cannot be double-spent.
        try:
            from core.credit_ledger import CreditLedger  # local import avoids cycle
            ledger = CreditLedger(node_id=self._registry.local_node_id)
            ledger.spend(
                task_id=tid,
                amount=bid.credits_requested,
                recipient=bid.bidder_node_id,
            )
        except Exception as exc:
            logger.warning("mesh:escrow_failed task_id=%s err=%s", tid, exc)

        # Notify winning peer.
        try:
            import requests  # type: ignore[import]

            requests.post(
                f"{bid.bidder_endpoint.rstrip('/')}/mesh/accept",
                json={
                    "task_id": tid,
                    "assigned_to": bid.bidder_node_id,
                    "credits_promised": bid.credits_requested,
                    "poster_node_id": self._registry.local_node_id,
                },
                timeout=4.0,
            )
        except Exception as exc:
            logger.debug("mesh:accept_notify_failed endpoint=%s err=%s", bid.bidder_endpoint, exc)

        logger.info(
            "mesh:assigned task_id=%s to=%s model=%s credits=%.2f",
            tid,
            bid.bidder_node_id,
            bid.model_name,
            bid.credits_requested,
        )
        return {
            "assigned": True,
            "task_id": tid,
            "winning_node": bid.bidder_node_id,
            "credits_escrowed": bid.credits_requested,
        }

    # ------------------------------------------------------------------
    # Result submission & verification
    # ------------------------------------------------------------------

    def submit_result(
        self,
        task_id: str,
        result: str,
        proof_hash: str | None = None,
        *,
        node_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Called by the *worker* node after it has finished executing a task.

        Computes (and optionally validates) the SHA-256 proof-of-work hash,
        then appends a contribution receipt via ``core.contribution_proof``.

        Parameters
        ----------
        task_id:   The task being reported on.
        result:    The LLM output / completed work product.
        proof_hash:
            Pre-computed proof hash.  When *None* the canonical hash is
            computed automatically: ``SHA-256(task_id + result + node_id)``.
        node_id:   The worker's node ID.  Defaults to the local node.

        Returns
        -------
        dict  With keys ``"accepted"``, ``"proof_hash"``, ``"receipt_id"``.
        """
        worker_id = str(node_id or self._registry.local_node_id)
        canonical_hash = _compute_proof_hash(task_id, result, worker_id)

        if proof_hash and proof_hash != canonical_hash:
            logger.warning(
                "mesh:proof_mismatch task_id=%s expected=%s got=%s",
                task_id, canonical_hash, proof_hash,
            )
            return {"accepted": False, "reason": "proof_hash_mismatch", "task_id": task_id}

        receipt_id = f"mesh_result:{task_id}:{worker_id}"
        self._results[task_id] = {
            "result": result,
            "proof_hash": canonical_hash,
            "worker_id": worker_id,
            "receipt_id": receipt_id,
            "submitted_at": time.time(),
        }

        # Append a durable contribution proof receipt.
        try:
            from core.contribution_proof import append_contribution_proof_receipt

            assignment = self._assignments.get(task_id)
            credits = float(assignment.credits_requested) if assignment else 0.0
            append_contribution_proof_receipt(
                entry_id=receipt_id,
                task_id=task_id,
                helper_peer_id=worker_id,
                parent_peer_id=self._registry.local_node_id,
                stage="mesh_result",
                outcome="submitted",
                compute_credits=credits,
                evidence={"proof_hash": canonical_hash, "result_chars": len(result)},
            )
        except Exception as exc:
            logger.debug("mesh:contribution_proof_failed task_id=%s err=%s", task_id, exc)

        logger.info(
            "mesh:result_submitted task_id=%s worker=%s hash=%s",
            task_id, worker_id, canonical_hash[:16],
        )
        return {"accepted": True, "proof_hash": canonical_hash, "receipt_id": receipt_id, "task_id": task_id}

    def verify_result(
        self,
        task_id: str,
        result: str,
        proof_hash: str,
        *,
        node_id: str | None = None,
    ) -> bool:
        """
        Verify that *result* matches *proof_hash*.

        Uses the same canonical hash formula:
        ``SHA-256(task_id + result + node_id)``.

        Returns *True* when the hash is valid, *False* otherwise.
        """
        stored = self._results.get(task_id)
        worker_id = str(
            node_id
            or (stored and stored.get("worker_id"))
            or self._registry.local_node_id
        )
        expected = _compute_proof_hash(task_id, result, worker_id)
        ok = proof_hash == expected
        if not ok:
            logger.warning(
                "mesh:verify_failed task_id=%s expected=%s got=%s",
                task_id, expected, proof_hash,
            )
        return ok


# ---------------------------------------------------------------------------
# Local node registry
# ---------------------------------------------------------------------------


class LocalNodeRegistry:
    """
    Lightweight in-process peer registry for the local NULLA mesh node.

    In a real deployment this would sync via mDNS / DHT / relay.  Here we
    provide a clean interface that can be backed by the existing
    ``core.discovery_index`` and ``network.peer_manager`` infrastructure.

    Parameters
    ----------
    node_id:
        This node's peer ID.  Defaults to ``network.signer.get_local_peer_id()``.
    endpoint:
        The URL at which this node's mesh HTTP server is reachable.
    model_name:
        The local LLM model name advertised to peers.
    """

    def __init__(
        self,
        node_id: str | None = None,
        endpoint: str = "",
        model_name: str = "",
    ) -> None:
        self._node_id: str = str(node_id or _resolve_local_node_id())
        self.local_endpoint: str = endpoint
        self.local_model_name: str = model_name
        self.local_capabilities: list[str] = []
        # Mutable in-memory peer list; updated by discover_peers().
        self._peers: list[dict[str, Any]] = []

    @property
    def local_node_id(self) -> str:
        return self._node_id

    def register_self(
        self,
        endpoint: str,
        model_name: str,
        capabilities: list[str] | None = None,
    ) -> None:
        """
        Announce this node's presence to the mesh.

        Persists the endpoint in ``core.discovery_index`` so the daemon can
        relay it to peers via CAPABILITY_AD / HELLO_AD messages.

        Parameters
        ----------
        endpoint:     Public URL of this node's mesh HTTP server.
        model_name:   LLM model running locally, e.g. ``"qwen2.5:14b"``.
        capabilities: Free-form list of tags, e.g. ``["code", "vision"]``.
        """
        self.local_endpoint = str(endpoint or "").strip()
        self.local_model_name = str(model_name or "").strip()
        self.local_capabilities = list(capabilities or [])

        try:
            from core.discovery_index import register_peer_endpoint

            register_peer_endpoint(self._node_id, self.local_endpoint)
        except Exception as exc:
            logger.debug("registry:register_self failed err=%s", exc)

        logger.info(
            "registry:registered node_id=%s endpoint=%s model=%s caps=%s",
            self._node_id, self.local_endpoint, self.local_model_name,
            self.local_capabilities,
        )

    def discover_peers(self) -> list[dict[str, Any]]:
        """
        Return a list of currently known online peers.

        Each entry is a dict with at minimum:
        ``{"node_id": str, "endpoint": str, "model_name": str, "latency_ms": float}``.

        The registry first tries ``core.discovery_index``, then falls back to
        the in-memory peer list populated by previous ``ping_peer()`` calls.
        """
        peers: list[dict[str, Any]] = []

        try:
            from core.discovery_index import list_known_peers  # may not exist yet

            raw = list_known_peers()  # type: ignore[attr-defined]
            for p in raw or []:
                if str(p.get("peer_id") or "") == self._node_id:
                    continue  # exclude self
                peers.append({
                    "node_id": str(p.get("peer_id") or ""),
                    "endpoint": str(p.get("endpoint") or ""),
                    "model_name": str(p.get("model_name") or "unknown"),
                    "latency_ms": float(p.get("latency_ms") or 0.0),
                })
        except Exception:
            # Fallback to in-memory list (populated by register_self / ping_peer).
            peers = [p for p in self._peers if p.get("node_id") != self._node_id]

        return peers

    def ping_peer(self, endpoint: str) -> float:
        """
        Send a lightweight HTTP GET to ``/mesh/ping`` and return round-trip
        latency in milliseconds.

        Updates the in-memory peer list on success.  Returns -1.0 when the
        peer is unreachable.

        Parameters
        ----------
        endpoint:  Full base URL, e.g. ``"http://192.168.1.10:8765"``.
        """
        url = f"{endpoint.rstrip('/')}/mesh/ping"
        start = time.perf_counter()
        try:
            import requests  # type: ignore[import]

            resp = requests.get(url, timeout=3.0)
            elapsed_ms = (time.perf_counter() - start) * 1000.0

            if resp.ok:
                data = resp.json()
                node_id = str(data.get("node_id") or "")
                model_name = str(data.get("model_name") or "unknown")

                # Upsert into in-memory list.
                for p in self._peers:
                    if p.get("endpoint") == endpoint:
                        p["latency_ms"] = elapsed_ms
                        p["node_id"] = node_id
                        p["model_name"] = model_name
                        break
                else:
                    self._peers.append({
                        "node_id": node_id,
                        "endpoint": endpoint,
                        "model_name": model_name,
                        "latency_ms": elapsed_ms,
                    })

                # Persist in discovery index.
                try:
                    from core.discovery_index import register_peer_endpoint
                    if node_id:
                        register_peer_endpoint(node_id, endpoint)
                except Exception:
                    pass

                logger.debug("registry:ping ok endpoint=%s latency=%.1fms", endpoint, elapsed_ms)
                return elapsed_ms

        except Exception as exc:
            logger.debug("registry:ping failed endpoint=%s err=%s", endpoint, exc)

        return -1.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compute_proof_hash(task_id: str, result: str, node_id: str) -> str:
    """
    Canonical proof-of-work hash: ``SHA-256(task_id + result + node_id)``.

    This is the receipt anchor referenced by the credit ledger and the
    contribution proof store.
    """
    raw = (str(task_id) + str(result) + str(node_id)).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _resolve_local_node_id() -> str:
    """Return the local node's peer ID from ``network.signer``, or a stable fallback."""
    try:
        from network.signer import get_local_peer_id

        return get_local_peer_id()
    except Exception:
        pass
    # Deterministic fallback: hostname-based UUID so restarts get the same ID.
    import socket

    hostname = socket.gethostname()
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, hostname))
