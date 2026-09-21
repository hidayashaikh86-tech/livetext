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

// Anti-Spam Configuration
const SPAM_TEXT_WINDOW_MS = 10000;          // 10-second sliding window for text messages
const SPAM_TEXT_MAX = 12;                   // Max text messages per 10s window
const SPAM_FILE_WINDOW_MS = 30000;          // 30-second sliding window for file messages
const SPAM_FILE_MAX = 15;                   // Max file messages per 30s window
const SPAM_MUTE_DURATIONS = [60000, 120000]; // Escalating: 1st mute = 60s, 2nd+ mute = 120s
const MAX_CONNECTIONS_PER_IP = 200; // High limit to allow college/office NAT networks and multiple tabs
const MAX_TOTAL_CONNECTIONS = 2000;

// Helper to get real client IP, respecting Cloudflare & reverse proxies (Render, NGINX)
function getRequestIp(req) {
  if (req && req.headers) {
    if (req.headers['cf-connecting-ip']) {
      return req.headers['cf-connecting-ip'].trim();
    }
    const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
    if (forwarded) {
      return String(forwarded).split(',')[0].trim();
    }
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

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

// Daily unique visitor tracking (resets each day)
let dailyVisitors = new Set();
let dailyVisitorDate = new Date().toDateString();

function trackVisitor(ip) {
  const today = new Date().toDateString();
  if (today !== dailyVisitorDate) {
    dailyVisitors = new Set();
    dailyVisitorDate = today;
  }
  dailyVisitors.add(ip);
}

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
      adminToken: adminToken || null,
      createdAt: Date.now()
    });
  }

  const room = rooms.get(id);

  // Safe upgrade: if room was just auto-created as public (no messages, no users)
  // and now the real creator provides an adminToken, upgrade it to Private.
  // Never upgrade an active public room (has messages or users) — prevents hijacking.
  if (!room.adminToken && adminToken && room.messages.length === 0 && clientsInRoom(id).length === 0) {
    room.adminToken = adminToken;
  }

  return room;
}

function clientsInRoom(roomId) {
  return Array.from(clients.values()).filter((client) => client.roomId === roomId);
}

function broadcastToRoom(roomId, payload) {
  for (const { socket } of clientsInRoom(roomId)) {
    sendJson(socket, payload);
  }
}

