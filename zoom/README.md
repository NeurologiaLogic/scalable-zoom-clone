# Project Hyperion - Mediasoup POC Scaffold

This repository contains a minimal scaffold for **Project Hyperion** using **mediasoup** as the SFU, **Kafka** as the event bus, a Node.js signaling service, and a minimal Electron/static UI for testing.

## Structure
- `docker-compose.yml` - launches Zookeeper, Kafka, Mediasoup worker (example image), signaling server, and a static UI service.
- `server/` - Node.js signaling service (Socket.IO + Kafka scaffold; mediasoup integration points commented).
- `electron/` - minimal static UI (serves `static/index.html`); for real Electron development change accordingly.

## Quick start (local POC)

1. Build and run the backend:
```bash
docker compose up --build
```

2. Build and run the frontend:
```bash
cd ./zoom/electron && npm run start
```

3. Open the UI at `http://localhost:4000` and click **Join Room**.

<!-- ## Notes & Next Steps
- `mediasoup` requires native build tools and must be configured with real network settings, ICE servers, and transports. The server scaffold shows where to integrate mediasoup worker/router/transport logic.
- This scaffold uses Kafka for room-level signaling topics. Expand topics and consumers to implement chat history, system events, and more.
- For a fully working SFU test, follow mediasoup official quickstart to create router/transports and exchange SDP/ICE between client and server.

If you want, I can now:
- Implement the mediasoup router/transport creation flows in `server/index.js` (note: mediasoup native build required),
- Add client-side SDP/transport exchange in the UI,
- Or generate a zip of this scaffold so you can download it. -->
