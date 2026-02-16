# ==============================================================================
# NEBULA V23.1 CORE - EVENT HORIZON COMPRESSION
# Source: Parad0x Labs Master Codex
# Purpose: Compresses transaction metadata (Memos/Logs) for Dark Protocol
# ==============================================================================

import zstandard as zstd
import struct
import json

PROTOCOL_ID = b'VOID'
VERSION = 231

class NebulaCore:
    def __init__(self):
        # Pre-trained dictionary for common crypto terms to boost ratio
        self.dict_data = zstd.ZstdCompressionParameters.from_level(22)

    def compress(self, data: dict) -> bytes:
        """Compresses a transaction payload into .void format"""
        json_bytes = json.dumps(data).encode('utf-8')

        cctx = zstd.ZstdCompressor(level=22)
        compressed = cctx.compress(json_bytes)

        # Header: VOID + Version(1) + OriginalSize(4) + Data
        header = struct.pack('>4sBI', PROTOCOL_ID, VERSION, len(json_bytes))
        return header + compressed

    def decompress(self, blob: bytes) -> dict:
        """Restores .void format to JSON"""
        if not blob.startswith(PROTOCOL_ID):
            raise ValueError("Invalid Nebula Artifact")

        header_size = struct.calcsize('>4sBI')
        _, _, orig_size = struct.unpack('>4sBI', blob[:header_size])

        dctx = zstd.ZstdDecompressor()
        payload = dctx.decompress(blob[header_size:])

        return json.loads(payload.decode('utf-8'))
