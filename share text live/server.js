const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_TEXT_LENGTH = 5000000; // ~5MB to support encrypted file uploads
const MAX_AUTHOR_NAME = 50;
const DEFAULT_EXPIRES_IN_MS = 2 * 60 * 1000;
const ALLOWED_EXPIRES_IN_MS = new Set([10 * 1000, 30 * 1000, DEFAULT_EXPIRES_IN_MS, 10 * 60 * 1000, 0]);
const TYPING_STALE_MS = 4500;

const clients = new Map();
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml"
};

function requestOrigin(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  const protocol = req.headers["x-forwarded-proto"] || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}

function sendJson(socket, payload) {
  if (socket.destroyed) return;

  const message = Buffer.from(JSON.stringify(payload));
  const header = [];

  header.push(0x81);

  if (message.length < 126) {
    header.push(message.length);
  } else if (message.length < 65536) {
    header.push(126, (message.length >> 8) & 255, message.length & 255);
  } else {
    header.push(
      127,
      0,
      0,
      0,
      0,
      (message.length >> 24) & 255,
      (message.length >> 16) & 255,
      (message.length >> 8) & 255,
      message.length & 255
    );
  }

  socket.write(Buffer.concat([Buffer.from(header), message]));
}

function normalizeRoomId(value) {
  const roomId = String(value || "public").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
  return roomId || "public";
}

function getRoom(roomId) {
  const id = normalizeRoomId(roomId);

  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      messages: [],
      typingDrafts: new Map(),
      pinnedMessageId: null
    });
  }

  return rooms.get(id);
}

function clientsInRoom(roomId) {
  return Array.from(clients.values()).filter((client) => client.roomId === roomId);
}

function broadcastToRoom(roomId, payload) {
  for (const { socket } of clientsInRoom(roomId)) {
    sendJson(socket, payload);
  }
}

function broadcastPresence(roomId) {
  const roomClients = clientsInRoom(roomId);

  broadcastToRoom(roomId, {
    type: "presence",
    roomId,
    count: roomClients.length,
    users: roomClients.map((client) => ({
      id: client.id,
      name: client.name,
      color: client.color
    }))
  });
}

function activeMessages(room) {
  const now = Date.now();
  return room.messages.filter((message) => !message.expiresAt || message.expiresAt > now);
}

function broadcastMessages(room) {
  removeExpiredMessages(room);
  // Ensure pinned message still exists
  if (room.pinnedMessageId && !room.messages.find(m => m.id === room.pinnedMessageId)) {
    room.pinnedMessageId = null;
  }
  
  broadcastToRoom(room.id, {
    type: "messages",
    roomId: room.id,
    messages: activeMessages(room),
    pinnedMessageId: room.pinnedMessageId,
    serverTime: Date.now()
  });
}

function activeTypingDrafts(room) {
  const now = Date.now();

  for (const [id, draft] of room.typingDrafts.entries()) {
    if (now - draft.updatedAt > TYPING_STALE_MS) {
      room.typingDrafts.delete(id);
    }
  }

  return Array.from(room.typingDrafts.values());
}

function broadcastTyping(room) {
  broadcastToRoom(room.id, { type: "typing", roomId: room.id, drafts: activeTypingDrafts(room) });
}

function tryParseFrame(buffer) {
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) === 0x80;
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
  if (masked) {
    mask = buffer.subarray(offset - 4, offset);
  }

  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = masked ? buffer[offset + index] ^ mask[index % 4] : buffer[offset + index];
  }

  let frame = null;
  if (opcode === 8) {
    frame = { type: "close" };
  } else if (opcode === 1 || opcode === 2 || opcode === 0) {
    frame = { type: "data", opcode, payload, fin };
  } else {
    frame = { type: "ignore" };
  }

  return { frame, bytesConsumed: totalFrameLength };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function cleanMessageText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function parseExpiresInMs(value) {
  const expiresInMs = Number(value);
  return ALLOWED_EXPIRES_IN_MS.has(expiresInMs) ? expiresInMs : DEFAULT_EXPIRES_IN_MS;
}

function removeExpiredMessages(room) {
  const now = Date.now();
  let index = room.messages.length - 1;
  let removed = false;

  while (index >= 0) {
    if (room.messages[index].expiresAt && room.messages[index].expiresAt <= now) {
      room.messages.splice(index, 1);
      removed = true;
    }

    index -= 1;
  }

  return removed;
}

