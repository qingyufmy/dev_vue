#property strict
#property version   "3.03"
#property description "AURUM Bridge local MT4 adapter. No DLL or WebRequest required."

input string InpPipeName = "AURUMBridgeV3";

#define MSG_HELLO        1
#define MSG_WELCOME      2
#define MSG_COLLECT      10
#define MSG_SNAPSHOT     11
#define MSG_QUOTE_REQUEST 12
#define MSG_QUOTE        13
#define MSG_RATES_REQUEST 14
#define MSG_RATES        15
#define MSG_SYMBOL_SNAPSHOT_REQUEST 16
#define MSG_SYMBOL_SNAPSHOT 17
#define MSG_COMMAND      20
#define MSG_COMMAND_RESULT 21
#define MSG_SHUTDOWN     90
#define MSG_SHUTDOWN_ACK 91
#define STREAM_ACCOUNT   1
#define STREAM_POSITIONS 2
#define STREAM_ORDERS    4
#define MAX_FRAME_BYTES  4194304
#define ACTION_PLACE     1
#define ACTION_CANCEL    2
#define ACTION_MODIFY    3
#define ACTION_CLOSE     4
#define ACTION_QUERY     5
#define ACTION_MODIFY_POSITION 6
#define SIDE_NONE        0
#define SIDE_BUY         1
#define SIDE_SELL        2
#define KIND_MARKET      1
#define KIND_LIMIT       2
#define KIND_STOP        3

int    g_pipe = INVALID_HANDLE;
bool   g_welcomed = false;
string g_terminal_id = "";
long   g_connection_epoch = 0;
string g_pipe_name = "";

int OnInit()
  {
   g_pipe_name = InpPipeName;
   EventSetTimer(1);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   DisconnectPipe();
  }

void OnTimer()
  {
   if(g_pipe == INVALID_HANDLE)
     {
      ConnectPipe();
      return;
     }
   uchar payload[];
   if(!ReadFrame(payload))
     {
      DisconnectPipe();
      return;
     }
   int offset = 0;
   int message_type = ReadInt32(payload, offset);
   if(message_type == MSG_WELCOME)
     {
      g_terminal_id = ReadUtf8(payload, offset);
      g_connection_epoch = ReadInt64(payload, offset);
      string reconnect_pipe = ReadUtf8(payload, offset);
      if(StringLen(reconnect_pipe) > 0)
         g_pipe_name = reconnect_pipe;
      g_welcomed = (StringLen(g_terminal_id) > 0 && g_connection_epoch > 0
         && StringLen(g_pipe_name) > 0);
      return;
     }
   if(message_type == MSG_COLLECT && g_welcomed)
     {
      int streams = ReadInt32(payload, offset);
      SendSnapshot(streams);
      return;
     }
   if(message_type == MSG_COMMAND && g_welcomed)
     {
      ExecuteCommand(payload, offset);
      return;
     }
   if(message_type == MSG_QUOTE_REQUEST && g_welcomed)
     {
      SendQuote(payload, offset);
      return;
     }
   if(message_type == MSG_RATES_REQUEST && g_welcomed)
     {
      SendRates(payload, offset);
      return;
     }
   if(message_type == MSG_SYMBOL_SNAPSHOT_REQUEST && g_welcomed)
     {
      SendSymbolSnapshot(payload, offset);
      return;
     }
   if(message_type == MSG_SHUTDOWN)
     {
      uchar response[];
      AppendInt32(response, MSG_SHUTDOWN_ACK);
      WriteFrame(response);
      DisconnectPipe();
     }
  }

bool ConnectPipe()
  {
   ResetLastError();
   string pipe_path = "\\\\.\\pipe\\" + g_pipe_name;
   g_pipe = FileOpen(pipe_path, FILE_READ|FILE_WRITE|FILE_BIN|FILE_ANSI);
   if(g_pipe == INVALID_HANDLE)
      return(false);
   g_welcomed = false;
   uchar hello[];
   AppendInt32(hello, MSG_HELLO);
   AppendInt32(hello, 3);
   AppendUtf8(hello, "3.0.3");
   AppendUtf8(hello, TerminalInfoString(TERMINAL_DATA_PATH));
   AppendUtf8(hello, AccountServer());
   AppendUtf8(hello, IntegerToString(AccountNumber()));
   AppendInt32(hello, IsConnected() ? 1 : 0);
   AppendInt32(hello, IsTradeAllowed() ? 1 : 0);
   if(!WriteFrame(hello))
     {
      DisconnectPipe();
      return(false);
     }
   return(true);
  }

void DisconnectPipe()
  {
   if(g_pipe != INVALID_HANDLE)
      FileClose(g_pipe);
   g_pipe = INVALID_HANDLE;
   g_welcomed = false;
   g_terminal_id = "";
   g_connection_epoch = 0;
  }

void SendSnapshot(const int streams)
  {
   string account_json = ((streams & STREAM_ACCOUNT) != 0) ? BuildAccountJson() : "{}";
   string positions_json = ((streams & STREAM_POSITIONS) != 0) ? BuildOrdersJson(true) : "[]";
   string orders_json = ((streams & STREAM_ORDERS) != 0) ? BuildOrdersJson(false) : "[]";
   uchar payload[];
   AppendInt32(payload, MSG_SNAPSHOT);
   AppendInt64(payload, ((long)TimeGMT()) * 1000);
   AppendUtf8(payload, account_json);
   AppendUtf8(payload, positions_json);
   AppendUtf8(payload, orders_json);
   if(!WriteFrame(payload))
     DisconnectPipe();
  }

