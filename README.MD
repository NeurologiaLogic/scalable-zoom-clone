# 🛰️ Project Hyperion: A Scalable Real-Time Video Communication Platform

## 1. Synopsis
**Project Hyperion** is an architectural blueprint and proof-of-concept for building a highly scalable video conferencing application — similar to **Zoom** or **Google Meet**. 🚀
The goal is not just to create a working prototype, but to **deeply understand and solve** the common scalability challenges in real-time communication systems.

This document outlines:
- The problems with naïve architectures.
- A robust, distributed system design.
- A clear implementation plan using:
  - **Electron** for the frontend,
  - **Mediasoup (SFU)** for media handling,
  - **Apache Kafka** for signaling and events.

---

## 2. The Problem: Pitfalls of Simple Real-Time Architectures

### 🚨 Problem I: The "N² Problem" of Peer-to-Peer (P2P) Connections
In a pure P2P mesh:
- Every participant connects directly to every other participant.

Example:
- 3 users → manageable
- 10 users → 9 simultaneous connections each
- 200 users → 199 incoming + 199 outgoing streams 😵

This creates two major bottlenecks:

#### **Upload Bandwidth Saturation**
A user must upload their video to all peers. With limited upstream bandwidth, this quickly becomes impossible.

#### **CPU Overload**
Encoding/decoding hundreds of streams crushes the client’s CPU, leading to crashes or lag.

> **Conclusion:**
> P2P mesh is only viable for very small calls. It breaks down exponentially as users increase.

---

### ⚠️ Problem II: The Scaling Wall of a Centralized WebSocket Server
A simple **Node.js + Socket.IO** signaling server helps peers connect — but introduces new problems:

- **Single Point of Failure (SPOF)** — if one server crashes, the system dies.
- **Vertical Scaling Limits** — a single server can only hold so many WebSocket connections.
- **Multi-Instance Problem** — if User A connects to Server 1 and User B connects to Server 2, how do they talk? Without coordination, they can’t.

---

## 3. Our Solution: A Distributed, Scalable Architecture

### ✅ Solution I: The Selective Forwarding Unit (SFU)
Replace P2P with a **Selective Forwarding Unit**.

How it works:
1. Each user connects once to the SFU.
2. They send a single upstream video/audio stream.
3. The SFU redistributes that stream to other users.

Advantages:
- Each client only handles **1 upload** and **N-1 downloads**.
- Shifts the heavy lifting to a **dedicated media server**.

