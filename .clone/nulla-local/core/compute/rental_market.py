"""
NULLA Compute Rental Market
===========================
Rent CPU/GPU/RAM to the mesh. Agents pay per token generated.

Payments: NULL credits (on-chain) or USDC via x402 payment rail.
"""

from __future__ import annotations

import subprocess
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class ComputeListing:
    node_id: str
    endpoint: str                    # e.g. "http://192.168.1.10:7860"
    hardware: dict                   # raw hardware_spec as provided / probed
    tokens_per_second: int           # estimated throughput
    price_per_1k_tokens: float       # in `currency` units
    currency: str                    # "NULL" | "USDC"
    min_rental_minutes: int
    available: bool


@dataclass
class RentalSession:
    session_id: str
    listing: ComputeListing
    duration_minutes: int
    started_at: float                # unix timestamp
    tokens_generated: int = 0
    active: bool = True


@dataclass
class WorkProof:
    """On-chain-ready proof that a node provided compute during a session."""
    session_id: str
    node_id: str
    duration_minutes: int
    tokens_generated: int
    total_cost: float
    currency: str
    ended_at: float
    # In production: sign this struct with the node's Ed25519 key and
    # submit to the NULL on-chain Proof-of-Right (POR) program.
    signature: Optional[str] = None


# ---------------------------------------------------------------------------
# Hardware probe
# ---------------------------------------------------------------------------

class HardwareProbe:
    """
    Reads actual machine specs.

    Dependencies
    ------------
    - psutil  (pip install psutil)
    - nvidia-smi (optional, present when an NVIDIA GPU is installed)
    """

    def probe(self) -> dict:
        """Return a dict describing this machine's hardware."""
        info: dict = {}

        # --- CPU / RAM via psutil ---
        try:
            import psutil  # type: ignore
            info["cpu_count"] = psutil.cpu_count(logical=False) or psutil.cpu_count()
            info["cpu_count_logical"] = psutil.cpu_count(logical=True)
            info["ram_gb"] = round(psutil.virtual_memory().total / (1024 ** 3), 1)
        except ImportError:
            import os
            info["cpu_count"] = os.cpu_count() or 1
            info["cpu_count_logical"] = info["cpu_count"]
            info["ram_gb"] = None  # psutil required for RAM

        # --- GPU via nvidia-smi ---
        gpu_info = self._probe_nvidia()
        if gpu_info:
            info["gpu_name"] = gpu_info.get("name")
            info["gpu_vram_gb"] = gpu_info.get("vram_gb")
        else:
            # Try to detect Apple Silicon via platform
            import platform
            machine = platform.machine().lower()
            proc = platform.processor().lower()
            if "arm" in machine or "apple" in proc:
                info["gpu_name"] = "Apple Silicon (MPS)"
                info["gpu_vram_gb"] = None  # unified memory; skip
            else:
                info["gpu_name"] = None
                info["gpu_vram_gb"] = None

        return info

    def _probe_nvidia(self) -> Optional[dict]:
        """Query nvidia-smi for GPU name and VRAM. Returns None if unavailable."""
        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                return None
            line = result.stdout.strip().splitlines()[0]
            parts = [p.strip() for p in line.split(",")]
            name = parts[0]
            vram_gb = round(int(parts[1]) / 1024, 1) if len(parts) > 1 else None
            return {"name": name, "vram_gb": vram_gb}
        except Exception:
            return None

    def estimate_tps(self, model_name: str) -> int:
        """
        Rough tokens-per-second estimate based on probed hardware and model.

        Benchmarks (single-user inference, quantised weights):
          - 7B  q4_K_M  on RTX 3090 (24 GB VRAM) : ~100 t/s
          - 7B  q4_K_M  on RTX 4090 (24 GB VRAM) : ~170 t/s
          - 7B  q4_K_M  on Apple M3 Pro (36 GB)  :  ~55 t/s
          - 7B  q4_K_M  on CPU-only (16-core)    :  ~12 t/s
          - 13B q4_K_M  on RTX 3090              :  ~55 t/s
          - 70B q4_K_M  on dual A100 80GB        :  ~40 t/s
        """
        hw = self.probe()
        model_lower = model_name.lower()

        # Determine model size class
        if any(tag in model_lower for tag in ("70b", "65b", "72b")):
            size_class = "70b"
        elif any(tag in model_lower for tag in ("34b", "33b", "30b")):
            size_class = "34b"
        elif any(tag in model_lower for tag in ("13b", "14b")):
            size_class = "13b"
        else:
            size_class = "7b"

        gpu = hw.get("gpu_name") or ""
        gpu_lower = gpu.lower()

        # GPU path
        if "4090" in gpu_lower:
            base = {"7b": 170, "13b": 90, "34b": 35, "70b": 0}[size_class]
        elif "3090" in gpu_lower or "3080" in gpu_lower:
            base = {"7b": 100, "13b": 55, "34b": 20, "70b": 0}[size_class]
        elif "a100" in gpu_lower or "h100" in gpu_lower:
            base = {"7b": 200, "13b": 110, "34b": 60, "70b": 40}[size_class]
        elif "apple" in gpu_lower or "mps" in gpu_lower:
            base = {"7b": 55, "13b": 28, "34b": 10, "70b": 0}[size_class]
        else:
            # CPU-only fallback; scale loosely with core count
            cores = hw.get("cpu_count") or 4
            factor = min(cores / 8, 2.5)
            base = {"7b": 12, "13b": 6, "34b": 2, "70b": 0}[size_class]
            base = max(1, int(base * factor))

        return max(1, base)


