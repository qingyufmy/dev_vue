"""Read-only export of the current platform XAUUSD strategy from the VM.

The remote code is sent to ``node`` on stdin so that this experiment does not
copy, modify, or install anything on the VM.  It imports the same policy and
output-format code as the running application and emits one JSON document.
No environment variable or credential is selected for export or printed.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from common import (
    EXPERIMENT_ROOT,
    SOURCE_ROOT,
    ensure_dir,
    git_commit,
    json_bytes,
    sha256_bytes,
    sha256_file,
)


DEFAULT_REMOTE_DIR = "/www/wwwroot/aurum-ai"
DEFAULT_SSH_ALIAS = "aurum-vm"
REMOTE_JSON_SENTINEL = "__AURUM_STRATEGY_EXPORT_JSON__"


def _remote_node_script(remote_dir: str, ssh_alias: str) -> str:
    # JSON encoding keeps the user-supplied path out of JavaScript syntax and
    # shell parsing.  The path is used only as a working directory/import root.
    remote_literal = json.dumps(remote_dir)
    host_literal = json.dumps(ssh_alias)
    return f"""import {{ spawnSync }} from 'node:child_process'
import {{ createHash }} from 'node:crypto'
import {{ pathToFileURL }} from 'node:url'

const remoteDir = {remote_literal}
const sshAlias = {host_literal}
let exportStage = 'bootstrap'

function gitValue(args) {{
  try {{
    const result = spawnSync('git', ['-C', remoteDir, ...args], {{ encoding:'utf8', stdio:['ignore','pipe','ignore'] }})
    if (result.status !== 0) return null
    const value = String(result.stdout || '').trim()
    return value || null
  }} catch {{ return null }}
}}

function sha256(value) {{
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}}

function parseJson(value, fallback) {{
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try {{ return JSON.parse(String(value)) }} catch {{ return fallback }}
}}

function symbolsFrom(value) {{
  const parsed = parseJson(value, value)
  if (Array.isArray(parsed)) return parsed.map(item => String(item || '').trim()).filter(Boolean)
  return String(parsed || '').split(',').map(item => item.trim()).filter(Boolean)
}}

function isXauusd(value) {{
  const upper = String(value || '').trim().toUpperCase()
  if (!upper) return false
  const base = upper.split(/[._-]/, 1)[0]
  return base === 'XAUUSD' || upper === 'XAUUSD'
}}

function safeStrategy(row, policy) {{
  const fields = ['id','title','description','symbols_json','market_data_plan_json','strategy_policy_json',
    'entry_methods_json','use_chan_analysis','use_ema34_filter','interval_minutes','is_active',
    'sort_order','created_at','updated_at','scope','inference_mode',
    'visibility_status','version','version_label']
  const strategy = {{}}
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(row, field)) strategy[field] = row[field]
  return {{ strategy, policy }}
}}

