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
