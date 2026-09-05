"""Exclusive staging inside the explicitly approved private backup/key directories.

Input is a bounded source-only JSON bundle, never database bytes or credentials.
No upload to the deployed checkout, chmod of existing parents, overwrite, or cleanup.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_BUNDLE_BYTES = 2 * 1024 * 1024
FILES = {
    "scripts/execute-v4-backup.mjs",
    "scripts/run-v4-backup-host.py",
    "scripts/lib/v4-backup-executor.mjs",
    "scripts/lib/v4-backup-continuation.mjs",
    "scripts/lib/v4-backup-io.mjs",
    "scripts/lib/v4-backup-artifact.mjs",
    "scripts/lib/v4-backup-preflight.mjs",
    "scripts/lib/v4-backup-sql-scope.mjs",
    "scripts/lib/v4-schema-fingerprint.mjs",
}


def no_links(path):
    for part in [path] + list(path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise ValueError("unsafe path")


def private_tree(path, floor):
    no_links(path)
    if path.exists():
        info = path.stat()
        if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != 0:
            raise ValueError("existing private parent mode")
        return
    if path != floor:
        private_tree(path.parent, floor)
    elif not floor.parent.is_dir():
        raise ValueError("parent missing")
    path.mkdir(mode=0o700)
    if stat.S_IMODE(path.stat().st_mode) != 0o700:
        raise ValueError("mode")


def prepare(bundle):
    if sys.platform != "linux" or os.getuid() != 0:
        raise ValueError("host")
    run_id = bundle.get("runId", "")
    if not re.fullmatch(r"\d{8}-\d{2}", run_id):
        raise ValueError("run")
    entries = bundle.get("files", [])
    if len(entries) != len(FILES) or {item["path"] for item in entries} != FILES:
        raise ValueError("file set")
    decoded = {}
    for item in entries:
        raw = base64.b64decode(item["base64"], validate=True)
        if not raw or len(raw) > 256 * 1024 or hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise ValueError("hash")
        decoded[item["path"]] = raw
    directory = Path("/www/backup/aurum-v4/m1") / run_id
    key_directory = Path("/root/.local/share/aurum-v4-backup-keys") / ("m1-" + run_id)
    continuation = bundle.get("mode") == "continue-existing"
    if bundle.get("mode") not in (None, "continue-existing"):
        raise ValueError("mode")
    if continuation:
        if run_id != "20260905-01":
            raise ValueError("continuation scope")
        for path in [directory, directory / "artifacts", key_directory]:
            no_links(path)
            if not path.is_dir() or stat.S_IMODE(path.stat().st_mode) != 0o700:
                raise ValueError("missing private original")
        directory = directory / "continuation-01"
    for path in ([directory] if continuation else [directory, key_directory]):
        no_links(path)
        if os.path.lexists(path):
            raise ValueError("run path already exists")
    for path in [Path("/www/backup"), Path("/root/.local/share"), Path("/www/server/data")]:
        capacity = os.statvfs(path)
        if capacity.f_bavail * capacity.f_frsize < 10 * 1024 ** 3 or capacity.f_ffree < 1000:
            raise ValueError("capacity")
    os.umask(0o077)
    private_tree(directory, Path("/www/backup/aurum-v4"))
    if not continuation:
        private_tree(key_directory, Path("/root/.local/share/aurum-v4-backup-keys"))
    for relative, raw in decoded.items():
        target = directory / "tools" / relative
        private_tree(target.parent, directory)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    receipt = {"status": "prepared", "runId": run_id, "mode": "continue-existing" if continuation else "execute",
               "files": [{"path": key, "sha256": hashlib.sha256(value).hexdigest()} for key, value in decoded.items()]}
    fd = os.open(directory / "tool-receipt.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(receipt, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    return receipt


if __name__ == "__main__":
    try:
        payload = sys.stdin.buffer.read(MAX_BUNDLE_BYTES + 1)
        if len(payload) > MAX_BUNDLE_BYTES:
            raise ValueError("bundle too large")
        print(json.dumps(prepare(json.loads(payload))))
    except Exception:
        print('{"status":"failed","code":"backup_host_staging_failed","preserved":true}', file=sys.stderr)
        sys.exit(1)
