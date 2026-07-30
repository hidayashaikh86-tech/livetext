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
const draftStatus = document.querySelector("#draft-status");
const toast = document.querySelector("#toast");
const template = document.querySelector("#message-template");

let socket;
let clientId = "";
let messages = [];
let typingDrafts = [];
let reconnectTimer;
let typingTimer;
let serverOffset = 0;
let currentRoomId = getRoomIdFromUrl();
let intentionalDisconnect = false;
let isConnected = false;
let draftSaveTimer;
let toastTimer;
let roomSwitchInProgress = false;

function connect() {
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
    setConnection("Connected live", "online");
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "hello") {
      clientId = payload.clientId;
      currentRoomId = payload.roomId || currentRoomId;
      updateRoomUi();
      nameInput.value = localStorage.getItem("shareTextLiveName") || payload.name;
      send({ type: "setName", name: nameInput.value });
      restoreDraft();
      messages = payload.messages || [];
      typingDrafts = payload.drafts || [];
      serverOffset = (payload.serverTime || Date.now()) - Date.now();
      renderMessages();
      renderTypingDrafts();

      if (roomSwitchInProgress) {
        roomSwitchInProgress = false;
        showToast(currentRoomId === "public" ? "You are back in the public room." : "Private room is ready to share.");
      }
    }

    if (payload.type === "messages") {
      messages = payload.messages || [];
      serverOffset = (payload.serverTime || Date.now()) - Date.now();
      renderMessages();
    }

    if (payload.type === "presence") {
      renderPeople(payload.users || [], payload.count || 0);
    }

    if (payload.type === "typing") {
      typingDrafts = payload.drafts || [];
      renderTypingDrafts();
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
  } else {
    url.searchParams.set("room", roomId);
  }

  url.hash = "";
  return url.toString();
}

function updateRoomUi() {
  roomLink.value = getRoomUrl();
  roomLabel.textContent = currentRoomId === "public"
    ? "Public room: everyone joins this room automatically."
    : `Private room: ${currentRoomId}`;
  roomChip.textContent = currentRoomId === "public" ? "Public room" : "Private room";
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
  messageInput.value = "";
  charCount.textContent = "0 / 800";
  renderMessages();
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
  connectionLabel.textContent = label;
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
  shareButton.disabled = !isConnected || !messageInput.value.trim();
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
  charCount.textContent = `${savedDraft.length} / 800`;
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
    button.textContent = "Copied";
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
    button.textContent = "Copied";
  }

  showToast("Copied to clipboard.");

  setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || "Copy";
  }, 1400);
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
  const nextSeconds = seconds % 60;
  return nextSeconds ? `${minutes}m ${nextSeconds}s left` : `${minutes}m left`;
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

    if (!expiresAt) {
      label.textContent = "Kept until deleted";
      bar.style.width = "100%";
      return;
    }

    const remaining = Math.max(0, expiresAt - now);
    const total = Math.max(1, expiresAt - createdAt);
    label.textContent = formatRemaining(remaining);
    bar.style.width = `${Math.max(4, Math.round((remaining / total) * 100))}%`;
  }
}

