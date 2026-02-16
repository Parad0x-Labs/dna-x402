#!/usr/bin/env python3
"""
PIE ENGINE CLI - Universal Compression Bridge
==============================================

MODES:
  img:compress  - Compress image to NLZ1 artifact
  img:restore   - Restore image from NLZ1 artifact
  img:roundtrip - Full compress+restore cycle
  pdx:pack      - Byte-exact pack any file (100% identical)
  pdx:unpack    - Byte-exact unpack from PDX

Usage:
    python pie_cli.py img:compress  --in photo.jpg --out photo.nlz1 --policy policy_image.json
    python pie_cli.py img:restore   --in photo.nlz1 --out restored.png
    python pie_cli.py img:roundtrip --in photo.jpg --out restored.png --keep-artifact
    python pie_cli.py pdx:pack      --in document.txt --out document.pdx
    python pie_cli.py pdx:unpack    --in document.pdx --out document.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# ----------------------------
# Config: paths to your tools
# ----------------------------
SCRIPT_DIR = Path(__file__).parent
DEFAULT_LAZARUS = str(SCRIPT_DIR / "lazarus20x_encoder.py")
DEFAULT_NULL_VM = str(SCRIPT_DIR / "null_vm.py")

# PDX Magic
PDX_MAGIC = b"PDX1"
CHUNK_DATA = 1

# Try zstd
try:
    import zstandard as zstd
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False


# ==============================================================================
# POLICY HANDLING
# ==============================================================================

def load_policy(policy_path: Optional[str]) -> Dict[str, Any]:
    """Load policy JSON file."""
    if not policy_path:
        return {}
    p = Path(policy_path)
    if not p.exists():
        print(f"[WARN] Policy file not found: {policy_path}, using defaults")
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def choose_downscale(policy: Dict[str, Any], default: int = 8) -> int:
    """
    Derive downscale factor from policy hints.
    Smaller downscale = higher quality, larger file.
    Larger downscale = lower quality, smaller file.
    """
    # Explicit override
    if "downscale" in policy:
        try:
            return int(policy["downscale"])
        except Exception:
            pass

    # "target_size_kb" heuristic
    tsk = policy.get("target_size_kb")
    if isinstance(tsk, int):
        if tsk <= 50:
            return 32
        if tsk <= 120:
            return 16
        return 8

    # "target_quality" heuristic
    tq = policy.get("target_quality")
    if isinstance(tq, int):
        if tq >= 92:
            return 8
        if tq >= 80:
            return 16
        return 32

    return default


# ==============================================================================
# UTILITIES
# ==============================================================================

def run(cmd: list[str], cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    """Run a command and raise on failure."""
    print(f"[CMD] {' '.join(str(c) for c in cmd)}")
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, errors='replace')
    if p.returncode != 0:
        raise RuntimeError(
            f"Command failed (exit {p.returncode}):\n"
            f"CMD: {' '.join(str(c) for c in cmd)}\n"
            f"STDOUT:\n{p.stdout}\n"
            f"STDERR:\n{p.stderr}\n"
        )
    if p.stdout.strip():
        print(p.stdout.strip())
    return p


def find_ppm_output(search_dir: Path, preferred_name: str = None) -> Optional[Path]:
    """Find the .ppm output file."""
    ppms = list(search_dir.glob("*.ppm"))
    if not ppms:
        return None

    # Prefer specific name if given
    if preferred_name:
        for ppm in ppms:
            if ppm.name == preferred_name:
                return ppm

    # Return newest
    return max(ppms, key=lambda p: p.stat().st_mtime)


def convert_ppm_to_png(ppm_path: Path, out_png: Path) -> None:
    """Convert PPM to PNG using PIL, ffmpeg, or ImageMagick."""
    out_png.parent.mkdir(parents=True, exist_ok=True)

    # Try PIL first (most likely available)
    try:
        from PIL import Image
        img = Image.open(ppm_path)
        img.save(out_png, "PNG")
        print(f"[PIL] Converted {ppm_path.name} -> {out_png.name}")
        return
    except ImportError:
        pass

    # Try ffmpeg
    if shutil.which("ffmpeg"):
        run(["ffmpeg", "-y", "-i", str(ppm_path), str(out_png)])
        return

    # Try ImageMagick
    if shutil.which("magick"):
        run(["magick", str(ppm_path), str(out_png)])
        return

    raise RuntimeError("Need PIL, ffmpeg, or ImageMagick. pip install Pillow")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ==============================================================================
# IMAGE COMPRESSION (LAZARUS / NLZ1)
# ==============================================================================

def generate_restore_bytecode(nlz1_path: str, output_ppm: str) -> bytes:
    """Generate Null VM bytecode to restore an NLZ1 artifact."""
    OP_START = 0x01
    OP_END = 0x02
    LL_OPEN = 0xE8
    LL_LOAD = 0xE9
    LL_RENDER = 0xEA
    LL_SAVE = 0xEB
    LL_STAT = 0xEC
    LL_CLOSE = 0xED

    def make_str(s: str) -> bytes:
        b = s.encode('utf-8')
        return bytes([len(b)]) + b

    bc = bytearray(b"NULL")
    bc.append(OP_START)
    bc.append(LL_OPEN)
    bc.append(LL_LOAD)
    bc.extend(make_str(nlz1_path))
    bc.append(LL_RENDER)
    bc.append(LL_STAT)
    bc.append(LL_SAVE)
    bc.extend(make_str(output_ppm))
    bc.append(LL_CLOSE)
    bc.append(OP_END)

    return bytes(bc)


def img_compress(args: argparse.Namespace) -> None:
    """Compress image to NLZ1 using Lazarus."""
    if not args.policy:
        print("[WARN] No policy file specified, using defaults (downscale=8)")

    policy = load_policy(args.policy)
    downscale = choose_downscale(policy)

    print(f"[IMG:COMPRESS] {args.input} -> {args.output} (downscale={downscale})")

    # Create temp dir for intermediate files
    with tempfile.TemporaryDirectory(prefix="pie_img_") as tmp:
        tmp_path = Path(tmp)

        # Step 1: Convert to PPM if needed
        input_path = Path(args.input)
        if input_path.suffix.lower() in ('.png', '.jpg', '.jpeg'):
            ppm_path = tmp_path / f"{input_path.stem}.ppm"
            print(f"[CONVERT] {input_path.name} -> {ppm_path.name}")
            convert_png_jpg_to_ppm(input_path, ppm_path)
            source_ppm = ppm_path
        else:
            # Assume it's already PPM
            source_ppm = input_path

        # Step 2: Run Lazarus compression
        nlz1_path = tmp_path / "output.nlz1"
        lazarus_cmd = [
            sys.executable, DEFAULT_LAZARUS,
            "--input", str(source_ppm),
            "--output", str(nlz1_path),
            "--downscale", str(downscale)
        ]

        try:
            run(lazarus_cmd)
        except Exception as e:
            print(f"[ERROR] Lazarus failed: {e}")
            print("[INFO] Make sure lazarus20x_encoder.py is in the same directory")
            raise

        # Step 3: Copy final artifact
        shutil.copy2(nlz1_path, args.output)
        print(f"[SUCCESS] Compressed {args.input} -> {args.output}")


def img_restore(args: argparse.Namespace) -> None:
    """Restore image from NLZ1 using Null VM."""
    print(f"[IMG:RESTORE] {args.input} -> {args.output}")

    with tempfile.TemporaryDirectory(prefix="pie_restore_") as tmp:
        tmp_path = Path(tmp)

        # Generate bytecode
        ppm_output = tmp_path / "restored.ppm"
        bc = generate_restore_bytecode(args.input, str(ppm_output))

        # Write bytecode to file
        bc_path = tmp_path / "restore.bc"
        bc_path.write_bytes(bc)

        # Run Null VM
        vm_cmd = [
            sys.executable, DEFAULT_NULL_VM,
            "--bytecode", str(bc_path)
        ]

        try:
            run(vm_cmd)
        except Exception as e:
            print(f"[ERROR] Null VM failed: {e}")
            print("[INFO] Make sure null_vm.py is available")
            raise

        # Convert PPM to final format
        if not ppm_output.exists():
            raise RuntimeError("Null VM did not produce PPM output")

        out_path = Path(args.output)
        if out_path.suffix.lower() == '.ppm':
            shutil.copy2(ppm_output, args.output)
        else:
            convert_ppm_to_png(ppm_output, out_path)

        print(f"[SUCCESS] Restored {args.input} -> {args.output}")


def img_roundtrip(args: argparse.Namespace) -> None:
    """Full compress + restore cycle for testing."""
    print(f"[IMG:ROUNDTRIP] {args.input} -> compress -> restore -> {args.output}")

    with tempfile.TemporaryDirectory(prefix="pie_roundtrip_") as tmp:
        tmp_path = Path(tmp)

        # Compress
        nlz1_path = tmp_path / "temp.nlz1"
        compress_args = argparse.Namespace(
            input=args.input,
            output=str(nlz1_path),
            policy=getattr(args, 'policy', None)
        )
        img_compress(compress_args)

        # Restore
        restore_args = argparse.Namespace(
            input=str(nlz1_path),
            output=args.output
        )
        img_restore(restore_args)

        if getattr(args, 'keep_artifact', False):
            artifact_dest = Path(args.input).parent / f"{Path(args.input).stem}_artifact.nlz1"
            shutil.copy2(nlz1_path, artifact_dest)
            print(f"[ARTIFACT] Kept {artifact_dest}")

        print(f"[SUCCESS] Roundtrip complete: {args.input} -> {args.output}")


# ==============================================================================
# PDX PACK/UNPACK (BYTE-EXACT FILE ARCHIVING)
# ==============================================================================

def pdx_pack(args: argparse.Namespace) -> None:
    """Pack any file into PDX format (byte-exact)."""
    input_path = Path(args.input)
    output_path = Path(args.output)

    print(f"[PDX:PACK] {args.input} -> {args.output}")

    # Read input
    data = input_path.read_bytes()

    # Simple PDX format: MAGIC + CHUNK_TYPE + LENGTH + DATA
    with open(output_path, "wb") as f:
        f.write(PDX_MAGIC)
        f.write(struct.pack(">I", CHUNK_DATA))  # chunk type
        f.write(struct.pack(">Q", len(data)))  # 64-bit length
        f.write(data)

    ratio = len(data) / output_path.stat().st_size
    print(".2f")


def pdx_unpack(args: argparse.Namespace) -> None:
    """Unpack PDX file to original (byte-exact)."""
    input_path = Path(args.input)
    output_path = Path(args.output)

    print(f"[PDX:UNPACK] {args.input} -> {args.output}")

    with open(input_path, "rb") as f:
        magic = f.read(4)
        if magic != PDX_MAGIC:
            raise ValueError(f"Invalid PDX magic: {magic}")

        chunk_type = struct.unpack(">I", f.read(4))[0]
        if chunk_type != CHUNK_DATA:
            raise ValueError(f"Unsupported chunk type: {chunk_type}")

        data_len = struct.unpack(">Q", f.read(8))[0]
        data = f.read(data_len)

        if len(data) != data_len:
            raise ValueError(f"Incomplete data: got {len(data)}, expected {data_len}")

    output_path.write_bytes(data)
    print(f"[SUCCESS] Unpacked {args.input} -> {args.output}")


def convert_png_jpg_to_ppm(input_path: Path, ppm_path: Path) -> None:
    """Convert PNG/JPG to PPM using PIL."""
    try:
        from PIL import Image
        img = Image.open(input_path)
        # Convert to RGB if needed
        if img.mode != 'RGB':
            img = img.convert('RGB')
        img.save(ppm_path, "PPM")
        print(f"[CONVERT] {input_path.name} -> {ppm_path.name}")
    except ImportError:
        raise RuntimeError("PIL required for image conversion: pip install Pillow")


# ==============================================================================
# MAIN CLI
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(description="PIE Engine CLI - Universal Compression Bridge")
    parser.add_argument("mode", choices=[
        "img:compress", "img:restore", "img:roundtrip",
        "pdx:pack", "pdx:unpack"
    ], help="Operation mode")

    # Common args
    parser.add_argument("--in", dest="input", required=True, help="Input file")
    parser.add_argument("--out", dest="output", required=True, help="Output file")

    # Image-specific args
    parser.add_argument("--policy", help="Policy JSON file for compression settings")

    # Roundtrip-specific args
    parser.add_argument("--keep-artifact", action="store_true",
                       help="Keep intermediate NLZ1 artifact after roundtrip")

    args = parser.parse_args()

    try:
        if args.mode == "img:compress":
            img_compress(args)
        elif args.mode == "img:restore":
            img_restore(args)
        elif args.mode == "img:roundtrip":
            img_roundtrip(args)
        elif args.mode == "pdx:pack":
            pdx_pack(args)
        elif args.mode == "pdx:unpack":
            pdx_unpack(args)
        else:
            raise ValueError(f"Unknown mode: {args.mode}")

    except Exception as e:
        print(f"[ERROR] {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
