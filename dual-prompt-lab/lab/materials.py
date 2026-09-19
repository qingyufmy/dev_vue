from __future__ import annotations

import os
from pathlib import Path

from .storage import LabError, canonical, file_sha, is_link, read_json, require, safe_child, sha, utc_now, workspace, write_json


TEXT_SUFFIXES = {".txt", ".md", ".srt", ".vtt", ".csv", ".json", ".jsonl"}


def ingest(work: Path, source: Path, channel: str = "author") -> dict:
    root, config = workspace(work)
    require(channel in ("author", "system"), "source_channel_invalid")
    require(not is_link(source), "linked_source_forbidden")
    source = source.resolve(strict=True)
    require(source != root and not root.is_relative_to(source) and not source.is_relative_to(root),
            "source_workspace_overlap")
    paths: list[Path] = []
    skipped: list[dict] = []
    if source.is_file():
        paths.append(source)
    else:
        def scan_error(error: OSError) -> None:
            raise LabError("source_scan_failed", type(error).__name__) from error

        for parent, directories, files in os.walk(source, followlinks=False, onerror=scan_error):
            base = Path(parent)
            for name in list(directories):
                if is_link(base / name):
                    directories.remove(name)
                    skipped.append({"path": str((base / name).relative_to(source)), "reason": "linked_path"})
            for name in files:
                path = base / name
                if is_link(path):
                    skipped.append({"path": str(path.relative_to(source)), "reason": "linked_path"})
                else:
                    paths.append(path)

    files = []
    for path in sorted(paths):
        digest = file_sha(path)
        source_id = sha(f"{config['mode']}:{channel}:{digest}")
        record = {"source_id": source_id, "sha256": digest, "channel": channel,
                  "mode": config["mode"], "status": "needs_text", "text": None, "text_sha256": None}
        if path.suffix.lower() in TEXT_SUFFIXES:
            if path.stat().st_size > 2 * 1024 * 1024:
                record["status"] = "text_too_large"
            else:
                try:
                    record["text"] = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
                    record["status"] = "ready" if record["text"].strip() else "empty_text"
                except UnicodeDecodeError:
                    record["status"] = "encoding_unknown"
        if record["text"] is not None:
            record["text_sha256"] = sha(record["text"])
        require(file_sha(path) == digest, "source_changed_during_read", path.name)
        stored = safe_child(root, "sources", f"{source_id}.json")
        if stored.exists():
            require(read_json(stored) == record, "source_record_conflict")
        else:
            write_json(stored, record)
        files.append({"path": str(path.relative_to(source)) if source.is_dir() else path.name,
                      "source_id": source_id, "sha256": digest, "status": record["status"]})

    body = {"schema_version": 1, "mode": config["mode"], "source_root": str(source),
            "files": files, "skipped": skipped}
    batch_id = sha(canonical(body))[:24]
    manifest = safe_child(root, "imports", f"{batch_id}.json")
    if not manifest.exists():
        write_json(manifest, {**body, "batch_id": batch_id, "imported_at": utc_now()})
    return {"batch_id": batch_id, "files": len(files), "unique_sources": len({f['source_id'] for f in files}),
            "ready_sources": len({f['source_id'] for f in files if f['status'] == 'ready'}),
            "pending_files": [f for f in files if f["status"] != "ready"], "skipped": skipped}


def read_source(root: Path, source_id: str) -> dict:
    require(isinstance(source_id, str) and len(source_id) == 64 and all(c in "0123456789abcdef" for c in source_id), "source_id_invalid")
    record = read_json(safe_child(root, "sources", f"{source_id}.json"))
    require(record["source_id"] == source_id, "source_id_mismatch")
    require(sha(f"{record['mode']}:{record['channel']}:{record['sha256']}") == source_id,
            "source_identity_mismatch")
    if record["text"] is not None:
        require(sha(record["text"]) == record.get("text_sha256"), "source_text_checksum_mismatch")
    return record
