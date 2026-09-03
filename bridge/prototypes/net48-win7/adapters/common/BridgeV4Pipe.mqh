#property strict

// Bridge V4 terminal-side wire codec.
// The EA/Service talks only to the local .NET Bridge over a named pipe.  The
// server owns internet authentication and all business policy; this file is
// deliberately limited to framing, bounded strings, and JSON helpers.

#define B4_PIPE_NAME                 "LiangjianBridgeV4"
#define B4_PROTOCOL_VERSION          1
#define B4_MAX_FRAME_BYTES           (256 * 1024)
#define B4_MAX_STRING_BYTES          (64 * 1024)
#define B4_MAX_SYMBOLS               64
#define B4_MAX_CANDLES               5000
#define B4_MAX_PAGE                  500

#define B4_MSG_HELLO                 1
#define B4_MSG_WELCOME               2
#define B4_MSG_QUERY_REQUEST         10
#define B4_MSG_QUERY_RESPONSE        11
#define B4_MSG_QUERY_ERROR           12
#define B4_MSG_COMMAND_REQUEST       20
#define B4_MSG_COMMAND_RESULT        21
#define B4_MSG_COMMAND_ERROR         22
#define B4_MSG_PING                  90
#define B4_MSG_PONG                  91

#define B4_ACTION_ORDER_PLACE        1
#define B4_ACTION_PROTECTION_SET     2
#define B4_ACTION_POSITION_CLOSE     3
#define B4_ACTION_PENDING_MODIFY     4
#define B4_ACTION_PENDING_CANCEL     5
#define B4_ACTION_EXECUTION_LOOKUP   6

#define B4_COMMAND_SUCCEEDED         1
#define B4_COMMAND_REJECTED          2
#define B4_COMMAND_FAILED            3
#define B4_COMMAND_UNCERTAIN         4

#define B4_STATE_UNKNOWN             0
#define B4_STATE_ABSENT              1
#define B4_STATE_POSITION            2
#define B4_STATE_PENDING             3
#define B4_STATE_CLOSED              4
#define B4_STATE_FILLED              5

#define B4_RESULT_ALREADY_ABSENT     1
#define B4_RESULT_ALREADY_APPLIED    2

#define B4_RESOURCE_TERMINAL_INFO    1
#define B4_RESOURCE_TERMINAL_CLOCK   2
#define B4_RESOURCE_ACCOUNT          3
#define B4_RESOURCE_SYMBOLS          4
#define B4_RESOURCE_INSTRUMENT       5
#define B4_RESOURCE_QUOTE            6
#define B4_RESOURCE_CANDLES          7
#define B4_RESOURCE_POSITIONS        8
#define B4_RESOURCE_PENDING_ORDERS   9
#define B4_RESOURCE_HISTORY_ORDERS   10
#define B4_RESOURCE_HISTORY_TRADES   11
#define B4_RESOURCE_HISTORY_DEALS    12
#define B4_RESOURCE_EXECUTION_LOOKUP 13
#define B4_RESOURCE_HEALTH           14

string B4JsonEscape(const string value)
  {
   string result = "";
   int length = StringLen(value);
   for(int index = 0; index < length; index++)
     {
      ushort code = (ushort)StringGetCharacter(value, index);
      if(code == 34) result += "\\\"";
      else if(code == 92) result += "\\\\";
      else if(code == 8) result += "\\b";
      else if(code == 9) result += "\\t";
      else if(code == 10) result += "\\n";
      else if(code == 12) result += "\\f";
      else if(code == 13) result += "\\r";
      else if(code < 32)
        {
         const string hex = "0123456789abcdef";
         result += "\\u";
         result += StringSubstr(hex, (code >> 12) & 15, 1);
         result += StringSubstr(hex, (code >> 8) & 15, 1);
         result += StringSubstr(hex, (code >> 4) & 15, 1);
         result += StringSubstr(hex, code & 15, 1);
        }
      else result += StringSubstr(value, index, 1);
     }
   return(result);
  }

string B4JsonString(const string value)
  {
   return("\"" + B4JsonEscape(value) + "\"");
  }

string B4JsonDecimal(const double value, const int digits)
  {
   if(!MathIsValidNumber(value)) return("null");
   return(B4JsonString(DoubleToString(value, digits)));
  }

string B4JsonNullableDecimal(const double value, const int digits)
  {
   if(!MathIsValidNumber(value) || value == 0.0) return("null");
   return(B4JsonString(DoubleToString(value, digits)));
  }

string B4LongText(const long value)
  {
   return(DoubleToString((double)value, 0));
  }

string B4JsonLong(const long value)
  {
   return(B4LongText(value));
  }

string B4JsonInt(const int value)
  {
   return(IntegerToString(value));
  }

string B4JsonBool(const bool value)
  {
   return(value ? "true" : "false");
  }

bool B4ValidText(const string value, const int max_bytes)
  {
   if(StringLen(value) <= 0 || StringLen(value) > max_bytes) return(false);
   if(StringFind(value, "\r") >= 0 || StringFind(value, "\n") >= 0) return(false);
   return(true);
  }

