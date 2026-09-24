#!/usr/bin/env python3
"""GotYouBro backup client for Python 3.8+ (standard library only).

Dumps a database, gzips it, splits it into parts that fit the server's upload limit and
uploads every part. Split backups also get a small manifest (<name>.manifest.json) so
restore.py can verify and rejoin the parts.

    python3 backup.py sqlite   ./data/app.db
    python3 backup.py postgres postgres://user:pass@localhost:5432/app
    python3 backup.py mysql    mysql://user:pass@localhost:3306/app
    python3 backup.py mongodb  mongodb://localhost:27017/app
    python3 backup.py file     ./uploads.tar

Options: --name <prefix>  --part-size-mb <n>  --keep (keep the local parts)
Env:     GOTYOUBRO_URL, GOTYOUBRO_TOKEN
Requires the matching CLI tool: mysqldump, pg_dump or mongodump (SQLite uses Python's sqlite3).
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

BASE_URL = os.environ.get("GOTYOUBRO_URL", "http://localhost:6969").rstrip("/")
TOKEN = os.environ.get("GOTYOUBRO_TOKEN", "")
MB = 1024 * 1024
CHUNK = 1 * MB
MAX_ATTEMPTS = 5

RESTORE_HINTS = {
    "sqlite": "gunzip -c {file} > app.db",
    "mysql": "gunzip -c {file} | mysql -u root -p",
    "postgres": "gunzip -c {file} | psql postgres://user:pass@host:5432/app",
    "mongodb": "gunzip -c {file} | mongorestore --uri=mongodb://host:27017 --archive",
    "file": "gunzip -c {file} > restored-file",
}


# ------------------------------------------------------------------ dump sources

def open_source(kind: str, target: str, work_dir: str):
    """Return (extension, readable binary stream, process-or-None)."""
    if kind == "sqlite":
        if not os.path.isfile(target):
            raise SystemExit(f"SQLite database not found: {target}")
        # The online backup API gives a consistent snapshot even while the app writes.
        snapshot = os.path.join(work_dir, "snapshot.sqlite")
        src, dst = sqlite3.connect(target), sqlite3.connect(snapshot)
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        return "sqlite", open(snapshot, "rb"), None
    if kind == "mysql":
        return "sql", *spawn(["mysqldump", *mysql_args(target, work_dir)])
    if kind == "postgres":
        # Move the password into PGPASSWORD so it doesn't show up in `ps`.
        env, dbname = dict(os.environ), target
        if re.match(r"^postgres(ql)?://", target):
            url = urllib.parse.urlsplit(target)
            if url.password:
                env["PGPASSWORD"] = urllib.parse.unquote(url.password)
                netloc = url.netloc.rsplit("@", 1)
                user = netloc[0].split(":", 1)[0]
                dbname = urllib.parse.urlunsplit(url._replace(netloc=f"{user}@{netloc[1]}"))
        return "sql", *spawn(["pg_dump", "--no-owner", "--no-privileges", f"--dbname={dbname}"], env)
    if kind == "mongodb":
        return "archive", *spawn(["mongodump", f"--uri={target}", "--archive"])
    if kind == "file":
        return os.path.basename(target), open(target, "rb"), None
    raise SystemExit(f'Unknown source type "{kind}" (sqlite, mysql, postgres, mongodb, file)')


def mysql_args(target: str, work_dir: str):
    """`mysql://user:pass@host:3306/db` or just `db` (then ~/.my.cnf / defaults are used).
    The password goes into a private options file instead of the command line."""
    args = ["--single-transaction", "--routines", "--triggers", "--events"]
    database = target
    if target.startswith("mysql://"):
        url = urllib.parse.urlsplit(target)
        database = urllib.parse.unquote(url.path.lstrip("/"))
        if url.hostname:
            args.append(f"--host={url.hostname}")
        if url.port:
            args.append(f"--port={url.port}")
        if url.username:
            args.append(f"--user={urllib.parse.unquote(url.username)}")
        if url.password:
            cnf = os.path.join(work_dir, "client.cnf")
            password = urllib.parse.unquote(url.password).replace("\\", "\\\\").replace('"', '\\"')
            fd = os.open(cnf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(f'[client]\npassword="{password}"\n')
            args.insert(0, f"--defaults-extra-file={cnf}")  # must be the first option
    if not database:
        raise SystemExit("MySQL: no database name in the target")
    return [*args, "--databases", database]


def spawn(args, env=None):
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, env=env)
    except FileNotFoundError:
        raise SystemExit(f"Cannot run {args[0]}: is it installed and on PATH?")
    return proc.stdout, proc


# ------------------------------------------------------------------ splitting

class PartWriter:
    """Cuts incoming bytes into fixed-size part files and hashes everything."""

    def __init__(self, directory: str, base_name: str, part_size: int):
        self.directory, self.base_name, self.part_size = directory, base_name, part_size
        self.parts = []  # dicts: path, size, hash
        self.total = 0
        self.hash = hashlib.sha256()
        self._file = None

    def write(self, data: bytes) -> None:
        self.hash.update(data)
        self.total += len(data)
        view = memoryview(data)
        while view:
            if not self.parts or self.parts[-1]["size"] >= self.part_size:
                self._next_part()
            part = self.parts[-1]
            piece = view[: self.part_size - part["size"]]
            self._file.write(piece)
            part["size"] += len(piece)
            part["hash"].update(piece)
            view = view[len(piece):]

    def _next_part(self) -> None:
        if self._file:
            self._file.close()
        path = os.path.join(self.directory, f"{self.base_name}.part{len(self.parts) + 1:03d}")
        self._file = open(path, "wb")
        self.parts.append({"path": path, "size": 0, "hash": hashlib.sha256()})

    def close(self) -> None:
        if self._file:
            self._file.close()


# ------------------------------------------------------------------ upload

def api(path: str, *, method="GET", data=None, headers=None, timeout=900):
    request = urllib.request.Request(
        f"{BASE_URL}{path}", method=method, data=data,
        headers={"Authorization": f"Bearer {TOKEN}", **(headers or {})},
    )
    return urllib.request.urlopen(request, timeout=timeout)


def server_max_bytes():
    """Largest file the server accepts for this token (min of admin limit and Telegram)."""
    try:
        with api("/api/v1/service", timeout=15) as response:
            return json.load(response)["data"]["limits"]["maxBackupBytes"]
    except Exception:
        return None


def upload_file(path: str, name: str) -> dict:
    attempt = 1
    while True:
        try:
            with open(path, "rb") as body:
                response = api(
                    "/api/v1/backups/raw?wait=true",
                    method="POST",
                    data=body,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "Content-Length": str(os.path.getsize(path)),
                        "X-Filename": urllib.parse.quote(name),
                        # Same key on retry: a delivered part is never sent twice, a failed one is retried.
                        "Idempotency-Key": name[-128:],
                    },
                )
                with response:
                    return json.load(response)["data"]  # 200 delivered, 202 still being delivered
        except urllib.error.HTTPError as err:
            try:
                error = json.load(err).get("error", {})
            except ValueError:
                error = {}
            reason = f"{err.code} {error.get('code', '')} {error.get('message', '')}".strip()
            if err.code == 429:
                seconds = int(err.headers.get("Retry-After", "60"))
                print(f"  rate limited, waiting {seconds}s…", flush=True)
                time.sleep(seconds)
                continue  # rate limiting isn't a failed attempt
            if (err.code >= 500 or err.code == 408) and attempt < MAX_ATTEMPTS:
                retry_wait(attempt, reason)
                attempt += 1
                continue
            raise RuntimeError(f"Upload of {name} failed: {reason}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if attempt >= MAX_ATTEMPTS:
                raise
            retry_wait(attempt, f"network error: {err}")
            attempt += 1


def retry_wait(attempt: int, reason: str) -> None:
    seconds = min(60, 2 ** attempt * 2)
    print(f"  {reason} — retrying in {seconds}s (attempt {attempt + 1}/{MAX_ATTEMPTS})", flush=True)
    time.sleep(seconds)


# ------------------------------------------------------------------ main

def main() -> None:
    parser = argparse.ArgumentParser(description="Back up a database to GotYouBro")
    parser.add_argument("type", choices=["sqlite", "mysql", "postgres", "mongodb", "file"])
    parser.add_argument("target", help="SQLite path, MySQL/Postgres/Mongo URI, or file path")
    parser.add_argument("--name", help="file name prefix (default: the source type)")
    parser.add_argument("--part-size-mb", type=float, help="split size (default: 95%% of the server limit)")
    parser.add_argument("--keep", action="store_true", help="keep the local parts")
    args = parser.parse_args()
    if not TOKEN:
        sys.exit("Set GOTYOUBRO_TOKEN")

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    work_dir = tempfile.mkdtemp(prefix="gotyoubro-")
    try:
        # 1. Dump → gzip → parts
        ext, stream, proc = open_source(args.type, args.target, work_dir)
        base_name = re.sub(r"[^\w.-]+", "_", f"{args.name or args.type}-{stamp}.{ext}.gz")
        server_max = server_max_bytes()
        part_size = int(args.part_size_mb * MB) if args.part_size_mb else int((server_max or 50 * MB) * 0.95)
        print(f"Dumping {args.type} → {base_name} (parts of {part_size / MB:.1f} MB)", flush=True)

        writer = PartWriter(work_dir, base_name, part_size)
        gzip = zlib.compressobj(9, zlib.DEFLATED, 31)  # wbits=31 → gzip container
        with stream:
            for chunk in iter(lambda: stream.read(CHUNK), b""):
                writer.write(gzip.compress(chunk))
        writer.write(gzip.flush())
        writer.close()
        if proc and proc.wait() != 0:
            raise RuntimeError(f"{proc.args[0]} exited with code {proc.returncode}")

        # 2. One part → upload as a plain .gz file. Several parts → parts + manifest.
        if len(writer.parts) == 1:
            single = os.path.join(work_dir, base_name)
            os.rename(writer.parts[0]["path"], single)
            uploads = [(single, base_name)]
        else:
            manifest = {
                "format": "gotyoubro-split-v1",
                "file": base_name,
                "source": args.type,
                "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "size": writer.total,
                "sha256": writer.hash.hexdigest(),
                "parts": [
                    {"file": os.path.basename(p["path"]), "size": p["size"], "sha256": p["hash"].hexdigest()}
                    for p in writer.parts
                ],
                "restore": f"python3 restore.py <folder with the parts> && {RESTORE_HINTS[args.type].format(file=base_name)}",
            }
            manifest_path = os.path.join(work_dir, f"{base_name}.manifest.json")
            with open(manifest_path, "w") as fh:
                json.dump(manifest, fh, indent=2)
            uploads = [(p["path"], os.path.basename(p["path"])) for p in writer.parts]
            uploads.append((manifest_path, os.path.basename(manifest_path)))

        # 3. Upload sequentially (keeps parts in order in the Telegram chat).
        for i, (path, name) in enumerate(uploads, 1):
            print(f"[{i}/{len(uploads)}] uploading {name} ({os.path.getsize(path) / MB:.1f} MB)", flush=True)
            result = upload_file(path, name)
            again = " (already uploaded)" if result.get("idempotent") else ""
            print(f"  ✓ {result['status']}{again} — backup {result['id']}", flush=True)
        print(f"Done: {writer.total / MB:.1f} MB in {len(uploads)} file(s).")
        if args.keep:
            print(f"Local copy kept in {work_dir}")
    finally:
        if not args.keep:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, sqlite3.Error) as exc:
        sys.exit(f"Backup failed: {exc}")