function renderMessages() {
  messagesEl.innerHTML = "";
  messageCount.textContent = `${messages.length} ${messages.length === 1 ? "note" : "notes"}`;
  copyAllButton.disabled = messages.length === 0;
  clearRoomButton.disabled = messages.length === 0;

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = currentRoomId === "public"
      ? "No shared text yet. Start the public room with the first message."
      : "This private room is empty. Share a message to start the conversation.";
    messagesEl.append(empty);
    return;
  }

  for (const message of messages.slice().reverse()) {
    const node = template.content.firstElementChild.cloneNode(true);
    const avatar = node.querySelector(".avatar");
    const author = node.querySelector(".author");
    const timestamp = node.querySelector(".timestamp");
    const text = node.querySelector(".message-text");
    const expiresLabel = node.querySelector(".expires-label");
    const editForm = node.querySelector(".edit-form");
    const editInput = editForm.querySelector("textarea");
    const copyButton = node.querySelector(".copy-message");
    const editButton = node.querySelector(".edit-message");
    const cancelButton = node.querySelector(".cancel-edit");
    const deleteButton = node.querySelector(".delete-message");

    avatar.style.background = message.authorColor || "#0b7a75";
    node.dataset.createdAt = message.createdAt;
    node.dataset.expiresAt = message.expiresAt || "";
    author.textContent = message.authorName || "Guest";
    timestamp.textContent = message.updatedAt !== message.createdAt
      ? `Edited ${formatTime(message.updatedAt)}`
      : `Shared ${formatTime(message.createdAt)}`;
    text.textContent = message.text;
    editInput.value = message.text;
    expiresLabel.textContent = message.expiresAt ? "Calculating..." : "Kept until deleted";

    copyButton.addEventListener("click", () => {
      copyText(formatMessageForCopy(message), copyButton);
    });

    editButton.addEventListener("click", () => {
      editForm.hidden = false;
      text.hidden = true;
      editInput.focus();
    });

    cancelButton.addEventListener("click", () => {
      editForm.hidden = true;
      text.hidden = false;
      editInput.value = message.text;
    });

    editForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextText = editInput.value.trim();
      if (!nextText) return;
      send({ type: "update", id: message.id, text: nextText });
    });

    deleteButton.addEventListener("click", () => {
      send({ type: "delete", id: message.id });
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
    avatar.style.background = draft.authorColor || "#0b7a75";

    const body = document.createElement("div");
    const heading = document.createElement("strong");
    const text = document.createElement("p");

    heading.textContent = `${draft.authorName || "Guest"} is typing live`;
    text.textContent = draft.text;

    body.append(heading, text);
    item.append(avatar, body);
    typingPreviews.append(item);
  }
}

function updateOwnLivePreview() {
  const text = messageInput.value.trim();
  livePreview.hidden = !text;
  livePreviewText.textContent = text;
}

function sendTypingSoon() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    send({ type: "typing", text: messageInput.value });
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
    avatar.style.background = user.color || "#0b7a75";

    const name = document.createElement("span");
    name.textContent = user.id === clientId ? `${user.name} (you)` : user.name;

    item.append(avatar, name);
    peopleList.append(item);
  }
}

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

copyAllButton.addEventListener("click", () => {
  const text = messages
    .slice()
    .sort((first, second) => first.createdAt - second.createdAt)
    .map(formatMessageForCopy)
    .join("\n\n");

  copyText(text, copyAllButton);
});

newRoomButton.addEventListener("click", () => {
  const roomId = generateRoomId();
  currentRoomId = roomId;
  updateRoomUi();
  copyText(roomLink.value, newRoomButton);
  switchRoom(roomId);
});

defaultRoomButton.addEventListener("click", () => {
  switchRoom("public");
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
  charCount.textContent = `${messageInput.value.length} / 800`;
  updateOwnLivePreview();
  updateSendState();
  saveDraftSoon();
  sendTypingSoon();
});

messageInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !shareButton.disabled) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

window.addEventListener("beforeunload", saveDraft);

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  if (!send({ type: "create", text, expiresInMs: Number(expirySelect.value) })) {
    showToast("Waiting for the live connection before sharing.");
    return;
  }

  messageInput.value = "";
  charCount.textContent = "0 / 800";
  updateOwnLivePreview();
  saveDraft();
  updateSendState();
  send({ type: "typing", text: "" });
  showToast("Shared with everyone in this room.");
  messageInput.focus();
});

clearRoomButton.addEventListener("click", () => {
  if (messages.length === 0) return;

  if (!window.confirm("Clear every message in this room for everyone connected?")) return;

  if (send({ type: "clear" })) {
    showToast("The room has been cleared.");
  }
});

const savedExpiry = localStorage.getItem("share-text-live:expiry");
if (savedExpiry && [...expirySelect.options].some((option) => option.value === savedExpiry)) {
  expirySelect.value = savedExpiry;
}

connect();
setInterval(updateCountdowns, 1000);
