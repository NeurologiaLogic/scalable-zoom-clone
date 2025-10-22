# 🛰️ Project Hyperion: A Scalable Real-Time Video Communication Platform

## 1. Synopsis
**Project Hyperion** is an architectural blueprint and proof-of-concept for building a highly scalable video conferencing application — similar to **Zoom** or **Google Meet**.  
The goal is not just to create a working prototype, but to **deeply understand and solve** the common scalability challenges in real-time communication systems.

This document outlines:
- The problems with naïve architectures.
- A robust, distributed system design.
- A clear implementation plan using:
  - **Electron** for the frontend,
  - **LiveKit (SFU)** for media handling,
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

**Chosen SFU:** [LiveKit](https://livekit.io/)  
> Open-source, full-stack WebRTC platform with built-in SFU, signaling, and SDKs.

---

### ✅ Solution II: Horizontally Scaled Signaling with Kafka

To scale signaling servers, we use **Kafka** as the message bus.

#### Architecture:
- Multiple **stateless** `Node.js + Socket.IO` servers behind a load balancer.
- Each server communicates via **Kafka topics**.

#### How It Works:
1. Server 1 publishes a message to `signaling-room-abc-123`.
2. Other servers (Server 2, Server 3, etc.) subscribed to the same topic forward it to connected clients in that room.

#### Benefits:
- **Horizontal Scalability** – add/remove signaling servers easily.
- **Resilience** – if one server fails, clients reconnect to another automatically.

---

### 🧠 Kafka as the Event-Driven Backbone

Kafka isn’t just a message queue — it’s a **persistent, ordered event log**.

We’ll use it for:
- **Chat:** Messages go to `chat-messages-room-xyz` → persistent & replayable.
- **System Events:** Actions like `user-joined`, `user-muted`, `meeting-ended`.
- **Future Services:** Recording, analytics, transcription — all can subscribe to these topics without touching the core app.

---

## 4. Development Plan

### 🏗️ Phase 1: Core Infrastructure Setup
- [ ] Deploy a **Kafka cluster** (Docker Compose)
- [ ] Deploy a **LiveKit SFU instance** (Docker)
- [ ] Initialize **Node.js signaling service**

### 🎥 Phase 2: Signaling and Media
- [ ] Create **Electron** app shell  
- [ ] Integrate **LiveKit Client SDK**  
- [ ] Connect to room → publish local video → subscribe to remote streams

### 🔄 Phase 3: Extending with Kafka
- [ ] Implement **real-time chat** via Kafka  
- [ ] Implement **presence and events** (`User X joined`, `User Y muted`, etc.)

---

## ⚙️ Tech Stack

| Component | Technology |
|------------|-------------|
| **Client Application** | Electron |
| **Real-Time Media** | WebRTC (via LiveKit SDK) |
| **Media Server (SFU)** | LiveKit |
| **Signaling & Event Bus** | Node.js + Socket.IO + Apache Kafka |

---

## ⏱️ Feasibility: Can This Be Built in 4 Hours?

| Component | Task | Feasible in 4h? | Notes |
|------------|------|-----------------|-------|
| **LiveKit setup (Docker)** | Launch local SFU | ✅ | Prebuilt Docker image available; 15–20 mins |
| **Kafka cluster setup** | Basic Compose setup | ✅ | Use Bitnami image; quick for local dev |
| **Signaling server** | Simple Socket.IO + Kafka bridge | ✅ | AI can scaffold basic pub/sub handler |
| **Electron client** | Basic UI + connect to LiveKit | ✅ | Using LiveKit JS SDK; minimal layout |
| **Chat via Kafka** | Basic send/receive demo | ⚠️ Partial | Feasible only for one room prototype |
| **Full distributed resilience test** | ❌ | Requires multiple nodes, load testing |
| **Production readiness (security, monitoring)** | ❌ | Out of scope for 4h POC |

### ✅ **Conclusion**
Yes — a **proof-of-concept prototype** (single room, basic signaling, LiveKit working, Kafka for chat) **is achievable in 4 hours with AI help**.  
However, full distributed scaling, multi-node orchestration, and resilience testing would require **1–2 additional days**.