void SendQuote(uchar &payload[], int &offset)
  {
   string request_id = ReadUtf8(payload, offset);
   string terminal_id = ReadUtf8(payload, offset);
   string broker_server = ReadUtf8(payload, offset);
   string login = ReadUtf8(payload, offset);
   long connection_epoch = ReadInt64(payload, offset);
   string symbol = ReadUtf8(payload, offset);
   if(request_id == "" || terminal_id != g_terminal_id
      || StringCompare(broker_server, AccountServer(), false) != 0
      || login != IntegerToString(AccountNumber())
      || connection_epoch != g_connection_epoch)
     {
      SendQuoteResult(request_id, symbol, 2, 0, 0, "quote_route_mismatch");
      return;
     }
   ResetLastError();
   if(symbol == "" || !SymbolSelect(symbol, true))
     {
      SendQuoteResult(request_id, symbol, 2, 0, 0, "symbol_unavailable");
      return;
     }
   RefreshRates();
   double bid = MarketInfo(symbol, MODE_BID);
   double ask = MarketInfo(symbol, MODE_ASK);
   if(bid <= 0 || ask <= 0 || ask < bid)
     {
      SendQuoteResult(request_id, symbol, 2, 0, 0, "symbol_tick_unavailable");
      return;
     }
   SendQuoteResult(request_id, symbol, 1, bid, ask, "");
  }

void SendQuoteResult(const string request_id, const string symbol, const int status,
   const double bid, const double ask, const string error_code)
  {
   long source_time = (long)MarketInfo(symbol, MODE_TIME);
   long observed_at = (source_time > 0 ? source_time : (long)TimeGMT()) * 1000;
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   if(digits < 0 || digits > 16) digits = 8;
   uchar response[];
   AppendInt32(response, MSG_QUOTE);
   AppendUtf8(response, request_id);
   AppendUtf8(response, symbol);
   AppendInt64(response, observed_at);
   AppendInt32(response, status);
   AppendUtf8(response, status == 1 ? DoubleToString(bid, digits) : "");
   AppendUtf8(response, status == 1 ? DoubleToString(ask, digits) : "");
   AppendUtf8(response, error_code);
   if(!WriteFrame(response))
      DisconnectPipe();
  }

int ResolveTimeframe(const string timeframe)
  {
   if(timeframe == "M1") return(PERIOD_M1);
   if(timeframe == "M5") return(PERIOD_M5);
   if(timeframe == "M15") return(PERIOD_M15);
   if(timeframe == "M30") return(PERIOD_M30);
   if(timeframe == "H1") return(PERIOD_H1);
   if(timeframe == "H4") return(PERIOD_H4);
   if(timeframe == "D1") return(PERIOD_D1);
   return(0);
  }

void SendRates(uchar &request[], int &offset)
  {
   string request_id = ReadUtf8(request, offset);
   string terminal_id = ReadUtf8(request, offset);
   string broker_server = ReadUtf8(request, offset);
   string login = ReadUtf8(request, offset);
   long connection_epoch = ReadInt64(request, offset);
   string symbol = ReadUtf8(request, offset);
   string timeframe_name = ReadUtf8(request, offset);
   int requested_count = ReadInt32(request, offset);
   long start_utc_msc = ReadInt64(request, offset);
   long end_utc_msc = ReadInt64(request, offset);
   if(request_id == "" || terminal_id != g_terminal_id
      || StringCompare(broker_server, AccountServer(), false) != 0
      || login != IntegerToString(AccountNumber())
      || connection_epoch != g_connection_epoch)
     {
      SendRatesResult(request_id, 2, "", "rates_route_mismatch", 0);
      return;
     }
   int timeframe = ResolveTimeframe(timeframe_name);
   if(symbol == "" || timeframe <= 0 || requested_count < 2 || requested_count > 5000
      || !SymbolSelect(symbol, true))
     {
      SendRatesResult(request_id, 2, "", "rates_params_invalid", 0);
      return;
     }
   int available = iBars(symbol, timeframe);
   if(available <= 0)
     {
      SendRatesResult(request_id, 2, "", "rates_unavailable", 0);
      return;
     }
   int newest_shift = 0;
   int oldest_shift = MathMin(requested_count - 1, available - 1);
   if(start_utc_msc > 0 || end_utc_msc > 0)
     {
      if(start_utc_msc <= 0 || end_utc_msc <= start_utc_msc)
        {
         SendRatesResult(request_id, 2, "", "rates_range_invalid", 0);
         return;
        }
      newest_shift = iBarShift(symbol, timeframe, (datetime)(end_utc_msc / 1000), false);
      oldest_shift = iBarShift(symbol, timeframe, (datetime)(start_utc_msc / 1000), false);
      if(newest_shift < 0 || oldest_shift < newest_shift)
        {
         SendRatesResult(request_id, 2, "", "rates_unavailable", 0);
         return;
        }
      oldest_shift = MathMin(oldest_shift, newest_shift + requested_count - 1);
     }
   int spread = (int)MarketInfo(symbol, MODE_SPREAD);
   string rates_json = "[";
   int actual_count = 0;
   for(int shift = oldest_shift; shift >= newest_shift; shift--)
     {
      datetime bar_time = iTime(symbol, timeframe, shift);
      if(bar_time <= 0) continue;
      if(actual_count > 0) rates_json += ",";
      rates_json += "{\"time_utc_msc\":" + IntegerToString((int)bar_time) + "000"
         + ",\"open\":" + JsonNumber(iOpen(symbol, timeframe, shift))
         + ",\"high\":" + JsonNumber(iHigh(symbol, timeframe, shift))
         + ",\"low\":" + JsonNumber(iLow(symbol, timeframe, shift))
         + ",\"close\":" + JsonNumber(iClose(symbol, timeframe, shift))
         + ",\"tick_volume\":" + IntegerToString((int)iVolume(symbol, timeframe, shift))
         + ",\"spread\":" + IntegerToString(spread)
         + ",\"real_volume\":0}";
      actual_count++;
     }
   rates_json += "]";
   string payload_json = "{\"symbol\":\"" + JsonEscape(symbol) + "\""
      + ",\"timeframe\":\"" + timeframe_name + "\""
      + ",\"count\":" + IntegerToString(actual_count)
      + ",\"rates\":" + rates_json + "}";
   long source_time = (long)iTime(symbol, timeframe, newest_shift) * 1000;
   SendRatesResult(request_id, 1, payload_json, "", source_time);
  }

