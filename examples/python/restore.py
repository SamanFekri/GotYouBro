#!/usr/bin/env python3
"""Rejoin a split GotYouBro backup (Python 3.8+, standard library only).

Download all parts (and the .manifest.json) from Telegram into one folder, then:

    python3 restore.py ./downloads                 # → postgres-20260924T030000Z.sql.gz
    python3 restore.py ./downloads --extract       # → postgres-20260924T030000Z.sql
    python3 restore.py a.part001 a.part002 --out backup.sql.gz

With a manifest every part and the joined file are verified with SHA-256.
Without one, files named *.partNNN are joined in order.
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys

PART_RE = re.compile(r"^(.*)\.part(\d{3,})$")


def collect_files(inputs):
    files = []
    for item in inputs:
        if os.path.isdir(item):
            files.extend(os.path.join(item, name) for name in sorted(os.listdir(item)))
        else:
            files.append(item)
    return files


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Rejoin a split GotYouBro backup")
    parser.add_argument("inputs", nargs="+", help="folder with the parts, or the part files")
    parser.add_argument("--out", help="output file (default: original name)")
    parser.add_argument("--extract", action="store_true", help="also gunzip the joined file")
    args = parser.parse_args()

    files = collect_files(args.inputs)
    manifest_path = next((f for f in files if f.endswith(".manifest.json")), None)
    manifest = None

    if manifest_path:
        with open(manifest_path) as fh:
            manifest = json.load(fh)
        by_name = {os.path.basename(f): f for f in files}
        folder = os.path.dirname(manifest_path)
        parts = [
            {**p, "path": by_name.get(p["file"], os.path.join(folder, p["file"]))} for p in manifest["parts"]
        ]
        out_name = manifest["file"]
    else:
        matches = [(f, PART_RE.match(os.path.basename(f))) for f in files]
        matches = sorted((m for m in matches if m[1]), key=lambda m: int(m[1].group(2)))
        if not matches:
            sys.exit("No *.partNNN files or manifest found")
        parts = [{"path": f} for f, _ in matches]
        out_name = matches[0][1].group(1)

    out = args.out or out_name
    print(f"Joining {len(parts)} part(s) → {out}")
    total = hashlib.sha256()
    with open(out, "wb") as output:
        for i, part in enumerate(parts, 1):
            path = part["path"]
            if not os.path.exists(path):
                sys.exit(f"Missing part: {os.path.basename(path)}")
            if part.get("sha256") and sha256(path) != part["sha256"]:
                sys.exit(f"Checksum mismatch in {os.path.basename(path)} — download it again")
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    total.update(chunk)
                    output.write(chunk)
            print(f"  ✓ {i}/{len(parts)} {os.path.basename(path)}")

    if manifest:
        if total.hexdigest() != manifest["sha256"]:
            sys.exit("Checksum of the joined file does not match the manifest")
        print("Checksums verified.")

    if args.extract:
        extracted = out[:-3] if out.endswith(".gz") else f"{out}.out"
        with gzip.open(out, "rb") as src, open(extracted, "wb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        print(f"Extracted → {extracted}")
    if manifest and manifest.get("restore"):
        print(f"\nRestore with:\n  {manifest['restore'].split('&& ')[-1]}")


if __name__ == "__main__":
    main()
