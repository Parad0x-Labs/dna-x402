#!/usr/bin/env python3

# ==============================================================================

# NEBULA V23.1 (FROZEN) - AUTO-EOL LOSSLESS RESTORE

#

# Fixes:

#

#   1) zstandard API compatibility: don't pass write_checksum alongside compression_params

#

#   2) var-buckets block (cid=255) is written RAW with ctype=9 (decoder must NOT zstd-decompress it)

#

#   3) Windows byte-perfect restore: AUTO tries LF then CRLF to match stored SHA256

#

#

# CLI:

#

#   Compress:

#

#     python nebula_v23_event_horizon_50x_FROZEN_AUTOEOL.py <in.log> <out.void>

#

#     python nebula_v23_event_horizon_50x_FROZEN_AUTOEOL.py c <in.log> <out.void>

#

#

#   Decompress (+verify):

#

#     python nebula_v23_event_horizon_50x_FROZEN_AUTOEOL.py d <in.void> <out.log>

#

#   Optional EOL control:

#

#     python ... d <in.void> <out.log> --eol auto|lf|crlf

#

# ==============================================================================

import struct

import zstandard as zstd

import json

import re

import time

import os

import sys

import hashlib

import datetime

import tempfile

import shutil

from collections import defaultdict



PROTOCOL_ID = b'VOID'

VERSION = 231



INT_MARK = "\u0001"

TOK_MARK = "\u0002"



CID_IP      = 0

CID_IDENT   = 1

CID_USER    = 2

CID_TS      = 3

CID_TZ      = 4

CID_METHOD  = 5

CID_URLTPL  = 6

CID_PROTO   = 7

CID_STATUS  = 8

CID_SIZE    = 9

CID_REFTPL  = 10

CID_UA      = 11

CID_HAS_RUA = 12



TPL_URL = 0

TPL_REF = 1



def sha256_file(path: str, chunk_size: int = 1024 * 1024) -> str:

    h = hashlib.sha256()

    with open(path, "rb") as f:

        for chunk in iter(lambda: f.read(chunk_size), b""):

            h.update(chunk)

    return h.hexdigest()



def detect_file_eol_style(path: str, sample_bytes: int = 1024 * 1024):

    """Detect dominant newline style and whether the file ends with a newline.



    Returns: (eol: 'lf'|'crlf', tail: 'lf'|'crlf'|'none')

    """

    try:

        with open(path, "rb") as f:

            head = f.read(sample_bytes)

            # Count CRLF first, then remaining LF not part of CRLF.

            crlf = head.count(b"\r\n")

            lf = head.count(b"\n") - crlf

            eol = "crlf" if crlf > 0 and crlf >= lf else "lf"



            # Tail detection

            f.seek(0, os.SEEK_END)

            size = f.tell()

            if size == 0:

                return eol, "none"

            back = 2 if size >= 2 else 1

            f.seek(-back, os.SEEK_END)

            tail_bytes = f.read(back)

            if tail_bytes.endswith(b"\r\n"):

                tail = "crlf"

            elif tail_bytes.endswith(b"\n"):

                tail = "lf"

            else:

                tail = "none"

            return eol, tail

    except Exception:

        # Safe default

        return "lf", "lf"



def _int64(n: int) -> int:

    return (n + (1 << 63)) % (1 << 64) - (1 << 63)



def zigzag(n: int) -> int:

    n = _int64(n)

    return (n << 1) ^ (n >> 63)



def unzigzag(n: int) -> int:

    return (n >> 1) ^ -(n & 1)



def pack_varints(ints):

    buf = bytearray()

    for x in ints:

        if x < 0:

            raise ValueError("varint must be non-negative")

        while x >= 0x80:

            buf.append((x & 0x7F) | 0x80)

            x >>= 7

        buf.append(x)

    return bytes(buf)