void SendRatesResult(const string request_id, const int status,
   const string payload_json, const string error_code, const long observed_at)
  {
   uchar response[];
   AppendInt32(response, MSG_RATES);
   AppendUtf8(response, request_id);
   AppendInt64(response, observed_at > 0 ? observed_at : ((long)TimeGMT()) * 1000);
   AppendInt32(response, status);
   AppendUtf8(response, payload_json);
   AppendUtf8(response, error_code);
   if(!WriteFrame(response)) DisconnectPipe();
  }

void SendSymbolSnapshot(uchar &request[], int &offset)
  {
   string request_id = ReadUtf8(request, offset);
   string terminal_id = ReadUtf8(request, offset);
   string broker_server = ReadUtf8(request, offset);
   string login = ReadUtf8(request, offset);
   long connection_epoch = ReadInt64(request, offset);
   string symbol = ReadUtf8(request, offset);
   if(request_id == "" || terminal_id != g_terminal_id
      || StringCompare(broker_server, AccountServer(), false) != 0
      || login != IntegerToString(AccountNumber())
      || connection_epoch != g_connection_epoch)
     {
      SendSymbolSnapshotResult(request_id, 2, "", "symbol_snapshot_route_mismatch", 0);
      return;
     }
   if(symbol == "" || !SymbolSelect(symbol, true))
     {
      SendSymbolSnapshotResult(request_id, 2, "", "symbol_unavailable", 0);
      return;
     }
   RefreshRates();
   double point = MarketInfo(symbol, MODE_POINT);
   double bid = MarketInfo(symbol, MODE_BID);
   double ask = MarketInfo(symbol, MODE_ASK);
   double margin_per_lot = MarketInfo(symbol, MODE_MARGINREQUIRED);
   string account_json = "{\"currency\":\"" + JsonEscape(AccountCurrency()) + "\""
      + ",\"balance\":" + JsonNumber(AccountBalance())
      + ",\"equity\":" + JsonNumber(AccountEquity())
      + ",\"leverage\":" + IntegerToString(AccountLeverage())
      + ",\"margin_mode\":0"
      + ",\"margin_so_mode\":" + IntegerToString(AccountStopoutMode())
      + ",\"margin_so_call\":" + JsonNumber(AccountStopoutLevel())
      + ",\"margin_so_so\":" + JsonNumber(AccountStopoutLevel()) + "}";
   string instrument_json = "{\"name\":\"" + JsonEscape(symbol) + "\""
      + ",\"digits\":" + IntegerToString((int)MarketInfo(symbol, MODE_DIGITS))
      + ",\"trade_mode\":" + (MarketInfo(symbol, MODE_TRADEALLOWED) > 0 ? "4" : "0")
      + ",\"trade_calc_mode\":" + IntegerToString((int)MarketInfo(symbol, MODE_PROFITCALCMODE))
      + ",\"trade_exemode\":0"
      + ",\"trade_stops_level\":" + IntegerToString((int)MarketInfo(symbol, MODE_STOPLEVEL))
      + ",\"trade_freeze_level\":" + IntegerToString((int)MarketInfo(symbol, MODE_FREEZELEVEL))
      + ",\"filling_mode\":0,\"order_mode\":0"
      + ",\"point\":" + JsonNumber(point)
      + ",\"spread\":" + IntegerToString((int)MarketInfo(symbol, MODE_SPREAD))
      + ",\"spread_float\":false"
      + ",\"tick_size\":" + JsonNumber(MarketInfo(symbol, MODE_TICKSIZE) * point)
      + ",\"tick_value\":" + JsonNumber(MarketInfo(symbol, MODE_TICKVALUE))
      + ",\"contract_size\":" + JsonNumber(MarketInfo(symbol, MODE_LOTSIZE))
      + ",\"margin_initial\":" + JsonNumber(MarketInfo(symbol, MODE_MARGININIT))
      + ",\"margin_maintenance\":" + JsonNumber(MarketInfo(symbol, MODE_MARGINMAINTENANCE))
      + ",\"margin_hedged\":" + JsonNumber(MarketInfo(symbol, MODE_MARGINHEDGED))
      + ",\"margin_per_lot_buy\":" + JsonNumber(margin_per_lot)
      + ",\"margin_per_lot_sell\":" + JsonNumber(margin_per_lot)
      + ",\"margin_reference_price_buy\":" + JsonNumber(ask)
      + ",\"margin_reference_price_sell\":" + JsonNumber(bid)
      + ",\"margin_profile_currency\":\"" + JsonEscape(AccountCurrency()) + "\""
      + ",\"margin_profile_volume\":1"
      + ",\"volume_min\":" + JsonNumber(MarketInfo(symbol, MODE_MINLOT))
      + ",\"volume_max\":" + JsonNumber(MarketInfo(symbol, MODE_MAXLOT))
      + ",\"volume_step\":" + JsonNumber(MarketInfo(symbol, MODE_LOTSTEP))
      + ",\"volume_limit\":0"
      + ",\"swap_mode\":" + IntegerToString((int)MarketInfo(symbol, MODE_SWAPTYPE))
      + ",\"swap_rollover3days\":3"
      + ",\"swap_long\":" + JsonNumber(MarketInfo(symbol, MODE_SWAPLONG))
      + ",\"swap_short\":" + JsonNumber(MarketInfo(symbol, MODE_SWAPSHORT))
      + ",\"currency_base\":\"\",\"currency_profit\":\"\",\"currency_margin\":\"\"}";
   string payload_json = "{\"symbol\":\"" + JsonEscape(symbol)
      + "\",\"source\":\"mt4\",\"account\":" + account_json
      + ",\"instrument\":" + instrument_json + "}";
   long source_time = (long)MarketInfo(symbol, MODE_TIME) * 1000;
   SendSymbolSnapshotResult(request_id, 1, payload_json, "", source_time);
  }