# ---------------------------------------------------------------------------
# Pricing helpers
# ---------------------------------------------------------------------------

# Reference prices in USDC per 1k tokens
_REFERENCE_PRICES_USDC = {
    "cpu": 0.0001,          # CPU-only node
    "gpu_rtx3090": 0.001,   # RTX 3090 / comparable
    "gpu_rtx4090": 0.0018,  # RTX 4090 / comparable
    "apple_m3pro": 0.0005,  # Apple Silicon M-series
    "gpu_a100": 0.004,      # Datacenter A100/H100
}

# NULL credit conversion: 1 USDC = 1000 NULL credits (governance-adjustable)
NULL_PER_USDC = 1000.0


def usdc_price_for_hardware(hw: dict) -> float:
    """Pick a USDC/1k-token reference price given a hardware dict."""
    gpu = (hw.get("gpu_name") or "").lower()
    if not gpu:
        return _REFERENCE_PRICES_USDC["cpu"]
    if "4090" in gpu:
        return _REFERENCE_PRICES_USDC["gpu_rtx4090"]
    if "3090" in gpu or "3080" in gpu:
        return _REFERENCE_PRICES_USDC["gpu_rtx3090"]
    if "a100" in gpu or "h100" in gpu:
        return _REFERENCE_PRICES_USDC["gpu_a100"]
    if "apple" in gpu or "mps" in gpu:
        return _REFERENCE_PRICES_USDC["apple_m3pro"]
    # Generic GPU: interpolate between CPU and 3090 prices
    return (_REFERENCE_PRICES_USDC["cpu"] + _REFERENCE_PRICES_USDC["gpu_rtx3090"]) / 2


# ---------------------------------------------------------------------------
# Compute Rental Market
# ---------------------------------------------------------------------------

