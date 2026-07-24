"""Pure helpers for classifying MetaTrader 5 order_send results.

This module intentionally has no PyQt or MetaTrader5 import so its safety rules
can be regression-tested without a running terminal.
"""


def classify_deal_result(result, mt5):
    """Return success, partial, uncertain, rejected, or unknown.

    A ticket on a non-DONE response proves only that MT5 assigned a reference;
    it does not prove that the requested position change completed.
    """
    if result is None:
        return "unknown"
    retcode = int(getattr(result, "retcode", -1) or -1)
    if retcode == int(mt5.TRADE_RETCODE_DONE):
        return "success"
    done_partial = getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", None)
    if done_partial is not None and retcode == int(done_partial):
        return "partial"
    order_ticket = int(getattr(result, "order", 0) or 0)
    deal_ticket = int(getattr(result, "deal", 0) or 0)
    if order_ticket > 0 or deal_ticket > 0:
        return "uncertain"
    return "rejected"


def retryable_trade_retcodes(mt5):
    """Return only quote-refresh retcodes that are safe to retry.

    REJECT (10006) and TOO_MANY_REQUESTS (10024) are intentionally excluded.
    Reading the exported MetaTrader5 constants avoids drifting numeric tables.
    """
    names_and_fallbacks = (
        ("TRADE_RETCODE_REQUOTE", 10004),
        ("TRADE_RETCODE_PRICE_CHANGED", 10020),
        ("TRADE_RETCODE_PRICE_OFF", 10021),
    )
    return {
        int(getattr(mt5, name, fallback))
        for name, fallback in names_and_fallbacks
    }


def parse_required_order_volume(params):
    """Parse an explicitly supplied order volume without inventing a default."""
    params = params if isinstance(params, dict) else {}
    raw_volume = params.get("lot")
    if raw_volume is None or raw_volume == "":
        raw_volume = params.get("volume")
    if raw_volume is None or raw_volume == "":
        return None, "volume is required"
    if isinstance(raw_volume, bool):
        return None, "volume must be numeric"
    try:
        return float(raw_volume), None
    except (TypeError, ValueError, OverflowError):
        return None, "volume must be numeric"
