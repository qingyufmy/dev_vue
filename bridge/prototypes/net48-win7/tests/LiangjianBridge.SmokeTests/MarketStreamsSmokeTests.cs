using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;
namespace Liangjian.BridgeV4.SmokeTests {
 internal static partial class SessionLifecycleSmokeTests {
  public static void TestMarketStreams() {
   string root=NewRoot("market-stream");
   try { using(var runtime=Runtime(root)) {
    var source=new MarketSource(); var streams=new BridgeMarketStreams(runtime,source,null);
    long now=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
    Assert(streams.Read(now).Length==0 && source.Reads==0,"unsubscribed_terminal_polled");
    string id="market-"+new string('a',32);
    streams.Control(MarketControl(id,now+90000,false),now);
    int beforeQuotes=source.Reads;
    Assert(streams.ReadCandles(now).Length==0 && source.Reads==beforeQuotes,"candle_loop_polled_quote");
    var frames=streams.ReadQuotes(now); Assert(frames.Length==1,"subscribed_quote_missing");
    var payload=Object(Parse(frames[0]),"payload");
    var quote=(IDictionary<string,object>)((object[])payload["upserts"])[0];
    Assert((string)quote["symbol"]=="EURUSD" && (string)quote["spread"]=="0.0002" && quote["last"]==null,"quote_normalization_failed");
    streams.Control(MarketControl(id,now+90000,false),now);
    Assert(streams.Read(now).Length==0,"unchanged_quote_resent_on_renewal");
    streams.Control(MarketControl(id,0,true),now); int reads=source.Reads;
    Assert(streams.Read(now).Length==0 && source.Reads==reads,"cancelled_terminal_polled");
    streams.Control(MarketControl(id,now+1,false),now);
    Assert(streams.Read(now+2).Length==0,"expired_lease_collected");
    bool failed=false;try{streams.Control(MarketControl(id,now+96000,false),now);}catch(InvalidDataException){failed=true;}
    Assert(failed,"unbounded_lease_accepted");
    streams.Control(MarketControl(id,now+90000,false),now); source.Symbol="OTHER";
    failed=false;try{streams.Read(now);}catch(InvalidDataException){failed=true;}
    Assert(failed,"symbol_alias_silently_relabelled");
    streams.Control(MarketControl("market-"+new string('b',32),now+90000,false,"OTHER"),now);
    int accountReads=source.AccountReads;
    Assert(streams.Read(now).Length==1,"invalid_symbol_starved_other_subscription");
    Assert(source.AccountReads-accountReads==2,"batch_repeats_identity_per_subscription");
    source.FailIdentityAfterQuote=true;
    failed=false;try{streams.ReadQuotes(now);}catch(InvalidDataException){failed=true;}
    Assert(failed,"batch_published_after_identity_changed");
    var candle=new Dictionary<string,object>{{"time_utc_msc",now-1000},{"open",1.1},{"high",1.2},{"low",1.0},{"close",1.15},{"tick_volume",10},{"spread",2}};
    var data=new Dictionary<string,object>{{"symbol","EURUSD"},{"timeframe","M5"},{"items",new object[]{candle}}};
    failed=false;try{ProjectionSourceSupport.MapCandles(data,"EURUSD","M5",now-5000,now+1,now,"r");}catch(InvalidDataException){failed=true;}
    Assert(failed,"historical_open_candle_accepted");
    Assert(!ProjectionSourceSupport.MapCandles(data,"EURUSD","M5",now-5000,now+1,now,"r",true)[0].Closed,"live_candle_falsely_closed");
   }} finally {DeleteRoot(root);}
  }
  private static BridgeEnvelope MarketControl(string id,long expiry,bool cancel,string symbol="EURUSD") {
   var payload=cancel?new Dictionary<string,object>{{"subscription_id",id}}:new Dictionary<string,object>{{"subscription_id",id},{"stream","quotes"},{"filter",new Dictionary<string,object>{{"symbol",symbol},{"timeframe",null},{"expires_at_utc_msc",expiry}}}};
   return BridgeEnvelope.Parse(new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"v",4},{"message_id","market-control"},{"type",cancel?"stream.unsubscribe":"stream.subscribe"},{"sent_at_utc_msc",Now},{"correlation_id",null},{"route",new Dictionary<string,object>{{"terminal_instance_id","terminal-a"},{"connection_epoch",1},{"account_ref",new Dictionary<string,object>{{"broker_server","Demo"},{"login","10001"}}}}},{"payload",payload}}));
  }
  private sealed class MarketSource:ITerminalQuerySource {
   public int Reads,AccountReads; public bool FailIdentityAfterQuote,IdentityChanged; public string Symbol="EURUSD";
   public TerminalQueryResult Query(ProfileRuntime runtime,BridgeQueryRequest request,long now) {
    Reads++;
    if(request.Resource=="account.snapshot") { AccountReads++; if(IdentityChanged) throw new InvalidDataException("identity_changed"); }
    else if(FailIdentityAfterQuote) IdentityChanged=true;
    string data=request.Resource=="account.snapshot"?"{\"login\":\"10001\",\"broker_server\":\"Demo\",\"currency\":\"USD\",\"connected\":true}":new JavaScriptSerializer().Serialize(new {items=new[]{new {symbol=Symbol,bid=1.1000,ask=1.1002,last=0,time_utc_msc=Now}}});
    return TerminalQueryResult.FromAdapterSuccess(request.RequestId,TerminalQueryTranslator.ResourceCode(request.Resource),now,0,"unavailable",data,null,false);
   }
  }
 }
}
