import('ws').then(({ default: WebSocket }) => {
  import('jsonwebtoken').then(({ default: jwt }) => {
    const token = jwt.sign({userId: 3}, 'wall-street-skill-secret');
    console.log('Connecting as bridge...');
    const ws = new WebSocket('ws://localhost:3000/aurum-api/bridge/ws?type=bridge&token=' + token);
    ws.on('open', () => {
      console.log('Bridge connected!');
      const data = JSON.stringify({type:'data', account:{login:123,balance:1000}, quote:{symbol:'XAUUSD',bid:2000,ask:2001}, positions:[]});
      ws.send(data);
      console.log('Sent data message');
      setTimeout(() => {
        ws.send(JSON.stringify({type:'hb'}));
        console.log('Sent heartbeat');
      }, 1000);
      setTimeout(() => {
        ws.close();
        console.log('Test complete - bridge stayed connected for 5s');
        process.exit(0);
      }, 5000);
    });
    ws.on('message', (d) => console.log('Server says:', d.toString().substring(0, 200)));
    ws.on('close', (code, reason) => {
      console.log('BRIDGE CLOSED!', code, reason.toString());
      process.exit(1);
    });
    ws.on('error', (e) => console.log('Error:', e.message));
  });
});
