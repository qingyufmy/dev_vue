-- Preserve every legacy candle and promote only the verified V4 build table.
RENAME TABLE `market_candles` TO `market_candles_legacy_v3`, `market_candles_build_v4` TO `market_candles`;
