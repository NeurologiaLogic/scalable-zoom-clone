// ------------------- Imports -------------------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');
const Redis = require('ioredis');
const Redlock = require("redlock")


// ------------------- Express + Socket.IO Setup -------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(__dirname + '/dist'));

const redis = new Redis({ host: 'redis', port: 6379 });
// Create a redlock instance (shared between all functions)
const redlock = new Redlock(
  [redis],
  {
    retryCount: 5,        // retry up to 5 times
    retryDelay: 100,      // wait 100ms between retries
    retryJitter: 50,      // add small randomness to avoid thundering herd
  }
);

// ------------------- Local In-Memory Stores -------------------
const workers = [];
const localRouters = {};
const localTransports = {};
const localProducers = {};
const localConsumers = {};

// ------------------- Worker -------------------
async function spawnWorker() {
  const worker = await mediasoup.createWorker();
  worker.on('died', () => setTimeout(spawnWorker, 2000));
  workers.push(worker);
  console.log('✅ Worker spawned');
}
(async () => {
  for (let i = 0; i < Math.max(1, Math.floor(os.cpus().length / 3)); i++) await spawnWorker();
})();
let workerIndex = 0;
function assignWorker() {
  const w = workers[workerIndex % workers.length];
  workerIndex++;
  return w;
}

function getCodecs() {
  return [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
  ];
}

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address; // e.g. "192.168.1.42"
      }
    }
  }
  return "127.0.0.1"; // fallback if not found
}

