#property strict
#property version   "4.000"
#property description "Liangjian Bridge V4 MT4 terminal adapter"

#include "..\\common\\BridgeV4Pipe.mqh"

input int InpPollMilliseconds = 100;

int  g_pipe = INVALID_HANDLE;
bool g_welcomed = false;
string g_terminal_instance_id = "";
long g_session_epoch = 0;
int g_server_offset_minutes = 0;
long g_offset_sampled_at_utc_msc = 0;
datetime g_last_server_time = 0;
bool g_offset_valid = false;
string g_bound_broker_server = "";
int g_bound_login = 0;
datetime g_next_connect_time = 0;
int g_connect_failures = 0;
uint g_last_bridge_activity = 0;

long B4MT4Hash(const string value)
  {
   long hash = 5381;
   for(int index = 0; index < StringLen(value); index++)
      hash = (hash * 33 + StringGetCharacter(value, index)) % 2147483629;
   return(hash);
  }

string B4MT4CacheKey(const string suffix)
  {
   return("LiangjianV4." + IntegerToString(AccountNumber()) + "."
      + B4LongText(B4MT4Hash(AccountServer())) + "." + suffix);
  }

void B4MT4LoadOffset()
  {
   string minutes_key = B4MT4CacheKey("offset_minutes");
   string sample_key = B4MT4CacheKey("offset_sample_utc");
   if(!GlobalVariableCheck(minutes_key) || !GlobalVariableCheck(sample_key)) return;
   int minutes = (int)MathRound(GlobalVariableGet(minutes_key));
   long sampled = (long)MathRound(GlobalVariableGet(sample_key));
   if(!B4ValidOffsetMinutes(minutes) || sampled <= 0) return;
   g_server_offset_minutes = minutes;
   g_offset_sampled_at_utc_msc = sampled;
   g_offset_valid = true;
  }

void B4MT4RefreshOffset()
  {
   datetime server_time = TimeCurrent();
   datetime utc_time = TimeGMT();
   if(server_time <= 0 || utc_time <= 0 || server_time <= g_last_server_time) return;
   g_last_server_time = server_time;
   long delta_seconds = (long)server_time - (long)utc_time;
   int minutes = (int)MathRound((double)delta_seconds / 60.0);
   long residual = delta_seconds - (long)minutes * 60;
   if(!B4ValidOffsetMinutes(minutes) || MathAbs((double)residual) > 120.0) return;
   g_server_offset_minutes = minutes;
   g_offset_sampled_at_utc_msc = (long)utc_time * 1000;
   g_offset_valid = true;
   GlobalVariableSet(B4MT4CacheKey("offset_minutes"), (double)minutes);
   GlobalVariableSet(B4MT4CacheKey("offset_sample_utc"), (double)g_offset_sampled_at_utc_msc);
  }

string B4MT4ClockStatus()
  {
   if(!g_offset_valid || g_offset_sampled_at_utc_msc <= 0) return("unavailable");
   long age = B4UtcNowMsc() - g_offset_sampled_at_utc_msc;
   return(age <= 300000 ? "calibrated" : "stale");
  }

bool B4MT4ToUtc(const datetime server_time, long &utc_msc)
  {
   if(!g_offset_valid || server_time <= 0) return(false);
   utc_msc = (long)server_time * 1000 - (long)g_server_offset_minutes * 60000;
   return(utc_msc > 0);
  }

string B4MT4Bool(const bool value)
  {
   return(B4JsonBool(value));
  }

int B4MT4Digits(const string symbol)
  {
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   return(digits >= 0 && digits <= 16 ? digits : 8);
  }

string B4MT4Decimal(const double value, const string symbol)
  {
   return(B4JsonDecimal(value, B4MT4Digits(symbol)));
  }

string B4MT4NullableDecimal(const double value, const string symbol)
  {
   return(B4JsonNullableDecimal(value, B4MT4Digits(symbol)));
  }

// Lots and contract volume settings are not prices.  Do not format them with
// the symbol's quote digits: a broker can expose a volume step with a finer
// (or coarser) scale than the quote.  Fixed-point output avoids scientific
// notation and trims only insignificant zeroes.
string B4MT4VolumeText(const double value)
  {
   if(!MathIsValidNumber(value)) return("");
   string text = DoubleToString(value, 16);
   while(StringLen(text) > 0
      && StringGetCharacter(text, StringLen(text) - 1) == '0')
      text = StringSubstr(text, 0, StringLen(text) - 1);
   if(StringLen(text) > 0
      && StringGetCharacter(text, StringLen(text) - 1) == '.')
      text = StringSubstr(text, 0, StringLen(text) - 1);
   if(text == "-0" || text == "") return("0");
   return(text);
  }

void B4MT4SendError(const string request_id, const int resource_code,
   const string code, const string message)
  {
   uchar response[];
   int size = 0;
   B4AppendInt32(response, size, B4_MSG_QUERY_ERROR);
   B4AppendUtf8(response, size, request_id);
   B4AppendInt32(response, size, resource_code);
   B4AppendUtf8(response, size, code);
   B4AppendUtf8(response, size, message);
   if(!B4WriteFrame(g_pipe, response, size)) B4MT4Disconnect();
  }

void B4MT4SendResponse(const string request_id, const int resource_code,
   const long observed_at_utc_msc, const string data_json,
   const string next_cursor, const bool has_more)
  {
   uchar response[];
   int size = 0;
   B4AppendInt32(response, size, B4_MSG_QUERY_RESPONSE);
   B4AppendUtf8(response, size, request_id);
   B4AppendInt32(response, size, resource_code);
   B4AppendInt64(response, size, observed_at_utc_msc > 0 ? observed_at_utc_msc : B4UtcNowMsc());
   B4AppendInt32(response, size, g_offset_valid ? g_server_offset_minutes : 0);
   B4AppendUtf8(response, size, B4MT4ClockStatus());
   B4AppendUtf8(response, size, data_json);
   B4AppendUtf8(response, size, next_cursor);
   B4AppendInt32(response, size, has_more ? 1 : 0);
   if(!B4WriteFrame(g_pipe, response, size)) B4MT4Disconnect();
  }

bool B4MT4RequireClock(const string request_id, const int resource_code)
  {
   if(g_offset_valid) return(true);
   B4MT4SendError(request_id, resource_code, "clock_unavailable",
      "terminal server clock offset is not calibrated");
   return(false);
  }

string B4MT4TerminalInfoJson()
  {
   return("{\"platform\":\"mt4\",\"adapter_version\":\"4.0.0.0\","
      + "\"terminal_build\":" + IntegerToString((int)TerminalInfoInteger(TERMINAL_BUILD))
      + ",\"terminal_name\":\"MetaTrader 4\",\"company\":"
      + B4JsonString(AccountCompany()) + ",\"data_path\":"
      + B4JsonString(TerminalInfoString(TERMINAL_DATA_PATH)) + ",\"program_path\":"
      + B4JsonString(TerminalInfoString(TERMINAL_PATH)) + ",\"connected\":"
      + B4MT4Bool(IsConnected()) + ",\"trade_allowed\":"
      + B4MT4Bool(IsTradeAllowed()) + "}");
  }

string B4MT4ClockJson()
  {
   datetime server_time = TimeCurrent();
   long utc_msc = 0;
   bool have_time = B4MT4ToUtc(server_time, utc_msc);
   return("{\"server_time_utc_msc\":" + (have_time ? B4JsonLong(utc_msc) : "null")
      + ",\"sampled_at_utc_msc\":"
      + (g_offset_sampled_at_utc_msc > 0 ? B4JsonLong(g_offset_sampled_at_utc_msc) : "null")
      + ",\"timezone_offset_minutes\":" + IntegerToString(g_server_offset_minutes)
      + ",\"clock_status\":" + B4JsonString(B4MT4ClockStatus()) + "}");
  }

string B4MT4AccountJson()
  {
   double margin = AccountMargin();
   string margin_level = margin > 0.0
      ? B4JsonString(DoubleToString(AccountEquity() / margin * 100.0, 2)) : "null";
   return("{\"login\":" + B4JsonString(IntegerToString(AccountNumber()))
      + ",\"broker_server\":" + B4JsonString(AccountServer())
      + ",\"name\":" + B4JsonString(AccountName())
      + ",\"company\":" + B4JsonString(AccountCompany())
      + ",\"currency\":" + B4JsonString(AccountCurrency())
      + ",\"leverage\":" + IntegerToString(AccountLeverage())
      + ",\"balance\":" + B4JsonString(DoubleToString(AccountBalance(), 8))
      + ",\"equity\":" + B4JsonString(DoubleToString(AccountEquity(), 8))
      + ",\"margin\":" + B4JsonString(DoubleToString(margin, 8))
      + ",\"free_margin\":" + B4JsonString(DoubleToString(AccountFreeMargin(), 8))
      + ",\"margin_level\":" + margin_level
      + ",\"profit\":" + B4JsonString(DoubleToString(AccountProfit(), 8))
      + ",\"connected\":" + B4MT4Bool(IsConnected())
      + ",\"trade_allowed\":" + B4MT4Bool(IsTradeAllowed()) + "}");
  }

string B4MT4ResolveMarketSymbol(const string requested)
  {
   // Standard-symbol queries and new orders resolve broker suffixes; existing tickets stay exact.
   if(StringLen(requested) < 1 || StringLen(requested) > 64) return("");
   string selected = "";
   int matches = 0;
   for(int index = 0; index < SymbolsTotal(false); index++)
     {
      string name = SymbolName(index, false);
      if(StringCompare(name, requested, false) == 0) return(name);
      if(StringLen(name) <= StringLen(requested) || StringLen(name) > 64
         || StringCompare(StringSubstr(name, 0, StringLen(requested)), requested, false) != 0) continue;
      matches++;
      selected = name;
     }
   return(matches == 1 ? selected : "");
  }

string B4MT4SymbolDescription(const string symbol)
  {
   string description = SymbolInfoString(symbol, SYMBOL_DESCRIPTION);
   return(description == "" ? symbol : description);
  }

string B4MT4SymbolsJson(const int limit, const int offset)
  {
   int total = SymbolsTotal(false);
   int skipped = 0;
   int emitted = 0;
   string items = "[";
   for(int index = 0; index < total && emitted < limit; index++)
     {
      string symbol = SymbolName(index, false);
      if(symbol == "") continue;
      if(skipped < offset)
        {
         skipped++;
         continue;
        }
      if(emitted > 0) items += ",";
      bool selected = SymbolInfoInteger(symbol, SYMBOL_SELECT) != 0;
      bool visible = SymbolInfoInteger(symbol, SYMBOL_VISIBLE) != 0;
      items += "{\"symbol\":" + B4JsonString(symbol)
         + ",\"selected\":" + B4MT4Bool(selected)
         + ",\"visible\":" + B4MT4Bool(visible)
         + ",\"description\":" + B4JsonString(B4MT4SymbolDescription(symbol)) + "}";
      emitted++;
     }
   items += "]";
   bool more = offset + emitted < total;
   string next = more ? B4Cursor(offset + emitted) : "";
   return("{\"items\":" + items + "}");
  }