void B4AppendByte(uchar &buffer[], int &size, const uchar value)
  {
   ArrayResize(buffer, size + 1);
   buffer[size] = value;
   size++;
  }

void B4AppendInt32(uchar &buffer[], int &size, const int value)
  {
   long raw = (long)value;
   if(raw < 0) raw += 4294967296;
   for(int index = 0; index < 4; index++)
     {
      B4AppendByte(buffer, size, (uchar)(raw & 255));
      raw >>= 8;
     }
  }

void B4AppendInt64(uchar &buffer[], int &size, const long value)
  {
   long raw = value;
   for(int index = 0; index < 8; index++)
     {
      B4AppendByte(buffer, size, (uchar)(raw & 255));
      raw >>= 8;
     }
  }

void B4AppendUtf8(uchar &buffer[], int &size, const string value)
  {
   uchar encoded[];
   int count = StringToCharArray(value, encoded, 0, WHOLE_ARRAY, CP_UTF8);
   if(count > 0 && encoded[count - 1] == 0) count--;
   if(count < 0 || count > B4_MAX_STRING_BYTES) count = 0;
   B4AppendInt32(buffer, size, count);
   for(int index = 0; index < count; index++)
      B4AppendByte(buffer, size, encoded[index]);
  }

bool B4ReadInt32(const uchar &buffer[], int &offset, int &value)
  {
   if(offset < 0 || offset + 4 > ArraySize(buffer)) return(false);
   long raw = (long)buffer[offset]
      | ((long)buffer[offset + 1] << 8)
      | ((long)buffer[offset + 2] << 16)
      | ((long)buffer[offset + 3] << 24);
   if(raw >= 2147483648) raw -= 4294967296;
   value = (int)raw;
   offset += 4;
   return(true);
  }

bool B4ReadInt64(const uchar &buffer[], int &offset, long &value)
  {
   if(offset < 0 || offset + 8 > ArraySize(buffer)) return(false);
   long raw = 0;
   for(int index = 0; index < 8; index++)
      raw |= ((long)buffer[offset + index] << (8 * index));
   value = raw;
   offset += 8;
   return(true);
  }

bool B4ReadUtf8(const uchar &buffer[], int &offset, string &value,
   const int max_bytes = B4_MAX_STRING_BYTES, const bool allow_empty = true)
  {
   int length = 0;
   if(!B4ReadInt32(buffer, offset, length) || length < 0
      || length > max_bytes || length > B4_MAX_STRING_BYTES
      || offset + length > ArraySize(buffer)) return(false);
   value = length == 0 ? "" : CharArrayToString(buffer, offset, length, CP_UTF8);
   offset += length;
   if(!allow_empty && StringLen(value) == 0) return(false);
   if(StringFind(value, "\r") >= 0 || StringFind(value, "\n") >= 0) return(false);
   return(true);
  }

bool B4WriteFrame(const int handle, uchar &payload[], const int payload_size)
  {
   if(handle == INVALID_HANDLE || payload_size <= 0
      || payload_size > B4_MAX_FRAME_BYTES || payload_size > ArraySize(payload))
      return(false);
   uchar header[];
   int header_size = 0;
   B4AppendInt32(header, header_size, payload_size);
   if(FileWriteArray(handle, header, 0, 4) != 4) return(false);
   if(FileWriteArray(handle, payload, 0, payload_size) != payload_size) return(false);
   FileFlush(handle);
   // MetaTrader named pipes are stream-like and require the read/write cursor
   // to be rewound after each direction switch.
   FileSeek(handle, 0, SEEK_SET);
   return(true);
  }

bool B4ReadFrame(const int handle, uchar &payload[])
  {
   if(handle == INVALID_HANDLE) return(false);
   uchar header[];
   ArrayResize(header, 4);
   if(FileReadArray(handle, header, 0, 4) != 4) return(false);
   int payload_size = 0;
   int offset = 0;
   if(!B4ReadInt32(header, offset, payload_size)
      || payload_size <= 0 || payload_size > B4_MAX_FRAME_BYTES) return(false);
   ArrayResize(payload, payload_size);
   if(FileReadArray(handle, payload, 0, payload_size) != payload_size) return(false);
   FileFlush(handle);
   FileSeek(handle, 0, SEEK_SET);
   return(true);
  }

bool B4PipeHasData(const int handle)
  {
   if(handle == INVALID_HANDLE) return(false);
   // FileIsEnding is the only non-blocking availability check exposed by the
   // MQL file API and works for the byte-mode named pipe used here.
   return(!FileIsEnding(handle));
  }

long B4UtcNowMsc()
  {
   return((long)TimeGMT() * 1000);
  }

bool B4ValidOffsetMinutes(const int value)
  {
   return(value >= -840 && value <= 840 && value % 15 == 0);
  }

string B4Cursor(const long value)
  {
   return(DoubleToString((double)value, 0));
  }