// ------------------- WebRTC Transport Creation -------------------
async function createWebRtcTransport(router, { direction, peerId }) {
  return router.createWebRtcTransport({
    listenIps: [
      {
        ip: '0.0.0.0', // where mediasoup listens
        announcedIp: process.env.ANNOUNCED_IP || getLocalIPv4() // public IP / domain
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    appData: { direction, peerId }
  });
}

// ------------------- Redis Helpers -------------------
/**
 * Adds a peer to a room in Redis atomically.
 * Uses WATCH + MULTI + EXEC to prevent race conditions.
 */
async function safeAddPeer(roomId, peerId, peerData) {
  const key = `room:${roomId}`;
  const lockKey = `${key}:lock:${peerId}`;
  const lock = await redlock.acquire([lockKey], 2000); // 2s lock TTL

  try {
    const type = await redis.type(key);
    if (type !== 'hash' && type !== 'none') {
      console.warn(`⚠️ Wrong Redis type for ${key} (${type}), resetting`);
      await redis.del(key);
    }

    const exists = await redis.hexists(key, peerId);
    if (exists) {
      console.log(`🟨 Peer ${peerId} already exists in ${key}, skipping add`);
      return;
    }

    await redis.hset(key, peerId, JSON.stringify(peerData));
    console.log(`🟩 Added peer ${peerId} to room ${roomId} (atomic)`);

  } finally {
    await lock.release().catch(() => {});
  }
}

/**
 * Safely updates peer data atomically.
 * Uses WATCH + MULTI + EXEC for concurrency safety.
 */
async function safeUpdatePeer(roomId, peerId, updateFn) {
  const key = `room:${roomId}`;
  const lockKey = `${key}:lock:${peerId}`;
  const lock = await redlock.acquire([lockKey], 2000);

  try {
    const raw = await redis.hget(key, peerId);
    const peerData = raw ? JSON.parse(raw) : { id: peerId, transports: [], producers: [], consumers: [] };

    if (!raw) {
      console.warn(`⚠️ Peer ${peerId} not found in ${key}, creating new entry`);
    }

    const before = JSON.parse(JSON.stringify(peerData));

    // Apply updates
    updateFn(peerData);

    await redis.hset(key, peerId, JSON.stringify(peerData));

    console.log(`🟦 Updated peer ${peerId} in ${key}`);
    console.log("├── Before:", before);
    console.log("└── After :", peerData);

    return peerData;
  } finally {
    await lock.release().catch(() => {});
  }
}

// ------------------- Socket.IO -------------------
io.on('connection', socket => {
  console.log('🔗 Client connected', socket.id);

  // ------------------- Join Room -------------------
  socket.on('join', async ({ roomId, peerName }) => {
    try {
      if (!localRouters[roomId]) {
        const router = await assignWorker().createRouter({ mediaCodecs: getCodecs() });
        localRouters[roomId] = router;
        localTransports[roomId] = {};
        localProducers[roomId] = {};
        localConsumers[roomId] = {};
      }

      await safeAddPeer(roomId, socket.id, {
        id: socket.id,
        name: peerName,
        transports: [],
        producers: [],
        consumers: []
      });

      socket.join(roomId);

      // -------- Get existing peers and producers --------
      const roomPeersRaw = await redis.hgetall(`room:${roomId}`);
      const existingProducers = [];

      for (const [pid, peerDataStr] of Object.entries(roomPeersRaw)) {
        const peerData = JSON.parse(peerDataStr);
        if (pid !== socket.id) {
          for (const producerId of peerData.producers || []) {
            existingProducers.push({
              producerId,
              peerId: pid,
              peerName: peerData.name
            });
          }
        }
      }

      if (existingProducers.length > 0) {
        for (const producer of existingProducers) {
          socket.emit('new-media-stream', producer);
        }
      }

      socket.to(roomId).emit('peer-joined', { peerId: socket.id, peerName });
      console.log('✅ Peer joined room', roomId);
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'join-failed', detail: err.message });
    }
  });

  // ------------------- Create Transport -------------------
  socket.on('create-transport', async ({ roomId, direction }) => {
    try {
      if (!localRouters[roomId]) {
        const router = await assignWorker().createRouter({ mediaCodecs: getCodecs() });
        localRouters[roomId] = router;
        localTransports[roomId] = {};
        localProducers[roomId] = {};
        localConsumers[roomId] = {};
      }

      const transport = await createWebRtcTransport(localRouters[roomId], { direction, peerId: socket.id });
      localTransports[roomId][transport.id] = transport;

      await safeUpdatePeer(roomId, socket.id, peer => {
        peer.transports.push({ id: transport.id, direction });
      });

      socket.emit('transport-created', {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        direction
      });
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'transport-failed', detail: err.message });
    }
  });

  // ------------------- Connect Transport -------------------
  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }) => {
    try {
      const transport = localTransports[roomId][transportId];
      await transport.connect({ dtlsParameters });
      socket.emit('connect-transport-ok', { transportId });
    } catch (err) {
      console.error(err);
      socket.emit('connect-transport-failed', { reason: err.message });
    }
  });

  // ------------------- Produce -------------------
  socket.on('produce', async ({ roomId, kind, rtpParameters }) => {
    try {
      const peerDataRaw = await redis.hget(`room:${roomId}`, socket.id);
      if (!peerDataRaw) throw new Error('Peer not found in room');
      const peerData = JSON.parse(peerDataRaw);

      const sendTransportMeta = peerData.transports.find(t => t.direction === 'send');
      if (!sendTransportMeta) throw new Error('No send transport for this peer');

      const sendTransport = localTransports[roomId][sendTransportMeta.id];
      if (!sendTransport) throw new Error('Send transport object not found');

      const producer = await sendTransport.produce({ kind, rtpParameters, appData: { peerId: socket.id } });
      localProducers[roomId][producer.id] = producer;

      await safeUpdatePeer(roomId, socket.id, peer => {
        peer.producers.push(producer.id);
      });

      socket.to(roomId).emit('new-media-stream', {
        producerId: producer.id,
        peerId: socket.id,
        peerName: peerData.name
      });

      socket.emit('produce-ok', { id: producer.id });
    } catch (err) {
      console.error(err);
      socket.emit('produce-failed', { reason: err.message });
    }
  });

  // ------------------- Consume -------------------
  socket.on('consume', async ({ roomId, producerId, rtpCapabilities }) => {
    try {
      const router = localRouters[roomId];
      const peerDataRaw = await redis.hget(`room:${roomId}`, socket.id);
      if (!peerDataRaw) return socket.emit('consume-failed', { reason: 'peer-not-found' });

      const peerData = JSON.parse(peerDataRaw);

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return socket.emit('consume-failed', { reason: 'cannot-consume' });
      }

      const recvTransportMeta = peerData.transports.find(t => t.direction === 'recv');
      if (!recvTransportMeta) throw new Error('No recv transport for this peer');

      const recvTransport = localTransports[roomId][recvTransportMeta.id];
      if (!recvTransport) throw new Error('Recv transport object not found');

      const consumer = await recvTransport.consume({ producerId, rtpCapabilities });
      localConsumers[roomId][consumer.id] = consumer;

      await safeUpdatePeer(roomId, socket.id, peer => peer.consumers.push(consumer.id));

      socket.emit('consume-success', {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (err) {
      console.error(err);
      socket.emit('consume-failed', { reason: err.message });
    }
  });

  // ------------------- Disconnect -------------------
  socket.on('disconnect', async () => {
    console.log('❌ Peer disconnected', socket.id);
    try {
      for (const roomId of Object.keys(localRouters)) {
        const peerDataRaw = await redis.hget(`room:${roomId}`, socket.id);
        if (!peerDataRaw) continue;
        const peerData = JSON.parse(peerDataRaw);

        if (peerData.producers) for (const pid of peerData.producers) localProducers[roomId][pid]?.close();
        if (peerData.consumers) for (const cid of peerData.consumers) localConsumers[roomId][cid]?.close();
        if (peerData.transports) for (const t of peerData.transports) localTransports[roomId][t.id]?.close();

        await redis.hdel(`room:${roomId}`, socket.id);
        socket.to(roomId).emit('peer-left', { peerId: socket.id });
      }
    } catch (err) {
      console.error(err);
    }
  });

  // ------------------- Leave Room -------------------
  socket.on('leave-room', async () => {
    console.log('❌ Peer Leave Room', socket.id);
    try {
      for (const roomId of Object.keys(localRouters)) {
        const peerDataRaw = await redis.hget(`room:${roomId}`, socket.id);
        if (!peerDataRaw) continue;
        const peerData = JSON.parse(peerDataRaw);

        if (peerData.producers) for (const pid of peerData.producers) localProducers[roomId][pid]?.close();
        if (peerData.consumers) for (const cid of peerData.consumers) localConsumers[roomId][cid]?.close();
        if (peerData.transports) for (const t of peerData.transports) localTransports[roomId][t.id]?.close();

        await redis.hdel(`room:${roomId}`, socket.id);
        socket.to(roomId).emit('peer-left', { peerId: socket.id });
      }
    } catch (err) {
      console.error(err);
    }
  });
});

// ------------------- RTP Capabilities -------------------
app.get('/getRtpCapabilities', async (req, res) => {
  const roomId = req.query.roomId;
  if (!localRouters[roomId]) {
    const router = await assignWorker().createRouter({ mediaCodecs: getCodecs() });
    localRouters[roomId] = router;
    localTransports[roomId] = {};
    localProducers[roomId] = {};
    localConsumers[roomId] = {};
  }
  res.json(localRouters[roomId].rtpCapabilities);
});

// ------------------- Start Server -------------------
server.listen(3000, () => console.log('🚀 Server listening on :3000'));
