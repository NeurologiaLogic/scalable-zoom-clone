// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');
const Redis = require('ioredis');
const { default: Redlock } = require('redlock');

console.log('[BACKEND] starting server.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(__dirname + '/dist'));

// Redis + redlock (same as your code)
const redis = new Redis({ host: 'redis', port: 6379 });
let redlock;
const commonOptions = { retryCount: 5, retryDelay: 100, retryJitter: 50 };

try {
  redlock = new Redlock([redis], commonOptions);
} catch (e1) {
  try {
    redlock = new Redlock({ clients: [redis], ...commonOptions });
  } catch (e2) {
    console.error('[BACKEND] redlock construction failed', e1, e2);
    throw e2;
  }
}

// in-memory maps (per room)
const workers = [];
const localRouters = {};
const localTransports = {};
const localProducers = {};
const localConsumers = {};

function trace(tag, msg, data) {
  console.log(`[BACKEND][${tag}] ${msg}`, data || "");
}

async function spawnWorker() {
  trace('worker', 'creating mediasoup worker');
  const worker = await mediasoup.createWorker({
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    rtcMinPort: 10000,
    rtcMaxPort: 10100
  });

  worker.on('died', () => {
    trace('worker', 'worker died, respawning in 2s');
    setTimeout(() => spawnWorker().catch(e => console.error(e)), 2000);
  });

  workers.push(worker);
  trace('worker', 'worker spawned');
}


(async () => {
  const num = Math.max(1, Math.floor(os.cpus().length / 3));
  for (let i = 0; i < num; i++) await spawnWorker();
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
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const localIp = getLocalIPv4();
const announcedIp = process.env.ANNOUNCED_IP || localIp;
async function createWebRtcTransport(router, { direction, peerId }) {
  trace('transport', `createWebRtcTransport direction=${direction} peerId=${peerId}`);
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    appData: { direction, peerId },
    // ✅ add ICE servers here
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // { urls: 'turn:YOUR_TURN_SERVER', username: 'user', credential: 'pass' }, // optional TURN
    ],
  });
  trace('transport', `created transport id=${transport.id}`);
  return transport;
}

// Redis helpers (same but with trace)
async function safeAddPeer(roomId, peerId, peerData) {
  const key = `room:${roomId}`;
  const lockKey = `${key}:lock:${peerId}`;
  trace('redis', `safeAddPeer acquiring lock ${lockKey}`);
  const lock = await redlock.acquire([lockKey], 2000);
  try {
    const type = await redis.type(key);
    if (type !== 'hash' && type !== 'none') {
      trace('redis', `wrong redis type for ${key} (${type}), resetting`);
      await redis.del(key);
    }
    const exists = await redis.hexists(key, peerId);
    if (exists) {
      trace('redis', `peer ${peerId} already exists in ${key}`);
      return;
    }
    await redis.hset(key, peerId, JSON.stringify(peerData));
    trace('redis', `added peer ${peerId} to ${key}`);
  } finally {
    await lock.release().catch(() => trace('redis', 'lock release failed (ignored)'));
  }
}

async function safeUpdatePeer(roomId, peerId, updateFn) {
  const key = `room:${roomId}`;
  const lockKey = `${key}:lock:${peerId}`;
  trace('redis', `safeUpdatePeer acquiring lock ${lockKey}`);
  const lock = await redlock.acquire([lockKey], 2000);
  try {
    const raw = await redis.hget(key, peerId);
    const peerData = raw ? JSON.parse(raw) : { id: peerId, transports: [], producers: [], consumers: [] };
    const before = JSON.parse(JSON.stringify(peerData));
    updateFn(peerData);
    await redis.hset(key, peerId, JSON.stringify(peerData));
    trace('redis', `updated peer ${peerId} in ${key}`, { before, after: peerData });
    return peerData;
  } finally {
    await lock.release().catch(() => trace('redis', 'lock release failed (ignored)'));
  }
}


(async () => {
  console.log("[BACKEND][init] 🧹 Clearing mediasoup state in Redis...");
  const keys = await redis.keys("mediasoup:*"); // adjust your prefix
  if (keys.length > 0) {
    await redis.del(keys);
    console.log(`[BACKEND][init] ✅ Cleared ${keys.length} mediasoup keys`);
  } else {
    console.log("[BACKEND][init] ✅ No mediasoup keys found to clear");
  }
})();

