#property strict
#property version   "3.00"
#property description "AURUM Bridge local MT4 adapter. No DLL or WebRequest required."

input string InpPipeName = "AURUMBridgeV3";

#define MSG_HELLO        1
#define MSG_WELCOME      2
#define MSG_COLLECT      10
#define MSG_SNAPSHOT     11
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
   AppendUtf8(hello, "3.0.0");
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
         stop_loss_value, take_profit_value, deviation, magic, expiration);
      return;
     }
   if(action == ACTION_CANCEL)
     {
      ExecuteCancel(command_id, (int)ticket_value);
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
      ExecuteClose(command_id, (int)ticket_value, volume, deviation);
      return;
     }
   if(action == ACTION_QUERY)
     {
      ExecuteQuery(command_id, (int)ticket_value);
      return;
     }
   SendCommandResult(command_id, 2, "command_action_unsupported", "", 0, 0);
  }

void ExecutePlace(const string command_id, const string symbol, const int side,
   const int order_kind, const double volume, const string price_value,
   const string stop_loss_value, const string take_profit_value,
   const int deviation, const int magic, const long expiration)
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
   int ticket = OrderSend(symbol, operation, volume, price, deviation, stop_loss, take_profit,
      "AURUM:" + suffix, magic, (datetime)expiration, clrNONE);
   if(ticket > 0)
      SendCommandResult(command_id, 1, "", "", 0, ticket);
   else
      SendTradeFailure(command_id, "mt4_order_send_failed");
  }

void ExecuteCancel(const string command_id, const int ticket)
  {
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      SendTradeFailure(command_id, "order_not_found");
      return;
     }
   int order_type = OrderType();
   if(order_type == OP_BUY || order_type == OP_SELL)
     {
      SendCommandResult(command_id, 2, "order_not_pending", "", 0, ticket);
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

void ExecuteClose(const string command_id, const int ticket, const double requested_volume,
   const int deviation)
  {
   if(!OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
     {
      SendTradeFailure(command_id, "position_not_found");
      return;
     }
   int order_type = OrderType();
   if(order_type != OP_BUY && order_type != OP_SELL)
     {
      SendCommandResult(command_id, 2, "position_not_found", "", 0, ticket);
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

void ExecuteQuery(const string command_id, const int ticket)
  {
   ResetLastError();
   bool found = OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES);
   if(!found)
      found = OrderSelect(ticket, SELECT_BY_TICKET, MODE_HISTORY);
   SendCommandResult(command_id, 1, "", "", found ? 0 : GetLastError(), found ? ticket : 0);
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
   const string error_message, const int broker_retcode, const long ticket)
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
