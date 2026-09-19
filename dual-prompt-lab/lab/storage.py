from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class LabError(Exception):
    def __init__(self, code: str, detail: str = ""):
        self.code, self.detail = code, detail
        super().__init__(f"{code}: {detail}" if detail else code)


def require(condition: bool, code: str, detail: str = "") -> None:
    if not condition:
        raise LabError(code, detail)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value: Any) -> datetime:
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z", value) is not None,
            "utc_timestamp_required")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise LabError("utc_timestamp_invalid") from error


def strict_json(text: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict:
        result: dict = {}
        for key, value in items:
            require(key not in result, "json_duplicate_key", key)
            result[key] = value
        return result

    def constant(_: str) -> None:
        raise LabError("json_non_finite_number")

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError) as error:
        raise LabError("json_invalid") from error

    def visit(node: Any, depth: int = 0) -> None:
        require(depth <= 64, "json_too_deep")
        if isinstance(node, float):
            require(math.isfinite(node), "json_non_finite_number")
        elif type(node) is int:
            require(abs(node) <= 2**53 - 1, "json_unsafe_integer_use_string")
        elif isinstance(node, dict):
            for child in node.values():
                visit(child, depth + 1)
        elif isinstance(node, list):
            for child in node:
                visit(child, depth + 1)

    visit(value)
    return value


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha(value: bytes | str) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    require(path.stat().st_size <= 32 * 1024 * 1024, "json_file_too_large")
    return strict_json(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: Any, *, replace: bool = False) -> None:
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", replace=replace)


def write_text(path: Path, text: str, *, replace: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    require(replace or not path.exists(), "file_already_exists", path.name)
    # Private temporary file in the same directory; replace only when explicitly requested.
    descriptor, temporary = tempfile.mkstemp(prefix=".promptlab-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            # Exclusive destination creation also prevents a concurrent writer being overwritten.
            os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def safe_child(root: Path, *parts: str) -> Path:
    root = root.resolve()
    path = root.joinpath(*parts)
    require(path.resolve().is_relative_to(root), "path_outside_workspace")
    for parent in [path, *path.parents]:
        if parent == root:
            break
        require(not is_link(parent), "linked_workspace_path_forbidden")
    return path


def is_link(path: Path) -> bool:
    if path.is_symlink():
        return True
    return path.exists() and bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def identifier(value: Any) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is not None,
            "identifier_invalid")
    return value


def workspace(path: Path) -> tuple[Path, dict]:
    root = path.resolve()
    config = read_json(safe_child(root, "config.json"))
    require(isinstance(config, dict) and config.get("schema_version") == 1, "workspace_not_initialized")
    require(config.get("mode") in ("real", "synthetic"), "workspace_mode_invalid")
    return root, config


def init_workspace(path: Path, synthetic: bool = False) -> dict:
    root = path.resolve()
    require(not root.exists() or not any(root.iterdir()), "workspace_not_empty")
    config = {
        "schema_version": 1, "mode": "synthetic" if synthetic else "real",
        "title": "双提示词", "symbols": [], "timeframes": [],
        "max_analysis_validity_seconds": None,
        "model": {"endpoint": None, "name": None, "api_key_env": "PROMPTLAB_API_KEY",
                  "max_tokens": 8192, "timeout_seconds": 60, "options": {}},
    }
    write_json(safe_child(root, "config.json"), config)
    write_json(safe_child(root, "rules.json"), {"schema_version": 1, "rules": []})
    return {"workspace": str(root), "status": "initialized", "mode": config["mode"]}
