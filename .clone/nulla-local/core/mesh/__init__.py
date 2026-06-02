"""
core.mesh — Peer-to-peer task routing and credit accounting for the NULLA local LLM mesh.

Local LLMs (Qwen 14B, Llama, Mistral, etc.) running on MacBooks, phones, and servers
connect to each other without a central server.  One node broadcasts a task, peers bid
on it, the winning node executes and submits a proof-of-work receipt, and the ledger
settles in NULL credit units.
"""
from core.mesh.task_router import LocalNodeRegistry, MeshTaskRouter, TaskBid
from core.mesh.credit_ledger import CreditLedger

__all__ = [
    "TaskBid",
    "MeshTaskRouter",
    "LocalNodeRegistry",
    "CreditLedger",
]