void SendSymbolSnapshotResult(const string request_id, const int status,
   const string payload_json, const string error_code, const long observed_at)
  {
   uchar response[];
   AppendInt32(response, MSG_SYMBOL_SNAPSHOT);
   AppendUtf8(response, request_id);
   AppendInt64(response, observed_at > 0 ? observed_at : ((long)TimeGMT()) * 1000);
   AppendInt32(response, status);
   AppendUtf8(response, payload_json);
   AppendUtf8(response, error_code);
   if(!WriteFrame(response)) DisconnectPipe();
  }

void ExecuteCommand(uchar &payload[], int &offset)
  {
   string command_id = ReadUtf8(payload, offset);
   string terminal_id = ReadUtf8(payload, offset);
   string broker_server = ReadUtf8(payload, offset);
   string login = ReadUtf8(payload, offset);
   long connection_epoch = ReadInt64(payload, offset);
   long deadline = ReadInt64(payload, offset);
   int action = ReadInt32(payload, offset);
   string symbol = ReadUtf8(payload, offset);
   int side = ReadInt32(payload, offset);
   int order_kind = ReadInt32(payload, offset);
   long ticket_value = ReadInt64(payload, offset);
   double volume = StrToDouble(ReadUtf8(payload, offset));
   string price_value = ReadUtf8(payload, offset);
   string stop_loss_value = ReadUtf8(payload, offset);
   string take_profit_value = ReadUtf8(payload, offset);
   int deviation = ReadInt32(payload, offset);
   int magic = ReadInt32(payload, offset);
   long expiration = ReadInt64(payload, offset);
   string expected_stop_loss_value = ReadUtf8(payload, offset);
   string expected_take_profit_value = ReadUtf8(payload, offset);
   string order_comment = ReadUtf8(payload, offset);
   string expected_kind = ReadUtf8(payload, offset);
   string bridge_command_ref = ReadUtf8(payload, offset);
   if(command_id == "" || terminal_id != g_terminal_id
      || StringCompare(broker_server, AccountServer(), false) != 0
      || login != IntegerToString(AccountNumber())
      || connection_epoch != g_connection_epoch)
     {
      SendCommandResult(command_id, 2, "command_route_mismatch", "", 0, 0);
      return;
     }
   if(deadline <= ((long)TimeGMT()) * 1000)
     {
      SendCommandResult(command_id, 2, "command_expired", "", 0, 0);
      return;
     }
   if(action != ACTION_QUERY && !IsTradeAllowed())
     {
      SendCommandResult(command_id, 2, "mt4_trade_not_allowed", "", 0, 0);
      return;
     }
   ResetLastError();
   if(action == ACTION_PLACE)
     {
      ExecutePlace(command_id, symbol, side, order_kind, volume, price_value,
         stop_loss_value, take_profit_value, deviation, magic, expiration, order_comment);
      return;
     }
   if(action == ACTION_CANCEL)
     {
      ExecuteCancel(command_id, (int)ticket_value, symbol, side, volume, magic);
      return;
     }
   if(action == ACTION_MODIFY)
     {
      ExecuteModify(command_id, (int)ticket_value, price_value,
         stop_loss_value, take_profit_value, expiration);
      return;
     }
   if(action == ACTION_CLOSE)
     {
      ExecuteClose(command_id, (int)ticket_value, symbol, side, volume, deviation, magic);
      return;
     }
   if(action == ACTION_MODIFY_POSITION)
     {
      ExecuteModifyPosition(command_id, (int)ticket_value, symbol, side, volume,
         stop_loss_value, take_profit_value, expected_stop_loss_value,
         expected_take_profit_value, magic);
      return;
     }
   if(action == ACTION_QUERY)
     {
      ExecuteQuery(command_id, (int)ticket_value, symbol, expected_kind,
         bridge_command_ref, magic);
      return;
     }
   SendCommandResult(command_id, 2, "command_action_unsupported", "", 0, 0);
  }