async function main() {{
  exportStage = 'chdir'
  process.chdir(remoteDir)
  // Dynamic imports happen after chdir so dotenv/config resolves the VM
  // project's .env in the same way as the application process.
  exportStage = 'imports'
  await import(pathToFileURL(`${{remoteDir}}/node_modules/dotenv/config.js`).href)
  const db = await import(pathToFileURL(`${{remoteDir}}/server/db.js`).href)
  const strategyPolicy = await import(pathToFileURL(`${{remoteDir}}/server/routes/ai/strategy-policy.js`).href)
  const llm = await import(pathToFileURL(`${{remoteDir}}/server/routes/ai/llm.js`).href)
  const chan = await import(pathToFileURL(`${{remoteDir}}/server/routes/ai/chan-window-policy.js`).href)
  exportStage = 'columns'
  const columnsRows = await db.queryAll('SHOW COLUMNS FROM auto_prompt_types')
  const columns = new Set(columnsRows.map(row => String(row.Field || row.field || '')))
  const candidates = ['id','title','description','system_prompt','symbols_json','market_data_plan_json',
    'strategy_policy_json','entry_methods_json','use_chan_analysis','use_ema34_filter','interval_minutes',
    'is_active','sort_order','created_at','updated_at','deleted_at','scope',
    'inference_mode','visibility_status','version','version_label']
  const selected = candidates.filter(field => columns.has(field))
  for (const required of ['id','system_prompt','symbols_json','updated_at']) if (!columns.has(required))
    throw new Error(`strategy_column_missing:${{required}}`)
  const predicates = ["scope = 'platform'", 'is_active = 1']
  if (columns.has('deleted_at')) predicates.push('deleted_at IS NULL')
  if (columns.has('visibility_status')) predicates.push("visibility_status = 'active'")
  exportStage = 'strategy_query'
  const rows = await db.queryAll(`SELECT ${{selected.map(field => `\\`${{field}}\\``).join(', ')}}\n`
    + `FROM auto_prompt_types WHERE ${{predicates.join(' AND ')}} ORDER BY updated_at DESC, id DESC`)
  const row = rows.find(candidate => symbolsFrom(candidate.symbols_json).some(isXauusd))
  if (!row) throw new Error('active_platform_xauusd_strategy_not_found')
  exportStage = 'policy'
  const policy = strategyPolicy.parseStrategyPolicy(row)
  exportStage = 'schema'
  const dynamic = llm.buildStrategyOutputFormat(null, policy.entryMethods)
  const outputSchema = JSON.parse(dynamic.outputFormat)
  const strategyBody = String(row.system_prompt || '')
  const strategyBodySha256 = sha256(strategyBody)
  const outputSchemaVersion = sha256(dynamic.outputFormat)
  exportStage = 'chan'
  const chanTimeframes = ['M1','M5','M15','M30','H1','H4','D1','W1']
  const chanPolicies = Object.fromEntries(chanTimeframes.map(timeframe => [timeframe, chan.getChanWindowPolicy(timeframe)]))
  exportStage = 'snapshot'
  let latestSnapshot = null
  const tables = await db.queryAll("SHOW TABLES LIKE 'inference_snapshots'")
  if (tables.length) latestSnapshot = await db.queryOne(
    'SELECT strategy_version, output_schema_version, prompt_hash, created_at FROM inference_snapshots WHERE strategy_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [Number(row.id)],
  )
  exportStage = 'result'
  return {{
    vm_host:sshAlias,
    remote_dir:remoteDir,
    git_branch:gitValue(['branch','--show-current']),
    git_commit:gitValue(['rev-parse','HEAD']),
    git_status_porcelain:gitValue(['status','--porcelain']) || '',
    strategy_body:strategyBody,
    strategy_body_sha256:strategyBodySha256,
    strategy_body_chars:strategyBody.length,
    strategy:safeStrategy(row, {{
      entry_methods:policy.entryMethods,
      market_data_plan:policy.marketDataPlan,
      use_chan_analysis:Boolean(policy.useChanAnalysis),
      use_ema34_filter:Boolean(policy.useEma34Filter),
      strategy_policy:policy.strategyPolicy,
      compiled_policy:policy.compiledPolicy,
      policy_mode:policy.policyMode,
      policy_hash:policy.compiledPolicy?.policy_hash || null,
    }}).strategy,
    policy:{{
      entry_methods:policy.entryMethods,
      market_data_plan:policy.marketDataPlan,
      use_chan_analysis:Boolean(policy.useChanAnalysis),
      use_ema34_filter:Boolean(policy.useEma34Filter),
      strategy_policy:policy.strategyPolicy,
      compiled_policy:policy.compiledPolicy,
      policy_mode:policy.policyMode,
      policy_hash:policy.compiledPolicy?.policy_hash || null,
    }},
    output_schema:outputSchema,
    output_schema_source:'server/routes/ai/llm.js::buildStrategyOutputFormat',
    output_schema_version:outputSchemaVersion,
    output_schema_chars:dynamic.outputFormat.length,
    output_schema_has_pending:Boolean(dynamic.hasPending),
    chan_window_policy_version:chan.CHAN_WINDOW_POLICY_VERSION,
    chan_window_policy_id:chan.CHAN_WINDOW_POLICY_ID,
    chan_policies:chanPolicies,
    latest_inference_snapshot:latestSnapshot,
  }}
}}

