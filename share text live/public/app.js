const statusDot = document.querySelector("#status-dot");
const connectionLabel = document.querySelector("#connection-label");
const nameInput = document.querySelector("#name-input");
const saveNameButton = document.querySelector("#save-name");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const expirySelect = document.querySelector("#expiry-select");
const charCount = document.querySelector("#char-count");
const shareButton = document.querySelector("#share-button");
const messagesEl = document.querySelector("#messages");
const messageCount = document.querySelector("#message-count");
const copyAllButton = document.querySelector("#copy-all");
const clearRoomButton = document.querySelector("#clear-room");
const pwModal = document.getElementById("pw-modal");
const pwInput = document.getElementById("pw-input");
const pwConfirm = document.getElementById("pw-confirm");
const pwCancel = document.getElementById("pw-cancel");
const pwToggle = document.getElementById("pw-toggle");
const pwEyeIcon = document.getElementById("pw-eye-icon");
const pwModalTitle = document.getElementById("pw-modal-title");
const pwModalDesc = document.getElementById("pw-modal-desc");
const pwModalLabel = document.getElementById("pw-modal-label");
const typingPreviews = document.querySelector("#typing-previews");
const peopleCount = document.querySelector("#people-count");
const peopleList = document.querySelector("#people-list");
const launchNotice = document.querySelector("#launch-notice");
const roomLink = document.querySelector("#room-link");
const copyLinkButton = document.querySelector("#copy-link");
const newRoomButton = document.querySelector("#new-room");
const defaultRoomButton = document.querySelector("#default-room");
const roomLabel = document.querySelector("#room-label");
const roomChip = document.querySelector("#room-chip");
const livePreview = document.querySelector("#live-preview");
const livePreviewText = livePreview.querySelector("p:last-child");
const draftStatus = document.querySelector("#draft-status") || {};
const toast = document.querySelector("#toast");
const template = document.querySelector("#message-template");
const showQrBtn = document.querySelector("#show-qr-btn");
const qrModal = document.querySelector("#qr-modal");
const closeQrModal = document.querySelector("#close-qr-modal");
const qrcodeContainer = document.querySelector("#qrcode-container");

if (launchNotice) {
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    launchNotice.innerHTML = `<strong>Open this app through the local server.</strong><span>Run <code>npm start</code>, then open <code>http://127.0.0.1:3000</code>.</span>`;
    launchNotice.hidden = false;
  }
}

// New elements for UI overhaul
const sidebar = document.getElementById("sidebar");
const toggleSidebarBtn = document.getElementById("toggle-sidebar");
const closeSidebarBtn = document.getElementById("close-sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const boardMenuBtn = document.getElementById("board-menu-btn");
const boardMenu = document.getElementById("board-menu");
const boardScrollArea = document.getElementById("board-scroll-area");
const mobileRoomName = document.getElementById("mobile-room-name");
const exportRoomButton = document.getElementById("export-room");

// Reply and Pin Elements
const replyBanner = document.getElementById("reply-banner");
const replyAuthor = document.getElementById("reply-author");
const replySnippet = document.getElementById("reply-snippet");
const cancelReplyBtn = document.getElementById("cancel-reply");

const pinnedBanner = document.getElementById("pinned-banner");
const pinnedAuthor = document.getElementById("pinned-author");
const pinnedSnippet = document.getElementById("pinned-snippet");
const closePinnedBtn = document.getElementById("close-pinned");

// Attachment Elements
const attachButton = document.getElementById("attach-button");
const fileInput = document.getElementById("file-input");
const attachmentPreview = document.getElementById("attachment-preview");
const attachmentName = document.getElementById("attachment-name");
const removeAttachmentBtn = document.getElementById("remove-attachment");

// Lightbox Elements
const lightbox = document.getElementById("lightbox");
const lightboxCloseBtn = document.getElementById("lightbox-close");

if (lightboxCloseBtn) {
  lightboxCloseBtn.addEventListener('click', () => {
    lightbox.classList.add('hidden');
  });
}
if (lightbox) {
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      lightbox.classList.add('hidden');
    }
  });
}

let socket;
let clientId = "";
let messages = [];
let typingDrafts = [];
let reconnectTimer;
let typingTimer;
let serverOffset = 0;
let myColor = "#6366f1"; // updated from server hello
const pendingMessages = new Map(); // pendingId → tempMessage, for reliable matching
let currentRoomId = getRoomIdFromUrl();
let intentionalDisconnect = false;
let isConnected = false;
let draftSaveTimer;
let toastTimer;
let roomSwitchInProgress = false;
let replyingToMessage = null;
let currentAttachment = null;
let pinnedMessageId = null;
let roomCryptoKey = null;

let renderTimeout;
function debouncedRenderMessages(shouldScroll) {
  clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    renderMessages();
    renderPinnedMessage();
    if (shouldScroll) scrollToBottom();
  }, 20);
}

// Helpers for scrolling
function scrollToBottom() {
  if (boardScrollArea) {
    boardScrollArea.scrollTo({
      top: boardScrollArea.scrollHeight,
      behavior: 'smooth'
    });
  }
}

// Adjust scroll when virtual keyboard opens (Viewport resize)
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    // Small delay to allow layout to settle
    setTimeout(scrollToBottom, 100);
  });
}