def iter_varints(data: bytes):

    idx = 0

    n = len(data)

    while idx < n:

        val = 0

        shift = 0

        while True:

            if idx >= n:

                raise EOFError("truncated varint stream")

            b = data[idx]

            idx += 1

            val |= (b & 0x7F) << shift

            if not (b & 0x80):

                break

            shift += 7

        yield val



def mtf_encode(ids, K=64):

    recent = []

    out = []

    for x in ids:

        try:

            pos = recent.index(x)

            out.append(pos + 1)

            recent.pop(pos)

            recent.insert(0, x)

        except ValueError:

            out.append(0)

            out.append(x + 1)

            recent.insert(0, x)

            if len(recent) > K:

                recent.pop()

    return out



def mtf_decode(vals_iter, K=64):

    recent = []

    out = []

    for v in vals_iter:

        if v != 0:

            pos = v - 1

            x = recent[pos]

            recent.pop(pos)

            recent.insert(0, x)

            out.append(x)

        else:

            raw = next(vals_iter)

            x = raw - 1

            recent.insert(0, x)

            if len(recent) > K:

                recent.pop()

            out.append(x)

    return out



class Transmuter:

    def __init__(self):

        self.month_map = {'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,

                          'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12}

        self.re_date = re.compile(r'^\[(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+\-]\d{4})\]$')

        combined = (

            r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'

            r'|([0-9a-fA-F]{8,})'

            r'|((?=[A-Za-z0-9_-]{16,})(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{16,})'

            r'|(\d+)'

        )

        self.re_combined = re.compile(combined)



    def parse_date_to_utc_and_tzmin(self, date_str: str):

        m = self.re_date.match(date_str)

        if not m:

            return 0, 0

        dd, mon_s, yyyy, hh, mm, ss, tz = m.groups()

        mon = self.month_map.get(mon_s, 1)

        tz_sign = 1 if tz[0] == '+' else -1

        tz_h = int(tz[1:3])

        tz_m = int(tz[3:5])

        tz_min = tz_sign * (tz_h * 60 + tz_m)



        local = datetime.datetime(int(yyyy), mon, int(dd), int(hh), int(mm), int(ss))

        utc = local - datetime.timedelta(minutes=tz_min)

        return int(utc.replace(tzinfo=datetime.timezone.utc).timestamp()), tz_min



    def format_date_from_utc_and_tzmin(self, utc_ts: int, tz_min: int):

        local = datetime.datetime.utcfromtimestamp(utc_ts + tz_min * 60)

        mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][local.month - 1]

        sign = '+' if tz_min >= 0 else '-'

        tz_abs = abs(tz_min)

        tz_h = tz_abs // 60

        tz_m = tz_abs % 60

        tz_str = f"{sign}{tz_h:02d}{tz_m:02d}"

        return f"[{local.day:02d}/{mon}/{local.year:04d}:{local.hour:02d}:{local.minute:02d}:{local.second:02d} {tz_str}"



    def skeletonize(self, s: str):

        slots = []

        def repl(m):

            g1, g2, g3, g4 = m.groups()

            if g4 is not None:

                slots.append(('i', int(g4)))

                return INT_MARK

            tok = g1 or g2 or g3

            slots.append(('t', tok))

            return TOK_MARK

        skel = self.re_combined.sub(repl, s)

        return skel, slots