// ------------------- Socket.IO -------------------
io.on('connection', (socket) => {
  trace('socket', 'client connected', socket.id);

  socket.on('join', async ({ roomId, peerName }) => {
    trace('join', `join requested by ${socket.id} name=${peerName} room=${roomId}`);
    try {
      if (!localRouters[roomId]) {
        const router = await assignWorker().createRouter({ mediaCodecs: getCodecs(),// ⚡ Add ICE servers here
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
          ], });
        localRouters[roomId] = router;
        localTransports[roomId] = {};
        localProducers[roomId] = {};
        localConsumers[roomId] = {};
        trace('join', `router created for room ${roomId}`);
      }
      await safeAddPeer(roomId, socket.id, { id: socket.id, name: peerName, transports: [], producers: [], consumers: [] });
      socket.join(roomId);
      socket.to(roomId).emit('peer-joined', { peerId: socket.id, peerName });
      trace('join', `peer ${socket.id} joined room ${roomId}`);
    } catch (e) {
      trace('join', 'join failed', e);
      socket.emit('error', { message: 'join-failed', detail: e.message });
    }
  });

  socket.on('create-transport', async ({ roomId, direction }) => {
    trace('transport', `create-transport request direction=${direction} from ${socket.id} room=${roomId}`);
    try {
      if (!localRouters[roomId]) {
        const router = await assignWorker().createRouter({ mediaCodecs: getCodecs() });
        localRouters[roomId] = router;
        localTransports[roomId] = {};
        localProducers[roomId] = {};
        localConsumers[roomId] = {};
        trace('transport', 'router created while creating transport');
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
      trace('transport', `transport-created emitted for ${direction} id=${transport.id}`);
    } catch (e) {
      trace('transport', 'create-transport failed', e);
      socket.emit('error', { message: 'transport-failed', detail: e.message });
    }
  });

  // Backend socket handler
  socket.on('connect-transport', ({ roomId, transportId, dtlsParameters }, callback) => {
    trace('transport', `connect-transport called for transport=${transportId} room=${roomId} by ${socket.id}`);

    const transport = localTransports[roomId][transportId];
    if (!transport) {
      trace('transport', 'transport object not found');
      return callback({ error: 'transport object not found' });
    }

    transport.connect({ dtlsParameters })
      .then(() => {
        trace('transport', `transport connected ${transportId}`);
        callback({ success: true });  // ✅ callback indicates success
      })
      .catch(err => {
        trace('transport', 'connect-transport failed', err);
        callback({ error: err.message });  // ✅ callback indicates failure
      });
  });


  socket.on('produce', async ({ roomId, kind, rtpParameters }, ack) => {
    trace('produce', `produce() from ${socket.id} kind=${kind} room=${roomId}`);
    try {
      const peerDataRaw = await redis.hget(`room:${roomId}`, socket.id);
      if (!peerDataRaw) throw new Error('Peer not found in room');
      const peerData = JSON.parse(peerDataRaw);

      const sendTransportMeta = peerData.transports.find(t => t.direction === 'send');
      if (!sendTransportMeta) throw new Error('No send transport for this peer');

      const sendTransport = localTransports[roomId][sendTransportMeta.id];
      if (!sendTransport) throw new Error('Send transport object not found');

      const producer = await sendTransport.produce({
        kind,
        rtpParameters,
        appData: { peerId: socket.id }
      });
      console.log('Producer created', producer.id, producer.kind, producer.rtpParameters.codecs);
      localProducers[roomId][producer.id] = producer;
      await safeUpdatePeer(roomId, socket.id, peer => peer.producers.push(producer.id));
      trace('produce', `producer created id=${producer.id}`);

      // notify other peers
      socket.to(roomId).emit('new-producer', {
        producerId: producer.id,
        peerId: socket.id,
        peerName: peerData.name || socket.id
      });

      // ✅ respond via acknowledgement
      ack({ id: producer.id });
    } catch (e) {
      trace('produce', 'produce failed', e);
      ack({ error: e.message });
    }
  });


  socket.on('consume', async ({ roomId, producerId, rtpCapabilities }, callback) => {
    trace('consume', `consume() request from ${socket.id} for producer ${producerId} in room ${roomId}`);

    try {
      const router = localRouters[roomId];
      if (!router) return callback({ error: 'no router', params: null });

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        trace('consume', `router cannot consume producer ${producerId}`);
        return callback({ error: 'cannot consume', params: null });
      }

      const peerDataRaw = await redis.hget(`room:${roomId}`, socket.id);
      if (!peerDataRaw) return callback({ error: 'peer not found', params: null });
      const peerData = JSON.parse(peerDataRaw);

      const recvTransportMeta = peerData.transports.find(t => t.direction === 'recv');
      if (!recvTransportMeta) return callback({ error: 'no recv transport', params: null });

      const recvTransport = localTransports[roomId]?.[recvTransportMeta.id];
      if (!recvTransport) return callback({ error: 'recv transport not found', params: null });

      const consumer = await recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true // <-- IMPORTANT: auto start playback
      });

      if (!localConsumers[roomId]) localConsumers[roomId] = {};
      localConsumers[roomId][consumer.id] = consumer;

      await safeUpdatePeer(roomId, socket.id, peer => peer.consumers.push(consumer.id));
      trace('consume', `consumer created id=${consumer.id} for producer ${producerId}`);

      callback({
        params: {
          id: consumer.id,
          producerId:consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        }
      });

      await consumer.resume();
           
      if (consumer.kind === 'video') {
        try {
          await consumer.requestKeyFrame(); // <-- THIS triggers the keyframe
          trace('consume', `Keyframe requested for consumer ${consumer.id}`);
        } catch (e) {
          trace('consume', 'Keyframe request failed', e);
        }
      }
    } catch (e) {
      trace('consume', 'consume error', e);
      callback({ error: e.message, params: null });
    }
  });



  socket.on('request-existing-producers', async ({ roomId }, callback) => {
    trace('socket', `request-existing-producers received from ${socket.id} for room ${roomId}`);

    try {
      const roomPeersRaw = await redis.hgetall(`room:${roomId}`);
      const existingProducers = [];

      for (const [pid, peerDataStr] of Object.entries(roomPeersRaw)) {
        if (pid === socket.id) continue; // skip self
        const peerData = JSON.parse(peerDataStr);

        for (const producerId of peerData.producers || []) {
          existingProducers.push({
            producerId,
            peerId: pid,
            peerName: peerData.name
          });
        }
      }

      trace('socket', 'existing producers compiled', existingProducers.map(p => p.producerId));

      // Return via callback
      callback({ params: existingProducers });
    } catch (e) {
      trace('socket', 'request-existing-producers failed', e);
      callback({ error: e.message, params: [] });
    }
  });


  socket.on('leave-room', async () => {
    trace('leave', `leave-room called by ${socket.id}`);
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
        trace('leave', `peer ${socket.id} removed from room ${roomId}`);
      }
    } catch (e) {
      trace('leave', 'leave-room failed', e);
    }
  });

  socket.on('disconnect', async () => {
    trace('socket', `disconnect detected for ${socket.id}`);
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
        trace('socket', `peer ${socket.id} cleaned up from room ${roomId}`);
      }
    } catch (e) {
      trace('socket', 'disconnect cleanup failed', e);
    }
  });
});

// RTP capabilities endpoint
app.get('/getRtpCapabilities', async (req, res) => {
  try {
    const roomId = req.query.roomId;
    if (!localRouters[roomId]) {
      const router = await assignWorker().createRouter({ mediaCodecs: getCodecs() });
      localRouters[roomId] = router;
      localTransports[roomId] = {};
      localProducers[roomId] = {};
      localConsumers[roomId] = {};
      trace('http', `router created for room ${roomId} on /getRtpCapabilities`);
    }
    res.json(localRouters[roomId].rtpCapabilities);
  } catch (e) {
    trace('http', 'getRtpCapabilities failed', e);
    res.status(500).json({ error: e.message });
  }
});

server.listen(3000, () => trace('system', 'Server listening on :3000'));