// Derives a deterministic AES-256 key from a password + roomId using PBKDF2
async function deriveKeyFromPassword(password, roomId) {
  const encoder = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("shareli-" + roomId),
      iterations: 200000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function setupCryptoKey() {
  if (currentRoomId === "public") {
    // Shared constant key for the public room so everyone can read each other's messages
    const publicBase64Key = "U2hhcmVUZXh0TGl2ZVB1YmxpY1Jvb21LZXkxMjM0NTY="; // btoa("ShareTextLivePublicRoomKey123456")
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const rawKey = new Uint8Array(atob(publicBase64Key).split('').map(c => c.charCodeAt(0)));
    roomCryptoKey = await window.crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return;
  }

  const hash = window.location.hash.slice(1);
  const hashParams = new URLSearchParams(hash);
  let keyBase64 = hashParams.get('key');
  const isPasswordProtected = hashParams.get('pwd') === '1';

  // If the room is password-protected and no raw key is embedded, prompt for password
  if (isPasswordProtected && !keyBase64) {
    const password = await promptForPassword();
    if (!password) {
      // User cancelled or entered nothing — redirect to public room
      window.location.href = "/";
      return;
    }
    roomCryptoKey = await deriveKeyFromPassword(password, currentRoomId);
    return;
  }

  if (!keyBase64) {
    const key = await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const exported = await window.crypto.subtle.exportKey("raw", key);
    keyBase64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    
    hashParams.set('key', keyBase64);
    window.history.replaceState(null, '', '#' + hashParams.toString());
  }

  const rawKey = new Uint8Array(atob(keyBase64).split('').map(c => c.charCodeAt(0)));
  roomCryptoKey = await window.crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// Shows a styled password prompt overlay and resolves with the entered password
// mode: 'join' = entering password to decrypt, 'create' = creating room (handled separately)
function promptForPassword() {
  return new Promise((resolve) => {
    if (!pwModal) { resolve(window.prompt("Enter room password:") || ""); return; }

    // Switch modal to JOIN mode
    if (pwModalTitle) pwModalTitle.textContent = "🔐 Password Required";
    if (pwModalDesc) pwModalDesc.textContent = "This room is password-protected. Enter the password shared by the room creator to read messages.";
    if (pwModalLabel) pwModalLabel.textContent = "Password";
    if (pwConfirm) pwConfirm.textContent = "Unlock Room";
    if (pwCancel) pwCancel.textContent = "Return to Public";
    pwInput.placeholder = "Enter room password…";
    pwInput.value = "";
    pwInput.type = "password";
    if (pwEyeIcon) pwEyeIcon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;

    // Make sure Cancel is visible
    if (pwCancel) pwCancel.style.display = "";

    pwModal.classList.remove("hidden");
    pwModal.setAttribute("aria-hidden", "false");

    const onConfirm = () => {
      const pw = pwInput.value.trim();
      cleanup();
      resolve(pw);
    };
    
    const onCancel = () => {
      cleanup();
      resolve(null); // return null to indicate cancellation
    };

    const onKeydown = (e) => { if (e.key === "Enter") onConfirm(); };

    function cleanup() {
      pwConfirm.removeEventListener("click", onConfirm);
      pwCancel.removeEventListener("click", onCancel);
      pwInput.removeEventListener("keydown", onKeydown);
      pwModal.classList.add("hidden");
      pwModal.setAttribute("aria-hidden", "true");
      // Restore to create-mode defaults
      if (pwModalTitle) pwModalTitle.textContent = "New Private Room";
      if (pwModalDesc) pwModalDesc.textContent = "Optionally add a password. Anyone with the correct password can decrypt messages — the server never sees it.";
      if (pwModalLabel) pwModalLabel.textContent = "Password (optional)";
      if (pwConfirm) pwConfirm.textContent = "Create Room";
      if (pwCancel) pwCancel.textContent = "Cancel";
      pwInput.placeholder = "Leave blank for random key…";
    }

    pwConfirm.addEventListener("click", onConfirm);
    pwCancel.addEventListener("click", onCancel);
    pwInput.addEventListener("keydown", onKeydown);
    setTimeout(() => pwInput.focus(), 50);
  });
}

async function encryptText(plainText) {
  if (!plainText) return plainText;
  if (!roomCryptoKey) return plainText;
  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plainText);
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      roomCryptoKey,
      encoded
    );
    
    // Convert to base64 without exceeding call stack or blocking main thread
    const ivBase64 = await bufferToBase64(iv);
    const cipherBase64 = await bufferToBase64(new Uint8Array(ciphertext));
    
    return `${ivBase64}:${cipherBase64}`;
  } catch (e) {
    console.error("Encryption failed", e);
    return plainText; 
  }
}

// Helper to convert Uint8Array to base64 non-blocking (much faster for large files)
async function bufferToBase64(buffer) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer]);
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Helper to convert base64 to Uint8Array safely and fast
async function base64ToBuffer(base64) {
  const res = await fetch(`data:application/octet-stream;base64,${base64}`);
  return await res.arrayBuffer();
}

async function decryptText(encryptedPayload) {
  if (!encryptedPayload) return encryptedPayload;
  if (!roomCryptoKey) return "🔒 Encrypted Message";
  if (!encryptedPayload.includes(':')) return encryptedPayload;

  try {
    const [ivBase64, cipherBase64] = encryptedPayload.split(':');
    
    // AES-GCM IV is 12 bytes -> exactly 16 chars in base64. Filter out most plaintexts with colons.
    if (ivBase64.length !== 16) {
      return encryptedPayload;
    }
    
    const iv = await base64ToBuffer(ivBase64);
    const ciphertext = await base64ToBuffer(cipherBase64);
    
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      roomCryptoKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.error("Decryption failed", e);
    // If decryption fails in the public room, it's extremely likely an old plaintext message
    // that happened to have a 16-char string before a colon, or a tampered message.
    return currentRoomId === "public" ? encryptedPayload : "🔒 Encrypted Message";
  }
}