string B4MT4InstrumentJson(const string symbol)
  {
   if(symbol == "") return("{}");
   int digits = B4MT4Digits(symbol);
   int trade_mode = MarketInfo(symbol, MODE_TRADEALLOWED) > 0 ? 4 : 0;
   return("{\"symbol\":" + B4JsonString(symbol)
      + ",\"description\":" + B4JsonString(B4MT4SymbolDescription(symbol))
      + ",\"digits\":" + IntegerToString(digits)
      + ",\"point\":" + B4MT4Decimal(MarketInfo(symbol, MODE_POINT), symbol)
      + ",\"tick_size\":" + B4MT4Decimal(MarketInfo(symbol, MODE_TICKSIZE), symbol)
      + ",\"tick_value\":" + B4MT4Decimal(MarketInfo(symbol, MODE_TICKVALUE), symbol)
      + ",\"contract_size\":" + B4MT4Decimal(MarketInfo(symbol, MODE_LOTSIZE), symbol)
      + ",\"volume_min\":" + B4MT4VolumeText(MarketInfo(symbol, MODE_MINLOT))
      + ",\"volume_max\":" + B4MT4VolumeText(MarketInfo(symbol, MODE_MAXLOT))
      + ",\"volume_step\":" + B4MT4VolumeText(MarketInfo(symbol, MODE_LOTSTEP))
      + ",\"stops_level\":" + IntegerToString((int)MarketInfo(symbol, MODE_STOPLEVEL))
      + ",\"freeze_level\":" + IntegerToString((int)MarketInfo(symbol, MODE_FREEZELEVEL))
      + ",\"trade_mode\":" + IntegerToString(trade_mode) + "}");
  }

string B4MT4QuoteItem(const string symbol)
  {
   if(symbol == "") return("{}");
   int digits = B4MT4Digits(symbol);
   datetime tick_time = (datetime)MarketInfo(symbol, MODE_TIME);
   long time_utc_msc = 0;
   bool have_time = B4MT4ToUtc(tick_time, time_utc_msc);
   return("{\"symbol\":" + B4JsonString(symbol)
      + ",\"bid\":" + B4MT4NullableDecimal(MarketInfo(symbol, MODE_BID), symbol)
      + ",\"ask\":" + B4MT4NullableDecimal(MarketInfo(symbol, MODE_ASK), symbol)
      + ",\"last\":" + B4MT4NullableDecimal(iClose(symbol, PERIOD_M1, 0), symbol)
      + ",\"volume\":" + B4LongText((long)iVolume(symbol, PERIOD_M1, 0))
      + ",\"time_utc_msc\":" + (have_time ? B4JsonLong(time_utc_msc) : "null") + "}");
  }

string B4MT4QuotesJson(string &symbols[])
  {
   string items = "[";
   int count = ArraySize(symbols);
   for(int index = 0; index < count; index++)
     {
      if(index > 0) items += ",";
      items += B4MT4QuoteItem(symbols[index]);
     }
   return("{\"items\":" + items + "]}");
  }

int B4MT4Timeframe(const int code)
  {
   if(code == 1) return(PERIOD_M1);
   if(code == 2) return(PERIOD_M5);
   if(code == 3) return(PERIOD_M15);
   if(code == 4) return(PERIOD_M30);
   if(code == 5) return(PERIOD_H1);
   if(code == 6) return(PERIOD_H4);
   if(code == 7) return(PERIOD_D1);
   if(code == 8) return(PERIOD_W1);
   if(code == 9) return(PERIOD_MN1);
   return(0);
  }

string B4MT4TimeframeName(const int code)
  {
   if(code == 1) return("M1");
   if(code == 2) return("M5");
   if(code == 3) return("M15");
   if(code == 4) return("M30");
   if(code == 5) return("H1");
   if(code == 6) return("H4");
   if(code == 7) return("D1");
   if(code == 8) return("W1");
   if(code == 9) return("MN1");
   return("");
  }

string B4MT4CandlesJson(const string symbol, const int timeframe_code,
   const int requested_count, const long start_utc_msc, const long end_utc_msc)
  {
   int timeframe = B4MT4Timeframe(timeframe_code);
   int available = iBars(symbol, timeframe);
   if(available <= 0) return("{\"symbol\":" + B4JsonString(symbol)
      + ",\"timeframe\":" + B4JsonString(B4MT4TimeframeName(timeframe_code))
      + ",\"items\":[]}");
   int oldest_shift = MathMin(available, B4_MAX_CANDLES) - 1;
   int newest_shift = 0;
   if(start_utc_msc > 0 && end_utc_msc > start_utc_msc)
     {
      datetime start_server = (datetime)(start_utc_msc / 1000
         + (long)g_server_offset_minutes * 60);
      datetime end_server = (datetime)(end_utc_msc / 1000
         + (long)g_server_offset_minutes * 60);
      oldest_shift = iBarShift(symbol, timeframe, start_server, false);
      newest_shift = iBarShift(symbol, timeframe, end_server, false);
      if(oldest_shift < 0 || newest_shift < 0)
         return("{\"symbol\":" + B4JsonString(symbol)
            + ",\"timeframe\":" + B4JsonString(B4MT4TimeframeName(timeframe_code))
            + ",\"items\":[]}");
      oldest_shift = MathMin(oldest_shift, available - 1);
      newest_shift = MathMax(newest_shift, 0);
     }
   int output_limit = requested_count > 0 ? requested_count : B4_MAX_CANDLES;
   string items = "[";
   int emitted = 0;
   for(int shift = oldest_shift; shift >= newest_shift && emitted < output_limit; shift--)
     {
      datetime server_time = iTime(symbol, timeframe, shift);
      long utc_msc = 0;
      if(!B4MT4ToUtc(server_time, utc_msc)) continue;
      if(start_utc_msc > 0 && utc_msc < start_utc_msc) continue;
      if(end_utc_msc > 0 && utc_msc >= end_utc_msc) continue;
      if(emitted > 0) items += ",";
      items += "{\"time_utc_msc\":" + B4JsonLong(utc_msc)
         + ",\"open\":" + B4MT4Decimal(iOpen(symbol, timeframe, shift), symbol)
         + ",\"high\":" + B4MT4Decimal(iHigh(symbol, timeframe, shift), symbol)
         + ",\"low\":" + B4MT4Decimal(iLow(symbol, timeframe, shift), symbol)
         + ",\"close\":" + B4MT4Decimal(iClose(symbol, timeframe, shift), symbol)
         + ",\"tick_volume\":" + B4LongText((long)iVolume(symbol, timeframe, shift))
         + ",\"spread\":" + IntegerToString((int)MarketInfo(symbol, MODE_SPREAD))
         + ",\"real_volume\":null}";
      emitted++;
     }
   items += "]";
   return("{\"symbol\":" + B4JsonString(symbol)
      + ",\"timeframe\":" + B4JsonString(B4MT4TimeframeName(timeframe_code))
      + ",\"items\":" + items + "}");
  }

string B4MT4Side(const int type)
  {
   if(type == OP_BUY || type == OP_BUYSTOP || type == OP_BUYLIMIT) return("buy");
   if(type == OP_SELL || type == OP_SELLSTOP || type == OP_SELLLIMIT) return("sell");
   return("unknown");
  }

string B4MT4OrderType(const int type)
  {
   if(type == OP_BUY) return("market_buy");
   if(type == OP_SELL) return("market_sell");
   if(type == OP_BUYLIMIT) return("buy_limit");
   if(type == OP_BUYSTOP) return("buy_stop");
   if(type == OP_SELLLIMIT) return("sell_limit");
   if(type == OP_SELLSTOP) return("sell_stop");
   if(type == 6) return("balance");
   if(type == 7) return("credit");
   return("unknown");
  }

string B4MT4PositionItem()
  {
   string symbol = OrderSymbol();
   long open_utc = 0;
   B4MT4ToUtc(OrderOpenTime(), open_utc);
   return("{\"ticket\":" + B4LongText(OrderTicket())
      + ",\"symbol\":" + B4JsonString(symbol)
      + ",\"side\":" + B4JsonString(B4MT4Side(OrderType()))
       + ",\"volume\":" + B4JsonString(B4MT4VolumeText(OrderLots()))
      + ",\"open_price\":" + B4MT4Decimal(OrderOpenPrice(), symbol)
      + ",\"current_price\":" + B4MT4NullableDecimal(
         OrderType() == OP_BUY ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK), symbol)
      + ",\"stop_loss\":" + B4MT4NullableDecimal(OrderStopLoss(), symbol)
      + ",\"take_profit\":" + B4MT4NullableDecimal(OrderTakeProfit(), symbol)
      + ",\"profit\":" + B4JsonString(DoubleToString(OrderProfit(), 8))
      + ",\"swap\":" + B4JsonString(DoubleToString(OrderSwap(), 8))
      + ",\"commission\":" + B4JsonString(DoubleToString(OrderCommission(), 8))
      + ",\"open_time_utc_msc\":" + (open_utc > 0 ? B4JsonLong(open_utc) : "null")
      + ",\"comment\":" + B4JsonString(OrderComment())
      + ",\"magic\":" + IntegerToString(OrderMagicNumber())
      + ",\"platform_semantics\":\"mt4_order\"}");
  }

string B4MT4PendingItem()
  {
   string symbol = OrderSymbol();
   long create_utc = 0;
   B4MT4ToUtc(OrderOpenTime(), create_utc);
   long expiry_utc = 0;
   B4MT4ToUtc(OrderExpiration(), expiry_utc);
   return("{\"ticket\":" + B4LongText(OrderTicket())
      + ",\"symbol\":" + B4JsonString(symbol)
      + ",\"side\":" + B4JsonString(B4MT4Side(OrderType()))
      + ",\"order_type\":" + B4JsonString(B4MT4OrderType(OrderType()))
      + ",\"price\":" + B4MT4Decimal(OrderOpenPrice(), symbol)
      + ",\"stop_loss\":" + B4MT4NullableDecimal(OrderStopLoss(), symbol)
      + ",\"take_profit\":" + B4MT4NullableDecimal(OrderTakeProfit(), symbol)
       + ",\"volume_initial\":" + B4JsonString(B4MT4VolumeText(OrderLots()))
       + ",\"volume_current\":" + B4JsonString(B4MT4VolumeText(OrderLots()))
      + ",\"create_time_utc_msc\":" + (create_utc > 0 ? B4JsonLong(create_utc) : "null")
      + ",\"expiration_time_utc_msc\":" + (expiry_utc > 0 ? B4JsonLong(expiry_utc) : "null")
      + ",\"comment\":" + B4JsonString(OrderComment())
      + ",\"magic\":" + IntegerToString(OrderMagicNumber())
      + ",\"platform_semantics\":\"mt4_order\"}");
  }

