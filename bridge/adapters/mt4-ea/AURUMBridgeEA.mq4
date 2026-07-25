#property strict
#property version   "3.00"
#property description "AURUM Bridge local MT4 adapter. No DLL or WebRequest required."

input string InpPipeName = "AURUMBridgeV3";

#define MSG_HELLO        1
#define MSG_WELCOME      2
#define MSG_COLLECT      10
#define MSG_SNAPSHOT     11
#define MSG_SHUTDOWN     90
#define MSG_SHUTDOWN_ACK 91
#define STREAM_ACCOUNT   1
#define STREAM_POSITIONS 2
#define STREAM_ORDERS    4
#define MAX_FRAME_BYTES  4194304

int    g_pipe = INVALID_HANDLE;
bool   g_welcomed = false;
string g_terminal_id = "";
long   g_connection_epoch = 0;

int OnInit()
  {
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
      g_welcomed = (StringLen(g_terminal_id) > 0 && g_connection_epoch > 0);
      return;
     }
   if(message_type == MSG_COLLECT && g_welcomed)
     {
      int streams = ReadInt32(payload, offset);
      SendSnapshot(streams);
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
   string pipe_path = "\\\\.\\pipe\\" + InpPipeName;
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