async function connect(options = {}) {
  if (!options.skipCrypto) await setupCryptoKey();
  updateRoomUi();

  if (location.protocol === "file:") {
    showFileMode();
    return;
  }

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const roomQuery = currentRoomId === "public" ? "" : `?room=${encodeURIComponent(currentRoomId)}`;
  socket = new WebSocket(`${protocol}://${location.host}/${roomQuery}`);

  isConnected = false;
  updateSendState();
  setConnection("Connecting...", "waiting");

  socket.addEventListener("open", () => {
    isConnected = true;
    updateSendState();
    setConnection("Connected live. Syncing...", "waiting");
  });

  socket.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);
    const isAtBottom = boardScrollArea ? (boardScrollArea.scrollHeight - boardScrollArea.scrollTop - boardScrollArea.clientHeight < 100) : false;

    if (payload.messages) {
      await Promise.all(payload.messages.map(async m => { m.text = await decryptText(m.text); }));
    }
    if (payload.drafts) {
      await Promise.all(payload.drafts.map(async d => { d.text = await decryptText(d.text); }));
    }
    if (payload.message) {
      payload.message.text = await decryptText(payload.message.text);
    }

    if (payload.type === "hello") {
      setConnection("Connected live", "online");
      clientId = payload.clientId;
      currentRoomId = payload.roomId || currentRoomId;
      updateRoomUi();
      nameInput.value = localStorage.getItem("shareTextLiveName") || payload.name;
      send({ type: "setName", name: nameInput.value });
      restoreDraft();
      messages = [];
      typingDrafts = payload.drafts || [];
      pinnedMessageId = payload.pinnedMessageId || null;
      serverOffset = (payload.serverTime || Date.now()) - Date.now();
      renderMessages();
      renderPinnedMessage();
      renderTypingDrafts();
      scrollToBottom();

      if (roomSwitchInProgress) {
        roomSwitchInProgress = false;
        showToast(currentRoomId === "public" ? "You are back in the public room." : "Private room is ready to share.");
      }
    }

    if (payload.type === "history") {
      messages.push(payload.message);
      debouncedRenderMessages(isAtBottom);
    }

    if (payload.type === "messages") {
      messages = payload.messages || [];
      pinnedMessageId = payload.pinnedMessageId || null;
      serverOffset = (payload.serverTime || Date.now()) - Date.now();
      renderMessages();
      renderPinnedMessage();
      if (isAtBottom) scrollToBottom();
    }
    
    if (payload.type === "newMessage") {
      // Match by pendingId first (fast + reliable, works for huge images too)
      let matched = false;
      for (const [pendingId, tmp] of pendingMessages.entries()) {
        if (tmp.authorId === clientId) {
          pendingMessages.delete(pendingId);
          const idx = messages.findIndex(m => m.id === tmp.id);
          if (idx !== -1) messages[idx] = payload.message;
          else messages.push(payload.message);
          matched = true;
          break;
        }
      }
      if (!matched) messages.push(payload.message);
      renderMessages();
      if (isAtBottom) scrollToBottom();
    }
    
    if (payload.type === "updateMessage") {
      const idx = messages.findIndex(m => m.id === payload.message.id);
      if (idx !== -1) messages[idx] = payload.message;
      renderMessages();
      renderPinnedMessage();
    }
    
    if (payload.type === "deleteMessage") {
      messages = messages.filter(m => m.id !== payload.messageId);
      if (payload.pinnedMessageId !== undefined) {
        pinnedMessageId = payload.pinnedMessageId;
      }
      renderMessages();
      renderPinnedMessage();
    }
    
    if (payload.type === "pinMessage") {
      pinnedMessageId = payload.pinnedMessageId || null;
      renderMessages();
      renderPinnedMessage();
    }

    if (payload.type === "clearMessages") {
      messages = [];
      pinnedMessageId = null;
      renderMessages();
      renderPinnedMessage();
    }

    if (payload.type === "presence") {
      // Update our own color from the server's authoritative list
      const me = (payload.users || []).find(u => u.id === clientId);
      if (me) myColor = me.color;
      renderPeople(payload.users || [], payload.count || 0);
    }

    if (payload.type === "typing") {
      typingDrafts = payload.drafts || [];
      renderTypingDrafts();
      if (isAtBottom) scrollToBottom();
    }
  });

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", scheduleReconnect);
}

function scheduleReconnect() {
  if (intentionalDisconnect) {
    intentionalDisconnect = false;
    return;
  }

  isConnected = false;
  updateSendState();
  setConnection("Reconnecting...", "offline");
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 1200);
}

function getRoomIdFromUrl() {
  if (location.protocol === "file:") return "public";
  const params = new URLSearchParams(location.search);
  return normalizeRoomId(params.get("room"));
}

function normalizeRoomId(value) {
  const roomId = String(value || "public").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
  return roomId || "public";
}

function getRoomUrl(roomId = currentRoomId) {
  if (location.protocol === "file:") return "http://127.0.0.1:3000";

  const url = new URL(location.href);
  if (roomId === "public") {
    url.searchParams.delete("room");
    url.hash = "";
  } else {
    url.searchParams.set("room", roomId);
    if (roomId === currentRoomId) {
      url.hash = window.location.hash;
    } else {
      url.hash = "";
    }
  }

  return url.toString();
}

function updateRoomUi() {
  roomLink.value = getRoomUrl();
  roomLabel.textContent = currentRoomId === "public"
    ? "Public room: everyone joins this room automatically."
    : `Private room: ${currentRoomId}`;
  roomChip.textContent = currentRoomId === "public" ? "Public" : "Private";
  if (mobileRoomName) mobileRoomName.textContent = currentRoomId === "public" ? "Public Room" : "Private Room";
  defaultRoomButton.disabled = currentRoomId === "public";

  const canonical = document.querySelector("link[rel='canonical']");
  if (canonical && location.protocol !== "file:") canonical.href = getRoomUrl("public");

  const ogUrl = document.querySelector("meta[property='og:url']");
  if (ogUrl && location.protocol !== "file:") ogUrl.content = getRoomUrl("public");
}