string B4MT4OrdersJson(const bool pending, const int limit, const int offset,
   const string requested_symbol, bool &has_more)
  {
   int total = OrdersTotal();
   int skipped = 0;
   int emitted = 0;
   has_more = false;
   string items = "[";
   for(int index = 0; index < total; index++)
     {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES)) continue;
      bool is_pending = OrderType() >= OP_BUYLIMIT && OrderType() <= OP_SELLSTOP;
      if(is_pending != pending) continue;
      if(requested_symbol != "" && OrderSymbol() != requested_symbol) continue;
      if(skipped < offset)
        {
         skipped++;
         continue;
        }
      if(emitted >= limit)
        {
         has_more = true;
         break;
        }
      if(emitted > 0) items += ",";
      items += pending ? B4MT4PendingItem() : B4MT4PositionItem();
      emitted++;
     }
   items += "]";
   return("{\"items\":" + items + "}");
  }

string B4MT4HistoryItem()
  {
   string symbol = OrderSymbol();
   datetime event_time = OrderCloseTime() > 0 ? OrderCloseTime() : OrderOpenTime();
   long event_utc = 0;
   B4MT4ToUtc(event_time, event_utc);
   return("{\"ticket\":" + B4LongText(OrderTicket())
      + ",\"order_ticket\":" + B4LongText(OrderTicket())
      + ",\"position_ticket\":null"
      + ",\"symbol\":" + B4JsonString(symbol)
      + ",\"side\":" + B4JsonString(B4MT4Side(OrderType()))
      + ",\"type\":" + B4JsonString(B4MT4OrderType(OrderType()))
       + ",\"volume\":" + B4JsonString(B4MT4VolumeText(OrderLots()))
      + ",\"price\":" + B4MT4Decimal(OrderCloseTime() > 0 ? OrderClosePrice() : OrderOpenPrice(), symbol)
      + ",\"profit\":" + B4JsonString(DoubleToString(OrderProfit(), 8))
      + ",\"commission\":" + B4JsonString(DoubleToString(OrderCommission(), 8))
      + ",\"swap\":" + B4JsonString(DoubleToString(OrderSwap(), 8))
      + ",\"time_utc_msc\":" + (event_utc > 0 ? B4JsonLong(event_utc) : "null")
      + ",\"comment\":" + B4JsonString(OrderComment())
      + ",\"magic\":" + IntegerToString(OrderMagicNumber())
      + ",\"platform_semantics\":\"mt4_order\"}");
  }

string B4MT4HistoryJson(const int resource_code, const long start_utc_msc,
   const long end_utc_msc, const int limit, const long cursor, bool &has_more)
  {
   int total = OrdersHistoryTotal();
   int skipped = 0;
   int emitted = 0;
   long inspected = 0;
   string items = "[";
   has_more = false;
   for(int index = 0; index < total; index++)
     {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_HISTORY)) continue;
      datetime event_time = OrderCloseTime() > 0 ? OrderCloseTime() : OrderOpenTime();
      long event_utc = 0;
      B4MT4ToUtc(event_time, event_utc);
      if(start_utc_msc > 0 && event_utc < start_utc_msc) continue;
      if(end_utc_msc > 0 && event_utc >= end_utc_msc) continue;
      bool closed = OrderCloseTime() > 0;
      bool market_trade = OrderType() == OP_BUY || OrderType() == OP_SELL;
      bool funds_event = OrderType() == 6 || OrderType() == 7;
      if(resource_code == B4_RESOURCE_HISTORY_TRADES && (!closed || !market_trade)) continue;
      if(resource_code == B4_RESOURCE_HISTORY_DEALS
         && (!closed || (!market_trade && !funds_event))) continue;
      if(inspected < cursor)
        {
         inspected++;
         continue;
        }
      if(emitted >= limit)
        {
         has_more = true;
         break;
        }
      if(emitted > 0) items += ",";
      items += B4MT4HistoryItem();
      emitted++;
      inspected++;
     }
   items += "]";
   return("{\"items\":" + items + "}");
  }

// ---------------------------------------------------------------------------
// V4 deterministic command path
// ---------------------------------------------------------------------------
// Values on this path are fixed-width protocol fields.  Prices and volumes
// use bounded decimal text because MQL4 has no portable bit-cast primitive for
// an IEEE-754 double.  The text is validated before it reaches any trade API.

bool B4MT4ValidDecimalText(const string value, const bool allow_empty,
   const bool allow_zero)
  {
   if(StringLen(value) == 0) return(allow_empty);
   if(StringLen(value) > 32) return(false);
   int digits = 0;
   int decimal_points = 0;
   for(int index = 0; index < StringLen(value); index++)
     {
      ushort code = (ushort)StringGetCharacter(value, index);
      if(code >= '0' && code <= '9')
        {
         digits++;
         continue;
        }
      if(code == '.' && decimal_points == 0 && index > 0
         && index + 1 < StringLen(value))
        {
         decimal_points++;
         continue;
        }
      return(false);
     }
   if(digits <= 0) return(false);
   double parsed = StrToDouble(value);
   if(!MathIsValidNumber(parsed) || parsed < 0.0) return(false);
   return(allow_zero || parsed > 0.0);
  }

bool B4MT4ReadCommandDecimal(const uchar &payload[], int &offset,
   string &value, bool &specified)
  {
   int flag = 0;
   if(!B4ReadInt32(payload, offset, flag) || (flag != 0 && flag != 1)) return(false);
   specified = flag == 1;
   if(!B4ReadUtf8(payload, offset, value, B4_MAX_STRING_BYTES, true)) return(false);
   if(!specified && StringLen(value) != 0) return(false);
   return(B4MT4ValidDecimalText(value, true, true));
  }

bool B4MT4ReadCommandFlag(const uchar &payload[], int &offset, bool &value)
  {
   int flag = 0;
   if(!B4ReadInt32(payload, offset, flag) || (flag != 0 && flag != 1)) return(false);
   value = flag == 1;
   return(true);
  }

string B4MT4ValueText(const double value, const string symbol)
  {
   if(!MathIsValidNumber(value)) return("");
   return(DoubleToString(value, B4MT4Digits(symbol)));
  }

bool B4MT4SameDecimal(const double actual, const string expected,
   const string symbol)
  {
   if(StringLen(expected) == 0) return(MathAbs(actual) <= 0.00000001);
   double target = StrToDouble(expected);
   double point = MarketInfo(symbol, MODE_POINT);
   double tolerance = MathMax(point / 2.0, 0.00000001);
   return(MathIsValidNumber(target) && MathAbs(actual - target) <= tolerance);
  }

int B4MT4DirectionCode(const int type)
  {
   if(type == OP_BUY || type == OP_BUYLIMIT || type == OP_BUYSTOP) return(1);
   if(type == OP_SELL || type == OP_SELLLIMIT || type == OP_SELLSTOP) return(2);
   return(0);
  }

int B4MT4OrderTypeCode(const int type)
  {
   if(type == OP_BUY || type == OP_SELL) return(1);
   if(type == OP_BUYLIMIT) return(2);
   if(type == OP_BUYSTOP) return(3);
   if(type == OP_SELLLIMIT) return(4);
   if(type == OP_SELLSTOP) return(5);
   return(0);
  }

int B4MT4Operation(const int direction, const int order_type)
  {
   if(order_type == 1 && direction == 1) return(OP_BUY);
   if(order_type == 1 && direction == 2) return(OP_SELL);
   if(order_type == 2 && direction == 1) return(OP_BUYLIMIT);
   if(order_type == 3 && direction == 1) return(OP_BUYSTOP);
   if(order_type == 4 && direction == 2) return(OP_SELLLIMIT);
   if(order_type == 5 && direction == 2) return(OP_SELLSTOP);
   return(-1);
  }

bool B4MT4IsPendingType(const int type)
  {
   return(type == OP_BUYLIMIT || type == OP_BUYSTOP
      || type == OP_SELLLIMIT || type == OP_SELLSTOP);
  }

bool B4MT4ValidVolume(const string symbol, const string value)
  {
   if(!B4MT4ValidDecimalText(value, false, false)) return(false);
   double volume = StrToDouble(value);
   return(MathIsValidNumber(volume) && volume > 0.0);
  }

bool B4MT4ValidStops(const string symbol, const int order_type,
   const double entry_price, const double stop_loss, const double take_profit,
   const bool stop_loss_specified, const bool take_profit_specified)
  {
   return((!stop_loss_specified || (MathIsValidNumber(stop_loss) && stop_loss >= 0.0))
      && (!take_profit_specified || (MathIsValidNumber(take_profit) && take_profit >= 0.0)));
  }

bool B4MT4UtcExpiration(const bool specified, const long utc_msc,
   datetime &server_expiration)
  {
   server_expiration = 0;
   if(!specified || utc_msc == 0) return(true);
   if(!g_offset_valid || utc_msc <= 0) return(false);
   long server_seconds = utc_msc / 1000 + (long)g_server_offset_minutes * 60;
   if(server_seconds <= (long)TimeCurrent()) return(false);
   server_expiration = (datetime)server_seconds;
   return(true);
  }

bool B4MT4AmbiguousTradeError(const int error_code)
  {
   return(error_code == 6 || error_code == 128 || error_code == 137
      || error_code == 146 || error_code == 4108);
  }

void B4MT4SendCommandResult(const string request_id, const string command_id,
   const int action, const int status, const int terminal_code, const long ticket,
   const int resource_state, const string actual_symbol, const int actual_direction,
   const int actual_order_type, const int actual_magic, const string actual_volume,
   const string actual_price, const bool actual_stop_loss_specified,
   const string actual_stop_loss, const bool actual_take_profit_specified,
   const string actual_take_profit, const bool actual_expiration_specified,
   const long actual_expiration_utc_msc, const long actual_open_time_utc_msc,
   const string actual_comment, const int result_flags, const string error_code,
   const string error_message)
  {
   uchar response[];
   int size = 0;
   B4AppendInt32(response, size, B4_MSG_COMMAND_RESULT);
   B4AppendUtf8(response, size, request_id);
   B4AppendUtf8(response, size, command_id);
   B4AppendInt32(response, size, action);
   B4AppendInt32(response, size, status);
   B4AppendInt32(response, size, terminal_code);
   B4AppendInt64(response, size, ticket);
   B4AppendInt32(response, size, resource_state);
   B4AppendInt64(response, size, B4UtcNowMsc());
   B4AppendUtf8(response, size, actual_symbol);
   B4AppendInt32(response, size, actual_direction);
   B4AppendInt32(response, size, actual_order_type);
   B4AppendInt32(response, size, actual_magic);
   B4AppendUtf8(response, size, actual_volume);
   B4AppendUtf8(response, size, actual_price);
   B4AppendInt32(response, size, actual_stop_loss_specified ? 1 : 0);
   B4AppendUtf8(response, size, actual_stop_loss);
   B4AppendInt32(response, size, actual_take_profit_specified ? 1 : 0);
   B4AppendUtf8(response, size, actual_take_profit);
   B4AppendInt32(response, size, actual_expiration_specified ? 1 : 0);
   B4AppendInt64(response, size, actual_expiration_utc_msc);
   B4AppendInt64(response, size, actual_open_time_utc_msc);
   B4AppendUtf8(response, size, actual_comment);
   B4AppendInt32(response, size, result_flags);
   B4AppendUtf8(response, size, error_code);
   B4AppendUtf8(response, size, error_message);
   if(!B4WriteFrame(g_pipe, response, size)) B4MT4Disconnect();
  }

