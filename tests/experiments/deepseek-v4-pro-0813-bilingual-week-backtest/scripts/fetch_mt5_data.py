"""Fetch a frozen, read-only MT5 market snapshot for the experiment.

This module never sends a trading request.  It initializes the explicitly
selected terminal, calibrates the broker server clock from advancing ticks,
downloads rates, filters the still-forming tail, and shuts the terminal down
in ``finally``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.metadata
import json
import math
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from common import (
    DATA_ROOT,
    EXPERIMENT_ROOT,
    TIMEFRAME_MINUTES,
    ensure_dir,
    git_commit,
    json_bytes,
    normalize_data_plan,
    sha256_bytes,
    sha256_file,
    strategy_chan_policy,
    utc_iso,
    utc_now_ms,
    write_json,
)


DEFAULT_TERMINAL_PATH = r"D:\Program Files\MetaTrader 5\terminal64.exe"
DEFAULT_WINDOW_DAYS = 7
DEFAULT_OUTCOME_HOURS = 12
MAX_M1_RANGE_BARS = 4_500
# XAUUSD is normally quoted 24/5.  Convert a required number of trading bars
# into a deliberately wider calendar range so weekend closures do not consume
# the Chan/indicator warm-up budget.  The post-fetch count check remains the
# authoritative guard for broker holidays or shallow terminal history.
CALENDAR_WARMUP_FACTOR = 1.6
UTC = dt.timezone.utc


def _value(row: Any, name: str, default: Any = None) -> Any:
    if isinstance(row, Mapping):
        return row.get(name, default)
    try:
        return getattr(row, name)
    except AttributeError:
        try:
            return row[name]
        except (IndexError, KeyError, TypeError):
            return default


def raw_tick_time_msc(tick: Any) -> int | None:
    value = _value(tick, "time_msc")
    try:
        number = int(value)
        if number > 0:
            return number
    except (TypeError, ValueError):
        pass
    value = _value(tick, "time")
    try:
        number = int(value)
        return number * 1000 if number > 0 else None
    except (TypeError, ValueError):
        return None


def calibrate_broker_offset(
    mt5_module: Any,
    symbol: str,
    *,
    wait_seconds: float = 10.0,
    poll_seconds: float = 0.5,
    max_tick_age_seconds: float = 300.0,
    now_fn: Callable[[], float] | None = None,
    monotonic_fn: Callable[[], float] | None = None,
    sleep_fn: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """Calibrate raw broker-server epoch against local UTC.

    MT5 rate/tick epochs on this terminal use broker server wall-clock time.
    We therefore require a fresh tick whose raw timestamp advances while
    sampling; a stale single tick is not enough evidence to infer an offset.
    """
    now_fn = now_fn or time.time
    monotonic_fn = monotonic_fn or time.monotonic
    sleep_fn = sleep_fn or time.sleep
    first = mt5_module.symbol_info_tick(symbol)
    first_raw = raw_tick_time_msc(first)
    if first_raw is None:
        raise RuntimeError("tick_time_missing")
    first_sampled = now_fn()
    last = first
    last_raw = first_raw
    deadline = monotonic_fn() + max(0.0, float(wait_seconds))
    attempts = 1
    while True:
        current = mt5_module.symbol_info_tick(symbol)
        attempts += 1
        current_raw = raw_tick_time_msc(current)
        sampled = now_fn()
        if current_raw is not None and current_raw > last_raw:
            # raw server epoch = local UTC epoch + offset.  Broker offsets are
            # timezone-like values; quantize to a 15-minute step and require
            # the residual to remain small.  The observed VM terminal is
            # UTC+3, i.e. +10,800 seconds.
            offset_seconds = int(round((current_raw / 1000.0 - sampled) / 900.0) * 900)
            normalized = current_raw / 1000.0 - offset_seconds
            residual = normalized - sampled
            age = sampled - normalized
            if abs(offset_seconds) > 36 * 3600:
                raise RuntimeError("broker_offset_out_of_range")
            if abs(residual) > 180:
                raise RuntimeError("broker_clock_residual_too_large")
            if age < -180 or age > max_tick_age_seconds:
                raise RuntimeError("tick_stale")
            return {
                "status": "verified",
                "method": "advancing_tick_15_minute_offset",
                "symbol": symbol,
                "first_raw_time_msc": first_raw,
                "last_raw_time_msc": current_raw,
                "first_sampled_utc_msc": int(first_sampled * 1000),
                "last_sampled_utc_msc": int(sampled * 1000),
                "raw_time_advanced": True,
                "attempts": attempts,
                "broker_offset_seconds": offset_seconds,
                "broker_offset_minutes": offset_seconds // 60,
                "normalized_last_tick_utc_msc": int(round(normalized * 1000)),
                "residual_seconds": round(residual, 3),
                "tick_age_seconds": round(age, 3),
                "fresh": True,
            }
        last = current
        if current_raw is not None:
            last_raw = max(last_raw, current_raw)
        if monotonic_fn() >= deadline:
            break
        sleep_fn(max(0.01, min(float(poll_seconds), max(0.01, deadline - monotonic_fn()))))
    raise RuntimeError("tick_not_advancing")


def symbol_base_matches(symbol: str, requested_base: str) -> bool:
    symbol = str(symbol or "").strip()
    base = str(requested_base or "").strip().upper()
    if not symbol or not base:
        return False
    upper_symbol = symbol.upper()
    if upper_symbol == base:
        return True
    suffix = symbol[len(base) :] if upper_symbol.startswith(base) else ""
    if not suffix:
        return False
    if suffix[0] in ".-_":
        return True
    # Common broker suffixes are lowercase letters or digits appended to the
    # canonical symbol; XAUUSDJPY-like uppercase instruments are not aliases.
    return bool(re.fullmatch(r"[a-z0-9]+", suffix))


def resolve_unique_symbol(mt5_module: Any, requested_base: str = "XAUUSD") -> str:
    requested = str(requested_base or "XAUUSD").strip().upper()
    try:
        rows = list(mt5_module.symbols_get() or [])
    except Exception as exc:  # pragma: no cover - terminal-dependent
        raise RuntimeError("mt5_symbols_unavailable") from exc
    names = []
    for row in rows:
        name = str(_value(row, "name", row if isinstance(row, str) else "") or "").strip()
        if name and symbol_base_matches(name, requested):
            names.append(name)
    exact = [name for name in names if name.upper() == requested]
    candidates = exact or names
    unique = sorted(set(candidates), key=lambda value: (value.upper() != requested, value))
    if len(unique) != 1:
        if not unique:
            raise RuntimeError("symbol_not_found")
        raise RuntimeError("symbol_ambiguous")
    return unique[0]


def utc_datetime_for_mt5(utc_msc: int, broker_offset_seconds: int) -> dt.datetime:
    """Convert a real UTC boundary to the raw server epoch expected by MT5."""
    shifted = (int(utc_msc) + int(broker_offset_seconds) * 1000) / 1000
    return dt.datetime.fromtimestamp(shifted, UTC)


def _normalise_rate(raw: Any, offset_seconds: int, captured_utc_msc: int) -> dict[str, Any]:
    raw_time = _value(raw, "time")
    try:
        raw_time_seconds = int(raw_time)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("rate_time_missing") from exc
    if raw_time_seconds <= 0:
        raise RuntimeError("rate_time_invalid")
    server_msc = raw_time_seconds * 1000
    utc_msc = server_msc - int(offset_seconds) * 1000
    result: dict[str, Any] = {
        "time": utc_iso(utc_msc),
        "time_utc_msc": utc_msc,
        "time_server_msc": server_msc,
        "captured_at_utc_msc": int(captured_utc_msc),
    }
    numeric_fields = ("open", "high", "low", "close")
    for field in numeric_fields:
        try:
            value = float(_value(raw, field))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"rate_{field}_invalid") from exc
        if not math.isfinite(value) or value <= 0:
            raise RuntimeError(f"rate_{field}_invalid")
        result[field] = value
    if result["high"] < max(result["open"], result["close"]) or result["low"] > min(result["open"], result["close"]) or result["low"] > result["high"]:
        raise RuntimeError("rate_ohlc_invalid")
    for field in ("tick_volume", "spread"):
        try:
            value = int(_value(raw, field, 0) or 0)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"rate_{field}_invalid") from exc
        if value < 0:
            raise RuntimeError(f"rate_{field}_invalid")
        result[field] = value
    return result


def normalise_and_filter_rates(
    raw_rates: Iterable[Any],
    *,
    timeframe: str,
    broker_offset_seconds: int,
    asof_utc_msc: int,
    captured_utc_msc: int | None = None,
) -> list[dict[str, Any]]:
    captured_utc_msc = int(captured_utc_msc or asof_utc_msc)
    duration = TIMEFRAME_MINUTES[str(timeframe).upper()] * 60_000
    by_time: dict[int, dict[str, Any]] = {}
    for raw in raw_rates:
        row = _normalise_rate(raw, broker_offset_seconds, captured_utc_msc)
        opened = int(row["time_utc_msc"])
        # A candle is visible to the model only after its close.  This is
        # independent of the terminal's wall-clock timezone.
        if opened + duration > int(asof_utc_msc):
            continue
        previous = by_time.get(opened)
        if previous is not None and previous != row:
            raise RuntimeError("rate_duplicate_conflict")
        by_time[opened] = row
    return [by_time[key] for key in sorted(by_time)]


def _range_chunks(start_utc_msc: int, end_utc_msc: int, timeframe: str) -> list[tuple[int, int]]:
    duration = TIMEFRAME_MINUTES[str(timeframe).upper()] * 60_000
    if str(timeframe).upper() != "M1":
        return [(start_utc_msc, end_utc_msc)]
    maximum = MAX_M1_RANGE_BARS * duration
    chunks = []
    cursor = int(start_utc_msc)
    while cursor < end_utc_msc:
        chunk_end = min(end_utc_msc, cursor + maximum)
        chunks.append((cursor, chunk_end))
        if chunk_end >= end_utc_msc:
            break
        cursor = chunk_end
    return chunks


def fetch_timeframe_rates(
    mt5_module: Any,
    symbol: str,
    timeframe: str,
    start_utc_msc: int,
    end_utc_msc: int,
    *,
    broker_offset_seconds: int,
    asof_utc_msc: int,
    captured_utc_msc: int,
) -> tuple[list[dict[str, Any]], int]:
    key = str(timeframe).upper()
    constant = getattr(mt5_module, f"TIMEFRAME_{key}", None)
    if constant is None:
        raise RuntimeError(f"mt5_timeframe_constant_missing:{key}")
    raw_rates: list[Any] = []
    calls = 0
    for chunk_start, chunk_end in _range_chunks(start_utc_msc, end_utc_msc, key):
        start_dt = utc_datetime_for_mt5(chunk_start, broker_offset_seconds)
        end_dt = utc_datetime_for_mt5(chunk_end, broker_offset_seconds)
        rows = mt5_module.copy_rates_range(symbol, constant, start_dt, end_dt)
        calls += 1
        if rows is None:
            raise RuntimeError(f"mt5_rates_unavailable:{key}")
        try:
            raw_rates.extend(list(rows))
        except TypeError as exc:
            raise RuntimeError(f"mt5_rates_invalid:{key}") from exc
    return normalise_and_filter_rates(
        raw_rates,
        timeframe=key,
        broker_offset_seconds=broker_offset_seconds,
        asof_utc_msc=asof_utc_msc,
        captured_utc_msc=captured_utc_msc,
    ), calls


def _plan_requirements(metadata: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    plan = normalize_data_plan(metadata.get("data_plan") or metadata.get("policy", {}).get("market_data_plan"))
    use_chan = bool(metadata.get("use_chan_analysis", metadata.get("policy", {}).get("use_chan_analysis")))
    compiled = metadata.get("policy", {}).get("compiled_policy")
    indicator_requirements: dict[str, int] = {}
    if isinstance(compiled, Mapping):
        for definition in compiled.get("indicators", []):
            if not isinstance(definition, Mapping) or definition.get("enabled") is False:
                continue
            source = definition.get("source") or {}
            timeframe = str(source.get("timeframe", "")).upper()
            params = definition.get("params") or {}
            try:
                required = max(
                    int(params.get("period", 0)),
                    int(params.get("minimum_bars", 0)),
                    int(params.get("warmup_target_bars", 0)),
                )
            except (TypeError, ValueError):
                required = 0
            if timeframe and required:
                indicator_requirements[timeframe] = max(indicator_requirements.get(timeframe, 0), required)
    required: dict[str, int] = {}
    for item in plan["timeframes"]:
        timeframe = item["timeframe"]
        count = int(item["kline_count"])
        if use_chan:
            count = max(count, int(strategy_chan_policy(timeframe)["target"]))
        count = max(count, indicator_requirements.get(timeframe, 0))
        required[timeframe] = count + 20
    required["M1"] = max(required.get("M1", 0), 120)
    return plan, required


def _gap_summary(bars: list[Mapping[str, Any]], timeframe: str) -> dict[str, Any]:
    if len(bars) < 2:
        return {"gap_count": 0, "largest_gap_minutes": 0}
    expected = TIMEFRAME_MINUTES[timeframe] * 60_000
    gaps = [int(bar["time_utc_msc"]) - int(previous["time_utc_msc"]) for previous, bar in zip(bars, bars[1:])]
    unexpected = [gap for gap in gaps if gap > expected]
    return {
        "gap_count": len(unexpected),
        "largest_gap_minutes": round(max(unexpected, default=expected) / 60_000, 3),
        "filled": False,
    }


def fetch_snapshot(
    *,
    metadata_path: Path,
    terminal_path: str = DEFAULT_TERMINAL_PATH,
    window_days: int = DEFAULT_WINDOW_DAYS,
    outcome_hours: int = DEFAULT_OUTCOME_HOURS,
    mt5_module: Any | None = None,
) -> dict[str, Any]:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    plan, required = _plan_requirements(metadata)
    if not metadata.get("source", {}).get("git_commit"):
        raise RuntimeError("vm_commit_missing")
    if mt5_module is None:
        try:
            import MetaTrader5 as mt5_module  # type: ignore
        except ImportError as exc:  # pragma: no cover - environment-dependent
            raise RuntimeError("metatrader5_python_package_missing") from exc
    initialized = False
    try:
        if not mt5_module.initialize(path=terminal_path):
            raise RuntimeError("mt5_initialize_failed")
        initialized = True
        requested_symbol = "XAUUSD"
        symbols_json = metadata.get("strategy", {}).get("symbols_json")
        if symbols_json:
            try:
                parsed_symbols = json.loads(symbols_json) if isinstance(symbols_json, str) else symbols_json
                if isinstance(parsed_symbols, list) and parsed_symbols:
                    requested_symbol = str(parsed_symbols[0])
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        symbol = resolve_unique_symbol(mt5_module, requested_symbol)
        calibration = calibrate_broker_offset(mt5_module, symbol)
        offset = int(calibration["broker_offset_seconds"])
        asof_utc_msc = int(calibration["last_sampled_utc_msc"])
        window_end = asof_utc_msc
        window_start = window_end - int(window_days) * 86_400_000
        outcome_end = window_end + int(outcome_hours) * 3_600_000
        warmup_start_by_timeframe = {
            timeframe: window_start - math.ceil(
                count * TIMEFRAME_MINUTES[timeframe] * 60_000 * CALENDAR_WARMUP_FACTOR
            )
            for timeframe, count in required.items()
        }
        warmup_start = min(warmup_start_by_timeframe.values())
        all_timeframes = list(dict.fromkeys([item["timeframe"] for item in plan["timeframes"]] + ["M1"]))
        timeframes: dict[str, Any] = {}
        total_calls = 0
        for timeframe in all_timeframes:
            start = warmup_start_by_timeframe.get(
                timeframe,
                window_start - required.get(timeframe, 120) * TIMEFRAME_MINUTES[timeframe] * 60_000,
            )
            bars, calls = fetch_timeframe_rates(
                mt5_module,
                symbol,
                timeframe,
                start,
                outcome_end,
                broker_offset_seconds=offset,
                asof_utc_msc=asof_utc_msc,
                captured_utc_msc=asof_utc_msc,
            )
            required_before_window = max(0, int(required.get(timeframe, 0)) - 20)
            available_before_window = sum(
                1
                for bar in bars
                if int(bar["time_utc_msc"]) + TIMEFRAME_MINUTES[timeframe] * 60_000 <= window_start
            )
            if available_before_window < required_before_window:
                raise RuntimeError(
                    f"mt5_warmup_insufficient:{timeframe}:{available_before_window}:{required_before_window}"
                )
            total_calls += calls
            timeframes[timeframe] = {
                "timeframe": timeframe,
                "minutes": TIMEFRAME_MINUTES[timeframe],
                "bars": bars,
                "bar_count": len(bars),
                "bars_before_score_window": available_before_window,
                "required_before_score_window": required_before_window,
                "gap_summary": _gap_summary(bars, timeframe),
            }
        payload = {
            "schema_version": "market-data-v1",
            "source": "local_mt5_python_rates_read_only",
            "terminal_path": terminal_path,
            "symbol_requested": requested_symbol,
            "symbol": symbol,
            "standard_symbol": "XAUUSD",
            "clock": calibration,
            "window": {
                "window_days": int(window_days),
                "outcome_hours": int(outcome_hours),
                "start_utc": utc_iso(window_start),
                "end_utc": utc_iso(window_end),
                "outcome_end_utc": utc_iso(outcome_end),
                "warmup_start_utc": utc_iso(warmup_start),
                "start_utc_msc": window_start,
                "end_utc_msc": window_end,
                "outcome_end_utc_msc": outcome_end,
                "warmup_start_utc_msc": warmup_start,
                "warmup_start_by_timeframe_utc_msc": warmup_start_by_timeframe,
            },
            "plan": plan,
            "warmup_requirements": required,
            "calendar_warmup_factor": CALENDAR_WARMUP_FACTOR,
            "timeframes": timeframes,
        }
        canonical = json_bytes(payload)
        payload_hash = sha256_bytes(canonical)
        # This is the hash of the canonical payload before its self-describing
        # field is added.  metadata.json is the authoritative sidecar and
        # repeats both the canonical and actual-file hashes.
        payload["market_data_sha256"] = payload_hash
        output_root = metadata_path.parent.parent
        data_root = output_root / "data"
        ensure_dir(data_root)
        data_path = data_root / "market-data.json"
        data_path.write_bytes(json_bytes(payload, pretty=True) + b"\n")
        package_version = None
        try:
            package_version = importlib.metadata.version("MetaTrader5")
        except importlib.metadata.PackageNotFoundError:
            package_version = getattr(mt5_module, "__version__", None)
        data_metadata = {
            "artifact_version": "market-data-v1",
            "market_data_sha256": payload_hash,
            "market_data_file_sha256": sha256_file(data_path),
            "market_data_bytes": data_path.stat().st_size,
            "symbol": symbol,
            "clock": calibration,
            "terminal_path": terminal_path,
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "metatrader5_python_version": package_version,
            "copy_rates_range_calls": total_calls,
            "plan": plan,
            "bar_counts": {key: value["bar_count"] for key, value in timeframes.items()},
            "bars_before_score_window": {
                key: value["bars_before_score_window"] for key, value in timeframes.items()
            },
            "required_before_score_window": {
                key: value["required_before_score_window"] for key, value in timeframes.items()
            },
            "warmup_start_by_timeframe_utc": {
                key: utc_iso(value) for key, value in warmup_start_by_timeframe.items()
            },
            "source": {
                "vm_commit": metadata.get("source", {}).get("git_commit"),
                "local_commit": git_commit(),
                "vm_branch": metadata.get("source", {}).get("git_branch"),
            },
            "accounts_exported": False,
        }
        write_json(data_root / "metadata.json", data_metadata)
        (data_root / "market-data.sha256").write_text(payload_hash + "\n", encoding="ascii")
        return data_metadata
    finally:
        if initialized:
            mt5_module.shutdown()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only local MT5 market snapshot")
    parser.add_argument("--metadata", type=Path, default=EXPERIMENT_ROOT / "artifacts" / "source" / "runtime-metadata.json")
    parser.add_argument("--terminal-path", default=DEFAULT_TERMINAL_PATH)
    parser.add_argument("--window-days", type=int, default=DEFAULT_WINDOW_DAYS)
    parser.add_argument("--outcome-hours", type=int, default=DEFAULT_OUTCOME_HOURS)
    args = parser.parse_args(argv)
    try:
        result = fetch_snapshot(
            metadata_path=args.metadata,
            terminal_path=args.terminal_path,
            window_days=max(1, args.window_days),
            outcome_hours=max(1, args.outcome_hours),
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
