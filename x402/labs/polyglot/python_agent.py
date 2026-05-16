#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.request
from urllib.parse import urljoin

SDK_ROOT = pathlib.Path(__file__).resolve().parents[2] / "sdk" / "python"
sys.path.insert(0, str(SDK_ROOT))

from dna_x402 import verify_signed_receipt  # noqa: E402


def request_json(method, url, body=None, headers=None, expect_status=None):
    data = None
    merged_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        merged_headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=merged_headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw) if raw else None
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        payload = json.loads(raw) if raw else None
        status = error.code

    if expect_status is not None and status != expect_status:
        raise RuntimeError(f"{method} {url} expected {expect_status}, got {status}: {payload}")
    return status, payload


def payment_proof(agent_id, quote, settlement, payment_helper_url=None):
    if payment_helper_url and settlement in ("transfer", "stream"):
        _, helper = request_json("POST", payment_helper_url, {
            "agentId": agent_id,
            "quoteId": quote["quoteId"],
            "settlement": settlement,
            "amountAtomic": quote["totalAtomic"],
            "recipient": quote["recipient"],
            "mint": quote["mint"],
        }, expect_status=200)
        proof = helper.get("paymentProof")
        if not isinstance(proof, dict):
            raise RuntimeError("payment helper did not return paymentProof")
        return proof

    digest = hashlib.sha256(f"{agent_id}:{quote['quoteId']}:{settlement}".encode("utf-8")).hexdigest()
    if settlement == "netting":
        return {
            "settlement": "netting",
            "amountAtomic": quote["totalAtomic"],
            "note": f"python-agent:{agent_id}",
        }
    if settlement == "stream":
        return {
            "settlement": "stream",
            "streamId": f"python-stream-{digest[:40]}",
            "amountAtomic": quote["totalAtomic"],
        }
    return {
        "settlement": "transfer",
        "txSignature": f"python-transfer-{digest}",
        "amountAtomic": quote["totalAtomic"],
    }


def main():
    parser = argparse.ArgumentParser(description="Raw Python x402 buyer agent")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--resource", required=True)
    parser.add_argument("--agent-id", default="python-agent")
    parser.add_argument("--settlement", choices=["transfer", "stream", "netting"], default=None)
    parser.add_argument("--payment-helper-url", default=None)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    resource_url = urljoin(base_url + "/", args.resource.lstrip("/"))

    unpaid_status, unpaid = request_json("GET", resource_url, expect_status=402)
    requirements = unpaid["paymentRequirements"]
    quote = requirements["quote"]
    settlement = args.settlement or requirements["recommendedMode"]
    commitment = hashlib.sha256(f"{args.agent_id}:{quote['quoteId']}".encode("utf-8")).hexdigest()

    commit_url = requirements["commitEndpoint"]
    finalize_url = requirements["finalizeEndpoint"]
    receipt_template = requirements["receiptEndpoint"]

    _, commit = request_json("POST", commit_url, {
        "quoteId": quote["quoteId"],
        "payerCommitment32B": commitment,
    }, expect_status=201)

    proof = payment_proof(args.agent_id, quote, settlement, args.payment_helper_url)
    _, finalized = request_json("POST", finalize_url, {
        "commitId": commit["commitId"],
        "paymentProof": proof,
    }, expect_status=200)

    receipt_url = receipt_template.replace(":receiptId", finalized["receiptId"])
    _, receipt = request_json("GET", receipt_url, expect_status=200)
    paid_status, paid = request_json("GET", resource_url, headers={
        "x-dnp-commit-id": commit["commitId"],
    }, expect_status=200)

    if not verify_signed_receipt(receipt):
        raise RuntimeError("native Python receipt signature verification failed")

    receipt_payload = receipt.get("payload", {})
    if receipt_payload.get("quoteId") != quote["quoteId"]:
        raise RuntimeError("receipt quoteId mismatch")
    if receipt_payload.get("commitId") != commit["commitId"]:
        raise RuntimeError("receipt commitId mismatch")
    if receipt_payload.get("payerCommitment32B") != commitment:
        raise RuntimeError("receipt payer commitment mismatch")
    if receipt_payload.get("settlement") != settlement:
        raise RuntimeError("receipt settlement mismatch")

    summary = {
        "ok": True,
        "agentLanguage": "python",
        "agentId": args.agent_id,
        "resource": args.resource,
        "unpaidStatus": unpaid_status,
        "paidStatus": paid_status,
        "settlement": settlement,
        "txSignature": proof.get("txSignature"),
        "topupSignature": proof.get("topupSignature"),
        "streamId": proof.get("streamId"),
        "quoteId": quote["quoteId"],
        "commitId": commit["commitId"],
        "receiptId": finalized["receiptId"],
        "receiptHash": receipt.get("receiptHash"),
        "signerPublicKey": receipt.get("signerPublicKey"),
        "fixtureId": paid.get("fixtureId"),
        "output": paid.get("output"),
        "seller_defined": paid.get("seller_defined"),
        "verifiable": paid.get("verifiable"),
    }
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
