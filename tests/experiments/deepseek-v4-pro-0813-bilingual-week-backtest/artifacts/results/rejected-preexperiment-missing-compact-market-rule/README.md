# Excluded pre-experiment: missing compact market rule

This directory preserves the first 32-call bilingual batch and its original
report/audit for traceability. It is excluded from every final metric.

Reason for exclusion: the requests contained the production compact K-line
arrays and their `input_encoding.kline_fields`, but the system prompt omitted
the production `COMPACT_MARKET_INPUT_RULE`. The four cells still shared the
same frozen market payload, so this batch remains useful as diagnostic evidence,
but it is not sufficiently equivalent to the online prompt path for formal
comparison.

The replacement formal batch starts from an empty sibling `calls/` directory
and includes the compact-input rule in the strategy-language variant.