void B4MT4SendCommandSimple(const string request_id, const string command_id,
   const int action, const int status, const int terminal_code, const long ticket,
   const int resource_state, const int result_flags, const string error_code,
   const string error_message)
  {
   B4MT4SendCommandResult(request_id, command_id, action, status, terminal_code,
      ticket, resource_state, "", 0, 0, 0, "", "", false, "", false, "",
      false, 0, 0, "", result_flags, error_code, error_message);
  }

void B4MT4SendSelectedCommandResult(const string request_id, const string command_id,
   const int action, const int status, const int terminal_code,
   const int resource_state, const int result_flags, const string error_code,
   const string error_message)
  {
   string symbol = OrderSymbol();
   long open_utc = 0;
   long expiration_utc = 0;
   B4MT4ToUtc(OrderOpenTime(), open_utc);
   bool expiration_specified = OrderExpiration() > 0
      && B4MT4ToUtc(OrderExpiration(), expiration_utc);
   bool stop_specified = OrderStopLoss() > 0.0;
   bool take_specified = OrderTakeProfit() > 0.0;
   B4MT4SendCommandResult(request_id, command_id, action, status, terminal_code,
      OrderTicket(), resource_state, symbol, B4MT4DirectionCode(OrderType()),
       B4MT4OrderTypeCode(OrderType()), OrderMagicNumber(),
       B4MT4VolumeText(OrderLots()), B4MT4ValueText(OrderOpenPrice(), symbol),
      stop_specified, stop_specified ? B4MT4ValueText(OrderStopLoss(), symbol) : "",
      take_specified, take_specified ? B4MT4ValueText(OrderTakeProfit(), symbol) : "",
      expiration_specified, expiration_utc, open_utc, OrderComment(), result_flags,
      error_code, error_message);
  }

bool B4MT4TradePermission(const string request_id, const string command_id,
   const int action)
  {
   if(!IsConnected())
     {
      B4MT4SendCommandSimple(request_id, command_id, action, B4_COMMAND_REJECTED,
         6, 0, B4_STATE_UNKNOWN, 0, "terminal_not_connected", "MT4 is not connected");
      return(false);
     }
   if(!IsTradeAllowed() || TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) == 0
      || MQLInfoInteger(MQL_TRADE_ALLOWED) == 0)
     {
      B4MT4SendCommandSimple(request_id, command_id, action, B4_COMMAND_REJECTED,
         4109, 0, B4_STATE_UNKNOWN, 0, "trade_not_allowed", "terminal or EA trading is disabled");
      return(false);
     }
   if(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) == 0)
     {
      B4MT4SendCommandSimple(request_id, command_id, action, B4_COMMAND_REJECTED,
         133, 0, B4_STATE_UNKNOWN, 0, "account_trade_not_allowed", "account trading is disabled");
      return(false);
     }
   if(AccountInfoInteger(ACCOUNT_TRADE_EXPERT) == 0)
     {
      B4MT4SendCommandSimple(request_id, command_id, action, B4_COMMAND_REJECTED,
         4112, 0, B4_STATE_UNKNOWN, 0, "expert_trade_not_allowed", "expert trading is disabled");
      return(false);
     }
   if(IsTradeContextBusy())
     {
      B4MT4SendCommandSimple(request_id, command_id, action, B4_COMMAND_REJECTED,
         146, 0, B4_STATE_UNKNOWN, 0, "trade_context_busy", "MT4 trade context is busy");
      return(false);
     }
   return(true);
  }

struct B4MT4Command
  {
   string request_id;
   string command_id;
   string idempotency_key;
   int action;
   long issued_at_utc_msc;
   long deadline_utc_msc;
   string terminal_instance_id;
   string broker_server;
   string login;
   long session_epoch;
   long ticket;
   string symbol;
   int direction;
   int order_type;
   int magic;
   string volume;
   bool price_specified;
   string price;
   bool stop_loss_specified;
   string stop_loss;
   bool take_profit_specified;
   string take_profit;
   bool expiration_specified;
   long expiration_utc_msc;
   int deviation;
   string comment;
   string lookup_reference;
   long expected_ticket;
   string expected_symbol;
   int expected_direction;
   int expected_order_type;
   int expected_magic;
   string expected_volume;
   bool expected_open_price_specified;
   string expected_open_price;
   bool expected_stop_loss_specified;
   string expected_stop_loss;
   bool expected_take_profit_specified;
   string expected_take_profit;
   bool expected_expiration_specified;
   long expected_expiration_utc_msc;
   long expected_revision;
  };

bool B4MT4ReadCommandDecimal(const uchar &payload[], int &offset,
   string &value, bool &specified);

bool B4MT4ReadCommand(B4MT4Command &command, uchar &payload[])
  {
   int offset = 4;
   int message_type = 0;
   int target_expiration_flag = 0;
   int expected_expiration_flag = 0;
   if(!B4ReadInt32(payload, offset, message_type) || message_type != B4_MSG_COMMAND_REQUEST
      || !B4ReadUtf8(payload, offset, command.request_id, 191, false)
      || !B4ReadUtf8(payload, offset, command.command_id, 191, false)
      || !B4ReadUtf8(payload, offset, command.idempotency_key, 191, false)
      || !B4ReadInt32(payload, offset, command.action)
      || !B4ReadInt64(payload, offset, command.issued_at_utc_msc)
      || !B4ReadInt64(payload, offset, command.deadline_utc_msc)
      || !B4ReadUtf8(payload, offset, command.terminal_instance_id, 191, false)
      || !B4ReadUtf8(payload, offset, command.broker_server, 128, false)
      || !B4ReadUtf8(payload, offset, command.login, 64, false)
      || !B4ReadInt64(payload, offset, command.session_epoch)
      || !B4ReadInt64(payload, offset, command.ticket)
      || !B4ReadUtf8(payload, offset, command.symbol, 64, true)
      || !B4ReadInt32(payload, offset, command.direction)
      || !B4ReadInt32(payload, offset, command.order_type)
      || !B4ReadInt32(payload, offset, command.magic)
      || !B4ReadUtf8(payload, offset, command.volume, 32, true)
      || !B4MT4ReadCommandDecimal(payload, offset, command.price, command.price_specified)
      || !B4MT4ReadCommandDecimal(payload, offset, command.stop_loss, command.stop_loss_specified)
      || !B4MT4ReadCommandDecimal(payload, offset, command.take_profit, command.take_profit_specified)
      || !B4ReadInt32(payload, offset, target_expiration_flag)
      || !B4ReadInt64(payload, offset, command.expiration_utc_msc)
      || !B4ReadInt32(payload, offset, command.deviation)
      || !B4ReadUtf8(payload, offset, command.comment, 64, true)
      || !B4ReadUtf8(payload, offset, command.lookup_reference, 191, true)
      || !B4ReadInt64(payload, offset, command.expected_ticket)
      || !B4ReadUtf8(payload, offset, command.expected_symbol, 64, true)
      || !B4ReadInt32(payload, offset, command.expected_direction)
      || !B4ReadInt32(payload, offset, command.expected_order_type)
      || !B4ReadInt32(payload, offset, command.expected_magic)
      || !B4ReadUtf8(payload, offset, command.expected_volume, 32, true)
      || !B4MT4ReadCommandDecimal(payload, offset, command.expected_open_price,
         command.expected_open_price_specified)
      || !B4MT4ReadCommandDecimal(payload, offset, command.expected_stop_loss,
         command.expected_stop_loss_specified)
      || !B4MT4ReadCommandDecimal(payload, offset, command.expected_take_profit,
         command.expected_take_profit_specified)
      || !B4ReadInt32(payload, offset, expected_expiration_flag)
      || !B4ReadInt64(payload, offset, command.expected_expiration_utc_msc)
      || !B4ReadInt64(payload, offset, command.expected_revision)
      || offset != ArraySize(payload)
      || (target_expiration_flag != 0 && target_expiration_flag != 1)
      || (expected_expiration_flag != 0 && expected_expiration_flag != 1))
     return(false);
   command.expiration_specified = target_expiration_flag == 1;
   command.expected_expiration_specified = expected_expiration_flag == 1;
   if(command.expiration_specified == false && command.expiration_utc_msc != 0) return(false);
   if(command.expected_expiration_specified == false
      && command.expected_expiration_utc_msc != 0) return(false);
   return(true);
  }

string B4MT4CommandReference(const string command_id)
  {
   string suffix = StringSubstr(command_id, MathMax(0, StringLen(command_id) - 24));
   return("B4:" + suffix);
  }

string B4MT4OrderComment(const string command_id)
  {
   string reference = B4MT4CommandReference(command_id);
   if(StringLen(reference) > 31) reference = StringSubstr(reference, 0, 31);
   return(reference);
  }

bool B4MT4CommandExpectedShape(const B4MT4Command &command)
  {
   if(command.expected_ticket <= 0 || StringLen(command.expected_symbol) <= 0
      || command.expected_direction < 1 || command.expected_direction > 2
      || command.expected_order_type < 1 || command.expected_order_type > 5
      || command.expected_magic < 0 || command.expected_revision != 0
      || !B4MT4ValidVolume(command.expected_symbol, command.expected_volume)
      || !command.expected_open_price_specified
      || !B4MT4ValidDecimalText(command.expected_open_price, false, false)
      || !command.expected_stop_loss_specified || !command.expected_take_profit_specified
      || !command.expected_expiration_specified)
      return(false);
   if(!B4MT4ValidDecimalText(command.expected_stop_loss, false, true)
      || !B4MT4ValidDecimalText(command.expected_take_profit, false, true)) return(false);
   if(command.expected_expiration_utc_msc < 0) return(false);
   return(true);
  }

