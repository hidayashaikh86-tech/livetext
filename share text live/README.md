# Share Text Live

A live shared text room where everyone connected can add, edit, and delete text in real time.

## Features

- Connected people list
- Automatic public room connection when someone visits the site
- Private room links for inviting a specific group
- Live text sharing
- Live typing previews before a message is sent
- Copy individual messages
- Copy the full shared text board
- Message edit and delete controls for everyone
- Disappearing messages with 10 second, 30 second, 2 minute, and 10 minute options
- Optional "keep until deleted" messages
- Copyable room link

## Run locally

```bash
npm start
```

Open:

```text
http://127.0.0.1:3000
```

Do not open `public/index.html` directly from Finder. The page needs the Node server for live sharing.

## Let other devices on the same Wi-Fi connect

```bash
npm run start:lan
```

Then open your computer's local network address from another device, for example:

```text
http://192.168.1.25:3000
```

## Make it available from anywhere

Deploy this folder to a Node.js host such as Render, Railway, Fly.io, or a VPS. The server uses plain Node.js and does not need any package installation.

Current behavior: messages stay in memory while the server is running, then disappear based on the selected timer or when someone deletes them. For permanent history, connect the app to a database later.

The homepage URL joins the public room automatically. Use "New private room" in the app to create a separate invite link for a specific group.
Use "Default public room" to leave a private room and return to the shared public room.