function generateRoomId() {
  const words = ["quick", "bright", "quiet", "fresh", "open", "clear", "live", "shared"];
  const second = ["note", "room", "text", "link", "page", "space", "group", "flow"];
  const pick = (items) => items[Math.floor(Math.random() * items.length)];
  return `${pick(words)}-${pick(second)}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function switchRoom(roomId, options = {}) {
  if (location.protocol === "file:") return;

  const shouldPushState = options.pushState !== false;

  clearTimeout(reconnectTimer);
  saveDraft();
  currentRoomId = normalizeRoomId(roomId);
  roomSwitchInProgress = true;
  if (shouldPushState) {
    history.pushState({}, "", getRoomUrl(currentRoomId));
  }

  messages = [];
  typingDrafts = [];
  clientId = "";
  pinnedMessageId = null;
  setReplyingTo(null);
  clearAttachment();
  messageInput.value = "";
  charCount.textContent = "0/50000";
  renderMessages();
  renderPinnedMessage();
  renderTypingDrafts();
  renderPeople([], 0);
  updateOwnLivePreview();
  updateRoomUi();

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    intentionalDisconnect = true;
    socket.close();
  }

  connect();
}

function setConnection(label, state) {
  if (connectionLabel) connectionLabel.textContent = label;
  statusDot.classList.toggle("online", state === "online");
  statusDot.classList.toggle("offline", state === "offline");
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function updateSendState() {
  shareButton.disabled = !isConnected || (!messageInput.value.trim() && !currentAttachment);
}

function getDraftKey() {
  return `share-text-live:draft:${currentRoomId}`;
}

function saveDraft() {
  const value = messageInput.value;

  if (value.trim()) {
    localStorage.setItem(getDraftKey(), value);
    draftStatus.textContent = "Draft saved";
  } else {
    localStorage.removeItem(getDraftKey());
    draftStatus.textContent = "Draft ready";
  }
}

function saveDraftSoon() {
  clearTimeout(draftSaveTimer);
  draftStatus.textContent = "Saving draft...";
  draftSaveTimer = setTimeout(saveDraft, 250);
}

function restoreDraft() {
  const savedDraft = localStorage.getItem(getDraftKey()) || "";
  messageInput.value = savedDraft;
  charCount.textContent = `${savedDraft.length}/50000`;
  draftStatus.textContent = savedDraft ? "Draft restored" : "Draft ready";
  updateOwnLivePreview();
  updateSendState();
}

function setControlsEnabled(enabled) {
  for (const control of [nameInput, saveNameButton, messageInput, expirySelect, shareButton]) {
    control.disabled = !enabled;
  }
}

function showFileMode() {
  launchNotice.hidden = false;
  setConnection("Server needed", "offline");
  setControlsEnabled(false);
  peopleCount.textContent = "0 people";
  peopleList.innerHTML = "";
  renderMessages();
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

async function copyText(value, button) {
  const text = String(value || "").trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    if (button) button.textContent = "Copied";
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    if (button) button.textContent = "Copied";
  }

  showToast("Copied to clipboard.");

  if (button) {
    setTimeout(() => {
      button.textContent = button.dataset.defaultLabel || "Copy";
    }, 1400);
  }
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatMessageForCopy(message) {
  return message.text;
}

function formatRemaining(ms) {
  if (ms <= 0) return "Disappearing now";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const nextSeconds = seconds % 60;
    return nextSeconds ? `${minutes}m ${nextSeconds}s left` : `${minutes}m left`;
  }
  
  const hours = Math.floor(minutes / 60);
  const nextMinutes = minutes % 60;
  return nextMinutes ? `${hours}h ${nextMinutes}m left` : `${hours}h left`;
}

function nowFromServerClock() {
  return Date.now() + serverOffset;
}

function updateCountdowns() {
  const now = nowFromServerClock();

  for (const card of messagesEl.querySelectorAll(".message-card")) {
    const expiresAt = Number(card.dataset.expiresAt || 0);
    const createdAt = Number(card.dataset.createdAt || 0);
    const label = card.querySelector(".expires-label");
    const bar = card.querySelector(".expiry-bar span");

    if (card.classList.contains("is-pending")) {
      label.textContent = "Sending...";
      bar.style.width = "100%";
      continue;
    }

    if (!expiresAt) {
      label.textContent = "Keep";
      bar.style.width = "100%";
      continue;
    }

    const remaining = Math.max(0, expiresAt - now);
    const total = Math.max(1, expiresAt - createdAt);
    label.textContent = formatRemaining(remaining);
    bar.style.width = `${Math.max(4, Math.round((remaining / total) * 100))}%`;
  }
}

function renderMessages() {
  messagesEl.innerHTML = "";
  if (messageCount) messageCount.textContent = `${messages.length} ${messages.length === 1 ? "note" : "notes"}`;
  if (copyAllButton) copyAllButton.disabled = messages.length === 0;
  if (clearRoomButton) clearRoomButton.disabled = messages.length === 0;

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.id = "empty-state";
    empty.style.cssText = "text-align: center; margin: auto; padding: 40px 20px; color: var(--muted); display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;";
    empty.innerHTML = `
      <div style="background: rgba(30, 169, 108, 0.1); color: #1ea96c; border: 1px solid rgba(30, 169, 108, 0.2); padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; display: flex; align-items: center; gap: 8px; margin-bottom: 24px; max-width: 400px; text-align: left;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        <span>Messages and files are <b>end-to-end encrypted</b>. No one outside of this room, not even Shareli, can read them.</span>
      </div>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 16px; opacity: 0.5;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
      <h3 style="margin: 0 0 8px; color: var(--text);">Ready to share</h3>
      <p style="margin: 0; font-size: 0.9rem;">Drag and drop a file anywhere, or paste text to begin.</p>
    `;

    if (currentRoomId === "public") {
      empty.innerHTML += `
        <button id="empty-state-private-btn" class="secondary-action" style="margin-top: 24px; display: inline-flex; align-items: center; gap: 8px; font-weight: 500;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          Create Private Room
        </button>
      `;
    }

    messagesEl.append(empty);

    const privateBtn = document.getElementById("empty-state-private-btn");
    if (privateBtn) {
      privateBtn.addEventListener("click", () => {
        const newRoomBtn = document.getElementById("new-room");
        if (newRoomBtn) newRoomBtn.click();
      });
    }

    return;
  }

  for (const message of messages) {
    const node = template.content.firstElementChild.cloneNode(true);
    const avatar = node.querySelector(".avatar");
    const author = node.querySelector(".author");
    const timestamp = node.querySelector(".timestamp");
    const text = node.querySelector(".message-text");
    const expiresLabel = node.querySelector(".expires-label");
    const editForm = node.querySelector(".edit-form");
    const editInput = editForm.querySelector("textarea");
    const copyButton = node.querySelector(".copy-message");
    const quickCopyBtn = node.querySelector(".quick-copy-btn");
    const quickDownloadBtn = node.querySelector(".quick-download-btn");
    const editButton = node.querySelector(".edit-message");
    const cancelButton = node.querySelector(".cancel-edit");
    const deleteButton = node.querySelector(".delete-message");
    const replyButton = node.querySelector(".reply-message");
    const pinButton = node.querySelector(".pin-message");
    const menuBtn = node.querySelector(".msg-menu-btn");
    const dropdown = node.querySelector(".msg-dropdown");
    
    const replyContext = node.querySelector(".message-reply-context");
    const replyContextAuthor = node.querySelector(".reply-context-author");
    const replyContextText = node.querySelector(".reply-context-text");

    avatar.style.background = message.authorColor || "#6366f1";
    node.dataset.createdAt = message.createdAt;
    node.dataset.messageId = message.id;
    node.dataset.expiresAt = message.expiresAt || "";
    
    if (message.isPending) {
      node.classList.add("is-pending");
      node.style.opacity = "0.55";
      node.style.pointerEvents = "none";
      node.title = "Sending…";
    }
    if (message.isFailed) {
      node.style.opacity = "0.75";
      node.style.outline = "1.5px solid #ef4444";
      node.style.borderRadius = "10px";
      node.title = "Failed to send";
      // Add a small retry indicator
      const failBadge = document.createElement("div");
      failBadge.style.cssText = "font-size:0.72rem;color:#ef4444;margin-top:4px;cursor:default;";
      failBadge.textContent = "⚠️ Not delivered — check your connection";
      node.querySelector(".message-text")?.after(failBadge);
    }
    author.textContent = message.authorName || "Guest";
    
    if (message.replyTo) {
      const parentMsg = messages.find(m => m.id === message.replyTo);
      if (parentMsg) {
        replyContext.classList.remove('hidden');
        replyContextAuthor.textContent = parentMsg.authorName || "Guest";
        replyContextText.textContent = (parentMsg.text || "").slice(0, 100).replace(/\n/g, ' ') + "...";
        
        replyContext.addEventListener('click', () => {
          const targetCard = document.querySelector(`.message-card[data-message-id="${parentMsg.id}"]`);
          if (targetCard) targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    }
    
    if (message.id === pinnedMessageId) {
      pinButton.textContent = "Unpin";
    }

    timestamp.textContent = message.updatedAt !== message.createdAt
      ? `Edited by ${message.editorName || 'someone'} at ${formatTime(message.updatedAt)}`
      : formatTime(message.createdAt);
      
    let messageContent = message.text || "";
    let attachmentData = null;
    
    if (messageContent.startsWith('{"__v":1')) {
      try {
        const parsed = JSON.parse(messageContent);
        messageContent = parsed.text;
        attachmentData = parsed.file;
      } catch (e) {}
    }
    
    if (window.marked && window.DOMPurify) {
      if (window.hljs) {
        marked.setOptions({
          highlight: function(code, lang) {
            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, { language }).value;
          }
        });
      }
      const rawHtml = marked.parse(messageContent || "", { breaks: true, gfm: true });
      text.innerHTML = DOMPurify.sanitize(rawHtml);
    } else {
      text.textContent = messageContent;
    }
    
    if (messageContent.trim().length > 0) {
      quickCopyBtn.classList.remove("hidden");
    }

    
    editInput.value = messageContent;
    expiresLabel.textContent = message.expiresAt ? "..." : "Keep";

    const attachmentContainer = node.querySelector(".message-attachment-container");
    if (attachmentData) {
      quickDownloadBtn.classList.remove("hidden");
      attachmentContainer.classList.remove("hidden");
      attachmentContainer.innerHTML = '';
      
      if (attachmentData.type.startsWith("image/")) {
        const wrapper = document.createElement("div");
        wrapper.className = "image-preview-wrapper";
        
        const img = document.createElement("img");
        img.src = attachmentData.data;
        img.alt = attachmentData.name;
        img.className = "message-image-preview";
        img.style.cursor = "pointer";
        
        // Modal for full image
        img.onclick = () => {
          const lightbox = document.getElementById("lightbox");
          const lightboxImg = document.getElementById("lightbox-img");
          const lightboxDownload = document.getElementById("lightbox-download");
          
          lightboxImg.src = attachmentData.data;
          lightboxImg.alt = attachmentData.name;
          
          // Setup lightbox download button
          lightboxDownload.onclick = () => {
            const a = document.createElement("a");
            a.href = attachmentData.data;
            a.download = attachmentData.name;
            a.click();
          };
          
          lightbox.classList.remove("hidden");
        };
        
        // Inline Download button overlay
        const dlBtn = document.createElement("button");
        dlBtn.className = "image-overlay-download";
        dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download';
        dlBtn.onclick = (e) => {
          e.stopPropagation();
          const a = document.createElement("a");
          a.href = attachmentData.data;
          a.download = attachmentData.name;
          a.click();
        };
        
        wrapper.appendChild(img);
        wrapper.appendChild(dlBtn);
        attachmentContainer.appendChild(wrapper);
      } else {
        const fileBox = document.createElement("div");
        fileBox.className = "message-file-box";
        
        const fileIcon = document.createElement("span");
        fileIcon.className = "file-icon";
        fileIcon.textContent = "📄";
        
        const fileName = document.createElement("span");
        fileName.className = "file-name";
        fileName.textContent = attachmentData.name;
        
        const downloadBtn = document.createElement("a");
        downloadBtn.className = "btn-secondary file-download";
        downloadBtn.textContent = "Download";
        downloadBtn.href = attachmentData.data;
        downloadBtn.download = attachmentData.name;
        
        fileBox.append(fileIcon, fileName, downloadBtn);
        attachmentContainer.appendChild(fileBox);
      }
    } else {
      attachmentContainer.classList.add("hidden");
    }

    if (menuBtn && dropdown) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.msg-dropdown').forEach(d => {
          if (d !== dropdown) d.classList.add('hidden');
        });
        dropdown.classList.toggle('hidden');
      });
    }

    copyButton.addEventListener("click", () => {
      copyText(formatMessageForCopy(message), copyButton);
      dropdown.classList.add('hidden');
    });

    if (quickCopyBtn) {
      quickCopyBtn.addEventListener("click", () => {
        copyText(formatMessageForCopy(message), quickCopyBtn);
      });
    }

    if (quickDownloadBtn) {
      quickDownloadBtn.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = attachmentData.data;
        a.download = attachmentData.name;
        a.click();
      });
    }

    editButton.addEventListener("click", () => {
      editForm.hidden = false;
      text.hidden = true;
      dropdown.classList.add('hidden');
      editInput.focus();
    });

    cancelButton.addEventListener("click", () => {
      editForm.hidden = true;
      text.hidden = false;
      editInput.value = message.text;
    });

    editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nextText = editInput.value.trim();
      if (!nextText && !attachmentData) return;
      
      let editPayloadData = nextText;
      if (attachmentData || nextText.startsWith('{"__v":1')) {
        editPayloadData = JSON.stringify({
          __v: 1,
          text: nextText,
          file: attachmentData
        });
      }
      
      const encryptedText = await encryptText(editPayloadData);
      send({ type: "update", id: message.id, text: encryptedText });
    });

    deleteButton.addEventListener("click", () => {
      send({ type: "delete", id: message.id });
      dropdown.classList.add('hidden');
    });
    
    replyButton.addEventListener("click", () => {
      setReplyingTo(message);
      dropdown.classList.add('hidden');
    });

    pinButton.addEventListener("click", () => {
      if (message.id === pinnedMessageId) {
        send({ type: "unpin" });
      } else {
        send({ type: "pin", id: message.id });
      }
      dropdown.classList.add('hidden');
    });

    messagesEl.append(node);
  }

  updateCountdowns();
}

function renderTypingDrafts() {
  typingPreviews.innerHTML = "";

  const visibleDrafts = typingDrafts.filter((draft) => draft.id !== clientId && draft.text);
  if (visibleDrafts.length === 0) return;

  for (const draft of visibleDrafts) {
    const item = document.createElement("article");
    item.className = "typing-card";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = draft.authorColor || "#6366f1";

    const body = document.createElement("div");
    const heading = document.createElement("strong");
    const text = document.createElement("p");

    heading.textContent = `${draft.authorName || "Guest"} is typing...`;
    if (window.marked && window.DOMPurify) {
      text.innerHTML = DOMPurify.sanitize(marked.parse(draft.text || "", { breaks: true, gfm: true }));
    } else {
      text.textContent = draft.text;
    }

    body.append(heading, text);
    item.append(avatar, body);
    typingPreviews.append(item);
  }
}

function updateOwnLivePreview() {
  const text = messageInput.value.trim();
  livePreview.hidden = !text;
  if (window.marked && window.DOMPurify) {
    livePreviewText.innerHTML = DOMPurify.sanitize(marked.parse(text || "", { breaks: true, gfm: true }));
  } else {
    livePreviewText.textContent = text;
  }
}

async function sendTypingSoon() {
  clearTimeout(typingTimer);
  const text = messageInput.value;
  typingTimer = setTimeout(async () => {
    send({ type: "typing", text: await encryptText(text) });
  }, 120);
}

function renderPeople(users, count) {
  peopleCount.textContent = `${count} ${count === 1 ? "person" : "people"}`;
  peopleList.innerHTML = "";

  for (const user of users) {
    const item = document.createElement("div");
    item.className = "person";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = user.color || "#6366f1";

    const name = document.createElement("span");
    name.textContent = user.id === clientId ? `${user.name} (you)` : user.name;

    item.append(avatar, name);
    peopleList.append(item);
  }
}

// Sidebar toggle logic
function toggleSidebar() {
  if (sidebar) sidebar.classList.toggle('open');
  if (sidebarOverlay) {
    sidebarOverlay.classList.toggle('hidden');
    sidebarOverlay.classList.toggle('active');
  }
}

if (toggleSidebarBtn) toggleSidebarBtn.addEventListener('click', toggleSidebar);
if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', toggleSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', toggleSidebar);

// Board Menu Dropdown
if (boardMenuBtn && boardMenu) {
  boardMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    boardMenu.classList.toggle('hidden');
  });
}

function setReplyingTo(message) {
  replyingToMessage = message;
  if (message) {
    replyBanner.classList.remove('hidden');
    replyAuthor.textContent = message.authorName || "Guest";
    replySnippet.textContent = (message.text || "").replace(/\n/g, ' ').slice(0, 60) + "...";
    messageInput.focus();
  } else {
    replyBanner.classList.add('hidden');
  }
}

if (cancelReplyBtn) {
  cancelReplyBtn.addEventListener('click', () => setReplyingTo(null));
}

// Attachment Logic
async function processFile(file) {
  if (file.size > 3 * 1024 * 1024) {
    showToast("File is too large! Maximum is 3MB.");
    return;
  }
  
  const reader = new FileReader();
  reader.onload = (e) => {
    currentAttachment = {
      name: file.name || "Pasted Image",
      type: file.type || "application/octet-stream",
      data: e.target.result // base64 data url
    };
    if (attachmentPreview) attachmentPreview.classList.remove("hidden");
    if (attachmentName) attachmentName.textContent = currentAttachment.name;
    updateSendState();
  };
  reader.readAsDataURL(file);
}

function clearAttachment() {
  currentAttachment = null;
  if (attachmentPreview) attachmentPreview.classList.add("hidden");
  updateSendState();
}

if (attachButton && fileInput) {
  attachButton.addEventListener("click", () => fileInput.click());
  
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await processFile(file);
    fileInput.value = ""; // Reset
  });
}

if (removeAttachmentBtn) {
  removeAttachmentBtn.addEventListener("click", () => {
    clearAttachment();
  });
}

// Handle drop and paste globally for attachments
document.addEventListener("paste", async (e) => {
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (let index in items) {
    const item = items[index];
    if (item.kind === 'file') {
      const blob = item.getAsFile();
      await processFile(blob);
      return;
    }
  }
});

const dragOverlay = document.getElementById("drag-overlay");

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer.types && e.dataTransfer.types.includes("Files")) {
    if (dragOverlay) dragOverlay.classList.remove("hidden");
  }
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer.types && e.dataTransfer.types.includes("Files")) {
    e.dataTransfer.dropEffect = 'copy';
  }
});

document.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (dragOverlay && e.relatedTarget === null) {
    dragOverlay.classList.add("hidden");
  }
});

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (dragOverlay) dragOverlay.classList.add("hidden");
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    await processFile(e.dataTransfer.files[0]);
  }
});

function renderPinnedMessage() {
  if (pinnedMessageId && pinnedBanner) {
    const msg = messages.find(m => m.id === pinnedMessageId);
    if (msg) {
      pinnedBanner.classList.remove('hidden');
      pinnedAuthor.textContent = msg.authorName || "Guest";
      pinnedSnippet.textContent = (msg.text || "").replace(/\n/g, ' ').slice(0, 80) + "...";
      
      pinnedBanner.onclick = (e) => {
        if (e.target.closest('#close-pinned')) return;
        const targetCard = document.querySelector(`.message-card[data-message-id="${msg.id}"]`);
        if (targetCard) targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    } else {
      pinnedBanner.classList.add('hidden');
    }
  } else if (pinnedBanner) {
    pinnedBanner.classList.add('hidden');
  }
}

if (closePinnedBtn) {
  closePinnedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    send({ type: "unpin" });
  });
}

// Global click to close dropdowns
document.addEventListener('click', () => {
  if (boardMenu) boardMenu.classList.add('hidden');
  document.querySelectorAll('.msg-dropdown').forEach(d => d.classList.add('hidden'));
});

saveNameButton.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return;

  localStorage.setItem("shareTextLiveName", name);
  if (send({ type: "setName", name })) {
    showToast("Display name saved.");
  }
});

copyLinkButton.addEventListener("click", async () => {
  copyText(roomLink.value, copyLinkButton);
});

if (showQrBtn) {
  showQrBtn.addEventListener("click", () => {
    qrcodeContainer.innerHTML = "";
    new QRCode(qrcodeContainer, {
      text: roomLink.value || window.location.href,
      width: 200,
      height: 200,
      colorDark : "#0d0d12",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.M
    });
    qrModal.classList.remove("hidden");
  });
}

if (closeQrModal) {
  closeQrModal.addEventListener("click", () => {
    qrModal.classList.add("hidden");
  });
}

if (copyAllButton) {
  copyAllButton.addEventListener("click", () => {
    const text = messages
      .slice()
      .sort((first, second) => first.createdAt - second.createdAt)
      .map(formatMessageForCopy)
      .join("\n\n");

    copyText(text);
    if (boardMenu) boardMenu.classList.add('hidden');
  });
}

if (exportRoomButton) {
  exportRoomButton.addEventListener("click", () => {
    const textContent = messages
      .slice()
      .sort((first, second) => first.createdAt - second.createdAt)
      .map(msg => `[${formatTime(msg.createdAt)}] ${msg.authorName || "Guest"}:\n${msg.text}`)
      .join("\n\n----------------------------------------\n\n");

    const blob = new Blob([textContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `share-text-live-${currentRoomId}-${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    if (boardMenu) boardMenu.classList.add('hidden');
    showToast("Room exported to file.");
  });
}

