# 🚀 Shareli

> **Ephemeral, zero-trace, end-to-end encrypted live text, voice notes, and file sharing with no database and no sign-up.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Encryption](https://img.shields.io/badge/Encryption-AES--GCM%20256--bit-blue.svg)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
[![Storage](https://img.shields.io/badge/Database-None%20(RAM--only)-red.svg)](#security--cryptographic-architecture)

---

## 🌐 Live Application

- **Primary Web App:** [https://shareli.online](https://shareli.online)
- **Static Mirror:** [https://shareli.in](https://shareli.in)

---

## ✨ Features

- 🔐 **End-to-End Encryption (E2EE):** AES-GCM 256-bit client-side encryption via WebCrypto API. Server never sees plaintext.
- 🎤 **Encrypted Voice Notes:** Record and transmit in-browser audio messages with inline playback.
- 📎 **File & Image Sharing:** Transfer images (with lightbox preview) and files up to 5MB.
- 📤 **Multi-File Upload:** Send multiple files in batch with real-time transfer progress.
- ⏱️ **Self-Destructing Timers:** 10s, 30s, 2m, 10m, or keep up to 6 hours. Spliced out of RAM upon expiry.
- 📌 **Message Pinning:** Pin crucial snippets or links to the top of the room.
- ✏️ **Edit & Delete:** Edit or remove your own messages in real time.
- 💬 **Live Typing Indicators:** Real-time character-by-character typing previews across connected peers.
- 📱 **QR Code Room Sync:** Instant cross-device pairing via QR code generation and built-in camera scanner.
- 🔒 **Password-Protected Rooms:** Client-side PBKDF2 (100,000 iterations) key derivation.
- 🌗 **Dark / Light Theme:** Seamless theme toggling with zero flash of unstyled content.
- 📲 **PWA Ready:** Installable to mobile and desktop home screens.
- 📋 **Markdown & Syntax Highlighting:** Auto-formatted code blocks for 190+ programming languages.

---

## 🔒 Security & Cryptographic Architecture

### 1. Client-Side Encryption
All encryption and decryption happens inside the user's browser using the native **WebCrypto API** (`crypto.subtle`). 
- **Cipher:** `AES-GCM` with a 256-bit key.
- **IV (Initialization Vector):** A fresh, cryptographically secure 12-byte random IV (`crypto.getRandomValues`) is generated for every single message, preventing replay attacks and pattern analysis.

### 2. URL Hash Key Distribution (Zero-Knowledge)
- In private rooms, the decryption key is embedded in the URL fragment: `https://shareli.online/#key=...`
- Per **RFC 3986**, URL hash fragments are handled exclusively by the client browser and are **never sent to the server** in HTTP request lines, headers, or WebSocket handshakes.
- The server physically cannot decrypt any payload it relays.

### 3. Password Rooms (PBKDF2)
When password protection is enabled, the encryption key is derived client-side using:
- **Algorithm:** PBKDF2 with SHA-256
- **Iterations:** 100,000 rounds
- **Salt:** Cryptographically bound to the unique room ID

### 4. Zero Database / RAM-Only Storage
- All room state and active connections live purely in the Node.js process memory (RAM).
- There is no SQL database, MongoDB, Redis, or disk storage for messages.
- When message timers expire or the server restarts, data is permanently erased.

---

## 🔍 How to Verify the Encryption (DIY)

You don't need to trust our claims — verify them directly in 10 seconds:

1. Open Shareli in your browser and press `F12` (or `Cmd+Option+I` on Mac) to open **Developer Tools**.
2. Navigate to the **Network** tab and filter by **WS** (WebSockets).
3. Send a message or file in a private room.
4. Click on the active WebSocket connection and inspect the transmitted frames:
   ```json
   {
     "type": "create",
     "text": "U2FsdGVkX1+vG8Z... [Encrypted AES-GCM Ciphertext]",
     "expiresInMs": 120000
   }
   ```
5. Notice that the server receives only raw ciphertext. Plaintext never leaves your machine.

---

## 🛠️ Local Development & Setup

Shareli is built with zero external runtime dependencies on the backend (pure native Node.js HTTP/WebSocket).

### Prerequisites
- Node.js `18.0.0` or higher

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/hidayashaikh86-tech/livetext.git
cd livetext

# Start the local server
npm start
```

Open your browser at `http://127.0.0.1:3000`.

### Local Network Sharing (Wi-Fi)
To test across devices on the same Wi-Fi network:

```bash
npm run start:lan
```

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | Optional | `3000` | Port for the HTTP and WebSocket server. |
| `ADMIN_SECRET` | Optional | `null` | Secret password for accessing `/admin` dashboard. |

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

## 👤 Author

**Md Hidayatullah Shaikh**
- Website: [https://shareli.online](https://shareli.online)
- GitHub: [@hidayashaikh86-tech](https://github.com/hidayashaikh86-tech)
