const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' wss: ws: data: blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com; media-src 'self' data: blob:; form-action 'self';"
};

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_TEXT_LENGTH = 12000000; // ~12MB to support encrypted file uploads (5MB raw → ~9MB after double base64)
const DEFAULT_EXPIRES_IN_MS = 2 * 60 * 1000;
const ALLOWED_EXPIRES_IN_MS = new Set([10 * 1000, 30 * 1000, DEFAULT_EXPIRES_IN_MS, 10 * 60 * 1000, 0]);
const TYPING_STALE_MS = 4500;

const RATE_LIMIT_WINDOW_MS = 10000; // 10 seconds
const RATE_LIMIT_MAX_MESSAGES = 40; // max messages per 10s window (supports bulk file uploads)
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_TOTAL_CONNECTIONS = 500;

// Developer admin secret — set via environment variable ADMIN_SECRET
// e.g. ADMIN_SECRET=mysecret node server.js
// Access dashboard: /admin (login form — cookie-based session)
// Enter rooms as admin: click "Enter" from dashboard (cookie-based — no secret in URL)
const DEVELOPER_ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// Timing-safe secret comparison (prevents timing attacks that can guess the key character by character)
function safeCompare(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Brute-force protection for /admin endpoint
const adminFailedAttempts = new Map(); // IP -> { count, lastAttempt }
const ADMIN_MAX_FAILED = 5;           // max failed attempts
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minute lockout

const clients = new Map();
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

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

function getRoom(roomId, adminToken = null) {
  const id = normalizeRoomId(roomId);

  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      messages: [],
      typingDrafts: new Map(),
      pinnedMessageId: null,
      adminToken: adminToken || null
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
      color: client.color,
      isDevAdmin: client.isDevAdmin || false
    }))
  });
}

function broadcastNewMessage(room, message) {
  broadcastToRoom(room.id, { type: "newMessage", message });
}

function broadcastUpdateMessage(room, message) {
  broadcastToRoom(room.id, { type: "updateMessage", message });
}

function broadcastDeleteMessage(room, messageId) {
  broadcastToRoom(room.id, { type: "deleteMessage", messageId, pinnedMessageId: room.pinnedMessageId });
}

function broadcastPin(room) {
  broadcastToRoom(room.id, { type: "pinMessage", pinnedMessageId: room.pinnedMessageId });
}

