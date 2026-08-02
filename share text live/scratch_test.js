const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/?room=test');

ws.on('open', () => {
  console.log('Connected');
  
  // 1. Send small message
  ws.send(JSON.stringify({
    type: "create",
    text: "small text",
    expiresInMs: 120000
  }));
  
  // 2. Send large message (1MB)
  const largeText = "A".repeat(1024 * 1024);
  ws.send(JSON.stringify({
    type: "create",
    text: largeText,
    expiresInMs: 120000
  }));
  
  console.log('Sent both messages');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === "messages") {
    console.log("Received messages broadcast. Count:", msg.messages.length);
    if (msg.messages.length > 0) {
       const latest = msg.messages[msg.messages.length - 1];
       console.log("Latest message length:", latest.text.length);
    }
  }
});

ws.on('error', console.error);
ws.on('close', () => console.log('Disconnected'));