// Password toggle eye icon
if (pwToggle && pwInput) {
  pwToggle.addEventListener("click", () => {
    const isHidden = pwInput.type === "password";
    pwInput.type = isHidden ? "text" : "password";
    if (pwEyeIcon) {
      pwEyeIcon.innerHTML = isHidden
        ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
        : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>` ;
    }
  });
}

newRoomButton.addEventListener("click", () => {
  if (!pwModal) {
    // Fallback if modal not found
    const roomId = generateRoomId();
    currentRoomId = roomId;
    updateRoomUi();
    copyText(roomLink.value, newRoomButton);
    switchRoom(roomId);
    return;
  }

  // Show the password modal
  pwInput.value = "";
  pwInput.type = "password";
  if (pwEyeIcon) pwEyeIcon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  if (pwCancel) pwCancel.style.display = "";
  pwModal.classList.remove("hidden");
  pwModal.setAttribute("aria-hidden", "false");
  setTimeout(() => pwInput.focus(), 50);

  const createRoom = async () => {
    const password = pwInput.value.trim();
    const roomId = generateRoomId();
    currentRoomId = roomId;

    if (password) {
      // Derive the AES key from the password
      roomCryptoKey = await deriveKeyFromPassword(password, roomId);
      // Store pwd=1 in the hash so visitors know to prompt for password
      // We do NOT embed the raw key in the URL — only the password flag
      const hashParams = new URLSearchParams();
      hashParams.set('pwd', '1');
      history.replaceState({}, "", window.location.pathname + `?room=${encodeURIComponent(roomId)}` + '#' + hashParams.toString());
    } else {
      // No password — generate a random key and embed it in the hash (existing behaviour)
      const key = await window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );
      const exported = await window.crypto.subtle.exportKey("raw", key);
      const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
      roomCryptoKey = key;
      const hashParams = new URLSearchParams();
      hashParams.set('key', keyBase64);
      history.replaceState({}, "", window.location.pathname + `?room=${encodeURIComponent(roomId)}` + '#' + hashParams.toString());
    }

    closeModal();

    // switchRoom resets state and calls connect(), but we already have the crypto key set
    // so we pass skipCrypto via a temporary flag to avoid re-running setupCryptoKey
    const prevKey = roomCryptoKey;
    const origSetup = window.__skipCryptoSetup;
    window.__skipCryptoSetup = true;

    // Reset state manually then call connect directly to avoid key overwrite
    clearTimeout(reconnectTimer);
    saveDraft();
    currentRoomId = normalizeRoomId(roomId);
    roomSwitchInProgress = true;
    messages = [];
    typingDrafts = [];
    clientId = "";
    pinnedMessageId = null;
    setReplyingTo(null);
    clearAttachment();
    messageInput.value = "";
    charCount.textContent = "0/50000";
    renderMessages();
    renderPinnedMessage();
    renderTypingDrafts();
    renderPeople([], 0);
    updateOwnLivePreview();

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      intentionalDisconnect = true;
      socket.close();
    }

    // Restore key (switchRoom->connect would overwrite it)
    roomCryptoKey = prevKey;
    connect({ skipCrypto: true });

    if (sidebar) sidebar.classList.remove('open');
    if (sidebarOverlay) {
      sidebarOverlay.classList.remove('active');
      sidebarOverlay.classList.add('hidden');
    }
    showToast(password ? "🔐 Password-protected room created!" : "Private room is ready to share.");
  };

  const closeModal = () => {
    pwModal.classList.add("hidden");
    pwModal.setAttribute("aria-hidden", "true");
    pwConfirm.removeEventListener("click", onConfirm);
    pwCancel.removeEventListener("click", onCancel);
    pwInput.removeEventListener("keydown", onKeydown);
  };

  const onConfirm = () => createRoom();
  const onCancel = () => closeModal();
  const onKeydown = (e) => { if (e.key === "Enter") createRoom(); if (e.key === "Escape") closeModal(); };

  pwConfirm.addEventListener("click", onConfirm);
  pwCancel.addEventListener("click", onCancel);
  pwInput.addEventListener("keydown", onKeydown);
});

defaultRoomButton.addEventListener("click", () => {
  switchRoom("public");
  if (sidebar) sidebar.classList.remove('open');
  if (sidebarOverlay) {
    sidebarOverlay.classList.remove('active');
    sidebarOverlay.classList.add('hidden');
  }
});

expirySelect.addEventListener("change", () => {
  localStorage.setItem("share-text-live:expiry", expirySelect.value);
  showToast("Message lifetime updated.");
});

window.addEventListener("popstate", () => {
  const nextRoomId = getRoomIdFromUrl();
  if (nextRoomId !== currentRoomId) {
    switchRoom(nextRoomId, { pushState: false });
  }
});

nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveNameButton.click();
  }
});

messageInput.addEventListener("input", () => {
  // Auto-resize textarea
  messageInput.style.height = 'auto';
  messageInput.style.height = (messageInput.scrollHeight) + 'px';
  if (messageInput.value === "") {
    messageInput.style.height = 'auto';
  }
  
  charCount.textContent = `${messageInput.value.length}/50000`;
  updateOwnLivePreview();
  updateSendState();
  saveDraftSoon();
  sendTypingSoon();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !shareButton.disabled) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

window.addEventListener("beforeunload", saveDraft);

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text && !currentAttachment) return;

  const originalBtnContent = shareButton.innerHTML;

  let payloadData = text;
  const snapshotAttachment = currentAttachment; // snapshot before clearing

  if (currentAttachment || text.startsWith('{"__v":1')) {
    payloadData = JSON.stringify({
      __v: 1,
      text: text,
      file: currentAttachment
    });
  }

  // Show "Sending..." state on button for large attachments
  if (snapshotAttachment && snapshotAttachment.data.length > 100000) {
    shareButton.innerHTML = "Sending...";
    shareButton.disabled = true;
    messageInput.disabled = true;
    
    // Yield to browser to paint the button state before heavy crypto processing
    await new Promise(r => setTimeout(r, 15));
  }

  // Encrypt and send
  const encryptedText = await encryptText(payloadData);
  const payload = { type: "create", text: encryptedText, expiresInMs: Number(expirySelect.value) };
  if (replyingToMessage) {
    payload.replyTo = replyingToMessage.id;
  }

  if (!send(payload)) {
    showToast("⚠️ Waiting for the live connection before sharing.");
    shareButton.innerHTML = originalBtnContent;
    shareButton.disabled = false;
    messageInput.disabled = false;
    return;
  }

  // ✅ Send succeeded — show optimistic (pending) message immediately
  const now = Date.now();
  const pendingId = "temp-" + now + "-" + Math.random().toString(36).slice(2);
  const tempMessage = {
    id: pendingId,
    text: payloadData,           // raw unencrypted (rendered locally only)
    authorId: clientId,
    authorName: nameInput.value || localStorage.getItem("shareTextLiveName") || "You",
    authorColor: myColor,        // use real color synced from server
    replyTo: replyingToMessage ? replyingToMessage.id : null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null, // Don't start timer until server confirms
    isPending: true
  };
  pendingMessages.set(pendingId, tempMessage);
  messages.push(tempMessage);
  renderMessages();

  // Timeout: if server doesn't confirm within 60s, mark as failed visually
  setTimeout(() => {
    if (!pendingMessages.has(pendingId)) return; // already confirmed
    
    // We keep it in the map so if it eventually succeeds, it can still reconcile
    const msg = pendingMessages.get(pendingId);
    if (msg) {
      msg.isFailed = true;
      msg.isPending = false;
      renderMessages();
    }
  }, 60000);

  // Reset UI immediately — user can type the next message
  messageInput.value = "";
  messageInput.style.height = "auto";
  charCount.textContent = "0/50000";
  clearAttachment();
  setReplyingTo(null);
  updateOwnLivePreview();
  saveDraft();
  updateSendState();
  send({ type: "typing", text: "" });

  shareButton.innerHTML = originalBtnContent;
  shareButton.disabled = false;
  messageInput.disabled = false;
  messageInput.focus();
  setTimeout(scrollToBottom, 50);
});

if (clearRoomButton) {
  clearRoomButton.addEventListener("click", () => {
    if (messages.length === 0) return;

    if (!window.confirm("Clear every message in this room for everyone connected?")) return;

    if (send({ type: "clear" })) {
      showToast("The room has been cleared.");
      if (boardMenu) boardMenu.classList.add('hidden');
    }
  });
}

const savedExpiry = localStorage.getItem("share-text-live:expiry");
if (savedExpiry && [...expirySelect.options].some((option) => option.value === savedExpiry)) {
  expirySelect.value = savedExpiry;
}

connect();
setInterval(updateCountdowns, 1000);

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('ServiceWorker registration successful with scope: ', registration.scope);
      }, (err) => {
        console.log('ServiceWorker registration failed: ', err);
      });
  });
}