bool B4MT4CommandTargetShape(const B4MT4Command &command)
  {
   if(command.action < B4_ACTION_ORDER_PLACE || command.action > B4_ACTION_EXECUTION_LOOKUP
      || StringLen(command.request_id) <= 0 || StringLen(command.command_id) <= 0
      || StringLen(command.idempotency_key) < 16 || StringLen(command.idempotency_key) > 191
      || command.issued_at_utc_msc <= 0 || command.deadline_utc_msc < command.issued_at_utc_msc
      || command.deadline_utc_msc < B4UtcNowMsc()
      || StringCompare(command.terminal_instance_id, g_terminal_instance_id, false) != 0
      || StringCompare(command.broker_server, AccountServer(), false) != 0
      || command.login != IntegerToString(AccountNumber())
      || command.session_epoch != g_session_epoch
      || command.deviation < 0 || command.deviation > 100000
      || command.ticket < 0 || command.magic < 0
      || command.direction < 0 || command.direction > 2
      || command.order_type < 0 || command.order_type > 5)
      return(false);
   if(command.price_specified && !B4MT4ValidDecimalText(command.price, false, false)) return(false);
   if(command.stop_loss_specified && !B4MT4ValidDecimalText(command.stop_loss, true, true)) return(false);
   if(command.take_profit_specified && !B4MT4ValidDecimalText(command.take_profit, true, true)) return(false);
   if(command.expiration_specified && command.expiration_utc_msc < 0) return(false);
   if(command.action == B4_ACTION_ORDER_PLACE)
     {
      if(command.expected_ticket != 0 || command.expected_symbol != ""
         || command.expected_direction != 0 || command.expected_order_type != 0
         || command.expected_magic != 0 || command.expected_volume != ""
         || command.expected_open_price_specified || command.expected_stop_loss_specified
         || command.expected_take_profit_specified || command.expected_expiration_specified
         || command.expected_expiration_utc_msc != 0 || command.expected_revision != 0
         || command.ticket != 0 || command.symbol == "" || command.direction < 1
         || command.order_type < 1 || command.order_type > 5
         || !B4MT4ValidVolume(command.symbol, command.volume)
         || (!command.price_specified && command.order_type != 1)
         || (command.price_specified && command.order_type == 1)
         || (command.stop_loss_specified && command.stop_loss == "")
         || (command.take_profit_specified && command.take_profit == "")
         || (command.expiration_specified && command.expiration_utc_msc == 0)) return(false);
      return(true);
     }
   if(command.action == B4_ACTION_EXECUTION_LOOKUP)
     {
      bool by_ticket = command.ticket > 0;
      bool by_reference = command.lookup_reference != "";
      if(by_ticket == by_reference || command.expected_ticket != 0
         || command.expected_symbol != "" || command.expected_direction != 0
         || command.expected_order_type != 0 || command.expected_magic != 0
         || command.expected_volume != "" || command.expected_open_price_specified
         || command.expected_stop_loss_specified || command.expected_take_profit_specified
         || command.expected_expiration_specified || command.expected_revision != 0)
         return(false);
      if(by_reference && (command.symbol == "" || command.magic < 0)) return(false);
      return(true);
     }
   if(!B4MT4CommandExpectedShape(command) || command.ticket != command.expected_ticket
      || command.symbol != command.expected_symbol || command.direction != command.expected_direction
      || command.order_type != command.expected_order_type || command.magic != command.expected_magic
      || !B4MT4SameDecimal(StrToDouble(command.volume), command.expected_volume, command.symbol))
      return(false);
   return(true);
  }

void B4MT4ExecutePlace(const string request_id, const string command_id,
   const string requested_symbol, const int direction, const int order_type,
   const string volume_text, const bool price_specified, const string price_text,
   const bool stop_loss_specified, const string stop_loss_text,
   const bool take_profit_specified, const string take_profit_text,
   const bool expiration_specified, const long expiration_utc,
   const int deviation, const int magic, const string idempotency_key)
  {
   if(!B4MT4TradePermission(request_id, command_id, B4_ACTION_ORDER_PLACE)) return;
   string symbol = B4MT4ResolveMarketSymbol(requested_symbol);
   int operation = B4MT4Operation(direction, order_type);
   if(operation < 0 || symbol == "" || !SymbolSelect(symbol, true)
      || !B4MT4ValidVolume(symbol, volume_text))
     {
      B4MT4SendCommandSimple(request_id, command_id, B4_ACTION_ORDER_PLACE,
         B4_COMMAND_REJECTED, 0, 0, B4_STATE_UNKNOWN, 0,
         "place_parameters_invalid", "order parameters or symbol are invalid");
      return;
     }
   double volume = StrToDouble(volume_text);
    int digits = B4MT4Digits(symbol);
   RefreshRates();
   double bid = MarketInfo(symbol, MODE_BID);
   double ask = MarketInfo(symbol, MODE_ASK);
   double price = order_type == 1 ? (direction == 1 ? ask : bid)
      : NormalizeDouble(StrToDouble(price_text), digits);
   double stop_loss = stop_loss_specified && stop_loss_text != ""
      ? NormalizeDouble(StrToDouble(stop_loss_text), digits) : 0.0;
   double take_profit = take_profit_specified && take_profit_text != ""
      ? NormalizeDouble(StrToDouble(take_profit_text), digits) : 0.0;
    if(!MathIsValidNumber(price) || price <= 0.0
       || (order_type != 1 && !price_specified)
       || (order_type == 1 && price_specified)
       || !B4MT4ValidStops(symbol, operation, price, stop_loss, take_profit,
          stop_loss_specified, take_profit_specified))
     {
      B4MT4SendCommandSimple(request_id, command_id, B4_ACTION_ORDER_PLACE,
         B4_COMMAND_REJECTED, 0, 0, B4_STATE_UNKNOWN, 0,
         "place_price_or_protection_invalid", "price or protection violates symbol rules");
      return;
     }
   datetime expiration = 0;
   if((order_type == 1 && expiration_specified && expiration_utc != 0)
      || !B4MT4UtcExpiration(expiration_specified, expiration_utc, expiration))
     {
      B4MT4SendCommandSimple(request_id, command_id, B4_ACTION_ORDER_PLACE,
         B4_COMMAND_REJECTED, 0, 0, B4_STATE_UNKNOWN, 0,
         "expiration_invalid", "expiration is invalid for this order");
      return;
     }
   // MT4 comments are the only durable terminal-side lookup hint available
   // after a response loss. Reserve it for the stable idempotency key so the
   // execution.lookup contract can reconcile an uncertain send.
   string comment = B4MT4OrderComment(idempotency_key);
   ResetLastError();
   int ticket = OrderSend(symbol, operation, volume, price, deviation, stop_loss,
      take_profit, comment, magic, expiration, clrNONE);
   int trade_error = ticket > 0 ? 0 : GetLastError();
   if(ticket <= 0)
     {
      B4MT4SendCommandSimple(request_id, command_id, B4_ACTION_ORDER_PLACE,
         B4MT4AmbiguousTradeError(trade_error) ? B4_COMMAND_UNCERTAIN : B4_COMMAND_FAILED,
         trade_error, 0, B4_STATE_UNKNOWN, 0, "order_send_failed", "OrderSend failed");
      return;
     }
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES)
      || OrderCloseTime() != 0 || OrderSymbol() != symbol
      || B4MT4OrderTypeCode(OrderType()) != order_type
      || B4MT4DirectionCode(OrderType()) != direction
      || OrderMagicNumber() != magic
      || !B4MT4SameDecimal(OrderLots(), volume_text, symbol)
      || (order_type != 1 && !B4MT4SameDecimal(OrderOpenPrice(), price_text, symbol))
      || (stop_loss_specified && stop_loss_text != ""
          && !B4MT4SameDecimal(OrderStopLoss(), stop_loss_text, symbol))
      || (!stop_loss_specified && OrderStopLoss() != 0.0)
      || (take_profit_specified && take_profit_text != ""
          && !B4MT4SameDecimal(OrderTakeProfit(), take_profit_text, symbol))
      || (!take_profit_specified && OrderTakeProfit() != 0.0)
      || (order_type != 1 && OrderExpiration() != expiration)
      || OrderComment() != comment)
     {
      B4MT4SendCommandSimple(request_id, command_id, B4_ACTION_ORDER_PLACE,
         B4_COMMAND_UNCERTAIN, 0, ticket, B4_STATE_UNKNOWN, 0,
         "order_send_verify_failed", "OrderSend result could not be verified");
      return;
     }
   B4MT4SendSelectedCommandResult(request_id, command_id, B4_ACTION_ORDER_PLACE,
      B4_COMMAND_SUCCEEDED, 0, order_type == 1 ? B4_STATE_POSITION : B4_STATE_PENDING,
      0, "", "");
  }

bool B4MT4MatchesExpected(const B4MT4Command &command)
  {
   if(OrderTicket() != command.expected_ticket || OrderSymbol() != command.expected_symbol
      || B4MT4DirectionCode(OrderType()) != command.expected_direction
      || B4MT4OrderTypeCode(OrderType()) != command.expected_order_type
      || OrderMagicNumber() != command.expected_magic
      || !B4MT4SameDecimal(OrderLots(), command.expected_volume, command.expected_symbol)
      || !B4MT4SameDecimal(OrderOpenPrice(), command.expected_open_price, command.expected_symbol))
      return(false);
   if(command.expected_stop_loss_specified
      && !B4MT4SameDecimal(OrderStopLoss(), command.expected_stop_loss, command.expected_symbol))
      return(false);
   if(command.expected_take_profit_specified
      && !B4MT4SameDecimal(OrderTakeProfit(), command.expected_take_profit, command.expected_symbol))
      return(false);
   if(command.expected_expiration_specified)
     {
      datetime expected_expiration = 0;
      if(!B4MT4UtcExpiration(true, command.expected_expiration_utc_msc, expected_expiration)
         || OrderExpiration() != expected_expiration) return(false);
     }
   return(true);
  }

bool B4MT4SelectHistoryAny(const long ticket)
  {
   return(ticket > 0 && OrderSelect((int)ticket, SELECT_BY_TICKET, MODE_HISTORY));
  }

bool B4MT4MatchesPostIdentity(const B4MT4Command &command)
  {
   return(OrderTicket() > 0 && OrderSymbol() == command.expected_symbol
      && B4MT4DirectionCode(OrderType()) == command.expected_direction
      && B4MT4OrderTypeCode(OrderType()) == command.expected_order_type
      && OrderMagicNumber() == command.expected_magic
      && B4MT4SameDecimal(OrderOpenPrice(), command.expected_open_price, command.expected_symbol));
  }

// A broker may replace the ticket when an MT4 position is partially closed.
// Reconcile exactly one remainder of the original order.  The durable comment
// is only one bound; all immutable identity fields and the expected remaining
// volume/open time must also match before a new ticket is accepted.
bool B4MT4SelectPartialRemainder(const B4MT4Command &command,
   const string original_comment, const datetime original_open_time,
   const double expected_remaining, int &ticket, double &lots)
  {
   ticket = 0;
   lots = 0.0;
   if(original_open_time <= 0 || expected_remaining <= 0.0
      || !MathIsValidNumber(expected_remaining)) return(false);
   double volume_tolerance = MathMax(MathAbs(expected_remaining) * 0.0000001,
      0.00000001);
   int matches = 0;
   for(int index = 0; index < OrdersTotal(); index++)
     {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderSymbol() != command.expected_symbol
         || OrderMagicNumber() != command.expected_magic
         || B4MT4DirectionCode(OrderType()) != command.expected_direction
         || B4MT4OrderTypeCode(OrderType()) != command.expected_order_type
         || OrderOpenTime() != original_open_time
         || !B4MT4SameDecimal(OrderOpenPrice(), command.expected_open_price,
            command.expected_symbol)
         || MathAbs(OrderLots() - expected_remaining) > volume_tolerance
         || OrderComment() != original_comment) continue;
      matches++;
      ticket = OrderTicket();
      lots = OrderLots();
     }
   if(matches != 1 || ticket <= 0) return(false);
   return(OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES));
  }