function broadcastToAll(payload) {
  for (const client of clients.values()) {
    if (client.socket && client.socket.writable) {
      sendJson(client.socket, payload);
    }
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
  
  // Heartbeat ping: Keep connection alive through college/corporate proxies and sync server clock
  if (action.type === "ping") {
    sendJson(client.socket, { type: "pong", serverTime: Date.now() });
    return;
  }

  // Anti-Spam: Typing events have their own lightweight limiter
  const now = Date.now();
  if (action.type === "typing") {
    client.typingTimestamps = (client.typingTimestamps || []).filter(t => now - t < SPAM_TEXT_WINDOW_MS);
    if (client.typingTimestamps.length >= 60) {
      return; // Silently drop excessive typing updates
    }
    client.typingTimestamps.push(now);
  }

  // Anti-Spam: Check if user is currently muted (applies to create/update/delete/clear actions)
  if (action.type === "create" || action.type === "update" || action.type === "delete" || action.type === "clear") {
    if (client.mutedUntil > now) {
      const remainingSec = Math.ceil((client.mutedUntil - now) / 1000);
      sendJson(client.socket, {
        type: 'muted',
        message: `You are muted. ${remainingSec} seconds remaining.`,
        mutedUntil: client.mutedUntil
      });
      return;
    }
  }

  // Anti-Spam: Rate check on 'create' messages (only DevAdmin is exempt — room admins are not)
  if (action.type === "create" && !client.isDevAdmin) {
    const safeText = String(action.text || "");
    const isFileMessage = safeText.length > 50000; // Encrypted files are >50KB

    if (isFileMessage) {
      // File counter: 15 per 30 seconds
      client.spamFileTimestamps = client.spamFileTimestamps.filter(t => now - t < SPAM_FILE_WINDOW_MS);
      if (client.spamFileTimestamps.length >= SPAM_FILE_MAX) {
        sendJson(client.socket, { type: 'error', message: 'Too many files. Please wait a moment.' });
        return;
      }
      client.spamFileTimestamps.push(now);
    } else {
      // Text counter: 12 per 10 seconds
      client.spamTextTimestamps = client.spamTextTimestamps.filter(t => now - t < SPAM_TEXT_WINDOW_MS);
      if (client.spamTextTimestamps.length >= SPAM_TEXT_MAX) {
        // STRIKE SYSTEM
        client.spamWarnings++;

        if (client.spamWarnings >= 2) {
          // STRIKE 2: MUTE + DELETE all messages from this user
          const muteDuration = SPAM_MUTE_DURATIONS[Math.min(client.muteCount, SPAM_MUTE_DURATIONS.length - 1)];
          client.mutedUntil = now + muteDuration;
          client.muteCount++;
          client.spamWarnings = 0;
          client.spamTextTimestamps = [];

          // Delete all messages from this spammer in the room
          const room = getRoom(client.roomId);
          const spammerMsgIds = room.messages.filter(m => m.authorId === client.id).map(m => m.id);
          room.messages = room.messages.filter(m => m.authorId !== client.id);

          // Broadcast deletion to all clients
          for (const msgId of spammerMsgIds) {
            broadcastDeleteMessage(room, msgId);
          }

          // Broadcast system notice to ALL users in the room
          broadcastToRoom(room.id, {
            type: 'systemNotice',
            message: `${client.name} was muted for spamming.`
          });

          // Tell the spammer they are muted
          const muteSec = Math.ceil(muteDuration / 1000);
          sendJson(client.socket, {
            type: 'muted',
            message: `You have been muted for ${muteSec} seconds. All your messages have been removed.`,
            mutedUntil: client.mutedUntil
          });
          return;
        }

        // STRIKE 1: Warning only
        sendJson(client.socket, { type: 'error', message: '⚠️ Slow down! You are sending too fast.' });
        return;
      }
      client.spamTextTimestamps.push(now);
    }
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

// ═══════════════════════════════════════════════════════════════
//  ADMIN AUTHENTICATION & SESSION HELPERS
// ═══════════════════════════════════════════════════════════════

function parseCookies(req) {
  const cookieHeader = (req && req.headers && req.headers.cookie) || '';
  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

function generateAdminToken() {
  const expires = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
  const payload = `admin:${expires}`;
  const signature = crypto.createHmac('sha256', DEVELOPER_ADMIN_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

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

function serveFile(req, res) {
  const pathname = (req.url || "/").split("?")[0] || "/";
  const requestedPath = pathname === "/" ? "/index.html" : pathname;

  // Track unique daily visitors on main page load
  if (requestedPath === "/index.html") {
    trackVisitor(getRequestIp(req));
  }

  if (requestedPath === "/health" || requestedPath === "/ping") {
    res.writeHead(200, { 'Content-Type': mimeTypes['.txt'], ...SECURITY_HEADERS });
    res.end("OK");
    return;
  }

  // Admin Actions: Force delete room, clear chat, prune empty rooms, broadcast announcement
  if (requestedPath === "/admin/action") {
    const cookies = parseCookies(req);
    if (!verifyAdminToken(cookies.shareli_admin)) {
      res.writeHead(403, SECURITY_HEADERS);
      res.end("Forbidden");
      return;
    }

    const processAction = (action, params) => {
      let successMsg = "done";
      if (action === "deleteRoom") {
        const targetRoom = params.get("room");
        if (targetRoom && targetRoom !== "public") {
          const room = rooms.get(targetRoom);
          if (room) {
            broadcastToRoom(targetRoom, { type: "clearMessages" });
            broadcastToRoom(targetRoom, { type: "error", message: "This room has been closed by the administrator." });
            room.messages.length = 0;
            rooms.delete(targetRoom);
            successMsg = "deleted";
          }
        }
      } else if (action === "clearChat") {
        const targetRoom = params.get("room");
        if (targetRoom) {
          const room = rooms.get(targetRoom);
          if (room && room.messages.length > 0) {
            room.messages.length = 0;
            room.pinnedMessageId = null;
            broadcastToRoom(targetRoom, { type: "clearMessages" });
            successMsg = "cleared";
          }
        }
      } else if (action === "pruneRooms") {
        let pruned = 0;
        for (const [id, r] of rooms.entries()) {
          if (id !== "public" && clientsInRoom(id).length === 0) {
            rooms.delete(id);
            pruned++;
          }
        }
        successMsg = `pruned_${pruned}`;
      } else if (action === "broadcast") {
        const msg = String(params.get("message") || "").trim().slice(0, 300);
        if (msg) {
          broadcastToAll({ type: "error", message: `📢 [Admin Announcement]: ${msg}` });
          successMsg = "broadcasted";
        }
      }

      res.writeHead(302, { 'Location': `/admin?success=${encodeURIComponent(successMsg)}`, ...SECURITY_HEADERS });
      res.end();
    };

    if (req.method === "POST") {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        const formData = new URLSearchParams(body);
        const action = formData.get("action");
        processAction(action, formData);
      });
      return;
    }

    const urlParams = new URL(req.url || "/admin/action", `http://${req.headers.host || "localhost"}`).searchParams;
    const action = urlParams.get("action");
    processAction(action, urlParams);
    return;
  }

  // Admin Enter Room: Sets a dev-mode cookie and redirects to room (no secret in URL ever)
  if (requestedPath === "/admin/enter") {
    const cookies = parseCookies(req);
    if (!verifyAdminToken(cookies.shareli_admin)) {
      res.writeHead(302, { 'Location': '/admin', ...SECURITY_HEADERS });
      res.end();
      return;
    }

    const urlParams = new URL(req.url || "/admin/enter", `http://${req.headers.host || "localhost"}`);
    const targetRoom = urlParams.searchParams.get("room") || "public";

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

  // Admin Login: POST form submission (key never in URL)
  if (requestedPath === "/admin/login" && req.method === "POST") {
    const reqIp = getRequestIp(req);

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

  // Admin Logout — clear BOTH admin cookies
  if (requestedPath === "/admin/logout") {
    res.writeHead(302, {
      'Location': '/admin',
      'Set-Cookie': [
        'shareli_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0',
        'shareli_dev_mode=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
      ],
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
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#0c0d14;color:#f0f0f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;-webkit-font-smoothing:antialiased}
    .login-box{background:#151622;border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:36px;max-width:380px;width:100%;box-shadow:0 24px 48px rgba(0,0,0,0.5)}
    .logo-badge{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.3rem;margin:0 auto 16px;box-shadow:0 4px 16px rgba(99,102,241,0.35)}
    h1{font-size:1.3rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:4px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px}
    .dev-badge{background:rgba(99,102,241,0.18);border:1px solid rgba(99,102,241,0.35);color:#a5b4fc;font-size:0.68rem;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:0.04em}
    .subtitle{color:#9ba1a6;font-size:0.82rem;margin-bottom:24px;text-align:center;line-height:1.4}
    label{font-size:0.75rem;font-weight:700;color:#9ba1a6;text-transform:uppercase;letter-spacing:0.04em;display:block;margin-bottom:8px}
    input[type="password"]{width:100%;padding:12px 14px;background:#0e0f18;border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#f0f0f5;font-size:0.92rem;outline:none;transition:border-color 0.15s,box-shadow 0.15s}
    input[type="password"]:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,0.18)}
    button{width:100%;padding:12px;margin-top:18px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:0.88rem;font-weight:700;border:none;border-radius:10px;cursor:pointer;transition:opacity 0.15s,transform 0.1s}
    button:hover{opacity:0.92}
    button:active{transform:scale(0.99)}
    .error-msg{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);color:#fca5a5;font-size:0.78rem;font-weight:600;padding:10px 12px;border-radius:8px;margin-top:14px;display:flex;align-items:center;gap:6px}
    .back-link{display:block;text-align:center;margin-top:20px;font-size:0.78rem;color:#9ba1a6;text-decoration:none;transition:color 0.15s}
    .back-link:hover{color:#e2e8f0}
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo-badge">S</div>
    <h1>SHARELI <span class="dev-badge">ADMIN</span></h1>
    <p class="subtitle">Enter your secret key to access the control center.</p>
    <form method="POST" action="/admin/login" autocomplete="off">
      <label for="key">Admin Secret Key</label>
      <input type="password" id="key" name="key" placeholder="Enter developer secret key" required autofocus>
      <button type="submit">Sign In to Dashboard</button>
      ${hasError ? '<div class="error-msg">⚠️ Invalid admin secret key. Please try again.</div>' : ''}
    </form>
    <a href="/" class="back-link">← Return to Shareli Chat</a>
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
    let publicRoomsCount = 0;
    let privateRoomsCount = 0;
    let totalMessages = 0;

    for (const room of rooms.values()) {
      if (room.adminToken) privateRoomsCount++;
      else publicRoomsCount++;
      totalMessages += (room.messages ? room.messages.length : 0);
    }

    const todayVisitors = dailyVisitors.size;
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
    const memUsage = process.memoryUsage();
    const memMB = (memUsage.rss / 1024 / 1024).toFixed(1);
    const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(1);
    const heapPercent = Math.min(100, Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100));
    const userPercent = Math.min(100, Math.round((totalUsers / MAX_TOTAL_CONNECTIONS) * 100));

    let failedLogins = 0;
    for (const attempt of adminFailedAttempts.values()) {
      failedLogins += (attempt.count || 0);
    }

    const now = Date.now();
    let activeMutes = 0;
    for (const client of clients.values()) {
      if (client.mutedUntil && client.mutedUntil > now) activeMutes++;
    }

    const successParam = urlParams.searchParams.get("success");
    let successBanner = "";
    if (successParam === "broadcasted") {
      successBanner = '<div class="alert-success">📢 Global announcement has been broadcasted to all active rooms!</div>';
    } else if (successParam === "deleted") {
      successBanner = '<div class="alert-success">🗑️ The room was successfully terminated and closed.</div>';
    } else if (successParam === "cleared") {
      successBanner = '<div class="alert-success">🧹 All messages in the room were successfully cleared.</div>';
    } else if (successParam && successParam.startsWith("pruned_")) {
      const count = successParam.split("_")[1] || "0";
      successBanner = `<div class="alert-success">✂️ Successfully pruned ${count} inactive empty rooms.</div>`;
    } else if (successParam) {
      successBanner = '<div class="alert-success">✅ Action executed successfully.</div>';
    }

    // Escape HTML to prevent XSS in admin dashboard
    const escHtml = (str) => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // Relative time helper
    function timeAgo(ts) {
      if (!ts) return '—';
      const diff = Date.now() - ts;
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return `${sec}s ago`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ago`;
      const d = Math.floor(hr / 24);
      return `${d}d ago`;
    }

    const roomRows = Array.from(rooms.entries()).map(([id, room]) => {
      const userCount = clientsInRoom(id).length;
      const msgCount = room.messages.length;
      const created = timeAgo(room.createdAt);
      const isPrivate = !!room.adminToken;
      const typeLabel = isPrivate ? 'private' : 'public';
      const typeBadge = isPrivate 
        ? '<span class="badge-pill pill-private">🔒 Private E2EE</span>'
        : '<span class="badge-pill pill-public">🌐 Public</span>';

      const userBadge = userCount > 0
        ? `<span class="badge-pill pill-online"><span class="dot-online"></span>${userCount} online</span>`
        : `<span class="badge-pill pill-muted">0 users</span>`;

      const enterBtn = !isPrivate
        ? `<a href="/admin/enter?room=${encodeURIComponent(id)}" class="btn-table-action btn-enter" title="Enter room as Dev Admin">▶ Enter</a>`
        : '';
      const clearBtn = msgCount > 0
        ? `<a href="/admin/action?action=clearChat&room=${encodeURIComponent(id)}" data-confirm="Clear all ${msgCount} messages in room '${escHtml(id)}'?" class="btn-table-action btn-clear" title="Clear messages">⟳ Clear</a>`
        : '';
      const deleteBtn = id !== 'public'
        ? `<a href="/admin/action?action=deleteRoom&room=${encodeURIComponent(id)}" data-confirm="Terminate room '${escHtml(id)}'? All connected users will be disconnected." class="btn-table-action btn-delete" title="Terminate room">✕ Delete</a>`
        : '';

      const actions = [enterBtn, clearBtn, deleteBtn].filter(Boolean).join(' ');

      return `<tr data-room-id="${escHtml(id)}" data-room-type="${typeLabel}">
        <td>
          <div class="room-id-cell">
            <code class="room-id-text">${escHtml(id)}</code>
            <button type="button" class="copy-room-id" data-room="${escHtml(id)}" title="Copy Room ID">📋</button>
          </div>
        </td>
        <td>${typeBadge}</td>
        <td style="text-align:center">${userBadge}</td>
        <td style="text-align:center"><span class="badge-count">${msgCount}</span></td>
        <td style="text-align:center;color:#9ba1a6;font-size:0.8rem">${created}</td>
        <td style="text-align:center">${actions || '<span style="color:#6b7280;font-size:0.8rem">—</span>'}</td>
      </tr>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shareli — Admin Control Center</title>
  <noscript><meta http-equiv="refresh" content="30"></noscript>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#0c0d14;color:#f3f4f8;padding:24px 28px;min-height:100vh;-webkit-font-smoothing:antialiased}
    
    /* Top Header Bar */
    .admin-navbar{display:flex;align-items:center;justify-content:space-between;padding-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:24px;flex-wrap:wrap;gap:16px}
    .brand-group{display:flex;align-items:center;gap:12px}
    .logo-badge{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.1rem;box-shadow:0 4px 16px rgba(99,102,241,0.35)}
    .brand-title{font-size:1.3rem;font-weight:800;letter-spacing:-0.02em;display:flex;align-items:center;gap:8px}
    .dev-badge{background:rgba(99,102,241,0.18);border:1px solid rgba(99,102,241,0.35);color:#a5b4fc;font-size:0.68rem;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:0.04em}
    .live-status{display:inline-flex;align-items:center;gap:6px;font-size:0.75rem;font-weight:600;color:#10b981;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);padding:3px 10px;border-radius:20px}
    .live-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;animation:pulse 2s infinite}
    @keyframes pulse{0%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}100%{opacity:1;transform:scale(1)}}
    
    .nav-actions{display:flex;align-items:center;gap:10px}
    .btn-nav{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#e2e8f0;font-size:0.8rem;font-weight:600;padding:7px 14px;border-radius:8px;text-decoration:none;transition:all 0.15s}
    .btn-nav:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.2)}
    .btn-nav.danger{color:#fca5a5;border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.08)}
    .btn-nav.danger:hover{background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.5)}

    /* Alert Success Banner */
    .alert-success{background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);color:#6ee7b7;padding:12px 18px;border-radius:10px;margin-bottom:24px;font-size:0.88rem;font-weight:600;display:flex;align-items:center;gap:8px}

    /* KPI Metrics Grid */
    .metrics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
    .metric-card{background:#151622;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:6px;position:relative;overflow:hidden;transition:border-color 0.2s}
    .metric-card:hover{border-color:rgba(99,102,241,0.4)}
    .metric-header{display:flex;justify-content:space-between;align-items:center}
    .metric-label{font-size:0.72rem;font-weight:700;color:#9ba1a6;text-transform:uppercase;letter-spacing:0.05em}
    .metric-icon{font-size:1.1rem;opacity:0.8}
    .metric-value{font-size:1.9rem;font-weight:800;color:#f3f4f8;letter-spacing:-0.03em}
    .metric-sub{font-size:0.75rem;color:#818cf8;font-weight:500}
    .progress-bar-bg{width:100%;height:4px;background:rgba(255,255,255,0.08);border-radius:2px;margin-top:6px;overflow:hidden}
    .progress-bar-fill{height:100%;background:linear-gradient(90deg,#6366f1,#10b981);border-radius:2px}

    /* Two-Column Dashboard Layout */
    .dashboard-layout{display:grid;grid-template-columns:1fr 340px;gap:24px;align-items:start}
    @media (max-width: 992px){.dashboard-layout{grid-template-columns:1fr}}

    /* Main Section: Active Rooms Table */
    .rooms-card{background:#151622;border:1px solid rgba(255,255,255,0.07);border-radius:14px;overflow:hidden}
    .rooms-header{padding:18px 20px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
    .rooms-title{font-size:1.05rem;font-weight:700}
    .filter-tabs{display:flex;background:#0e0f18;padding:3px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);gap:2px}
    .filter-tab{background:transparent;border:none;color:#9ba1a6;font-size:0.75rem;font-weight:600;padding:5px 12px;border-radius:6px;cursor:pointer;transition:all 0.15s}
    .filter-tab.active{background:#6366f1;color:#fff}
    
    .search-row{padding:12px 20px;background:rgba(0,0,0,0.15);border-bottom:1px solid rgba(255,255,255,0.05)}
    .search-input{width:100%;background:#0e0f18;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px 14px;color:#f3f4f8;font-size:0.85rem;outline:none;transition:border-color 0.15s}
    .search-input:focus{border-color:#6366f1}

    .table-container{overflow-x:auto}
    table{width:100%;border-collapse:collapse;text-align:left}
    thead{background:#11121c}
    th{padding:12px 16px;font-size:0.72rem;font-weight:700;color:#9ba1a6;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid rgba(255,255,255,0.06)}
    td{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.85rem}
    tr:hover td{background:rgba(255,255,255,0.02)}
    
    .room-id-cell{display:flex;align-items:center;gap:8px}
    .room-id-text{font-family:ui-monospace,SFMono-Regular,monospace;color:#e0e7ff;font-weight:600;font-size:0.82rem}
    .copy-room-id{background:transparent;border:none;cursor:pointer;font-size:0.85rem;opacity:0.6;transition:opacity 0.15s;padding:2px 4px;border-radius:4px}
    .copy-room-id:hover{opacity:1;background:rgba(255,255,255,0.08)}
    .copy-room-id.copied{color:#10b981;opacity:1;font-size:0.75rem;font-weight:700}

    /* Badges */
    .badge-pill{display:inline-flex;align-items:center;gap:5px;font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap}
    .pill-public{background:rgba(14,165,233,0.12);color:#38bdf8;border:1px solid rgba(14,165,233,0.25)}
    .pill-private{background:rgba(168,85,247,0.12);color:#c084fc;border:1px solid rgba(168,85,247,0.25)}
    .pill-online{background:rgba(16,185,129,0.12);color:#34d399;border:1px solid rgba(16,185,129,0.25)}
    .dot-online{width:5px;height:5px;border-radius:50%;background:#34d399;box-shadow:0 0 5px #34d399}
    .pill-muted{background:rgba(255,255,255,0.04);color:#9ba1a6;border:1px solid rgba(255,255,255,0.08)}
    .badge-count{font-weight:700;color:#f3f4f8;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:10px;font-size:0.75rem}

    /* Action Buttons in Table */
    .btn-table-action{display:inline-block;padding:3px 8px;border-radius:6px;font-size:0.74rem;font-weight:600;text-decoration:none;transition:all 0.15s;margin:0 2px}
    .btn-enter{color:#34d399;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25)}
    .btn-enter:hover{background:rgba(16,185,129,0.2)}
    .btn-clear{color:#fbbf24;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25)}
    .btn-clear:hover{background:rgba(245,158,11,0.2)}
    .btn-delete{color:#f87171;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25)}
    .btn-delete:hover{background:rgba(239,68,68,0.2)}

    /* Side Column Cards */
    .side-stack{display:flex;flex-direction:column;gap:20px}
    .tool-card{background:#151622;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:20px}
    .tool-title{font-size:0.92rem;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:8px}
    .tool-desc{font-size:0.76rem;color:#9ba1a6;line-height:1.4;margin-bottom:14px}
    
    /* Broadcast Form */
    .broadcast-textarea{width:100%;padding:10px 12px;background:#0e0f18;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#f3f4f8;font-size:0.82rem;font-family:inherit;resize:vertical;outline:none;transition:border-color 0.15s}
    .broadcast-textarea:focus{border-color:#6366f1}
    .broadcast-row{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
    .counter{font-size:0.72rem;color:#9ba1a6}
    .btn-broadcast{background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;color:#fff;font-size:0.78rem;font-weight:700;padding:7px 14px;border-radius:8px;cursor:pointer;transition:opacity 0.15s}
    .btn-broadcast:hover{opacity:0.9}

    /* Maintenance Actions */
    .quick-actions{display:flex;flex-direction:column;gap:8px}
    .btn-quick{display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);color:#e2e8f0;font-size:0.78rem;font-weight:600;padding:9px;border-radius:8px;text-decoration:none;transition:all 0.15s}
    .btn-quick:hover{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.15)}
    .btn-quick.danger{color:#fca5a5;border-color:rgba(239,68,68,0.25);background:rgba(239,68,68,0.06)}
    .btn-quick.danger:hover{background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.4)}

    /* Telemetry List */
    .telemetry-list{display:flex;flex-direction:column;gap:10px}
    .telemetry-item{display:flex;justify-content:space-between;align-items:center;font-size:0.76rem}
    .telemetry-label{color:#9ba1a6}
    .telemetry-val{color:#f3f4f8;font-weight:600;font-family:ui-monospace,SFMono-Regular,monospace}

    /* Footer & Auto-Refresh */
    .admin-footer{margin-top:32px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:0.78rem;color:#9ba1a6}
    .refresh-ctrl{display:inline-flex;align-items:center;gap:8px}
    .btn-ghost-sm{background:transparent;border:1px solid rgba(255,255,255,0.1);color:#9ba1a6;font-size:0.72rem;padding:3px 8px;border-radius:6px;cursor:pointer;transition:all 0.15s}
    .btn-ghost-sm:hover{background:rgba(255,255,255,0.06);color:#f3f4f8}
    .btn-ghost-sm.paused{background:rgba(245,158,11,0.15);color:#fbbf24;border-color:rgba(245,158,11,0.3)}
  </style>
</head>
<body>
  <!-- Header Bar -->
  <header class="admin-navbar">
    <div class="brand-group">
      <div class="logo-badge">S</div>
      <div>
        <div class="brand-title">
          SHARELI <span class="dev-badge">DEV ADMIN</span>
        </div>
      </div>
      <span class="live-status"><span class="live-dot"></span> LIVE</span>
    </div>
    <div class="nav-actions">
      <a href="/" target="_blank" class="btn-nav" title="Open Public App">🌐 Public App</a>
      <a href="/admin" class="btn-nav" title="Refresh Dashboard">⟳ Refresh</a>
      <a href="/admin/logout" class="btn-nav danger" title="Sign Out">🚪 Sign Out</a>
    </div>
  </header>

  ${successBanner}

  <!-- 6 Metrics Cards -->
  <section class="metrics-grid">
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">Active Users</span>
        <span class="metric-icon">👥</span>
      </div>
      <div class="metric-value">${totalUsers}</div>
      <div class="metric-sub">${userPercent}% of ${MAX_TOTAL_CONNECTIONS} limit</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${userPercent}%"></div></div>
    </div>

    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">Active Rooms</span>
        <span class="metric-icon">🚪</span>
      </div>
      <div class="metric-value">${totalRooms}</div>
      <div class="metric-sub">${publicRoomsCount} Public · ${privateRoomsCount} Private</div>
    </div>

    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">Messages in Memory</span>
        <span class="metric-icon">💬</span>
      </div>
      <div class="metric-value">${totalMessages}</div>
      <div class="metric-sub">Temporary ephemeral storage</div>
    </div>

    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">Today's Visitors</span>
        <span class="metric-icon">📅</span>
      </div>
      <div class="metric-value">${todayVisitors}</div>
      <div class="metric-sub">Unique daily IPs (UTC reset)</div>
    </div>

    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">Server Uptime</span>
        <span class="metric-icon">⏱️</span>
      </div>
      <div class="metric-value" style="font-size:1.5rem;padding-top:4px">${uptimeStr}</div>
      <div class="metric-sub">Continuous running time</div>
    </div>

    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">RAM Usage</span>
        <span class="metric-icon">⚡</span>
      </div>
      <div class="metric-value">${memMB}<span style="font-size:1rem;color:#9ba1a6">MB</span></div>
      <div class="metric-sub">Heap: ${heapUsedMB} / ${heapTotalMB} MB (${heapPercent}%)</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${heapPercent}%"></div></div>
    </div>
  </section>

  <!-- Two Column Layout -->
  <main class="dashboard-layout">
    <!-- Active Rooms Table -->
    <section class="rooms-card">
      <div class="rooms-header">
        <h2 class="rooms-title">Active Rooms (${totalRooms})</h2>
        <div class="filter-tabs">
          <button type="button" class="filter-tab active" data-filter="all">All (${totalRooms})</button>
          <button type="button" class="filter-tab" data-filter="public">Public (${publicRoomsCount})</button>
          <button type="button" class="filter-tab" data-filter="private">Private (${privateRoomsCount})</button>
        </div>
      </div>

      <div class="search-row">
        <input type="text" id="room-search" class="search-input" placeholder="🔍 Search room by ID or status..." />
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Room ID</th>
              <th>Type</th>
              <th style="text-align:center">Connected</th>
              <th style="text-align:center">Messages</th>
              <th style="text-align:center">Created</th>
              <th style="text-align:center">Actions</th>
            </tr>
          </thead>
          <tbody id="rooms-tbody">
            ${totalRooms === 0 ? `<tr><td colspan="6" style="text-align:center;padding:32px;color:#9ba1a6">No active rooms right now.</td></tr>` : roomRows}
            <tr id="no-search-results" style="display:none"><td colspan="6" style="text-align:center;padding:24px;color:#9ba1a6">No rooms matching your search.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Side Tools & Telemetry -->
    <aside class="side-stack">
      <!-- Broadcast Tool -->
      <div class="tool-card">
        <div class="tool-title">📢 Global Announcement</div>
        <p class="tool-desc">Broadcast an instant popup toast notification to every user currently online in all rooms.</p>
        <form method="POST" action="/admin/action">
          <input type="hidden" name="action" value="broadcast">
          <textarea id="broadcast-msg" name="message" class="broadcast-textarea" placeholder="Type announcement message..." rows="3" maxlength="300" required></textarea>
          <div class="broadcast-row">
            <span id="broadcast-counter" class="counter">0/300</span>
            <button type="submit" class="btn-broadcast">Broadcast</button>
          </div>
        </form>
      </div>

      <!-- Quick Maintenance Actions -->
      <div class="tool-card">
        <div class="tool-title">⚡ Quick Server Actions</div>
        <p class="tool-desc">Execute immediate room cleanup or maintenance routines.</p>
        <div class="quick-actions">
          <a href="/admin/action?action=pruneRooms" data-confirm="Prune all inactive empty rooms with 0 users?" class="btn-quick">✂️ Prune Empty Rooms</a>
          <a href="/admin/action?action=clearChat&room=public" data-confirm="Clear all messages in the public room?" class="btn-quick danger">🧹 Clear Public Chat</a>
        </div>
      </div>

      <!-- Telemetry & Security -->
      <div class="tool-card">
        <div class="tool-title">🛡️ Security & Telemetry</div>
        <div class="telemetry-list">
          <div class="telemetry-item">
            <span class="telemetry-label">Anti-Spam Threshold</span>
            <span class="telemetry-val">12 msg / 10s</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">File Rate Limit</span>
            <span class="telemetry-val">15 file / 30s</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Buffer Flood Cap</span>
            <span class="telemetry-val">15MB (Anti-OOM)</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Active Spammer Mutes</span>
            <span class="telemetry-val" style="color:${activeMutes > 0 ? '#f59e0b' : '#34d399'}">${activeMutes}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Failed Admin Logins</span>
            <span class="telemetry-val" style="color:${failedLogins > 0 ? '#ef4444' : '#34d399'}">${failedLogins}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Runtime Environment</span>
            <span class="telemetry-val">Node ${process.version}</span>
          </div>
        </div>
      </div>
    </aside>
  </main>

  <!-- Footer / Auto-Refresh Indicator -->
  <footer class="admin-footer">
    <div>Shareli Server Control Center • E2E Zero-Knowledge Architecture</div>
    <div class="refresh-ctrl">
      Auto-refreshing in <strong id="refresh-timer">30s</strong>
      <button type="button" id="pause-refresh-btn" class="btn-ghost-sm">⏸ Pause</button>
      <a href="/admin" class="btn-ghost-sm" style="text-decoration:none">⟳ Refresh Now</a>
    </div>
  </footer>

  <script src="/admin.js" defer></script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': mimeTypes['.html'], ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
    res.end(html);
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
  const clientIp = getRequestIp(req);
  trackVisitor(clientIp);
  if (clients.size >= MAX_TOTAL_CONNECTIONS) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  // Whitelist internal/private IPs from per-IP limits (Render proxy router, localhost, 10.x, etc.)
  const isPrivateOrProxy = 
    clientIp === 'unknown' || 
    clientIp === '127.0.0.1' || 
    clientIp === '::1' || 
    clientIp === '::ffff:127.0.0.1' ||
    clientIp.startsWith('10.') || 
    clientIp.startsWith('192.168.') ||
    clientIp.startsWith('172.');

  if (!isPrivateOrProxy) {
    const ipCount = Array.from(clients.values()).filter(c => c.ip === clientIp).length;
    if (ipCount >= MAX_CONNECTIONS_PER_IP) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return;
    }
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
  const room = getRoom(requestUrl.searchParams.get("room"), providedAdminToken);
  const connectionId = crypto.randomUUID();
  const sessionId = requestUrl.searchParams.get("sessionId");
  const id = sessionId ? crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16) : crypto.randomUUID();

  // Developer admin: verified via shareli_dev_mode cookie (set by /admin/enter)
  let isDevAdmin = false;
  if (DEVELOPER_ADMIN_SECRET) {
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
  }
  // Room admin: verified via room-specific adminToken (timing-safe comparison)
  const isRoomAdmin = room.id !== 'public' && room.adminToken && providedAdminToken && safeCompare(room.adminToken, providedAdminToken);
  const isAdmin = isDevAdmin || isRoomAdmin;
  
  const client = {
    connectionId,
    id,
    socket,
    ip: clientIp,
    roomId: room.id,
    name: `Guest ${String(clients.size + 1).padStart(2, "0")}`,
    color: `hsl(${Math.floor(Math.random() * 360)} 70% 45%)`,
    messageBuffer: [],
    // Anti-spam tracking
    spamTextTimestamps: [],   // Text message send times (10s window)
    spamFileTimestamps: [],   // File message send times (30s window)
    spamWarnings: 0,          // Strike counter: 0 → warning, 1 → mute
    muteCount: 0,             // How many times muted (for escalation: 1st=60s, 2nd+=120s)
    mutedUntil: 0,            // Timestamp when mute expires
    isAdmin,
    isDevAdmin
  };

  clients.set(connectionId, client);
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

    // Memory protection: kill connection if buffer grows beyond safe limit (prevents OOM attack)
    const MAX_BUFFER_SIZE = 15 * 1024 * 1024; // 15MB
    if (dataBuffer.length > MAX_BUFFER_SIZE) {
      socket.destroy();
      return;
    }

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
    clients.delete(connectionId);
    room.typingDrafts.delete(id);
    broadcastPresence(room.id);
    broadcastTyping(room);
  });

  socket.on("error", () => {
    clients.delete(connectionId);
    room.typingDrafts.delete(id);
    broadcastPresence(room.id);
    broadcastTyping(room);
  });
});

setInterval(() => {
  // Prune any dead/destroyed sockets from memory
  for (const [clientId, c] of clients.entries()) {
    if (c.socket.destroyed || !c.socket.writable) {
      clients.delete(clientId);
    }
  }

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