class ComputeRentalMarket:
    """
    In-process stub for the NULLA compute rental mesh.

    Production replacement: each method becomes an RPC call to the
    NULLA coordinator (a Solana program + off-chain relay), with
    payments settled via the x402 NULL payment rail.
    """

    def __init__(self, node_id: Optional[str] = None, currency: str = "NULL"):
        self.node_id: str = node_id or f"node-{uuid.uuid4().hex[:8]}"
        self.currency: str = currency          # "NULL" or "USDC"
        self._listings: dict[str, ComputeListing] = {}
        self._sessions: dict[str, RentalSession] = {}
        self._probe = HardwareProbe()

    # ------------------------------------------------------------------
    # Provider side
    # ------------------------------------------------------------------

    def list_hardware(
        self,
        hardware_spec: dict,
        price: Optional[float] = None,
        endpoint: str = "http://localhost:7860",
        min_rental_minutes: int = 5,
    ) -> ComputeListing:
        """
        Advertise this node's hardware to the mesh.

        Parameters
        ----------
        hardware_spec : dict
            Keys: cpu_cores, ram_gb, gpu_name, gpu_vram_gb,
                  model_names_available (list[str])
        price : float | None
            Price per 1k tokens in `self.currency`.
            If None, auto-derived from reference pricing.
        endpoint : str
            Publicly reachable URL for the inference server.
        min_rental_minutes : int
            Minimum session length the node will accept.

        Returns
        -------
        ComputeListing
        """
        # Merge caller-provided spec with live probe for missing keys
        probed = self._probe.probe()
        hw: dict = {**probed, **hardware_spec}  # caller values win

        # Estimate TPS from first available model name
        models: list = hw.get("model_names_available") or []
        model_name = models[0] if models else "llama-7b"
        tps = self._probe.estimate_tps(model_name)

        # Derive price
        usdc_price = price if price is not None else usdc_price_for_hardware(hw)
        if self.currency == "NULL":
            final_price = usdc_price * NULL_PER_USDC
        else:
            final_price = usdc_price

        listing = ComputeListing(
            node_id=self.node_id,
            endpoint=endpoint,
            hardware=hw,
            tokens_per_second=tps,
            price_per_1k_tokens=round(final_price, 6),
            currency=self.currency,
            min_rental_minutes=min_rental_minutes,
            available=True,
        )
        self._listings[self.node_id] = listing
        return listing

    # ------------------------------------------------------------------
    # Consumer side
    # ------------------------------------------------------------------

    def discover_rentals(
        self,
        min_tps: int = 10,
        max_price: float = 10.0,
    ) -> list[ComputeListing]:
        """
        Return available listings meeting throughput and price constraints.

        Parameters
        ----------
        min_tps : int
            Minimum acceptable tokens-per-second.
        max_price : float
            Maximum price per 1k tokens (in listing's own currency).

        Returns
        -------
        list[ComputeListing] sorted by price ascending.

        TODO (production): broadcast a discovery query to the NULLA
        coordinator program; results come back via signed peer messages.
        """
        results = [
            l for l in self._listings.values()
            if l.available
            and l.tokens_per_second >= min_tps
            and l.price_per_1k_tokens <= max_price
        ]
        return sorted(results, key=lambda l: l.price_per_1k_tokens)

    def rent(
        self,
        listing: ComputeListing,
        duration_minutes: int,
    ) -> RentalSession:
        """
        Open a rental session against a listing.

        In production this locks NULL collateral on-chain via x402 and
        returns a signed capability token the renter presents to the node.

        Parameters
        ----------
        listing : ComputeListing
        duration_minutes : int
            Must be >= listing.min_rental_minutes.

        Returns
        -------
        RentalSession

        Raises
        ------
        ValueError if duration is below the listing minimum or the
        listing is not available.
        """
        if not listing.available:
            raise ValueError(f"Listing {listing.node_id} is not available.")
        if duration_minutes < listing.min_rental_minutes:
            raise ValueError(
                f"duration_minutes={duration_minutes} is below "
                f"minimum {listing.min_rental_minutes} for this listing."
            )

        session = RentalSession(
            session_id=f"sess-{uuid.uuid4().hex[:12]}",
            listing=listing,
            duration_minutes=duration_minutes,
            started_at=time.time(),
        )
        listing.available = False  # mark as occupied (single-tenant stub)
        self._sessions[session.session_id] = session
        return session

    def release(self, session: RentalSession) -> WorkProof:
        """
        Close a rental session and emit a WorkProof.

        The WorkProof records tokens generated and total cost. In
        production the node signs this struct with its Ed25519 key and
        submits it to the NULL POR program; the renter's locked
        collateral is released minus the cost.

        Parameters
        ----------
        session : RentalSession

        Returns
        -------
        WorkProof
        """
        if not session.active:
            raise ValueError(f"Session {session.session_id} is already closed.")

        session.active = False
        session.listing.available = True

        ended_at = time.time()
        elapsed_minutes = (ended_at - session.started_at) / 60

        # Estimate tokens generated if not tracked externally
        tokens = session.tokens_generated or int(
            session.listing.tokens_per_second * elapsed_minutes * 60
        )

        total_cost = round(
            (tokens / 1000) * session.listing.price_per_1k_tokens, 8
        )

        proof = WorkProof(
            session_id=session.session_id,
            node_id=session.listing.node_id,
            duration_minutes=round(elapsed_minutes, 3),
            tokens_generated=tokens,
            total_cost=total_cost,
            currency=session.listing.currency,
            ended_at=ended_at,
            # TODO: replace with node's Ed25519 signature over canonical hash
            signature=f"stub-sig-{uuid.uuid4().hex[:16]}",
        )
        return proof


# ---------------------------------------------------------------------------
# Quick smoke-test / demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=== NULLA Compute Rental — local smoke test ===\n")

    probe = HardwareProbe()
    hw = probe.probe()
    print("Detected hardware:", hw)

    tps_7b = probe.estimate_tps("llama-7b")
    tps_13b = probe.estimate_tps("llama-13b")
    print(f"Estimated TPS  7B model: {tps_7b}")
    print(f"Estimated TPS 13B model: {tps_13b}\n")

    market = ComputeRentalMarket(node_id="local-node-demo", currency="NULL")

    listing = market.list_hardware(
        hardware_spec={
            "cpu_cores": hw.get("cpu_count", 8),
            "ram_gb": hw.get("ram_gb", 16),
            "gpu_name": hw.get("gpu_name"),
            "gpu_vram_gb": hw.get("gpu_vram_gb"),
            "model_names_available": ["llama-7b", "mistral-7b"],
        },
        endpoint="http://localhost:7860",
        min_rental_minutes=1,
    )
    print("Listing created:")
    print(f"  node_id            : {listing.node_id}")
    print(f"  tokens_per_second  : {listing.tokens_per_second}")
    print(f"  price_per_1k_tokens: {listing.price_per_1k_tokens} {listing.currency}")
    print(f"  hardware           : {listing.hardware}\n")

    results = market.discover_rentals(min_tps=1, max_price=10_000)
    print(f"discover_rentals() returned {len(results)} listing(s)")

    session = market.rent(listing, duration_minutes=1)
    print(f"\nRental session opened: {session.session_id}")

    # Simulate some tokens being generated
    session.tokens_generated = listing.tokens_per_second * 60  # ~1 min worth

    proof = market.release(session)
    print(f"Session released. WorkProof:")
    print(f"  tokens_generated : {proof.tokens_generated}")
    print(f"  total_cost       : {proof.total_cost} {proof.currency}")
    print(f"  signature        : {proof.signature}")