void B4MT4SendResourceMismatch(const B4MT4Command &command, const string code)
  {
   B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
      B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_UNKNOWN, 0, code,
      "the selected terminal resource no longer matches expected state");
  }

void B4MT4ExecuteProtection(const B4MT4Command &command)
  {
   if(!B4MT4TradePermission(command.request_id, command.command_id, command.action)) return;
   if(!OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_ABSENT, 0,
         "resource_absent", "position is not present");
      return;
     }
   if(!B4MT4MatchesExpected(command))
     {
      B4MT4SendResourceMismatch(command, "resource_identity_changed");
      return;
     }
   string symbol = OrderSymbol();
   double stop_loss = command.stop_loss_specified
      ? (command.stop_loss == "" ? 0.0 : StrToDouble(command.stop_loss)) : OrderStopLoss();
   double take_profit = command.take_profit_specified
      ? (command.take_profit == "" ? 0.0 : StrToDouble(command.take_profit)) : OrderTakeProfit();
   if(!B4MT4ValidStops(symbol, OrderType(), OrderOpenPrice(), stop_loss, take_profit,
      true, true))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 130, command.ticket, B4_STATE_POSITION, 0,
         "protection_invalid", "stop loss or take profit violates symbol rules");
      return;
     }
   if(MathAbs(OrderStopLoss() - stop_loss) <= 0.00000001
      && MathAbs(OrderTakeProfit() - take_profit) <= 0.00000001)
     {
      B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
         B4_COMMAND_SUCCEEDED, 0, B4_STATE_POSITION, B4_RESULT_ALREADY_APPLIED, "", "");
      return;
     }
   ResetLastError();
   bool modified = OrderModify((int)command.ticket, OrderOpenPrice(), stop_loss,
      take_profit, OrderExpiration(), clrNONE);
   int trade_error = modified ? 0 : GetLastError();
   if(!modified)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4MT4AmbiguousTradeError(trade_error) ? B4_COMMAND_UNCERTAIN : B4_COMMAND_FAILED,
         trade_error, command.ticket, B4_STATE_UNKNOWN, 0, "protection_modify_failed",
         "OrderModify failed");
      return;
     }
   if(!OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES)
      || !B4MT4MatchesPostIdentity(command)
      || MathAbs(OrderStopLoss() - stop_loss) > MathMax(MarketInfo(symbol, MODE_POINT) / 2.0, 0.00000001)
      || MathAbs(OrderTakeProfit() - take_profit) > MathMax(MarketInfo(symbol, MODE_POINT) / 2.0, 0.00000001))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_UNKNOWN, 0,
         "protection_verify_failed", "protection result could not be verified");
      return;
     }
   B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
      B4_COMMAND_SUCCEEDED, 0, B4_STATE_POSITION, 0, "", "");
  }

void B4MT4ExecutePendingModify(const B4MT4Command &command)
  {
   if(!B4MT4TradePermission(command.request_id, command.command_id, command.action)) return;
   if(!OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_ABSENT, 0,
         "resource_absent", "pending order is not present");
      return;
     }
   if(!B4MT4MatchesExpected(command))
     {
      B4MT4SendResourceMismatch(command, "resource_identity_changed");
      return;
     }
   string symbol = OrderSymbol();
   int operation = OrderType();
   int digits = B4MT4Digits(symbol);
   double price = command.price_specified
      ? NormalizeDouble(StrToDouble(command.price), digits) : OrderOpenPrice();
   double stop_loss = command.stop_loss_specified
      ? (command.stop_loss == "" ? 0.0 : NormalizeDouble(StrToDouble(command.stop_loss), digits))
      : OrderStopLoss();
   double take_profit = command.take_profit_specified
      ? (command.take_profit == "" ? 0.0 : NormalizeDouble(StrToDouble(command.take_profit), digits))
      : OrderTakeProfit();
   datetime expiration = OrderExpiration();
   if(command.expiration_specified)
     {
      if(!g_offset_valid)
        {
         B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
            B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_PENDING, 0,
            "clock_unavailable", "terminal UTC offset is not calibrated");
         return;
        }
      if(!B4MT4UtcExpiration(true, command.expiration_utc_msc, expiration))
        {
         B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
            B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_PENDING, 0,
            "expiration_invalid", "pending order expiration is invalid");
         return;
        }
     }
   RefreshRates();
   double bid = MarketInfo(symbol, MODE_BID);
   double ask = MarketInfo(symbol, MODE_ASK);
    if(!MathIsValidNumber(price) || price <= 0.0
       || !B4MT4ValidStops(symbol, operation, price, stop_loss, take_profit, true, true))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 130, command.ticket, B4_STATE_PENDING, 0,
         "pending_parameters_invalid", "pending order parameters violate symbol rules");
      return;
     }
   if(!command.price_specified && !command.stop_loss_specified
      && !command.take_profit_specified && !command.expiration_specified)
     {
      B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
         B4_COMMAND_SUCCEEDED, 0, B4_STATE_PENDING, B4_RESULT_ALREADY_APPLIED, "", "");
      return;
     }
   ResetLastError();
   bool modified = OrderModify((int)command.ticket, price, stop_loss, take_profit,
      expiration, clrNONE);
   int trade_error = modified ? 0 : GetLastError();
   if(!modified)
     {
      // A timeout/busy response can follow a broker-side apply.  Do not let
      // the Bridge turn that uncertainty into a second modify.
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4MT4AmbiguousTradeError(trade_error) ? B4_COMMAND_UNCERTAIN : B4_COMMAND_FAILED,
         trade_error, command.ticket, B4_STATE_UNKNOWN, 0, "pending_modify_failed",
         "OrderModify failed");
      return;
     }
   if(!OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES)
      || !B4MT4MatchesPostIdentity(command)
      || MathAbs(OrderOpenPrice() - price) > MathMax(MarketInfo(symbol, MODE_POINT) / 2.0, 0.00000001)
      || MathAbs(OrderStopLoss() - stop_loss) > MathMax(MarketInfo(symbol, MODE_POINT) / 2.0, 0.00000001)
      || MathAbs(OrderTakeProfit() - take_profit) > MathMax(MarketInfo(symbol, MODE_POINT) / 2.0, 0.00000001)
      || OrderExpiration() != expiration)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_UNKNOWN, 0,
         "pending_modify_verify_failed", "pending modify result could not be verified");
      return;
     }
   B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
      B4_COMMAND_SUCCEEDED, 0, B4_STATE_PENDING, 0, "", "");
  }

void B4MT4ExecuteClose(const B4MT4Command &command)
  {
   if(!B4MT4TradePermission(command.request_id, command.command_id, command.action)) return;
   if(!OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_ABSENT, 0,
         "resource_absent", "position is not present");
      return;
     }
   if(!B4MT4MatchesExpected(command))
     {
      B4MT4SendResourceMismatch(command, "resource_identity_changed");
      return;
     }
    double close_volume = StrToDouble(command.volume);
    double current_volume = OrderLots();
    string symbol = OrderSymbol();
    datetime original_open_time = OrderOpenTime();
    string original_comment = OrderComment();
    if(!B4MT4ValidVolume(symbol, command.volume))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 131, command.ticket, B4_STATE_POSITION, 0,
         "close_volume_invalid", "close volume is outside the position");
      return;
     }
   int type = OrderType();
   double close_price = type == OP_BUY ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);
   if(close_price <= 0.0)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 129, command.ticket, B4_STATE_POSITION, 0,
         "quote_unavailable", "close quote is unavailable");
      return;
     }
   ResetLastError();
   bool closed = OrderClose((int)command.ticket, close_volume, close_price,
      command.deviation, clrNONE);
   int trade_error = closed ? 0 : GetLastError();
   if(!closed)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4MT4AmbiguousTradeError(trade_error) ? B4_COMMAND_UNCERTAIN : B4_COMMAND_FAILED,
         trade_error, command.ticket, B4_STATE_UNKNOWN, 0, "position_close_failed",
         "OrderClose failed");
      return;
     }
   double expected_remaining = current_volume - close_volume;
   int remaining_ticket = 0;
   double remaining_volume = 0.0;
   if(expected_remaining > 0.00000001
      && OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES)
      && B4MT4MatchesPostIdentity(command))
     {
      remaining_ticket = OrderTicket();
      remaining_volume = OrderLots();
      if(MathAbs(remaining_volume - expected_remaining)
         <= MathMax(MathAbs(expected_remaining) * 0.0000001, 0.00000001))
        {
         B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
            B4_COMMAND_SUCCEEDED, 0, B4_STATE_POSITION, 0, "", "");
         return;
        }
     }
    if(B4MT4SelectPartialRemainder(command, original_comment, original_open_time,
       expected_remaining, remaining_ticket, remaining_volume)
       && remaining_volume > 0.0)
     {
       if(MathAbs(remaining_volume - expected_remaining)
          > MathMax(MathAbs(expected_remaining) * 0.0000001, 0.00000001))
        {
         B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
            B4_COMMAND_UNCERTAIN, 0, remaining_ticket, B4_STATE_UNKNOWN, 0,
            "position_close_verify_failed", "remaining position volume is unexpected");
         return;
        }
      B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
         B4_COMMAND_SUCCEEDED, 0, B4_STATE_POSITION, 0, "", "");
      return;
     }
   if(expected_remaining > 0.00000001)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_UNKNOWN, 0,
         "position_close_verify_failed", "partial close could not be reconciled");
      return;
     }
   if(B4MT4SelectHistoryAny(command.ticket) && OrderCloseTime() > 0)
     {
      B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
         B4_COMMAND_SUCCEEDED, 0, B4_STATE_CLOSED, 0, "", "");
      return;
     }
   B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
      B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_UNKNOWN, 0,
      "position_close_verify_failed", "closed position could not be reconciled");
  }

