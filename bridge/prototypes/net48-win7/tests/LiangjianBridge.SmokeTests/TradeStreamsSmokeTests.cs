using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;
namespace Liangjian.BridgeV4.SmokeTests {
 internal static partial class SessionLifecycleSmokeTests {
  public static void TestTradeStreams() {
   var mt4 = new Dictionary<string,object>{{"ticket",101},{"symbol","XAUUSD.s"},{"side","buy"},{"volume","0.01"},{"open_price","2300.12"},{"current_price","2301.12"},{"stop_loss",null},{"take_profit","2350"},{"profit","1.00"},{"open_time_utc_msc",Now},{"magic",0}};
   var result=BridgeTradeStreams.Normalize(mt4,"mt4",true);
   Assert((string)result["ticket"]=="101" && result["stop_loss"]==null && (string)result["order_type"]=="market","mt4_normalization_failed");
   var mt5=new Dictionary<string,object>{{"ticket",9007199254740993L},{"identifier",9007199254740992L},{"symbol","EURUSD"},{"type",1},{"magic",12},{"volume",0.25},{"price_open",1.12345},{"price_current",1.12},{"sl",0.0},{"tp",1.10},{"profit",-2.5},{"open_time_utc_msc",Now}};
   result=BridgeTradeStreams.Normalize(mt5,"mt5",true);
   Assert((string)result["ticket"]=="9007199254740993" && (string)result["direction"]=="sell" && result["stop_loss"]==null,"mt5_identity_or_direction_failed");
   mt5["type"]=6;mt5["volume_current"]=0.15;mt5["price_stoplimit"]=1.12;mt5["create_time_utc_msc"]=Now;mt5["expiration_time_utc_msc"]=null;
   result=BridgeTradeStreams.Normalize(mt5,"mt5",false);
   Assert((string)result["order_type"]=="buy_stop_limit" && (string)result["volume"]=="0.15" && result["expiration_utc_msc"]==null,"mt5_pending_failed");
   mt4["open_time_utc_msc"]=null;
   bool rejected=false;try{BridgeTradeStreams.Normalize(mt4,"mt4",true);}catch(InvalidDataException){rejected=true;}
   Assert(rejected,"unknown_clock_became_utc");
   string root=NewRoot("trade-stream");
   try {using(var runtime=Runtime(root)) {
    var source=new TradeStreamSource();var stream=new BridgeTradeStreams(runtime,source);
    long now=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
    var messages=stream.Read(now);Assert(messages.Length==2,"full_empty_snapshots_missing");
    Assert(((object[])Object(Parse(messages[0]),"payload")["upserts"]).Length==0,"empty_snapshot_wrong");
    source.Partial=true;rejected=false;try{stream.Read(now);}catch(InvalidDataException){rejected=true;}
    Assert(rejected,"partial_page_replaced_full_snapshot");
   }}finally{DeleteRoot(root);}
  }
  private sealed class TradeStreamSource:ITerminalQuerySource {
   public bool Partial;
   public TerminalQueryResult Query(ProfileRuntime runtime,BridgeQueryRequest request,long now) {
    string data=request.Resource=="account.snapshot"?"{\"login\":\"10001\",\"broker_server\":\"Demo\",\"currency\":\"USD\",\"connected\":true}":"{\"items\":[]}";
    bool partial=Partial && request.Resource!="account.snapshot";
    return TerminalQueryResult.FromAdapterSuccess(request.RequestId,TerminalQueryTranslator.ResourceCode(request.Resource),now,0,"unavailable",data,partial?"500":null,partial);
   }
  }
 }
}