void ExecutePlace(const string command_id, const string symbol, const int side,
   const int order_kind, const double volume, const string price_value,
   const string stop_loss_value, const string take_profit_value,
   const int deviation, const int magic, const long expiration,
   const string order_comment)
  {
   int operation = -1;
   if(order_kind == KIND_MARKET && side == SIDE_BUY) operation = OP_BUY;
   else if(order_kind == KIND_MARKET && side == SIDE_SELL) operation = OP_SELL;
   else if(order_kind == KIND_LIMIT && side == SIDE_BUY) operation = OP_BUYLIMIT;
   else if(order_kind == KIND_LIMIT && side == SIDE_SELL) operation = OP_SELLLIMIT;
   else if(order_kind == KIND_STOP && side == SIDE_BUY) operation = OP_BUYSTOP;
   else if(order_kind == KIND_STOP && side == SIDE_SELL) operation = OP_SELLSTOP;
   if(operation < 0 || symbol == "" || volume <= 0)
     {
      SendCommandResult(command_id, 2, "mt4_place_order_params_invalid", "", 0, 0);
      return;
     }
   RefreshRates();
   double price = (price_value == "")
      ? MarketInfo(symbol, side == SIDE_BUY ? MODE_ASK : MODE_BID)
      : StrToDouble(price_value);
   double stop_loss = (stop_loss_value == "") ? 0 : StrToDouble(stop_loss_value);
   double take_profit = (take_profit_value == "") ? 0 : StrToDouble(take_profit_value);
   string suffix = StringSubstr(command_id, MathMax(0, StringLen(command_id) - 20));
   string durable_comment = order_comment == "" ? "AURUM:" + suffix : order_comment;
   int ticket = OrderSend(symbol, operation, volume, price, deviation, stop_loss, take_profit,
      durable_comment, magic, (datetime)expiration, clrNONE);
   if(ticket > 0)
      SendCommandResult(command_id, 1, "", "", 0, ticket);
   else
      SendTradeFailure(command_id, "mt4_order_send_failed");
  }

void ExecuteCancel(const string command_id, const int ticket, const string expected_symbol,
   const int expected_side, const double expected_volume, const int expected_magic)
  {
   bool guarded = expected_symbol != "" && expected_side != SIDE_NONE && expected_volume > 0;
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      if(guarded)
        {
         SendCommandResult(command_id, 1, "", "already_absent", 0, ticket);
         return;
        }
      SendTradeFailure(command_id, "order_not_found");
      return;
     }
   if(OrderCloseTime() > 0)
     {
      if(guarded)
         SendCommandResult(command_id, 1, "", "already_absent", 0, ticket);
      else
         SendCommandResult(command_id, 2, "order_not_found", "", 0, ticket);
      return;
     }
   int order_type = OrderType();
   if(order_type == OP_BUY || order_type == OP_SELL)
     {
      SendCommandResult(command_id, 2, "order_not_pending", "", 0, ticket);
      return;
     }
   int actual_side = (order_type == OP_BUYLIMIT || order_type == OP_BUYSTOP) ? SIDE_BUY : SIDE_SELL;
   if(guarded && OrderSymbol() != expected_symbol)
     {
      SendCommandResult(command_id, 2, "management_symbol_mismatch", "", 0, ticket);
      return;
     }
   if(guarded && actual_side != expected_side)
     {
      SendCommandResult(command_id, 2, "management_direction_mismatch", "", 0, ticket);
      return;
     }
   if(guarded && OrderMagicNumber() != expected_magic)
     {
      SendCommandResult(command_id, 2, "management_magic_mismatch", "", 0, ticket);
      return;
     }
   if(guarded && MathAbs(OrderLots() - expected_volume) > 0.00000001)
     {
      SendCommandResult(command_id, 2, "management_volume_mismatch", "", 0, ticket);
      return;
     }
   if(OrderDelete(ticket, clrNONE))
      SendCommandResult(command_id, 1, "", "", 0, ticket);
   else
      SendTradeFailure(command_id, "mt4_order_delete_failed");
  }

void ExecuteModify(const string command_id, const int ticket, const string price_value,
   const string stop_loss_value, const string take_profit_value, const long expiration)
  {
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      SendTradeFailure(command_id, "order_not_found");
      return;
     }
   double price = (price_value == "") ? OrderOpenPrice() : StrToDouble(price_value);
   double stop_loss = (stop_loss_value == "") ? OrderStopLoss() : StrToDouble(stop_loss_value);
   double take_profit = (take_profit_value == "") ? OrderTakeProfit() : StrToDouble(take_profit_value);
   datetime expiry = (expiration == 0) ? OrderExpiration() : (datetime)expiration;
   if(OrderModify(ticket, price, stop_loss, take_profit, expiry, clrNONE))
      SendCommandResult(command_id, 1, "", "", 0, ticket);
   else
      SendTradeFailure(command_id, "mt4_order_modify_failed");
  }

void ExecuteClose(const string command_id, const int ticket, const string expected_symbol,
   const int expected_side, const double requested_volume, const int deviation, const int expected_magic)
  {
   bool guarded = expected_symbol != "" && expected_side != SIDE_NONE && requested_volume > 0;
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      if(guarded)
        {
         SendCommandResult(command_id, 1, "", "already_absent", 0, ticket);
         return;
        }
      SendTradeFailure(command_id, "position_not_found");
      return;
     }
   if(OrderCloseTime() > 0)
     {
      if(guarded)
         SendCommandResult(command_id, 1, "", "already_absent", 0, ticket);
      else
         SendCommandResult(command_id, 2, "position_not_found", "", 0, ticket);
      return;
     }
   int order_type = OrderType();
   if(order_type != OP_BUY && order_type != OP_SELL)
     {
      SendCommandResult(command_id, 2, "position_not_found", "", 0, ticket);
      return;
     }
   int actual_side = order_type == OP_BUY ? SIDE_BUY : SIDE_SELL;
   if(guarded && OrderSymbol() != expected_symbol)
     {
      SendCommandResult(command_id, 2, "management_symbol_mismatch", "", 0, ticket);
      return;
     }
   if(guarded && actual_side != expected_side)
     {
      SendCommandResult(command_id, 2, "management_direction_mismatch", "", 0, ticket);
      return;
     }
   if(guarded && OrderMagicNumber() != expected_magic)
     {
      SendCommandResult(command_id, 2, "management_magic_mismatch", "", 0, ticket);
      return;
     }
   if(guarded && MathAbs(OrderLots() - requested_volume) > 0.00000001)
     {
      SendCommandResult(command_id, 2, "management_volume_mismatch", "", 0, ticket);
      return;
     }
   double volume = (requested_volume <= 0) ? OrderLots() : requested_volume;
   if(volume <= 0 || volume > OrderLots())
     {
      SendCommandResult(command_id, 2, "close_volume_invalid", "", 0, ticket);
      return;
     }
   RefreshRates();
   double price = MarketInfo(OrderSymbol(), order_type == OP_BUY ? MODE_BID : MODE_ASK);
   if(OrderClose(ticket, volume, price, deviation, clrNONE))
      SendCommandResult(command_id, 1, "", "", 0, ticket);
   else
      SendTradeFailure(command_id, "mt4_order_close_failed");
  }