void B4MT4ExecutePendingCancel(const B4MT4Command &command)
  {
   if(!B4MT4TradePermission(command.request_id, command.command_id, command.action)) return;
   if(!OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      if(B4MT4SelectHistoryAny(command.ticket))
        {
         if(B4MT4IsPendingType(OrderType()))
           {
            B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
               B4_COMMAND_SUCCEEDED, 0, command.ticket, B4_STATE_ABSENT,
               B4_RESULT_ALREADY_ABSENT, "", "pending order was already absent");
            return;
           }
         B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
            B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_FILLED, 0,
            "pending_filled", "pending order was filled before cancellation");
         return;
        }
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_UNKNOWN, 0,
         "pending_cancel_unverified", "pending order absence has no terminal evidence");
      return;
     }
   if(!B4MT4MatchesExpected(command))
     {
      B4MT4SendResourceMismatch(command, "resource_identity_changed");
      return;
     }
   ResetLastError();
   bool deleted = OrderDelete((int)command.ticket, clrNONE);
   int trade_error = deleted ? 0 : GetLastError();
   if(!deleted)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4MT4AmbiguousTradeError(trade_error) ? B4_COMMAND_UNCERTAIN : B4_COMMAND_FAILED,
         trade_error, command.ticket, B4_STATE_UNKNOWN, 0, "pending_cancel_failed",
         "OrderDelete failed");
      return;
     }
   if(OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      if(!B4MT4MatchesExpected(command))
        {
         B4MT4SendResourceMismatch(command, "resource_identity_changed");
         return;
        }
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_PENDING, 0,
         "pending_cancel_verify_failed", "pending order remains after delete");
      return;
     }
   if(B4MT4SelectHistoryAny(command.ticket) && B4MT4IsPendingType(OrderType()))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_SUCCEEDED, 0, command.ticket, B4_STATE_ABSENT, 0, "", "");
      return;
     }
   if(B4MT4SelectHistoryAny(command.ticket) && !B4MT4IsPendingType(OrderType()))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
         B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_FILLED, 0,
         "pending_filled", "pending order filled while cancellation was in flight");
      return;
     }
   B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
      B4_COMMAND_UNCERTAIN, 0, command.ticket, B4_STATE_UNKNOWN, 0,
      "pending_cancel_verify_failed", "pending order cancellation could not be verified");
  }

void B4MT4ExecuteLookup(const B4MT4Command &command)
  {
   if(command.ticket > 0)
     {
      if(OrderSelect((int)command.ticket, SELECT_BY_TICKET, MODE_TRADES))
        {
         int state = B4MT4IsPendingType(OrderType()) ? B4_STATE_PENDING : B4_STATE_POSITION;
         B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
            B4_COMMAND_SUCCEEDED, 0, state, 0, "", "");
         return;
        }
      if(B4MT4SelectHistoryAny(command.ticket))
        {
         int state = B4MT4IsPendingType(OrderType()) ? B4_STATE_ABSENT
            : (OrderCloseTime() > 0 ? B4_STATE_CLOSED : B4_STATE_UNKNOWN);
         B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
            B4_COMMAND_SUCCEEDED, 0, state, 0, "", "");
         return;
        }
     }
   if(command.lookup_reference != "")
     {
      string symbol = B4MT4ResolveMarketSymbol(command.symbol);
      if(symbol == "")
        {
         B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
            B4_COMMAND_REJECTED, 0, 0, B4_STATE_UNKNOWN, 0,
            "symbol_unavailable", "execution symbol could not be resolved uniquely");
         return;
        }
      string reference = command.lookup_reference;
      if(StringFind(reference, "B4:") != 0)
         reference = B4MT4CommandReference(reference);
      int total = OrdersTotal();
      for(int index = 0; index < total; index++)
        {
         if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES)) continue;
         if(OrderSymbol() != symbol || OrderMagicNumber() != command.magic
            || StringFind(OrderComment(), reference) != 0) continue;
         int state = B4MT4IsPendingType(OrderType()) ? B4_STATE_PENDING : B4_STATE_POSITION;
         B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
            B4_COMMAND_SUCCEEDED, 0, state, 0, "", "");
         return;
        }
      int history_total = OrdersHistoryTotal();
      for(int history_index = history_total - 1; history_index >= 0; history_index--)
        {
         if(!OrderSelect(history_index, SELECT_BY_POS, MODE_HISTORY)) continue;
         if(OrderSymbol() != symbol || OrderMagicNumber() != command.magic
            || StringFind(OrderComment(), reference) != 0) continue;
         int state = B4MT4IsPendingType(OrderType()) ? B4_STATE_ABSENT
            : (OrderCloseTime() > 0 ? B4_STATE_CLOSED : B4_STATE_UNKNOWN);
         B4MT4SendSelectedCommandResult(command.request_id, command.command_id, command.action,
            B4_COMMAND_SUCCEEDED, 0, state, 0, "", "");
         return;
        }
     }
   B4MT4SendCommandSimple(command.request_id, command.command_id, command.action,
      B4_COMMAND_REJECTED, 0, command.ticket, B4_STATE_ABSENT, 0,
      "execution_not_found", "no matching terminal execution was found");
  }

void B4MT4HandleCommand(uchar &payload[])
  {
   B4MT4Command command;
   if(!B4MT4ReadCommand(command, payload))
     {
      // A malformed frame may not contain usable correlation ids.  Keep the
      // response parseable when possible; otherwise the pipe is closed by the
      // caller after the protocol error.
      string request_id = command.request_id == "" ? "malformed-request" : command.request_id;
      string command_id = command.command_id == "" ? "malformed-command" : command.command_id;
      int action = command.action >= B4_ACTION_ORDER_PLACE
         && command.action <= B4_ACTION_EXECUTION_LOOKUP
         ? command.action : B4_ACTION_EXECUTION_LOOKUP;
      B4MT4SendCommandSimple(request_id, command_id, action, B4_COMMAND_REJECTED,
         400, 0, B4_STATE_UNKNOWN, 0, "command_malformed", "command wire is invalid");
      return;
     }
   int action = command.action;
   if(action < B4_ACTION_ORDER_PLACE || action > B4_ACTION_EXECUTION_LOOKUP)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id,
         B4_ACTION_EXECUTION_LOOKUP, B4_COMMAND_REJECTED, 400, 0,
         B4_STATE_UNKNOWN, 0, "command_action_unknown", "command action is unsupported");
      return;
     }
   if(command.deadline_utc_msc < B4UtcNowMsc())
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, action,
         B4_COMMAND_REJECTED, 408, command.ticket, B4_STATE_UNKNOWN, 0,
         "deadline_expired", "command deadline has expired");
      return;
     }
   if(StringCompare(command.terminal_instance_id, g_terminal_instance_id, false) != 0
      || StringCompare(command.broker_server, AccountServer(), false) != 0
      || command.login != IntegerToString(AccountNumber())
      || command.session_epoch != g_session_epoch)
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, action,
         B4_COMMAND_REJECTED, 409, command.ticket, B4_STATE_UNKNOWN, 0,
         "route_mismatch", "command route does not match this terminal session");
      return;
     }
   if(!B4MT4CommandTargetShape(command))
     {
      B4MT4SendCommandSimple(command.request_id, command.command_id, action,
         B4_COMMAND_REJECTED, 400, command.ticket, B4_STATE_UNKNOWN, 0,
         "command_parameters_invalid", "command target or expected state is invalid");
      return;
     }
   switch(action)
     {
      case B4_ACTION_ORDER_PLACE:
         B4MT4ExecutePlace(command.request_id, command.command_id, command.symbol,
            command.direction, command.order_type, command.volume,
            command.price_specified, command.price, command.stop_loss_specified,
            command.stop_loss, command.take_profit_specified, command.take_profit,
            command.expiration_specified, command.expiration_utc_msc, command.deviation,
            command.magic, command.idempotency_key);
         return;
      case B4_ACTION_PROTECTION_SET:
         B4MT4ExecuteProtection(command);
         return;
      case B4_ACTION_POSITION_CLOSE:
         B4MT4ExecuteClose(command);
         return;
      case B4_ACTION_PENDING_MODIFY:
         B4MT4ExecutePendingModify(command);
         return;
      case B4_ACTION_PENDING_CANCEL:
         B4MT4ExecutePendingCancel(command);
         return;
      case B4_ACTION_EXECUTION_LOOKUP:
         B4MT4ExecuteLookup(command);
         return;
     }
  }