function handleClientAction(client, action) {
  if (!action || typeof action !== "object") return;

  const room = getRoom(client.roomId);

  if (action.type === "setName") {
    const nextName = cleanText(action.name).slice(0, 28);
    client.name = nextName || client.name;
    const draft = room.typingDrafts.get(client.id);
    if (draft) draft.authorName = client.name;
    broadcastPresence(room.id);
    broadcastTyping(room);
    return;
  }

  if (action.type === "create") {
    const safeText = String(action.text || "");
    const text = safeText.length > MAX_TEXT_LENGTH ? safeText.slice(0, MAX_TEXT_LENGTH) : safeText;
    if (!text) return;

    const expiresInMs = parseExpiresInMs(action.expiresInMs);
    const createdAt = Date.now();
    const message = {
      id: crypto.randomUUID(),
      text,
      authorId: client.id,
      authorName: client.name,
      authorColor: client.color,
      replyTo: action.replyTo ? String(action.replyTo).slice(0, 36) : null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiresInMs === 0 ? null : createdAt + expiresInMs
    };

    room.messages.push(message);
    room.typingDrafts.delete(client.id);
    broadcastMessages(room);
    broadcastTyping(room);
    return;
  }

  if (action.type === "update") {
    removeExpiredMessages(room);
    const safeUpdateText = String(action.text || "");
    const text = safeUpdateText.length > MAX_TEXT_LENGTH ? safeUpdateText.slice(0, MAX_TEXT_LENGTH) : safeUpdateText;
    const message = room.messages.find((item) => item.id === action.id);
    if (!message || !text) return;

    message.text = text;
    message.updatedAt = Date.now();
    message.editorId = client.id;
    message.editorName = client.name;
    broadcastMessages(room);
    return;
  }

  if (action.type === "typing") {
    const draftText = String(action.text || "");
    const text = draftText.length > MAX_TEXT_LENGTH ? draftText.slice(0, MAX_TEXT_LENGTH) : draftText;

    if (!text) {
      room.typingDrafts.delete(client.id);
    } else {
      room.typingDrafts.set(client.id, {
        id: client.id,
        authorName: client.name,
        authorColor: client.color,
        text: text,
        updatedAt: Date.now()
      });
    }

    broadcastTyping(room);
    return;
  }

  if (action.type === "delete") {
    removeExpiredMessages(room);
    const index = room.messages.findIndex((item) => item.id === action.id);
    if (index === -1) return;

    room.messages.splice(index, 1);
    if (room.pinnedMessageId === action.id) {
      room.pinnedMessageId = null;
    }
    broadcastMessages(room);
    return;
  }

  if (action.type === "pin") {
    if (room.messages.some(m => m.id === action.id)) {
      room.pinnedMessageId = action.id;
      broadcastMessages(room);
    }
    return;
  }

  if (action.type === "unpin") {
    room.pinnedMessageId = null;
    broadcastMessages(room);
    return;
  }

  if (action.type === "clear") {
    if (room.messages.length === 0) return;

    room.messages.length = 0;
    broadcastMessages(room);
  }
}

function serveFile(req, res) {
  const pathname = (req.url || "/").split("?")[0] || "/";
  const requestedPath = pathname === "/" ? "/index.html" : pathname;

  if (requestedPath === "/robots.txt") {
    const origin = requestOrigin(req);
    res.writeHead(200, { "Content-Type": mimeTypes[".txt"] });
    res.end(["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n"));
    return;
  }

  if (requestedPath === "/sitemap.xml") {
    const origin = requestOrigin(req);
    res.writeHead(200, { "Content-Type": mimeTypes[".xml"] });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`);
    return;
  }

  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

const server = http.createServer(serveFile);

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade !== "websocket") {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      ""
    ].join("\r\n")
  );

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const room = getRoom(requestUrl.searchParams.get("room"));
  const id = crypto.randomUUID();
  const client = {
    id,
    socket,
    roomId: room.id,
    name: `Guest ${String(clients.size + 1).padStart(2, "0")}`,
    color: `hsl(${Math.floor(Math.random() * 360)} 70% 45%)`,
    messageBuffer: []
  };

  clients.set(id, client);
  sendJson(socket, {
    type: "hello",
    clientId: id,
    roomId: room.id,
    name: client.name,
    messages: activeMessages(room),
    drafts: activeTypingDrafts(room),
    pinnedMessageId: room.pinnedMessageId,
    serverTime: Date.now()
  });
  broadcastPresence(room.id);

  let dataBuffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    dataBuffer = Buffer.concat([dataBuffer, chunk]);

    while (dataBuffer.length > 0) {
      const parsed = tryParseFrame(dataBuffer);
      if (!parsed) break; // Wait for more data

      dataBuffer = dataBuffer.subarray(parsed.bytesConsumed);

      if (parsed.frame.type === "close") {
        socket.end();
        return;
      }

      if (parsed.frame.type === "data") {
        client.messageBuffer.push(parsed.frame.payload);
        if (parsed.frame.fin) {
          const fullMessage = Buffer.concat(client.messageBuffer);
          client.messageBuffer = [];
          try {
            const data = JSON.parse(fullMessage.toString("utf8"));
            handleClientAction(client, data);
          } catch {
            // Invalid JSON, drop it
          }
        }
      }
    }
  });

  socket.on("close", () => {
    clients.delete(id);
    room.typingDrafts.delete(id);
    broadcastPresence(room.id);
    broadcastTyping(room);
  });

  socket.on("error", () => {
    clients.delete(id);
    room.typingDrafts.delete(id);
    broadcastPresence(room.id);
    broadcastTyping(room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (removeExpiredMessages(room)) {
      broadcastMessages(room);
    }

    const beforeTypingCount = room.typingDrafts.size;
    activeTypingDrafts(room);
    if (room.typingDrafts.size !== beforeTypingCount) {
      broadcastTyping(room);
    }
  }
}, 1000);

server.listen(PORT, HOST, () => {
  console.log(`Share Text Live is running on port ${PORT}`);
});
