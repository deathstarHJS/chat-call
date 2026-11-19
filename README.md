# Pingr

A WhatsApp-style messaging web app: accounts, one-to-one chats, groups, and voice/video calls that work between different Wi-Fi and mobile networks.

## Files
- `server.js`: the Node server (no dependencies). Accounts, chats, messages, live updates, call signaling.
- `index.html`: the whole app (what people see in the browser).
- `package.json`: lets hosts run `npm start`.

## Features
- Sign up / log in. Passwords are hashed (scrypt); you stay logged in on your device.
- Search for people by username and start a chat; groups of up to 50 people (add people, leave).
- Unread counts, online status, message history saved on the server.
- Voice and video calls, 1:1 or group (up to 6 people), with ringing, accept/decline, mute and camera toggle.
- Works on phones and desktops (responsive).

## Run on your own computer
    node server.js
    # open http://localhost:3000 in two browser windows, sign up as two users

## Put it online (so it works on different Wi-Fi)
1. Upload these files to a GitHub repo and deploy as a Node web service (Render, Railway, Fly.io).
   Start command: `npm start`. You get an `https://` address; calls only work over https.
2. **Keep accounts and messages (important).** The server saves everything to a file at
   `DATA_DIR/db.json` (default: a `data` folder next to server.js). Free hosting plans usually
   wipe that folder when the app restarts or redeploys, which deletes all accounts and chats.
   To keep data, attach a persistent disk/volume to your service and set the environment
   variable `DATA_DIR` to its mount path (for example `/var/data`).
   - Render: disks are on paid plans. Fly.io and Railway offer volumes.
3. **Calls on strict networks (TURN).** Free Google STUN connects most home and phone networks.
   School/work Wi-Fi and some mobile carriers need a TURN relay. Get one from a provider
   (Metered, Twilio, Cloudflare) and set these environment variables:

       TURN_URL=turn:your.turn.host:3478,turns:your.turn.host:443?transport=tcp
       TURN_USER=username
       TURN_PASS=password

## Limits to know about
- Text messages only for now (no images/files, no read receipts, no push notifications when the tab is closed).
- Group calls are peer-to-peer mesh, fine for about 2-6 people.
- Storage is a single JSON file: great for friends and small groups, not for thousands of users.