void B4MT4HandleQuery(uchar &payload[])
  {
   int offset = 4;
   string request_id = "";
   int resource_code = 0;
   long deadline = 0;
   if(!B4ReadUtf8(payload, offset, request_id, 191, false)
      || !B4ReadInt32(payload, offset, resource_code)
      || !B4ReadInt64(payload, offset, deadline))
     {
      B4MT4SendError(request_id, resource_code, "request_malformed", "query header is invalid");
      return;
     }
   long now = B4UtcNowMsc();
   if(deadline <= 0 || deadline < now)
     {
      B4MT4SendError(request_id, resource_code, "deadline_expired", "query deadline has expired");
      return;
     }
   if(resource_code < B4_RESOURCE_TERMINAL_INFO || resource_code > B4_RESOURCE_HEALTH)
     {
      B4MT4SendError(request_id, resource_code, "resource_unsupported", "resource code is unsupported");
      return;
     }
   if(resource_code == B4_RESOURCE_EXECUTION_LOOKUP)
     {
      B4MT4SendError(request_id, resource_code, "unsupported_read_only_resource", "execution lookup is not implemented by the terminal adapter");
      return;
     }
   if(resource_code == B4_RESOURCE_TERMINAL_INFO)
     {
      if(offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "unexpected trailing bytes");
         return;
        }
      B4MT4SendResponse(request_id, resource_code, now, B4MT4TerminalInfoJson(), "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_TERMINAL_CLOCK)
     {
      if(offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "unexpected trailing bytes");
         return;
        }
      B4MT4SendResponse(request_id, resource_code, now, B4MT4ClockJson(), "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_ACCOUNT)
     {
      if(offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "unexpected trailing bytes");
         return;
        }
      B4MT4SendResponse(request_id, resource_code, now, B4MT4AccountJson(), "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_HEALTH)
     {
      if(offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "unexpected trailing bytes");
         return;
        }
      string health = "{\"ok\":" + B4MT4Bool(IsConnected())
         + ",\"platform\":\"mt4\",\"terminal_build\":"
         + IntegerToString((int)TerminalInfoInteger(TERMINAL_BUILD))
         + ",\"connected\":" + B4MT4Bool(IsConnected())
         + ",\"last_error\":null}";
      B4MT4SendResponse(request_id, resource_code, now, health, "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_SYMBOLS)
     {
      int limit = 0, page_offset = 0;
      if(!B4ReadInt32(payload, offset, limit) || !B4ReadInt32(payload, offset, page_offset)
         || limit < 1 || limit > B4_MAX_PAGE || page_offset < 0)
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "symbol page is invalid");
         return;
        }
      int total = SymbolsTotal(false);
      if(offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "unexpected trailing bytes");
         return;
        }
      int emitted = MathMin(limit, MathMax(0, total - page_offset));
      bool more = page_offset + emitted < total;
      B4MT4SendResponse(request_id, resource_code, now,
         B4MT4SymbolsJson(limit, page_offset), more ? B4Cursor(page_offset + emitted) : "", more);
      return;
     }
   if(resource_code == B4_RESOURCE_INSTRUMENT)
     {
      string symbol = "";
      if(!B4ReadUtf8(payload, offset, symbol, 128, false)
         || offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "instrument symbol is invalid");
         return;
        }
      symbol = B4MT4ResolveMarketSymbol(symbol);
      if(symbol == "" || !SymbolSelect(symbol, true))
        {
         B4MT4SendError(request_id, resource_code, "symbol_unavailable", "instrument is not available");
         return;
        }
      B4MT4SendResponse(request_id, resource_code, now, B4MT4InstrumentJson(symbol), "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_QUOTE)
     {
      int count = 0;
      if(!B4ReadInt32(payload, offset, count) || count < 1 || count > B4_MAX_SYMBOLS)
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "quote symbol count is invalid");
         return;
        }
      string symbols[];
      ArrayResize(symbols, count);
      for(int index = 0; index < count; index++)
        {
         if(!B4ReadUtf8(payload, offset, symbols[index], 128, false))
           {
            B4MT4SendError(request_id, resource_code, "params_invalid", "quote symbol is invalid");
           return;
           }
        }
      if(offset != ArraySize(payload))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "unexpected trailing bytes");
         return;
        }
      for(int symbol_index = 0; symbol_index < count; symbol_index++)
        {
         symbols[symbol_index] = B4MT4ResolveMarketSymbol(symbols[symbol_index]);
         if(symbols[symbol_index] == "" || !SymbolSelect(symbols[symbol_index], true))
           {
            B4MT4SendError(request_id, resource_code, "symbol_unavailable", "quote symbol is not available");
            return;
           }
        }
      B4MT4SendResponse(request_id, resource_code, now, B4MT4QuotesJson(symbols), "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_CANDLES)
     {
      string symbol = "";
      int timeframe_code = 0, count = 0;
      long start_utc = 0, end_utc = 0;
      if(!B4ReadUtf8(payload, offset, symbol, 128, false)
         || !B4ReadInt32(payload, offset, timeframe_code)
         || !B4ReadInt32(payload, offset, count)
         || !B4ReadInt64(payload, offset, start_utc)
         || !B4ReadInt64(payload, offset, end_utc)
         || offset != ArraySize(payload)
         || B4MT4Timeframe(timeframe_code) <= 0
         || ((count < 1 || count > B4_MAX_CANDLES || start_utc != 0 || end_utc != 0)
             && (count != 0 || start_utc <= 0 || end_utc <= start_utc)))
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "candle query is invalid");
         return;
        }
      if(!B4MT4RequireClock(request_id, resource_code)) return;
      symbol = B4MT4ResolveMarketSymbol(symbol);
      if(symbol == "" || !SymbolSelect(symbol, true))
        {
         B4MT4SendError(request_id, resource_code, "symbol_unavailable", "candle symbol is not available");
         return;
        }
      B4MT4SendResponse(request_id, resource_code, now,
         B4MT4CandlesJson(symbol, timeframe_code, count, start_utc, end_utc), "", false);
      return;
     }
   if(resource_code == B4_RESOURCE_POSITIONS || resource_code == B4_RESOURCE_PENDING_ORDERS)
     {
      int limit = 0, page_offset = 0;
      string symbol = "";
      if(!B4ReadInt32(payload, offset, limit) || !B4ReadInt32(payload, offset, page_offset)
         || !B4ReadUtf8(payload, offset, symbol, 128, true)
         || offset != ArraySize(payload)
         || limit < 1 || limit > B4_MAX_PAGE || page_offset < 0)
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "trading page is invalid");
         return;
        }
      if(!B4MT4RequireClock(request_id, resource_code)) return;
      bool pending = resource_code == B4_RESOURCE_PENDING_ORDERS;
      bool more = false;
      B4MT4SendResponse(request_id, resource_code, now,
         B4MT4OrdersJson(pending, limit, page_offset, symbol, more),
         more ? B4Cursor(page_offset + limit) : "", more);
      return;
     }
   if(resource_code == B4_RESOURCE_HISTORY_ORDERS
      || resource_code == B4_RESOURCE_HISTORY_TRADES
      || resource_code == B4_RESOURCE_HISTORY_DEALS)
     {
      long start_utc = 0, end_utc = 0, cursor = 0;
      int limit = 0;
      if(!B4ReadInt64(payload, offset, start_utc)
         || !B4ReadInt64(payload, offset, end_utc)
         || !B4ReadInt32(payload, offset, limit)
         || !B4ReadInt64(payload, offset, cursor)
         || offset != ArraySize(payload)
         || start_utc < 0 || end_utc < 0 || ((start_utc > 0) != (end_utc > 0))
         || (end_utc > 0 && end_utc <= start_utc)
         || limit < 1 || limit > B4_MAX_PAGE || cursor < 0)
        {
         B4MT4SendError(request_id, resource_code, "params_invalid", "history query is invalid");
         return;
        }
      if(!B4MT4RequireClock(request_id, resource_code)) return;
      bool more = false;
      string data = B4MT4HistoryJson(resource_code, start_utc, end_utc, limit, cursor, more);
      B4MT4SendResponse(request_id, resource_code, now, data,
         more ? B4Cursor(cursor + limit) : "", more);
      return;
     }
   B4MT4SendError(request_id, resource_code, "resource_unsupported", "resource code is unsupported");
  }

void B4MT4Disconnect()
  {
   if(g_pipe != INVALID_HANDLE) FileClose(g_pipe);
   g_pipe = INVALID_HANDLE;
   g_welcomed = false;
   g_terminal_instance_id = "";
   g_session_epoch = 0;
   g_bound_broker_server = "";
   g_bound_login = 0;
  }

bool B4MT4Connect()
  {
   string path = "\\\\.\\pipe\\" + B4_PIPE_NAME;
   ResetLastError();
   g_pipe = FileOpen(path, FILE_READ | FILE_WRITE | FILE_BIN | FILE_ANSI);
   if(g_pipe == INVALID_HANDLE) return(false);
   g_welcomed = false;
   uchar hello[];
   int size = 0;
   B4AppendInt32(hello, size, B4_MSG_HELLO);
   B4AppendInt32(hello, size, B4_PROTOCOL_VERSION);
   B4AppendUtf8(hello, size, "4.0.0.0");
   B4AppendUtf8(hello, size, "mt4");
   B4AppendUtf8(hello, size, TerminalInfoString(TERMINAL_DATA_PATH));
   B4AppendUtf8(hello, size, TerminalInfoString(TERMINAL_PATH));
   B4AppendUtf8(hello, size, AccountServer());
   B4AppendUtf8(hello, size, IntegerToString(AccountNumber()));
   B4AppendInt32(hello, size, (int)TerminalInfoInteger(TERMINAL_BUILD));
   B4AppendInt32(hello, size, IsConnected() ? 1 : 0);
   B4AppendInt32(hello, size, IsTradeAllowed() ? 1 : 0);
   B4AppendInt32(hello, size, g_offset_valid ? g_server_offset_minutes : 0);
   B4AppendUtf8(hello, size, B4MT4ClockStatus());
   B4AppendInt64(hello, size, g_offset_sampled_at_utc_msc);
   if(!B4WriteFrame(g_pipe, hello, size))
     {
      B4MT4Disconnect();
      return(false);
     }
   g_bound_broker_server = AccountServer();
   g_bound_login = AccountNumber();
   g_connect_failures = 0;
   g_last_bridge_activity = GetTickCount();
   g_next_connect_time = 0;
   return(true);
  }

void B4MT4HandleFrame(uchar &payload[])
  {
   int offset = 0;
   int message_type = 0;
   if(!B4ReadInt32(payload, offset, message_type))
     {
      B4MT4Disconnect();
      return;
     }
   if(message_type == B4_MSG_WELCOME)
     {
      long epoch = 0;
      if(!B4ReadUtf8(payload, offset, g_terminal_instance_id, 191, false)
         || !B4ReadInt64(payload, offset, epoch) || epoch <= 0)
        {
         B4MT4Disconnect();
         return;
        }
      g_session_epoch = epoch;
      g_welcomed = true;
      return;
     }
   if(message_type == B4_MSG_QUERY_REQUEST && g_welcomed)
     {
      B4MT4HandleQuery(payload);
      return;
     }
   if(message_type == B4_MSG_COMMAND_REQUEST && g_welcomed)
     {
      B4MT4HandleCommand(payload);
      return;
     }
   if(message_type == B4_MSG_PING)
     {
      uchar response[];
      int size = 0;
      B4AppendInt32(response, size, B4_MSG_PONG);
      B4AppendInt64(response, size, B4UtcNowMsc());
      B4AppendInt32(response, size, IsConnected() ? 1 : 0);
      B4AppendInt32(response, size, IsTradeAllowed() ? 1 : 0);
      B4AppendInt32(response, size, (int)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED));
      B4AppendInt32(response, size, (int)MQLInfoInteger(MQL_TRADE_ALLOWED));
      B4AppendInt32(response, size, (int)AccountInfoInteger(ACCOUNT_TRADE_EXPERT));
      B4AppendInt32(response, size, (int)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED));
      if(!B4WriteFrame(g_pipe, response, size)) B4MT4Disconnect();
     }
  }

int OnInit()
  {
   if(InpPollMilliseconds < 100 || InpPollMilliseconds > 5000) return(INIT_PARAMETERS_INCORRECT);
   B4MT4LoadOffset();
   g_last_server_time = TimeCurrent();
   if(!EventSetMillisecondTimer(InpPollMilliseconds)) return(INIT_FAILED);
   Print("Liangjian Bridge V4 adapter initialized");
   return(INIT_SUCCEEDED);
  }

void OnTick()
  {
   B4MT4RefreshOffset();
  }

void OnTimer()
  {
   B4MT4RefreshOffset();
   if(g_pipe == INVALID_HANDLE)
     {
      if(TimeLocal() < g_next_connect_time) return;
      if(!B4MT4Connect())
        {
         int connect_error = GetLastError();
         g_connect_failures++;
         if(g_connect_failures == 1 || g_connect_failures % 8 == 0)
            Print("Liangjian Bridge V4 pipe connect failed: ", connect_error);
         int delay = (int)MathPow(2.0, MathMin(g_connect_failures, 5));
         if(delay > 30) delay = 30;
         g_next_connect_time = TimeLocal() + delay;
        }
      return;
     }
   if(!IsConnected() || AccountNumber() != g_bound_login
      || StringCompare(AccountServer(), g_bound_broker_server, false) != 0)
     {
      // A terminal account switch must never be served over the old route.
      B4MT4Disconnect();
      g_next_connect_time = TimeLocal() + 1;
      return;
     }
   // A closed pipe can look just like an idle pipe to the MQL file API.
   // Bridge sends a heartbeat every 3 seconds, even without an account connection.
   if((uint)(GetTickCount() - g_last_bridge_activity) >= 30000)
     {
      Print("Liangjian Bridge V4 heartbeat expired; reconnecting");
      B4MT4Disconnect();
      g_next_connect_time = TimeLocal() + 1;
      return;
     }
   if(!B4PipeHasData(g_pipe)) return;
   uchar payload[];
   if(!B4ReadFrame(g_pipe, payload))
     {
      B4MT4Disconnect();
      return;
     }
   B4MT4HandleFrame(payload);
   g_last_bridge_activity = GetTickCount();
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   B4MT4Disconnect();
  }