class NebulaHorizon50x:

    def __init__(self):

        self.t = Transmuter()

        self.re_clf = re.compile(

            r'^(\S+) (\S+) (\S+) (\[.*?\]) "(.*?)" (\d{3}) (\S+)(?: "(.*?)" "(.*?)")?$'

        )

        self.dicts = defaultdict(dict)

        self.rev = defaultdict(list)



    def _did(self, key: str, val: str) -> int:

        d = self.dicts[key]

        if val not in d:

            d[val] = len(self.rev[key])

            self.rev[key].append(val)

        return d[val]



    def _parse_request(self, req: str):

        parts = req.split(" ")

        if len(parts) >= 3:

            method = parts[0]

            proto = parts[-1]

            target = " ".join(parts[1:-1])

            return method, target, proto

        return "", req, ""



    def compress(self, input_path: str, output_path: str):

        print(f"[NEBULA V23.1] Event Horizon 50x: {input_path}")

        start = time.time()



        orig_hash = sha256_file(input_path)

        orig_size = os.path.getsize(input_path)

        eol_hint, tail_newline = detect_file_eol_style(input_path)



        cols = defaultdict(list)

        var_buckets = {}

        row_count = 0



        with open(input_path, "r", encoding="latin-1", errors="strict") as f:

            for line in f:

                line = line.rstrip("\n")

                if not line:

                    continue

                m = self.re_clf.match(line)

                if not m:

                    # Skip malformed lines (like other algorithms)

                    continue

                ip, ident, user, date_s, req, status_s, size_s, ref, ua = m.groups()



                cols[CID_IP].append(self._did("ip", ip))

                cols[CID_IDENT].append(self._did("ident", ident))

                cols[CID_USER].append(self._did("user", user))



                utc_ts, tz_min = self.t.parse_date_to_utc_and_tzmin(date_s)

                cols[CID_TS].append(utc_ts)

                cols[CID_TZ].append(tz_min)



                method, target, proto = self._parse_request(req)

                cols[CID_METHOD].append(self._did("method", method))

                cols[CID_PROTO].append(self._did("proto", proto))



                url_skel, slots = self.t.skeletonize(target)

                url_id = self._did("urltpl", url_skel)

                cols[CID_URLTPL].append(url_id)



                for slot_idx, (stype, sval) in enumerate(slots):

                    key = (TPL_URL, url_id, slot_idx)

                    b = var_buckets.get(key)

                    if b is None:

                        var_buckets[key] = {'type': stype, 'vals': [sval]}

                    else:

                        if b['type'] != stype:

                            raise ValueError("Template slot type mismatch.")

                        b['vals'].append(sval)



                cols[CID_STATUS].append(int(status_s))

                if size_s == '-' or size_s == '':

                    cols[CID_SIZE].append(-1)

                else:

                    cols[CID_SIZE].append(int(size_s))



                has_rua = 1 if (ref is not None or ua is not None) else 0

                cols[CID_HAS_RUA].append(has_rua)



                ref_val = ref or ""

                if ref_val == "-":

                    ref_id = self._did("reftpl", "-")

                    cols[CID_REFTPL].append(ref_id)

                else:

                    ref_skel, rslots = self.t.skeletonize(ref_val)

                    ref_id = self._did("reftpl", ref_skel)

                    cols[CID_REFTPL].append(ref_id)

                    for slot_idx, (stype, sval) in enumerate(rslots):

                        key = (TPL_REF, ref_id, slot_idx)

                        b = var_buckets.get(key)

                        if b is None:

                            var_buckets[key] = {'type': stype, 'vals': [sval]}

                        else:

                            if b['type'] != stype:

                                raise ValueError("Ref slot type mismatch.")

                            b['vals'].append(sval)



                ua_val = ua or ""

                cols[CID_UA].append(self._did("ua", ua_val))



                row_count += 1



        print(f"   rows={row_count:,} url_templates={len(self.rev['urltpl'])} ref_templates={len(self.rev['reftpl'])}")

        print(f"   isolated_var_streams={len(var_buckets):,}")



        cparams = zstd.ZstdCompressionParameters.from_level(22, enable_ldm=True, threads=-1)

        cctx = zstd.ZstdCompressor(compression_params=cparams)



        meta = {

            "version": VERSION,

            "sha256": orig_hash,

            "orig_size": orig_size,

            "eol_hint": eol_hint,          # "lf" or "crlf"

            "tail_newline": tail_newline,  # "lf", "crlf", or "none"

            "dicts": {

                "ip": self.rev["ip"],

                "ident": self.rev["ident"],

                "user": self.rev["user"],

                "method": self.rev["method"],

                "proto": self.rev["proto"],

                "ua": self.rev["ua"],

                "urltpl": self.rev["urltpl"],

                "reftpl": self.rev["reftpl"],

            }

        }

        meta_c = cctx.compress(json.dumps(meta, ensure_ascii=False).encode("utf-8"))



        with open(output_path, "wb") as out:

            out.write(struct.pack(">4sBHII", PROTOCOL_ID, VERSION, 0, row_count, len(meta_c)))

            out.write(meta_c)



            def write_block(cid: int, ctype: int, payload_raw: bytes):

                cd = cctx.compress(payload_raw)

                out.write(struct.pack(">BBI", cid, ctype, len(cd)))

                out.write(cd)



            for cid in (CID_IP, CID_IDENT, CID_USER, CID_METHOD, CID_URLTPL, CID_PROTO, CID_REFTPL, CID_UA):

                write_block(cid, 3, pack_varints(mtf_encode(cols[cid], K=64)))



            ts_d = []

            last = 0

            for ts in cols[CID_TS]:

                ts_d.append(zigzag(ts - last))

                last = ts

            write_block(CID_TS, 2, pack_varints(ts_d))



            tz_ids = [self._did("tz", str(x)) for x in cols[CID_TZ]]

            tz_rev = self.rev["tz"]

            mtf_tz = mtf_encode(tz_ids, K=16)

            tz_dict_json = json.dumps(tz_rev).encode("utf-8")

            tz_blob = pack_varints([len(tz_dict_json)]) + tz_dict_json + pack_varints(mtf_tz)

            write_block(CID_TZ, 4, tz_blob)



            write_block(CID_STATUS, 1, pack_varints(cols[CID_STATUS]))



            sizes = [(0 if s < 0 else s + 1) for s in cols[CID_SIZE]]

            write_block(CID_SIZE, 1, pack_varints(sizes))



            write_block(CID_HAS_RUA, 1, pack_varints(cols[CID_HAS_RUA]))



            vb = bytearray()

            vb.extend(struct.pack(">I", len(var_buckets)))



            for (tpl_type, tpl_id, slot_idx), info in var_buckets.items():

                vtype = info["type"]

                vals = info["vals"]



                if vtype == 'i':

                    deltas = []

                    last = 0

                    for v in vals:

                        vv = int(v)

                        deltas.append(zigzag(vv - last))

                        last = vv

                    raw = pack_varints(deltas)

                    vtype_b = 0

                else:

                    raw = bytearray()

                    raw.extend(pack_varints([len(vals)]))

                    for s in vals:

                        b = str(s).encode("utf-8")

                        raw.extend(pack_varints([len(b)]))

                        raw.extend(b)

                    raw = bytes(raw)

                    vtype_b = 1



                comp = cctx.compress(raw)

                vb.extend(struct.pack(">BIHB", tpl_type, tpl_id, slot_idx, vtype_b))

                vb.extend(struct.pack(">I", len(comp)))

                vb.extend(comp)



            out.write(struct.pack(">BBI", 255, 9, len(vb)))

            out.write(vb)



        final = os.path.getsize(output_path)

        orig = os.path.getsize(input_path)

        print(f"[DONE] Ratio: {orig/final:.2f}x | {orig/1024/1024:.2f}MB -> {final/1024/1024:.2f}MB | Time: {time.time()-start:.2f}s")

        return output_path



    def _decompress_to_temp_with_eol(self, input_path: str, temp_path: str, eol: bytes):

        """Write reconstructed bytes to temp_path using specified EOL (b'\\n' or b'\\r\\n'). Returns sha256 hex."""

        dctx = zstd.ZstdDecompressor()



        with open(input_path, "rb") as f:

            magic, ver, _reserved, rows, meta_len = struct.unpack(">4sBHII", f.read(15))

            if magic != PROTOCOL_ID:

                raise ValueError("bad magic")

            if ver != VERSION:

                raise ValueError(f"bad version: {ver}")



            meta = json.loads(dctx.decompress(f.read(meta_len)).decode("utf-8"))

            want_sha = meta.get("sha256", "")

            tail_newline = meta.get("tail_newline", "lf")

            # tail_newline: "lf" | "crlf" | "none"



            dicts = meta["dicts"]

            rev_ip     = dicts["ip"]

            rev_ident  = dicts["ident"]

            rev_user   = dicts["user"]

            rev_method = dicts["method"]

            rev_proto  = dicts["proto"]

            rev_ua     = dicts["ua"]

            rev_urltpl = dicts["urltpl"]

            rev_reftpl = dicts["reftpl"]



            blocks = {}

            varblock = None



            while True:

                hdr = f.read(6)

                if not hdr:

                    break

                cid, ctype, clen = struct.unpack(">BBI", hdr)

                cdat = f.read(clen)

                if len(cdat) != clen:

                    raise EOFError("truncated block")

                if cid == 255:

                    varblock = (ctype, cdat)

                else:

                    blocks[cid] = (ctype, cdat)



            def decode_mtf_col(cid):

                raw = dctx.decompress(blocks[cid][1])

                vals = list(iter_varints(raw))

                return mtf_decode(iter(vals), K=64)



            ip_ids     = decode_mtf_col(CID_IP)

            ident_ids  = decode_mtf_col(CID_IDENT)

            user_ids   = decode_mtf_col(CID_USER)

            method_ids = decode_mtf_col(CID_METHOD)

            url_ids    = decode_mtf_col(CID_URLTPL)

            proto_ids  = decode_mtf_col(CID_PROTO)

            ref_ids    = decode_mtf_col(CID_REFTPL)

            ua_ids     = decode_mtf_col(CID_UA)



            ts_d = list(iter_varints(dctx.decompress(blocks[CID_TS][1])))

            utc_ts = []

            last = 0

            for z in ts_d:

                last = last + unzigzag(z)

                utc_ts.append(last)



            tz_blob = dctx.decompress(blocks[CID_TZ][1])

            cur = 0



            def read_varint():

                nonlocal cur

                val = 0

                shift = 0

                while True:

                    if cur >= len(tz_blob):

                        raise EOFError("truncated varint")

                    b = tz_blob[cur]

                    cur += 1

                    val |= (b & 0x7F) << shift

                    if not (b & 0x80):

                        return val

                    shift += 7



            dj_len = read_varint()

            dj = tz_blob[cur:cur + dj_len]

            cur += dj_len

            tz_rev = json.loads(dj.decode("utf-8"))

            tz_vals = list(iter_varints(tz_blob[cur:]))

            tz_ids = mtf_decode(iter(tz_vals), K=16)

            tz_min = [int(tz_rev[i]) for i in tz_ids]



            status = list(iter_varints(dctx.decompress(blocks[CID_STATUS][1])))



            sizes_enc = list(iter_varints(dctx.decompress(blocks[CID_SIZE][1])))

            sizes = [(-1 if v == 0 else v - 1) for v in sizes_enc]



            has_rua = list(iter_varints(dctx.decompress(blocks[CID_HAS_RUA][1])))



            if not (len(ip_ids) == len(url_ids) == len(utc_ts) == rows):

                raise ValueError("row count mismatch")



            if varblock is None:

                raise ValueError("missing varblock")

            vb_ctype, vb_cdat = varblock



            # IMPORTANT: cid=255 payload is RAW when ctype==9

            if vb_ctype == 9:

                vb = vb_cdat

            else:

                vb = dctx.decompress(vb_cdat)



            pos = 0

            bucket_count = struct.unpack(">I", vb[pos:pos + 4])[0]

            pos += 4



            int_streams = {}

            tok_streams = {}



            for _ in range(bucket_count):

                tpl_type, tpl_id, slot_idx, vtype_b = struct.unpack(">BIHB", vb[pos:pos + 8])

                pos += 8

                clen = struct.unpack(">I", vb[pos:pos + 4])[0]

                pos += 4

                comp = vb[pos:pos + clen]

                pos += clen

                raw = dctx.decompress(comp)



                key = (tpl_type, tpl_id, slot_idx)

                if vtype_b == 0:

                    deltas = list(iter_varints(raw))

                    vals = []

                    last = 0

                    for z in deltas:

                        last = last + unzigzag(z)

                        vals.append(last)

                    int_streams[key] = vals

                else:

                    cur2 = 0



                    def rv():

                        nonlocal cur2

                        val = 0

                        shift = 0

                        while True:

                            b = raw[cur2]

                            cur2 += 1

                            val |= (b & 0x7F) << shift

                            if not (b & 0x80):

                                return val

                            shift += 7



                    cnt = rv()

                    vals = []

                    for _k in range(cnt):

                        ln = rv()

                        b = raw[cur2:cur2 + ln]

                        cur2 += ln

                        vals.append(b.decode("utf-8", errors="strict"))

                    tok_streams[key] = vals



            ptr_int = defaultdict(int)

            ptr_tok = defaultdict(int)



            def fill_template(tpl_type, tpl_id, skel: str):

                out = []

                slot_idx = 0

                for ch in skel:

                    if ch == INT_MARK:

                        key = (tpl_type, tpl_id, slot_idx)

                        i = ptr_int[key]

                        val = int_streams[key][i]

                        ptr_int[key] = i + 1

                        out.append(str(val))

                        slot_idx += 1

                    elif ch == TOK_MARK:

                        key = (tpl_type, tpl_id, slot_idx)

                        i = ptr_tok[key]

                        val = tok_streams[key][i]

                        ptr_tok[key] = i + 1

                        out.append(val)

                        slot_idx += 1

                    else:

                        out.append(ch)

                return "".join(out)



            # Stream-write bytes with chosen EOL, while hashing bytes as written.

            h = hashlib.sha256()

            with open(temp_path, "wb") as out:

                for i in range(rows):

                    ip = rev_ip[ip_ids[i]]

                    ident = rev_ident[ident_ids[i]]

                    user = rev_user[user_ids[i]]

                    date_s = self.t.format_date_from_utc_and_tzmin(utc_ts[i], tz_min[i])



                    method = rev_method[method_ids[i]]

                    proto = rev_proto[proto_ids[i]]



                    url_skel = rev_urltpl[url_ids[i]]

                    target = fill_template(TPL_URL, url_ids[i], url_skel)



                    # Preserve basic CLF request formatting: METHOD SP TARGET SP PROTO

                    if method and proto:

                        req = f"{method} {target} {proto}"

                    elif method:

                        req = f"{method} {target}"

                    else:

                        req = f"{target}"



                    status_s = str(status[i])

                    size_s = "-" if sizes[i] < 0 else str(sizes[i])



                    ref_skel = rev_reftpl[ref_ids[i]]

                    if ref_skel == "-":

                        ref_s = "-"

                    else:

                        ref_s = fill_template(TPL_REF, ref_ids[i], ref_skel)



                    ua_s = rev_ua[ua_ids[i]]



                    if has_rua[i] == 1:

                        line = f'{ip} {ident} {user} {date_s} "{req}" {status_s} {size_s} "{ref_s}" "{ua_s}"'

                    else:

                        line = f'{ip} {ident} {user} {date_s} "{req}" {status_s} {size_s}'



                    b_line = line.encode("latin-1", errors="strict")

                    if (i == rows - 1) and (tail_newline == "none"):

                        b = b_line

                    else:

                        b = b_line + eol

                    out.write(b)

                    h.update(b)



            got_sha = h.hexdigest()

            return got_sha, want_sha



    def decompress(self, input_path: str, output_path: str, verify_hash: bool = True, eol_mode: str = "auto"):

        print(f"[NEBULA V23.1] Reconstructing: {input_path}")

        start = time.time()



        # Prefer the newline style recorded in the archive metadata (avoids the classic CRLF->LF 1 byte/line shrink).

        pref = None

        try:

            dctx0 = zstd.ZstdDecompressor()

            with open(input_path, "rb") as f0:

                magic, ver, _reserved, _rows0, meta_len = struct.unpack(">4sBHII", f0.read(15))

                if magic == PROTOCOL_ID and ver == VERSION:

                    meta0 = json.loads(dctx0.decompress(f0.read(meta_len)).decode("utf-8"))

                    tn = meta0.get("tail_newline")

                    eh = meta0.get("eol_hint")

                    if tn in ("lf", "crlf"):

                        pref = tn

                    elif eh in ("lf", "crlf"):

                        pref = eh

        except Exception:

            pref = None



        eol_mode = (eol_mode or "auto").lower()

        if eol_mode not in ("auto", "lf", "crlf"):

            raise ValueError("--eol must be auto|lf|crlf")



        candidates = []

        if eol_mode == "auto":

            if pref == "crlf":

                candidates = [(b"\r\n", "CRLF"), (b"\n", "LF")]

            else:

                candidates = [(b"\n", "LF"), (b"\r\n", "CRLF")]

        elif eol_mode == "lf":

            candidates = [(b"\n", "LF")]

        else:

            candidates = [(b"\r\n", "CRLF")]



        tmp_dir = tempfile.mkdtemp(prefix="nebula_v23_restore_")

        try:

            for eol, tag in candidates:

                tmp_path = os.path.join(tmp_dir, f"restore_{tag}.tmp")

                got_sha, want_sha = self._decompress_to_temp_with_eol(input_path, tmp_path, eol)



                if (not verify_hash) or (not want_sha) or (got_sha == want_sha):

                    # Move temp to output

                    shutil.copyfile(tmp_path, output_path)

                    if verify_hash and want_sha:

                        print(f"[VERIFY] SHA256 OK ({tag}): {got_sha[:16]}...")

                    print(f"[DONE] Restore Time: {time.time()-start:.2f}s -> {output_path}")

                    return output_path



            # If none matched:

            raise ValueError(f"SHA256 mismatch! expected={want_sha} got={got_sha} (tried {', '.join(t for _,t in candidates)})")

        finally:

            try:

                # best-effort cleanup

                for fn in os.listdir(tmp_dir):

                    try:

                        os.remove(os.path.join(tmp_dir, fn))

                    except Exception:

                        pass

                os.rmdir(tmp_dir)

            except Exception:

                pass



