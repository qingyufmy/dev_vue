"""Extract independent native completion time without changing legacy order facts."""


def native_order_completion_time(row, normalize, observed_at_utc_msc):
    """Return UTC completion milliseconds, or None when native evidence is absent.

    The caller still owns terminal state, ticket, route and same-batch validation.
    normalize must use a verified broker clock; its errors propagate unchanged.
    """
    def integer(value):
        if type(value) is not int or value < 0 or value > 9007199254740991:
            raise ValueError('mt5_completion_time_invalid')
        return value

    observed = integer(observed_at_utc_msc)
    if observed == 0:
        raise ValueError('mt5_completion_time_invalid')
    millis = integer(0 if row.get('time_done_msc') is None else row['time_done_msc'])
    seconds = integer(0 if row.get('time_done') is None else row['time_done'])
    if millis and seconds and millis // 1000 != seconds:
        raise ValueError('mt5_completion_time_conflict')
    native = millis or seconds * 1000
    if not native:
        return None
    integer(native)
    completed = integer(normalize(native))
    if completed == 0 or completed > observed:
        raise ValueError('mt5_completion_time_invalid')
    return completed


def history_order_completion_evidence(rows, emitted_orders, clock, observed_at_utc_msc):
    """Versioned sidecar, limited to native orders selected and emitted on this page."""
    emitted = {str(row['ticket']) for row in emitted_orders}
    states = {2: 'cancelled', 4: 'filled', 5: 'rejected', 6: 'expired'}
    items = []
    seen = set()
    for row in rows:
        ticket = row.get('ticket')
        if type(ticket) is not int or ticket <= 0:
            raise ValueError('mt5_completion_ticket_invalid')
        if str(ticket) not in emitted:
            continue
        if ticket in seen:
            raise ValueError('mt5_completion_ticket_duplicate')
        seen.add(ticket)
        state = row.get('state')
        if type(state) is not int or state not in states:
            continue
        completed = native_order_completion_time(row, clock.normalize, observed_at_utc_msc)
        if completed is None:
            continue
        items.append({'ticket': str(ticket), 'native_state': state, 'state': states[state],
                      'completed_at_utc_msc': completed,
                      'timezone_offset_minutes': clock.require_offset_minutes(),
                      'observed_at_utc_msc': observed_at_utc_msc})
    return {'version': 1, 'platform': 'mt5', 'items': items}