void ExecuteModifyPosition(const string command_id, const int ticket,
   const string expected_symbol, const int expected_side, const double expected_volume,
   const string stop_loss_value, const string take_profit_value,
   const string expected_stop_loss_value, const string expected_take_profit_value,
   const int expected_magic)
  {
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES) || OrderCloseTime() > 0)
     {
      SendCommandResult(command_id, 2, "system_position_not_found", "", 0, ticket);
      return;
     }
   int order_type = OrderType();
   if(order_type != OP_BUY && order_type != OP_SELL)
     {
      SendCommandResult(command_id, 2, "system_position_not_found", "", 0, ticket);
      return;
     }
   int actual_side = order_type == OP_BUY ? SIDE_BUY : SIDE_SELL;
   if(OrderSymbol() != expected_symbol)
     {
      SendCommandResult(command_id, 2, "management_symbol_mismatch", "", 0, ticket);
      return;
     }
   if(actual_side != expected_side)
     {
      SendCommandResult(command_id, 2, "management_direction_mismatch", "", 0, ticket);
      return;
     }
   if(OrderMagicNumber() != expected_magic)
     {
      SendCommandResult(command_id, 2, "management_magic_mismatch", "", 0, ticket);
      return;
     }
   if(MathAbs(OrderLots() - expected_volume) > 0.00000001)
     {
      SendCommandResult(command_id, 2, "management_volume_mismatch", "", 0, ticket);
      return;
     }
   double point = MarketInfo(OrderSymbol(), MODE_POINT);
   double tolerance = MathMax(point / 2.0, 0.00000001);
   if(expected_stop_loss_value != ""
      && MathAbs(OrderStopLoss() - StrToDouble(expected_stop_loss_value)) > tolerance)
     {
      SendCommandResult(command_id, 2, "position_stop_loss_changed", "", 0, ticket);
      return;
     }
   if(expected_take_profit_value != ""
      && MathAbs(OrderTakeProfit() - StrToDouble(expected_take_profit_value)) > tolerance)
     {
      SendCommandResult(command_id, 2, "position_take_profit_changed", "", 0, ticket);
      return;
     }
   if(stop_loss_value == "" && take_profit_value == "")
     {
      SendCommandResult(command_id, 2, "protection_price_required", "", 0, ticket);
      return;
     }
   int digits = (int)MarketInfo(OrderSymbol(), MODE_DIGITS);
   double next_sl = stop_loss_value == "" ? OrderStopLoss()
      : NormalizeDouble(StrToDouble(stop_loss_value), digits);
   double next_tp = take_profit_value == "" ? OrderTakeProfit()
      : NormalizeDouble(StrToDouble(take_profit_value), digits);
   if((stop_loss_value != "" && next_sl <= 0) || (take_profit_value != "" && next_tp <= 0))
     {
      SendCommandResult(command_id, 2, "protection_price_invalid", "", 0, ticket);
      return;
     }
   RefreshRates();
   double bid = MarketInfo(OrderSymbol(), MODE_BID);
   double ask = MarketInfo(OrderSymbol(), MODE_ASK);
   int min_points = (int)MathMax(MarketInfo(OrderSymbol(), MODE_STOPLEVEL),
      MarketInfo(OrderSymbol(), MODE_FREEZELEVEL));
   double min_distance = min_points * point;
   if(stop_loss_value != "")
     {
      bool valid_sl = order_type == OP_BUY ? next_sl < bid - min_distance : next_sl > ask + min_distance;
      if(!valid_sl)
        {
         SendCommandResult(command_id, 2, "stop_loss_direction_or_distance_invalid", "", 0, ticket);
         return;
        }
     }
   if(take_profit_value != "")
     {
      bool valid_tp = order_type == OP_BUY ? next_tp > ask + min_distance : next_tp < bid - min_distance;
      if(!valid_tp)
        {
         SendCommandResult(command_id, 2, "take_profit_direction_or_distance_invalid", "", 0, ticket);
         return;
        }
     }
   if(MathAbs(OrderStopLoss() - next_sl) <= tolerance
      && MathAbs(OrderTakeProfit() - next_tp) <= tolerance)
     {
      SendCommandResult(command_id, 1, "", "already_applied", 0, ticket);
      return;
     }
   if(!OrderModify(ticket, OrderOpenPrice(), next_sl, next_tp, 0, clrNONE))
     {
      SendTradeFailure(command_id, "mt4_position_modify_failed");
      return;
     }
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES)
      || MathAbs(OrderStopLoss() - next_sl) > tolerance
      || MathAbs(OrderTakeProfit() - next_tp) > tolerance)
     {
      SendCommandResult(command_id, 3, "position_protection_verify_failed", "", GetLastError(), ticket);
      return;
     }
   SendCommandResult(command_id, 1, "", "", 0, ticket);
  }