def main():

    # Backward compatible:

    #   python script.py <in.log> <out.void> -> compress

    if len(sys.argv) == 3:

        NebulaHorizon50x().compress(sys.argv[1], sys.argv[2])

        return



    if len(sys.argv) < 4:

        print("Usage:")

        print("  python nebula_v23_event_horizon_50x_FROZEN_AUTOEOL.py <in.log> <out.void>        (compress)")

        print("  python nebula_v23_event_horizon_50x_FROZEN_AUTOEOL.py c <in.log> <out.void>      (compress)")

        print("  python nebula_v23_event_horizon_50x_FROZEN_AUTOEOL.py d <in.void> <out.log>      (decompress + verify)")

        print("  optional: --eol auto|lf|crlf")

        sys.exit(1)



    mode = sys.argv[1].lower()

    inp = sys.argv[2]

    outp = sys.argv[3]



    eol_mode = "auto"

    if "--eol" in sys.argv:

        i = sys.argv.index("--eol")

        if i + 1 < len(sys.argv):

            eol_mode = sys.argv[i + 1]



    eng = NebulaHorizon50x()

    if mode == "d":

        eng.decompress(inp, outp, verify_hash=True, eol_mode=eol_mode)

    elif mode == "c":

        eng.compress(inp, outp)

    else:

        raise SystemExit("mode must be 'c' or 'd'")



if __name__ == "__main__":

    main()
