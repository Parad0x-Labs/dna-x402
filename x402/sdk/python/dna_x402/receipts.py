import base64
import hashlib
import json
from typing import Any, Mapping

P = 2**255 - 19
Q = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
I = pow(2, (P - 1) // 4, P)


def _hash_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_body(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, (bytes, bytearray, memoryview)):
        encoded = base64.urlsafe_b64encode(bytes(value)).rstrip(b"=").decode("ascii")
        return f"base64:{encoded}"
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def compute_request_digest(method: str, path: str, body: Any = None) -> str:
    return _hash_hex(f"{method.upper()}|{path}|{_canonical_body(body)}")


def compute_response_digest(status: int, body: Any = None) -> str:
    return _hash_hex(f"{status}|{_canonical_body(body)}")


def normalize_commitment_32b(value: str) -> str:
    normalized = value[2:] if value.startswith("0x") else value
    if len(normalized) != 64 or any(ch not in "0123456789abcdefABCDEF" for ch in normalized):
        raise ValueError("payerCommitment32B must be 32-byte hex (64 chars)")
    return normalized.lower()


def _base58_decode(value: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    acc = 0
    for ch in value:
        idx = alphabet.find(ch)
        if idx == -1:
            raise ValueError("invalid base58 character")
        acc = acc * 58 + idx
    raw = acc.to_bytes((acc.bit_length() + 7) // 8, "big") if acc else b""
    pad = len(value) - len(value.lstrip("1"))
    return b"\x00" * pad + raw


def _xrecover(y: int, sign: int) -> int:
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P)
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = (x * I) % P
    if (x * x - xx) % P != 0:
        raise ValueError("invalid ed25519 point")
    if (x & 1) != sign:
        x = P - x
    return x


def _decode_point(encoded: bytes) -> tuple[int, int]:
    if len(encoded) != 32:
        raise ValueError("ed25519 point must be 32 bytes")
    y = int.from_bytes(encoded, "little") & ((1 << 255) - 1)
    sign = encoded[31] >> 7
    if y >= P:
        raise ValueError("invalid ed25519 y coordinate")
    return (_xrecover(y, sign), y)


def _point_add(p1: tuple[int, int], p2: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = p1
    x2, y2 = p2
    denom = pow(1 + D * x1 * x2 * y1 * y2, P - 2, P)
    x3 = ((x1 * y2 + x2 * y1) * denom) % P
    denom_y = pow(1 - D * x1 * x2 * y1 * y2, P - 2, P)
    y3 = ((y1 * y2 + x1 * x2) * denom_y) % P
    return x3, y3


B = (_xrecover(4 * pow(5, P - 2, P) % P, 0), 4 * pow(5, P - 2, P) % P)


def _scalar_mult(point: tuple[int, int], scalar: int) -> tuple[int, int]:
    result = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def _ed25519_verify(public_key: bytes, signature: bytes, message: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    try:
        a = _decode_point(public_key)
        r = _decode_point(signature[:32])
    except ValueError:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= Q:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % Q
    return _scalar_mult(B, s) == _point_add(r, _scalar_mult(a, h))


def _receipt_hash_input(receipt: Mapping[str, Any]) -> str:
    return json.dumps(
        {
            "prevHash": receipt["prevHash"],
            "payload": receipt["payload"],
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )


def verify_signed_receipt(receipt: Mapping[str, Any]) -> bool:
    try:
        receipt_hash = hashlib.sha256(_receipt_hash_input(receipt).encode("utf-8")).hexdigest()
        if receipt_hash != receipt["receiptHash"]:
            return False
        signature = _base58_decode(receipt["signature"])
        public_key = _base58_decode(receipt["signerPublicKey"])
        return _ed25519_verify(public_key, signature, bytes.fromhex(receipt_hash))
    except Exception:
        return False


def _detached_payload(payload: Any) -> bytes:
    return hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).digest()


def verify_detached_signature(payload: Any, signature: str, signer_public_key: str) -> bool:
    try:
        return _ed25519_verify(
            _base58_decode(signer_public_key),
            _base58_decode(signature),
            _detached_payload(payload),
        )
    except Exception:
        return False


def _signable_quote_payload(quote: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "quoteId": quote["quoteId"],
        "shopId": quote["shopId"],
        "endpointId": quote["endpointId"],
        "method": quote["method"],
        "path": quote["path"],
        "capabilityTags": quote["capabilityTags"],
        "price": quote["price"],
        "mint": quote["mint"],
        "expiresAt": quote["expiresAt"],
        "expectedLatencyMs": quote["expectedLatencyMs"],
        "load": quote["load"],
        "reputation": quote["reputation"],
        "badges": quote.get("badges"),
        "settlementModes": quote["settlementModes"],
        "rankScore": quote["rankScore"],
    }


def verify_quote_signature(quote: Mapping[str, Any], signer_public_key: str) -> bool:
    signature = quote.get("signature")
    if not isinstance(signature, str):
        return False
    return verify_detached_signature(_signable_quote_payload(quote), signature, signer_public_key)


def verify_receipt_binding(
    receipt: Mapping[str, Any],
    *,
    request_digest: str,
    response_digest: str,
    recipient: str | None = None,
    mint: str | None = None,
    total_atomic: str | None = None,
) -> bool:
    payload = receipt.get("payload")
    if not isinstance(payload, Mapping):
        return False
    if payload.get("requestDigest") != request_digest:
        return False
    if payload.get("responseDigest") != response_digest:
        return False
    if recipient is not None and payload.get("recipient") != recipient:
        return False
    if mint is not None and payload.get("mint") != mint:
        return False
    if total_atomic is not None and payload.get("totalAtomic") != total_atomic:
        return False
    return True