**Chosen SFU:** [Mediasoup](https://mediasoup.org/)
> Open-source, high-performance WebRTC SFU library.

---

### ✅ Solution II: Horizontally Scaled Signaling with Kafka

To scale signaling servers, we use **Kafka** as the message bus.

#### Architecture:
- Multiple **stateless** `Node.js + Socket.IO` servers behind a load balancer.
- Each server communicates via **Kafka topics**.

#### How It Works:
1. Server 1 receives a message (e.g., 'joinRoom') from Client A.
2. Server 1 publishes relevant events (e.g., `user-joined`) to a specific Kafka topic (e.g., `room-events-<roomId>`).
3. Other servers (Server 2, Server 3, etc.) subscribed to the same topic receive the event.
4. Server 2 forwards the event to its connected Client B in the same room via Socket.IO.

#### Benefits:
- **Horizontal Scalability** – add/remove signaling servers easily.
- **Resilience** – if one server fails, clients reconnect to another automatically.
- **Decoupling** - Signaling logic is separated from direct server-to-server communication.

---

### 🧠 Kafka as the Event-Driven Backbone

Kafka isn’t just a message queue — it’s a **persistent, ordered event log**. 📜

We’ll use it for:
- **Signaling Distribution:** Broadcasting events like `new-producer`, `producer-closed` across signaling instances.
- **Chat:** Messages go to `chat-messages-<roomId>` → persistent & replayable.
- **System Events:** Actions like `user-joined`, `user-left`, `user-muted`, `meeting-ended`.
- **Future Services:** Recording, analytics, transcription — all can subscribe to these topics without touching the core signaling/media flow.

---

## 4. Development Plan 🗺️

This plan outlines the key stages to build the Hyperion prototype, focusing on demonstrating the core architecture first.

### 🏗️ Phase 1: Foundational Infrastructure (Completed ✅)
*Goal: Set up the essential backend services and basic communication channels.*
* [✅] **Docker Environment:** Configure `docker-compose.yml` for all services.
* [✅] **Kafka Cluster:** Deploy Kafka (single node sufficient for initial dev) using Docker.
* [✅] **Redis Instance:** Deploy Redis for caching/state management using Docker.
* [✅] **Load Balancer:** Set up Nginx or Caddy for future scaling (even if pointing to one instance initially).
* [✅] **Basic Signaling Server:** Initialize Node.js + Socket.IO service, confirm basic WebSocket connections.

---

### 🎬 Phase 2: Core Media Flow - Single Node MVP (Completed ✅)
*Goal: Get a single user sending and receiving their own video via one SFU instance.*
* [✅] **Electron Client Shell:** Create the basic Electron application window and structure.
* [✅] **Mediasoup Server Integration:** Implement server-side logic to create Mediasoup Workers and Routers.
* [✅] **Mediasoup Client Integration:** Integrate `mediasoup-client` SDK in Electron.
* [✅] **Transport Establishment:** Implement signaling for creating WebRTC transports (send and receive) between client and server.
* [✅] **Local Media Publishing:** Connect to a room, get user media (mic/camera), and publish tracks via the send transport.
* [✅] **Basic Loopback/Subscription:** Subscribe to the user's *own* published tracks via the receive transport (simple test).

---

### 🔄 Phase 3: Multi-User Communication & Kafka Integration
*Goal: Enable multiple users in the same room to see each other, using Kafka for signaling between server instances.*
* [ ] **Kafka Pub/Sub:** Integrate Kafka producer/consumer logic into the signaling server(s).
* [ ] **Mediasoup pipeRouter()** Enables SFU communication on different servers
* [ ] **Distributed Signaling:** Refactor signaling logic (`joinRoom`, `newProducer`, `consume`, etc.) to publish events to Kafka topics (e.g., `room-events-<roomId>`).
* [ ] **Signaling Consumption:** Implement Kafka consumers in signaling servers to listen for relevant room events and forward them to connected Socket.IO clients.
* [ ] **Remote Media Subscription:** Client logic to receive `new-producer` events (via Kafka->Socket.IO) and create consumers for remote tracks.
* [ ] **Multi-User UI:** Update Electron UI to dynamically display video elements for multiple participants.

---

### ✨ Phase 4: Core Features & Scalability Demonstration
*Goal: Implement essential features leveraging the event-driven architecture and demonstrate basic multi-instance signaling.*
* [ ] **Presence Tracking:** Implement user online/offline status using Redis for state and Kafka for broadcasting join/leave events.
* [ ] **Basic Chat:** Implement simple text chat using Kafka topics for message persistence and distribution.
* [ ] *(Optional)* **Multi-Signaling Instance Test:** Run 2+ signaling server containers locally behind the load balancer to verify Kafka-based communication works.

---

### 🚀 Phase 5: Future Enhancements & True Scaling
*Goal: Outline next steps for production readiness and advanced capabilities.*
* [ ] **Multi-SFU Architecture:** Design and implement logic for distributing users/rooms across multiple Mediasoup instances (requires careful state management and potentially inter-SFU routing).
* [ ] **Geo-Distribution:** Deploy infrastructure across multiple regions.
* [ ] **Monitoring & Metrics:** Integrate robust logging, monitoring (Prometheus, Grafana), and alerting.
* [ ] **Advanced Features:** Screen sharing, recording, transcription, reactions, etc.
* [ ] **Security Hardening:** Authentication, authorization, rate limiting, etc.

---

## ⚙️ Tech Stack

| Component             | Technology                         | Purpose                                  |
| :-------------------- | :--------------------------------- | :--------------------------------------- |
| **Client Application** | Electron (Node.js, Chromium)     | Cross-platform desktop application shell |
| **Real-Time Media** | WebRTC                             | Browser standard for P2P media         |
| **Media Server (SFU)** | Mediasoup (Node.js/C++)            | Efficiently routes media streams           |
| **Signaling Server** | Node.js + Socket.IO                | Handles WebSocket connections, API       |
| **Event Bus / Message Queue** | Apache Kafka                       | Decouples signaling, enables scaling   |
| **State / Cache** | Redis                              | Stores transient state (e.g., presence) |
| **Load Balancer** | Nginx / Caddy                      | Distributes client connections         |
| **Containerization** | Docker / Docker Compose            | Manages deployment environment           |

---

## ⏱️ Component Responsibilities & Complexity

This table breaks down the effort involved in building and integrating the core parts of the system.

| Component / Area        | Key Tasks                                                                  | Technologies Involved                       | Estimated Complexity | Key Challenges / Notes                                       |
| :---------------------- | :------------------------------------------------------------------------- | :------------------------------------------ | :------------------- | :----------------------------------------------------------- |
| **Infrastructure** | Docker Compose setup, Network config (`ANNOUNCED_IP`), Basic LB setup      | Docker, Nginx/Caddy, Kafka/Zookeeper Images | **Low** | Correct Docker networking is crucial.                        |
| **Signaling Server** | Socket.IO connection handling, Room logic, Kafka integration (Pub/Sub)   | Node.js, Socket.IO, `kafkajs`             | **Medium** | Managing state across stateless instances, Kafka error handling. |
| **Media Server (SFU)** | Mediasoup setup, Router/Transport/Producer/Consumer management             | Mediasoup Node.js library                 | **Medium-High** | Understanding Mediasoup API, WebRTC concepts, debugging media. |
| **Client Application** | Electron shell, UI layout, Signaling connection, Mediasoup Client SDK usage | Electron, HTML/CSS/JS, `mediasoup-client` | **Medium** | Dynamic UI for peers, handling getUserMedia/tracks.        |
| **Core Features** | Presence (Redis + Kafka events), Chat (Kafka topics)                       | Redis client (`ioredis`), `kafkajs`         | **Medium** | Designing robust event schemas, managing state consistency.  |
| **Scalability Design** | Ensuring signaling statelessness, *Planning* for multi-SFU (if needed)     | Architectural Design, Kafka               | **High (for multi-SFU)** | Requires careful planning, state synchronization strategy. |