bool SelectQueryOrder(const int ticket, const string expected_symbol,
   const string bridge_command_ref, const int expected_magic, const int pool)
  {
   if(bridge_command_ref != "")
     {
      int total = pool == MODE_TRADES ? OrdersTotal() : OrdersHistoryTotal();
      for(int index = total - 1; index >= 0; index--)
        {
         if(!OrderSelect(index, SELECT_BY_POS, pool))
            continue;
         if(OrderComment() != bridge_command_ref)
            continue;
         if(expected_symbol != "" && OrderSymbol() != expected_symbol)
            continue;
         if(OrderMagicNumber() != expected_magic)
            continue;
         return(true);
        }
      return(false);
     }
   if(ticket <= 0 || !OrderSelect(ticket, SELECT_BY_TICKET, pool))
      return(false);
   bool selected_active = OrderCloseTime() == 0;
   if((pool == MODE_TRADES && !selected_active)
      || (pool == MODE_HISTORY && selected_active))
      return(false);
   if(expected_symbol != "" && OrderSymbol() != expected_symbol)
      return(false);
   return(OrderMagicNumber() == expected_magic);
  }

void ExecuteQuery(const string command_id, const int ticket,
   const string expected_symbol, const string expected_kind,
   const string bridge_command_ref, const int expected_magic)
  {
   ResetLastError();
   bool active = SelectQueryOrder(ticket, expected_symbol, bridge_command_ref,
      expected_magic, MODE_TRADES);
   bool found = active;
   if(!found)
      found = SelectQueryOrder(ticket, expected_symbol, bridge_command_ref,
         expected_magic, MODE_HISTORY);
   if(!found)
     {
      SendCommandResult(command_id, 1, "", "", 0, 0,
         "{\"found\":false,\"complete\":true}");
      return;
     }
   int selected_ticket = OrderTicket();
   int order_type = OrderType();
   bool is_market = order_type == OP_BUY || order_type == OP_SELL;
   string kind = is_market ? "trade" : "pending";
   string pending_state = "";
   if(!is_market)
     {
      if(active)
         pending_state = "pending";
      else if(OrderExpiration() > 0 && OrderCloseTime() >= OrderExpiration())
         pending_state = "expired";
      else
         pending_state = "cancelled";
     }
   string raw = "{\"found\":true,\"complete\":true"
      + ",\"kind\":\"" + kind + "\""
      + ",\"ticket\":\"" + IntegerToString(selected_ticket) + "\""
      + ",\"order\":\"" + IntegerToString(selected_ticket) + "\""
      + (is_market ? ",\"position_id\":\"" + IntegerToString(selected_ticket) + "\"" : "")
      + ",\"symbol\":\"" + JsonEscape(OrderSymbol()) + "\""
      + ",\"comment\":\"" + JsonEscape(OrderComment()) + "\""
      + (pending_state == "" ? "" : ",\"pending_state\":\"" + pending_state + "\"")
      + "}";
   SendCommandResult(command_id, 1, "", "", 0, selected_ticket, raw);
  }

void SendTradeFailure(const string command_id, const string fallback_code)
  {
   int error_code = GetLastError();
   string code = (error_code > 0)
      ? "mt4_error_" + IntegerToString(error_code)
      : fallback_code;
   SendCommandResult(command_id, 2, code, fallback_code, error_code, 0);
  }

void SendCommandResult(const string command_id, const int status, const string error_code,
   const string error_message, const int broker_retcode, const long ticket,
   const string raw_result_json = "")
  {
   uchar response[];
   AppendInt32(response, MSG_COMMAND_RESULT);
   AppendUtf8(response, command_id);
   AppendInt32(response, status);
   AppendUtf8(response, error_code);
   AppendUtf8(response, error_message);
   AppendInt32(response, broker_retcode);
   AppendInt64(response, ticket);
   AppendInt64(response, ((long)TimeGMT()) * 1000);
   AppendUtf8(response, raw_result_json);
   if(!WriteFrame(response))
      DisconnectPipe();
  }

string BuildAccountJson()
  {
   return("{"
      + "\"login\":\"" + IntegerToString(AccountNumber()) + "\","
      + "\"server\":\"" + JsonEscape(AccountServer()) + "\","
      + "\"name\":\"" + JsonEscape(AccountName()) + "\","
      + "\"currency\":\"" + JsonEscape(AccountCurrency()) + "\","
      + "\"leverage\":" + IntegerToString(AccountLeverage()) + ","
      + "\"balance\":" + JsonNumber(AccountBalance()) + ","
      + "\"credit\":" + JsonNumber(AccountCredit()) + ","
      + "\"equity\":" + JsonNumber(AccountEquity()) + ","
      + "\"margin\":" + JsonNumber(AccountMargin()) + ","
      + "\"margin_free\":" + JsonNumber(AccountFreeMargin()) + ","
      + "\"profit\":" + JsonNumber(AccountProfit()) + ","
      + "\"connected\":" + (IsConnected() ? "true" : "false") + ","
      + "\"trade_allowed\":" + (IsTradeAllowed() ? "true" : "false")
      + "}");
  }

string BuildOrdersJson(const bool market_positions)
  {
   string json = "[";
   bool first = true;
   int total = OrdersTotal();
   for(int index = 0; index < total; index++)
     {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES))
         continue;
      int order_type = OrderType();
      bool is_market = (order_type == OP_BUY || order_type == OP_SELL);
      if(is_market != market_positions)
         continue;
      if(!first)
         json += ",";
      json += BuildSelectedOrderJson();
      first = false;
     }
   return(json + "]");
  }

