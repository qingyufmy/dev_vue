using System;
using System.Collections.Generic;
using Liangjian.BridgeV4.Runtime;
namespace Liangjian.BridgeV4.SmokeTests {
 internal static partial class SessionLifecycleSmokeTests {
  public static void TestAccountStream() {
   string root=NewRoot("account-stream");
   try { using(var runtime=Runtime(root)) {
    var stream=new BridgeAccountStream(runtime);
    Assert(stream.Create(Now)==null,"missing_account_published");
    var data=new Dictionary<string,object>{{"balance","9007199254740993.12"},{"equity","99.10"},{"margin","0"},{"free_margin","-1.25"},{"profit","-2.10"},{"currency","USD"},{"leverage",100},{"trade_allowed",false}};
    stream.Observe(data,Now);
    var envelope=Parse(stream.Create(Now));
    Assert((string)Object(envelope,"route")["terminal_instance_id"]=="terminal-a","wrong_route");
    var payload=Object(envelope,"payload");
    var item=(IDictionary<string,object>)((object[])payload["upserts"])[0];
    Assert((string)item["balance"]=="9007199254740993.12" && !(bool)item["trade_permission"],"money_or_permission_changed");
    Assert(stream.Create(Now+1)==null,"observation_resent");
    Controller(runtime).Begin(Now+2);
    Assert(stream.Create(Now+2)!=null,"reconnect_not_republished");
    data["profit"]=-1.9300000000000002;
    stream.Observe(data,Now+3);
    var rounded=(IDictionary<string,object>)((object[])Object(Parse(stream.Create(Now+3)),"payload")["upserts"])[0];
    Assert((string)rounded["floating_profit"]=="-1.93","binary_float_exceeded_contract_scale");
    stream.Observe(data,Now+3);
    Assert(stream.Create(Now+26000)==null,"stale_snapshot_published");
   }} finally {DeleteRoot(root);}
  }
 }
}