function broadcastClearMessages(room) {
  broadcastToRoom(room.id, { type: "clearMessages" });
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
  
  // Rate limiting: Separate lightweight typing events from state-modifying actions
  const now = Date.now();
  if (action.type === "typing") {
    client.typingTimestamps = (client.typingTimestamps || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (client.typingTimestamps.length >= 60) {
      return; // Silently drop excessive typing updates without error toast
    }
    client.typingTimestamps.push(now);
  } else {
    client.rateLimitTimestamps = (client.rateLimitTimestamps || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (client.rateLimitTimestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      sendJson(client.socket, { type: 'error', message: 'Rate limited. Please slow down.' });
      return;
    }
    client.rateLimitTimestamps.push(now);
  }

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
    if (safeText.length > MAX_TEXT_LENGTH) {
      sendJson(client.socket, { type: 'error', message: 'Message too large. Maximum file size is 5MB.' });
      return;
    }
    const text = safeText;
    if (!text) return;

    const expiresInMs = parseExpiresInMs(action.expiresInMs);
    const createdAt = Date.now();
    const message = {
      id: crypto.randomUUID(),
      text,
      authorId: client.id,
      authorName: client.name,
      authorColor: client.color,
      isDevAdmin: client.isDevAdmin || false,
      replyTo: action.replyTo ? String(action.replyTo).slice(0, 36) : null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiresInMs === 0 ? createdAt + 6 * 60 * 60 * 1000 : createdAt + expiresInMs
    };

    room.messages.push(message);
    const MAX_MESSAGES_PER_ROOM = 200;
    while (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.shift();
    }
    room.typingDrafts.delete(client.id);
    broadcastNewMessage(room, message);
    broadcastTyping(room);
    return;
  }

  if (action.type === "update") {
    removeExpiredMessages(room);
    const safeUpdateText = String(action.text || "");
    if (safeUpdateText.length > MAX_TEXT_LENGTH) {
      sendJson(client.socket, { type: 'error', message: 'Message too large. Maximum file size is 5MB.' });
      return;
    }
    const text = safeUpdateText;
    const message = room.messages.find((item) => item.id === action.id);
    if (!message || !text) return;
    if (message.authorId !== client.id) return; // Only author can edit
    
    const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
    if (Date.now() - message.createdAt > EDIT_WINDOW_MS) return; // Edit window expired

    message.text = text;
    message.updatedAt = Date.now();
    message.editorId = client.id;
    message.editorName = client.name;
    broadcastUpdateMessage(room, message);
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
    if (room.messages[index].authorId !== client.id && !client.isAdmin) return; // Only author or admin can delete

    room.messages.splice(index, 1);
    if (room.pinnedMessageId === action.id) {
      room.pinnedMessageId = null;
    }
    broadcastDeleteMessage(room, action.id);
    return;
  }

  if (action.type === "pin") {
    if (room.messages.some(m => m.id === action.id)) {
      room.pinnedMessageId = action.id;
      broadcastPin(room);
    }
    return;
  }

  if (action.type === "unpin") {
    room.pinnedMessageId = null;
    broadcastPin(room);
    return;
  }

  if (action.type === "clear") {
    if (room.id === "public") return; // Public room cannot be cleared
    if (room.adminToken && !client.isAdmin) return; // Only admin can clear private rooms with an admin

    if (room.messages.length === 0) return;

    room.messages.length = 0;
    room.pinnedMessageId = null;
    broadcastClearMessages(room);
  }
}

function serveFile(req, res) {
  const pathname = (req.url || "/").split("?")[0] || "/";
  const requestedPath = pathname === "/" ? "/index.html" : pathname;

  if (requestedPath === "/health" || requestedPath === "/ping") {
    res.writeHead(200, { 'Content-Type': mimeTypes['.txt'], ...SECURITY_HEADERS });
    res.end("OK");
    return;
  }

  // Admin Action: Force delete a room (cookie-authenticated)
  if (requestedPath === "/admin/action") {
    const urlParams = new URL(req.url || "/admin/action", `http://${req.headers.host || "localhost"}`);
    const action = urlParams.searchParams.get("action");
    const targetRoom = urlParams.searchParams.get("room");
    const cookieHeader = req.headers.cookie || '';
    const adminCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('shareli_admin='));
    const tokenValue = adminCookie ? decodeURIComponent(adminCookie.split('=').slice(1).join('=')) : '';

    // Reuse verifyAdminToken (defined in /admin route below, but we need inline check here)
    let actionAuthed = false;
    if (DEVELOPER_ADMIN_SECRET && tokenValue) {
      const parts = tokenValue.split(':');
      if (parts.length === 3) {
        const [prefix, expiresStr, signature] = parts;
        if (prefix === 'admin') {
          const expires = parseInt(expiresStr, 10);
          if (!isNaN(expires) && Date.now() <= expires) {
            const expectedSig = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(`${prefix}:${expiresStr}`).digest('hex');
            actionAuthed = safeCompare(signature, expectedSig);
          }
        }
      }
    }

    if (!actionAuthed) {
      res.writeHead(403, SECURITY_HEADERS);
      res.end("Forbidden");
      return;
    }

    if (action === "deleteRoom" && targetRoom && targetRoom !== "public") {
      const room = rooms.get(targetRoom);
      if (room) {
        broadcastToRoom(targetRoom, { type: "clearMessages" });
        broadcastToRoom(targetRoom, { type: "error", message: "This room has been closed by the administrator." });
        room.messages.length = 0;
        rooms.delete(targetRoom);
      }
    }

    res.writeHead(302, { 'Location': '/admin', ...SECURITY_HEADERS });
    res.end();
    return;
  }

  // Admin Enter Room: Sets a dev-mode cookie and redirects to room (no secret in URL ever)
  if (requestedPath === "/admin/enter") {
    const urlParams = new URL(req.url || "/admin/enter", `http://${req.headers.host || "localhost"}`);
    const targetRoom = urlParams.searchParams.get("room") || "public";
    const cookieHeader = req.headers.cookie || '';
    const adminCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('shareli_admin='));
    const tokenValue = adminCookie ? decodeURIComponent(adminCookie.split('=').slice(1).join('=')) : '';

    // Verify admin session (same logic as /admin/action)
    let isAuthed = false;
    if (DEVELOPER_ADMIN_SECRET && tokenValue) {
      const parts = tokenValue.split(':');
      if (parts.length === 3) {
        const [prefix, expiresStr, signature] = parts;
        if (prefix === 'admin') {
          const expires = parseInt(expiresStr, 10);
          if (!isNaN(expires) && Date.now() <= expires) {
            const expectedSig = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(`${prefix}:${expiresStr}`).digest('hex');
            isAuthed = safeCompare(signature, expectedSig);
          }
        }
      }
    }

    if (!isAuthed) {
      res.writeHead(302, { 'Location': '/admin', ...SECURITY_HEADERS });
      res.end();
      return;
    }

    // Generate a dev-mode token (HMAC-signed, 2 hour expiry) for WebSocket auth
    const devExpires = Date.now() + 2 * 60 * 60 * 1000;
    const devPayload = `dev:${devExpires}`;
    const devSignature = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(devPayload).digest('hex');
    const devToken = `${devPayload}:${devSignature}`;
    const isSecure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

    // Build redirect URL
    const redirectUrl = targetRoom === "public" ? "/" : `/?room=${encodeURIComponent(targetRoom)}`;

    res.writeHead(302, {
      'Location': redirectUrl,
      'Set-Cookie': `shareli_dev_mode=${encodeURIComponent(devToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200${isSecure ? '; Secure' : ''}`,
      ...SECURITY_HEADERS
    });
    res.end();
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ADMIN AUTHENTICATION — Cookie-based (key never appears in URL/history)
  // ═══════════════════════════════════════════════════════════════

  // Helper: generate a time-limited admin session token
  function generateAdminToken() {
    const expires = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
    const payload = `admin:${expires}`;
    const signature = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(payload).digest('hex');
    return `${payload}:${signature}`;
  }

  // Helper: verify admin session token from cookie
  function verifyAdminToken(token) {
    if (!token || !DEVELOPER_ADMIN_SECRET) return false;
    const parts = token.split(':');
    if (parts.length !== 3) return false;
    const [prefix, expiresStr, signature] = parts;
    if (prefix !== 'admin') return false;
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires) || Date.now() > expires) return false;
    const expectedSig = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(`${prefix}:${expiresStr}`).digest('hex');
    return safeCompare(signature, expectedSig);
  }

  // Helper: parse cookies from request
  function parseCookies(req) {
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(c => {
      const [key, ...val] = c.trim().split('=');
      if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
    });
    return cookies;
  }

  // Admin Login: POST form submission (key never in URL)
  if (requestedPath === "/admin/login" && req.method === "POST") {
    const reqIp = req.socket.remoteAddress || 'unknown';

    // Brute-force check
    const attempt = adminFailedAttempts.get(reqIp);
    if (attempt && attempt.count >= ADMIN_MAX_FAILED && (Date.now() - attempt.lastAttempt) < ADMIN_LOCKOUT_MS) {
      res.writeHead(429, { 'Content-Type': mimeTypes['.html'], ...SECURITY_HEADERS });
      res.end("<!DOCTYPE html><html><body style='font-family:monospace;padding:40px;background:#0d0d12;color:#ef4444'><h2>429 Too Many Requests</h2><p>Too many failed attempts. Try again in 15 minutes.</p></body></html>");
      return;
    }

    // Read POST body
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      const formData = new URLSearchParams(body);
      const providedKey = formData.get('key') || '';

      if (!DEVELOPER_ADMIN_SECRET || !safeCompare(providedKey, DEVELOPER_ADMIN_SECRET)) {
        const prev = adminFailedAttempts.get(reqIp) || { count: 0, lastAttempt: 0 };
        adminFailedAttempts.set(reqIp, { count: prev.count + 1, lastAttempt: Date.now() });
        res.writeHead(302, { 'Location': '/admin?error=1', ...SECURITY_HEADERS });
        res.end();
        return;
      }

      // Success — set session cookie and redirect
      adminFailedAttempts.delete(reqIp);
      const token = generateAdminToken();
      res.writeHead(302, {
        'Location': '/admin',
        'Set-Cookie': `shareli_admin=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=7200${req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
        ...SECURITY_HEADERS
      });
      res.end();
    });
    return;
  }

  // Admin Logout
  if (requestedPath === "/admin/logout") {
    res.writeHead(302, {
      'Location': '/admin',
      'Set-Cookie': 'shareli_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0',
      ...SECURITY_HEADERS
    });
    res.end();
    return;
  }

  // Developer Admin Dashboard
  if (requestedPath === "/admin") {
    const cookies = parseCookies(req);
    const isAuthenticated = verifyAdminToken(cookies.shareli_admin);
    const urlParams = new URL(req.url || "/admin", `http://${req.headers.host || "localhost"}`);
    const hasError = urlParams.searchParams.get("error") === "1";

    // Not authenticated — show login form
    if (!isAuthenticated) {
      const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shareli — Admin Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#0d0d12;color:#f0f0f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
    .login-box{background:#1a1a24;border:1px solid #333344;border-radius:16px;padding:40px;max-width:380px;width:100%}
    h1{font-size:1.3rem;font-weight:700;margin-bottom:4px;text-align:center}
    .subtitle{color:#9ba1a6;font-size:0.82rem;margin-bottom:28px;text-align:center}
    label{font-size:0.78rem;font-weight:600;color:#9ba1a6;text-transform:uppercase;letter-spacing:0.04em;display:block;margin-bottom:6px}
    input[type="password"]{width:100%;padding:12px 16px;background:#232330;border:1px solid #333344;border-radius:10px;color:#f0f0f5;font-size:0.95rem;outline:none;transition:border 0.2s}
    input[type="password"]:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,0.15)}
    button{width:100%;padding:12px;margin-top:16px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:0.9rem;font-weight:700;border:none;border-radius:10px;cursor:pointer;transition:opacity 0.2s}
    button:hover{opacity:0.9}
    .error{color:#ef4444;font-size:0.82rem;margin-top:12px;text-align:center}
    .badge{display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:0.6rem;font-weight:800;padding:2px 8px;border-radius:4px;margin-left:6px;vertical-align:middle}
    .lock{font-size:2rem;text-align:center;margin-bottom:12px}
  </style>
</head>
<body>
  <div class="login-box">
    <div class="lock">🔐</div>
    <h1>Shareli <span class="badge">ADMIN</span></h1>
    <p class="subtitle">Enter your admin secret key to continue.</p>
    <form method="POST" action="/admin/login" autocomplete="off">
      <label for="key">Admin Secret Key</label>
      <input type="password" id="key" name="key" placeholder="Enter your secret key" required autofocus>
      <button type="submit">Sign In</button>
    </form>
    ${hasError ? '<p class="error">❌ Invalid key. Please try again.</p>' : ''}
  </div>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': mimeTypes['.html'], ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
      res.end(loginHtml);
      return;
    }

    // Authenticated — show dashboard

    const totalUsers = clients.size;
    const totalRooms = rooms.size;
    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;
    const memUsage = process.memoryUsage();
    const memMB = (memUsage.rss / 1024 / 1024).toFixed(1);

    // Escape HTML to prevent XSS in admin dashboard
    const escHtml = (str) => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const roomRows = Array.from(rooms.entries()).map(([id, room]) => {
      const userCount = clientsInRoom(id).length;
      const msgCount = room.messages.length;
      const enterBtn = `<a href="/admin/enter?room=${encodeURIComponent(id)}" style="color:#10b981;text-decoration:none;font-size:0.8rem;font-weight:600" title="Enter as dev admin">▶ Enter</a>`;
      const deleteBtn = id !== 'public' 
        ? `<a href="/admin/action?action=deleteRoom&room=${encodeURIComponent(id)}" onclick="return confirm('Delete room ${escHtml(id)}? All users will be disconnected.')" style="color:#ef4444;text-decoration:none;font-size:0.8rem;font-weight:600">✕ Delete</a>`
        : ``;
      return `<tr><td style='padding:8px 12px;border-bottom:1px solid #333'>${escHtml(id)}</td><td style='padding:8px 12px;border-bottom:1px solid #333;text-align:center'>${userCount}</td><td style='padding:8px 12px;border-bottom:1px solid #333;text-align:center'>${msgCount}</td><td style='padding:8px 12px;border-bottom:1px solid #333;color:${room.adminToken ? "#10b981" : "#9ba1a6"}'>${room.adminToken ? "🔒 Private" : "🌐 Public"}</td><td style='padding:8px 12px;border-bottom:1px solid #333;text-align:center'>${enterBtn}${deleteBtn ? ' · ' + deleteBtn : ''}</td></tr>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shareli — Admin Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#0d0d12;color:#f0f0f5;padding:32px;min-height:100vh}
    h1{font-size:1.6rem;font-weight:700;margin-bottom:4px}
    .subtitle{color:#9ba1a6;font-size:0.85rem;margin-bottom:32px}
    .badge{display:inline-block;background:#6366f1;color:#fff;font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:4px;margin-left:8px;vertical-align:middle}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:32px}
    .stat-card{background:#1a1a24;border:1px solid #333344;border-radius:12px;padding:20px}
    .stat-label{font-size:0.75rem;color:#9ba1a6;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px}
    .stat-value{font-size:2rem;font-weight:700;color:#f0f0f5}
    .stat-unit{font-size:0.85rem;color:#9ba1a6;margin-left:4px}
    h2{font-size:1.1rem;font-weight:600;margin-bottom:12px;color:#f0f0f5}
    table{width:100%;border-collapse:collapse;background:#1a1a24;border:1px solid #333344;border-radius:12px;overflow:hidden}
    thead{background:#232330}
    th{padding:10px 12px;text-align:left;font-size:0.78rem;font-weight:600;color:#9ba1a6;text-transform:uppercase;letter-spacing:0.04em}
    td{color:#f0f0f5;font-size:0.9rem}
    .empty{color:#9ba1a6;font-style:italic;padding:20px;text-align:center}
    .refresh{margin-top:24px;color:#9ba1a6;font-size:0.8rem}
    .refresh a{color:#6366f1;text-decoration:none}
    .tag{font-size:0.65rem;font-weight:700;padding:2px 6px;border-radius:4px;background:#6366f130;color:#818cf8;margin-left:8px}
  </style>
</head>
<body>
  <h1>🛡️ Shareli <span class="badge">DEV ADMIN</span></h1>
  <p class="subtitle">Server Admin Dashboard — Only you can see this page. No message content is exposed.</p>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-label">Active Users</div>
      <div class="stat-value">${totalUsers}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Active Rooms</div>
      <div class="stat-value">${totalRooms}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Server Uptime</div>
      <div class="stat-value" style="font-size:1.2rem;padding-top:8px">${uptimeStr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">RAM Usage</div>
      <div class="stat-value">${memMB}<span class="stat-unit">MB</span></div>
    </div>
  </div>

  <h2>Active Rooms</h2>
  ${totalRooms === 0 ? `<div class="empty">No active rooms right now.</div>` : `
  <table>
    <thead>
      <tr>
        <th>Room ID</th>
        <th style="text-align:center">Users</th>
        <th style="text-align:center">Messages</th>
        <th>Type</th>
        <th style="text-align:center">Action</th>
      </tr>
    </thead>
    <tbody>${roomRows}</tbody>
  </table>`}

  <p class="refresh">Auto-refreshes every 30s — <a href="/admin">Refresh now</a> · <a href="/admin/logout" style="color:#ef4444">Logout</a></p>
</body>
</html>`;

    // Add meta refresh tag inside <head> to avoid CSP inline script violation
    const finalHtml = html.replace('</head>', `  <meta http-equiv="refresh" content="30">\n</head>`);

    res.writeHead(200, { 'Content-Type': mimeTypes['.html'], ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
    res.end(finalHtml);
    return;
  }

  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end("Not found");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    
    // Ensure service worker, HTML, sitemap, and robots are never HTTP-cached
    const cacheHeaders = (filePath.endsWith('sw.js') || filePath.endsWith('.html') || filePath.endsWith('.xml') || filePath.endsWith('.txt')) 
      ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
      : {};

    res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS, ...cacheHeaders });
    res.end(content);
  });
}

const server = http.createServer(serveFile);

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade !== "websocket") {
    socket.destroy();
    return;
  }

  // Connection limits
  const clientIp = req.socket.remoteAddress || 'unknown';
  if (clients.size >= MAX_TOTAL_CONNECTIONS) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }
  const ipCount = Array.from(clients.values()).filter(c => c.ip === clientIp).length;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
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
  const providedAdminToken = requestUrl.searchParams.get("adminToken");
  const providedDevSecret = requestUrl.searchParams.get("devAdmin");
  const room = getRoom(requestUrl.searchParams.get("room"), providedAdminToken);
  const sessionId = requestUrl.searchParams.get("sessionId");
  const id = sessionId ? crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16) : crypto.randomUUID();
  
  // Developer admin: check via cookie first (secure), then URL param (legacy fallback)
  let isDevAdmin = false;
  if (DEVELOPER_ADMIN_SECRET) {
    // Method 1: Cookie-based (set by /admin/enter — no secret in URL)
    const cookieHeader = req.headers.cookie || '';
    const devCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('shareli_dev_mode='));
    if (devCookie) {
      const devToken = decodeURIComponent(devCookie.split('=').slice(1).join('='));
      const parts = devToken.split(':');
      if (parts.length === 3 && parts[0] === 'dev') {
        const expires = parseInt(parts[1], 10);
        if (!isNaN(expires) && Date.now() <= expires) {
          const expectedSig = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(`dev:${parts[1]}`).digest('hex');
          isDevAdmin = safeCompare(parts[2], expectedSig);
        }
      }
    }
    // Method 2: URL param fallback (for localStorage-based legacy flow)
    if (!isDevAdmin && providedDevSecret) {
      isDevAdmin = safeCompare(providedDevSecret, DEVELOPER_ADMIN_SECRET);
    }
  }
  // Room admin: verified via room-specific adminToken
  const isAdmin = isDevAdmin || ((room.id !== 'public' && room.adminToken && room.adminToken === providedAdminToken) ? true : false);
  
  const client = {
    id,
    socket,
    ip: clientIp,
    roomId: room.id,
    name: `Guest ${String(clients.size + 1).padStart(2, "0")}`,
    color: `hsl(${Math.floor(Math.random() * 360)} 70% 45%)`,
    messageBuffer: [],
    rateLimitTimestamps: [],
    isAdmin,
    isDevAdmin
  };

  clients.set(id, client);
  sendJson(socket, {
    type: "hello",
    clientId: id,
    roomId: room.id,
    name: client.name,
    drafts: activeTypingDrafts(room),
    pinnedMessageId: room.pinnedMessageId,
    serverTime: Date.now(),
    isAdmin: client.isAdmin,
    isDevAdmin: client.isDevAdmin,
    hasAdmin: !!room.adminToken
  });

  const historyMsgs = activeMessages(room);
  historyMsgs.forEach(msg => {
    sendJson(socket, {
      type: "history",
      message: msg
    });
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

    // Clean up empty rooms with no connected users
    if (room.id !== 'public' && room.messages.length === 0 && clientsInRoom(room.id).length === 0) {
      rooms.delete(room.id);
    }
  }
}, 1000);

server.listen(PORT, HOST, () => {
  console.log(`Share Text Live is running on port ${PORT}`);
});