string BuildSelectedOrderJson()
  {
   int order_type = OrderType();
   string side = (order_type == OP_BUY || order_type == OP_BUYLIMIT || order_type == OP_BUYSTOP)
      ? "buy" : "sell";
   return("{"
      + "\"ticket\":\"" + IntegerToString(OrderTicket()) + "\","
      + "\"symbol\":\"" + JsonEscape(OrderSymbol()) + "\","
      + "\"type\":" + IntegerToString(order_type) + ","
      + "\"side\":\"" + side + "\","
      + "\"volume\":" + JsonNumber(OrderLots()) + ","
      + "\"price_open\":" + JsonNumber(OrderOpenPrice()) + ","
      + "\"stop_loss\":" + JsonNumber(OrderStopLoss()) + ","
      + "\"take_profit\":" + JsonNumber(OrderTakeProfit()) + ","
      + "\"profit\":" + JsonNumber(OrderProfit()) + ","
      + "\"swap\":" + JsonNumber(OrderSwap()) + ","
      + "\"commission\":" + JsonNumber(OrderCommission()) + ","
      + "\"magic\":" + IntegerToString(OrderMagicNumber()) + ","
      + "\"open_time\":" + IntegerToString((int)OrderOpenTime()) + ","
      + "\"expiration\":" + IntegerToString((int)OrderExpiration()) + ","
      + "\"comment\":\"" + JsonEscape(OrderComment()) + "\""
      + "}");
  }

string JsonNumber(const double value)
  {
   if(!MathIsValidNumber(value))
      return("0");
   return(DoubleToString(value, 8));
  }

string JsonEscape(const string value)
  {
   string escaped = "";
   int length = StringLen(value);
   for(int index = 0; index < length; index++)
     {
      ushort character = StringGetCharacter(value, index);
      if(character == 34)
         escaped += "\\\"";
      else if(character == 92)
         escaped += "\\\\";
      else if(character == 8)
         escaped += "\\b";
      else if(character == 9)
         escaped += "\\t";
      else if(character == 10)
         escaped += "\\n";
      else if(character == 12)
         escaped += "\\f";
      else if(character == 13)
         escaped += "\\r";
      else if(character < 32)
         escaped += StringFormat("\\u%04x", character);
      else
         escaped += ShortToString(character);
     }
   return(escaped);
  }

bool WriteFrame(uchar &payload[])
  {
   if(g_pipe == INVALID_HANDLE)
      return(false);
   int size = ArraySize(payload);
   if(size <= 0 || size > MAX_FRAME_BYTES)
      return(false);
   ResetLastError();
   FileWriteInteger(g_pipe, size, INT_VALUE);
   if(FileWriteArray(g_pipe, payload, 0, size) != size)
      return(false);
   FileFlush(g_pipe);
   return(FileSeek(g_pipe, 0, SEEK_SET));
  }

bool ReadFrame(uchar &payload[])
  {
   if(g_pipe == INVALID_HANDLE)
      return(false);
   ResetLastError();
   int size = FileReadInteger(g_pipe, INT_VALUE);
   if(size <= 0 || size > MAX_FRAME_BYTES)
      return(false);
   ArrayResize(payload, size);
   if(FileReadArray(g_pipe, payload, 0, size) != size)
      return(false);
   FileFlush(g_pipe);
   return(FileSeek(g_pipe, 0, SEEK_SET));
  }

void AppendInt32(uchar &buffer[], const int value)
  {
   int offset = ArraySize(buffer);
   ArrayResize(buffer, offset + 4);
   buffer[offset] = (uchar)(value & 255);
   buffer[offset + 1] = (uchar)((value >> 8) & 255);
   buffer[offset + 2] = (uchar)((value >> 16) & 255);
   buffer[offset + 3] = (uchar)((value >> 24) & 255);
  }

void AppendInt64(uchar &buffer[], const long value)
  {
   int offset = ArraySize(buffer);
   ArrayResize(buffer, offset + 8);
   for(int index = 0; index < 8; index++)
      buffer[offset + index] = (uchar)((value >> (index * 8)) & 255);
  }

void AppendUtf8(uchar &buffer[], const string value)
  {
   uchar encoded[];
   int copied = StringToCharArray(value, encoded, 0, WHOLE_ARRAY, CP_UTF8);
   int length = MathMax(0, copied - 1);
   AppendInt32(buffer, length);
   int offset = ArraySize(buffer);
   ArrayResize(buffer, offset + length);
   if(length > 0)
      ArrayCopy(buffer, encoded, offset, 0, length);
  }

int ReadInt32(uchar &buffer[], int &offset)
  {
   if(offset + 4 > ArraySize(buffer))
     {
      offset = ArraySize(buffer);
      return(0);
     }
   int value = ((int)buffer[offset])
      | ((int)buffer[offset + 1] << 8)
      | ((int)buffer[offset + 2] << 16)
      | ((int)buffer[offset + 3] << 24);
   offset += 4;
   return(value);
  }

long ReadInt64(uchar &buffer[], int &offset)
  {
   if(offset + 8 > ArraySize(buffer))
     {
      offset = ArraySize(buffer);
      return(0);
     }
   long value = 0;
   for(int index = 0; index < 8; index++)
      value |= ((long)buffer[offset + index]) << (index * 8);
   offset += 8;
   return(value);
  }

string ReadUtf8(uchar &buffer[], int &offset)
  {
   int length = ReadInt32(buffer, offset);
   if(length < 0 || offset + length > ArraySize(buffer))
     {
      offset = ArraySize(buffer);
      return("");
     }
   string value = CharArrayToString(buffer, offset, length, CP_UTF8);
   offset += length;
   return(value);
  }