main().then(value => {{
  const serialized = `\n{REMOTE_JSON_SENTINEL}${{JSON.stringify(value)}}`
  process.stdout.write(serialized, () => process.exit(0))
}})
  .catch(error => {{
    // Keep remote failures bounded and credential-free.  The caller receives
    // the non-zero exit status and does not persist this diagnostic as data.
    const code = /^[a-z0-9_.:-]+$/i.test(String(error?.message || ''))
      ? String(error.message) : `remote_export_failed:${{exportStage}}`
    process.stderr.write(code)
    process.exit(1)
  }})
"""


def _parse_remote_output(stdout: str) -> dict[str, Any]:
    sentinel_index = stdout.rfind(REMOTE_JSON_SENTINEL)
    if sentinel_index >= 0:
        stdout = stdout[sentinel_index + len(REMOTE_JSON_SENTINEL) :].strip()
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError:
        # SSH wrappers occasionally prepend a harmless login banner.  Parse
        # only the final JSON object and never persist the banner.
        start = stdout.find("{")
        end = stdout.rfind("}")
        if start < 0 or end <= start:
            raise RuntimeError("remote_export_invalid_json")
        try:
            value = json.loads(stdout[start : end + 1])
        except json.JSONDecodeError as exc:
            raise RuntimeError("remote_export_invalid_json") from exc
    if not isinstance(value, dict):
        raise RuntimeError("remote_export_invalid_object")
    return value


def export_strategy(
    *,
    ssh_alias: str = DEFAULT_SSH_ALIAS,
    remote_dir: str = DEFAULT_REMOTE_DIR,
    experiment_root: Path = EXPERIMENT_ROOT,
    timeout_seconds: int = 60,
) -> dict[str, Any]:
    source_root = experiment_root / "artifacts" / "source"
    ensure_dir(source_root)
    script = _remote_node_script(remote_dir, ssh_alias)
    try:
        result = subprocess.run(
            ["ssh", ssh_alias, "node", "--input-type=module", "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("vm_export_timeout") from exc
    except OSError as exc:
        raise RuntimeError("ssh_unavailable") from exc
    if result.returncode != 0:
        # Do not echo the remote stderr: importing a misconfigured application
        # can include deployment paths or provider diagnostics.  The remote
        # script itself emits only a bounded machine error code; surface it
        # only if it still matches that allow-list.
        diagnostic = str(result.stderr or "").strip()
        if re.fullmatch(r"[a-z0-9_.:-]+", diagnostic, flags=re.IGNORECASE):
            raise RuntimeError(f"vm_export_failed:{diagnostic}")
        raise RuntimeError("vm_export_failed")
    payload = _parse_remote_output(result.stdout)
    body = payload.get("strategy_body")
    if not isinstance(body, str) or not body.strip():
        raise RuntimeError("strategy_body_missing")
    output_schema = payload.get("output_schema")
    if not isinstance(output_schema, dict) or not output_schema:
        raise RuntimeError("output_schema_missing")
    strategy_path = source_root / "strategy.zh.md"
    schema_path = source_root / "output-schema.zh.json"
    strategy_raw = body.encode("utf-8")
    schema_raw = json_bytes(output_schema, pretty=True) + b"\n"
    local_strategy_hash = sha256_bytes(strategy_raw)
    local_schema_hash = sha256_bytes(schema_raw)
    remote_strategy_hash = str(payload.get("strategy_body_sha256") or "")
    if not remote_strategy_hash or local_strategy_hash != remote_strategy_hash:
        raise RuntimeError("strategy_body_hash_mismatch")
    remote_schema_version = str(payload.get("output_schema_version") or "")
    if not remote_schema_version:
        raise RuntimeError("output_schema_version_missing")
    latest_snapshot = payload.get("latest_inference_snapshot")
    if isinstance(latest_snapshot, dict):
        snapshot_schema_version = str(latest_snapshot.get("output_schema_version") or "")
        if snapshot_schema_version and snapshot_schema_version != remote_schema_version:
            raise RuntimeError("latest_snapshot_schema_version_mismatch")
        snapshot_strategy_version = latest_snapshot.get("strategy_version")
        strategy_version = (payload.get("strategy") or {}).get("version")
        if snapshot_strategy_version is not None and strategy_version is not None:
            if int(snapshot_strategy_version) != int(strategy_version):
                raise RuntimeError("latest_snapshot_strategy_version_mismatch")
    if str(payload.get("git_status_porcelain") or "").strip():
        raise RuntimeError("vm_worktree_not_clean")
    policy = payload.get("policy") if isinstance(payload.get("policy"), dict) else {}
    strategy_meta = payload.get("strategy") if isinstance(payload.get("strategy"), dict) else {}
    safe_strategy_meta = {
        key: strategy_meta[key]
        for key in (
            "id", "title", "description", "symbols_json", "market_data_plan_json",
            "strategy_policy_json", "entry_methods_json", "use_chan_analysis", "use_ema34_filter",
            "interval_minutes", "is_active", "sort_order", "created_at", "updated_at", "scope",
            "inference_mode", "visibility_status", "version",
            "version_label",
        )
        if key in strategy_meta
    }
    metadata = {
        "artifact_version": "deepseek-v4-pro-0813-bilingual-week-backtest-v1",
        "exported_at_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "source": {
            "vm_host": payload.get("vm_host", ssh_alias),
            "remote_dir": payload.get("remote_dir", remote_dir),
            "git_branch": payload.get("git_branch"),
            "git_commit": payload.get("git_commit"),
            "git_status_porcelain": "",
            "output_schema_source": payload.get("output_schema_source"),
        },
        "strategy": safe_strategy_meta,
        "strategy_body_sha256": local_strategy_hash,
        "strategy_body_chars": payload.get("strategy_body_chars"),
        "output_schema_sha256": local_schema_hash,
        "output_schema_version": remote_schema_version,
        "output_schema_chars": payload.get("output_schema_chars"),
        "policy": policy,
        "data_plan": policy.get("market_data_plan"),
        "entry_methods": policy.get("entry_methods"),
        "use_chan_analysis": policy.get("use_chan_analysis"),
        "use_ema34_filter": policy.get("use_ema34_filter"),
        "strategy_policy_hash": policy.get("policy_hash"),
        "chan_window_policy_version": payload.get("chan_window_policy_version"),
        "chan_window_policy_id": payload.get("chan_window_policy_id"),
        "chan_policies": payload.get("chan_policies", {}),
        "latest_inference_snapshot": latest_snapshot,
        "historical_simulation": {
            "position_management_schema": "not included; empty-account A/B replay",
            "account_data_exported": False,
        },
    }
    metadata_path = source_root / "runtime-metadata.json"
    metadata_raw = json_bytes(metadata, pretty=True) + b"\n"

    # Validate the entire remote payload before replacing any previously
    # verified local artifact.  Each replacement is atomic within the folder.
    for path, raw in (
        (strategy_path, strategy_raw),
        (schema_path, schema_raw),
        (metadata_path, metadata_raw),
    ):
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(raw)
        temporary.replace(path)
    (source_root / "strategy.zh.md.sha256").write_text(metadata["strategy_body_sha256"] + "\n", encoding="ascii")
    (source_root / "output-schema.zh.json.sha256").write_text(metadata["output_schema_sha256"] + "\n", encoding="ascii")
    (source_root / "runtime-metadata.sha256").write_text(sha256_file(metadata_path) + "\n", encoding="ascii")
    return metadata


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only VM platform strategy export")
    parser.add_argument("--ssh-alias", default=DEFAULT_SSH_ALIAS)
    parser.add_argument("--remote-dir", default=DEFAULT_REMOTE_DIR)
    parser.add_argument("--timeout-seconds", type=int, default=60)
    args = parser.parse_args(argv)
    try:
        metadata = export_strategy(
            ssh_alias=args.ssh_alias,
            remote_dir=args.remote_dir,
            timeout_seconds=max(5, args.timeout_seconds),
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({
        "ok": True,
        "strategy_id": metadata.get("strategy", {}).get("id"),
        "strategy_version": metadata.get("strategy", {}).get("version"),
        "vm_commit": metadata.get("source", {}).get("git_commit"),
        "strategy_body_sha256": metadata.get("strategy_body_sha256"),
        "output_schema_sha256": metadata.get("output_schema_sha256"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
