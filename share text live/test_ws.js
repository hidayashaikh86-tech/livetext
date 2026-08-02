const http = require('http');
const crypto = require('crypto');
const ws = require('ws');

const server = http.createServer();
server.on("upgrade", (req, socket) => {
  const acceptKey = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey}`, "", ""].join("\r\n"));

  let dataBuffer = Buffer.alloc(0);
  
  function tryParseFrame(buffer) {
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }
    const masked = (buffer[1] & 0x80) === 0x80;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      offset += 4;
    }
    const totalFrameLength = offset + length;
    if (buffer.length < totalFrameLength) return null;
    let mask;
    if (masked) mask = buffer.subarray(offset - 4, offset);
    const payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = masked ? buffer[offset + index] ^ mask[index % 4] : buffer[offset + index];
    }
    let frame = null;
    if (opcode === 8) frame = { type: "close" };
    else if (opcode === 1) {
      try { frame = { type: "message", data: JSON.parse(payload.toString("utf8")) }; } 
      catch (e) { frame = { type: "invalid", error: e.message }; console.log("JSON PARSE ERROR"); }
    } else frame = { type: "ignore", opcode };
    return { frame, bytesConsumed: totalFrameLength };
  }

  socket.on("data", (chunk) => {
    dataBuffer = Buffer.concat([dataBuffer, chunk]);
    while (dataBuffer.length > 0) {
      const parsed = tryParseFrame(dataBuffer);
      if (!parsed) break;
      dataBuffer = dataBuffer.subarray(parsed.bytesConsumed);
      console.log("Parsed frame:", parsed.frame.type, parsed.frame.opcode || "");
      if (parsed.frame.type === "message") console.log("Received valid message of length", JSON.stringify(parsed.frame.data).length);
    }
  });
});
server.listen(3002, () => {
  console.log("Server listening");
  const client = new ws('ws://localhost:3002');
  client.on('open', () => {
    const largeObj = { type: 'create', text: 'A'.repeat(2 * 1024 * 1024) }; // 2MB
    client.send(JSON.stringify(largeObj));
    setTimeout(() => process.exit(0), 1000);
  });
});
