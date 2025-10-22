// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Kafka } = require('kafkajs');
const mediasoup = require("mediasoup");
const os = require('os');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname + '/dist'));


// ---------------- Redis ----------------
// !docker
const redis = new Redis({ host: 'redis', port: 6379 });

// ---------------- Kafka ----------------
// !docker
const kafka = new Kafka({
  clientId: 'hyperion-signaling',
  brokers: ['kafka1:9094']
});


const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'hyperion-signaling-group' });

// ---------------- Mediasoup Workers ----------------
const numWorkers = os.cpus().length/3;
const workers = [];
const localRouters = {}; // roomId -> router locally
const localTransports = {};   // localTransports[roomId] = { transportId: transportObj, ... }
const localProducers = {};    // localProducers[roomId] = { producerId: producerObj, ... }
const localConsumers = {};    // localConsumers[roomId] = { consumerId: consumerObj, ... }

async function spawnWorker() {
  const worker = await mediasoup.createWorker();
  worker.on('died', () => {
    console.error('Worker died, respawning in 2s...');
    setTimeout(spawnWorker, 2000);
  });
  workers.push(worker);
  return worker;
}
(async () => { for (let i = 0; i < numWorkers; i++) await spawnWorker(); })();

let workerIndex = 0;
function assignWorker() {
  const worker = workers[workerIndex % workers.length];
  workerIndex++;
  return worker;
}

// ---------------- Mediasoup Helper ----------------
function getMediasoupCodecs() {
  return [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
  ];
}

async function createWebRtcTransport(router) {
  return await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP || '127.0.0.1' }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
}

// ---------------- Kafka Handlers ----------------
async function handleCreateTransport(roomId, payload) {
  const roomRaw = await redis.get(`room:${roomId}`);
  if (!roomRaw) return;
  const room = JSON.parse(roomRaw);

  const router = localRouters[roomId];
  if (!router) return;

  const transport = await createWebRtcTransport(router);
  room.peers[payload.peerId].transports.push({ id: transport.id, direction: payload.direction });

  await redis.set(`room:${roomId}`, JSON.stringify(room));

  //direction is just for info
  io.to(payload.peerId).emit('transport-created', {
    direction: payload.direction,
    ...transport
  });
}


async function handleConnectTransport(roomId, payload) {
  const roomRaw = await redis.get(`room:${roomId}`);
  if (!roomRaw) return;
  const room = JSON.parse(roomRaw);

  const router = localRouters[roomId];
  if (!router) return;

  // Map transportId -> transport object locally
  const localTransport = router.transports.find(t => t.id === payload.transportId);
  if (!localTransport) return;

  await localTransport.connect({ dtlsParameters: payload.dtlsParameters });

  // sending confirmation that the transport is connected
  io.to(payload.peerId).emit('connect-transport-ok');
}

async function handleProduce(roomId, payload) {
  const roomRaw = await redis.get(`room:${roomId}`);
  if (!roomRaw) return;
  const room = JSON.parse(roomRaw);

  const router = localRouters[roomId];
  if (!router) return;

  const sendTransportId = room.peers[payload.peerId].transports.find(t => t.direction === 'send').id;
  const localTransport = router._transports?.find(t => t.id === sendTransportId);
  if (!localTransport) return;

  const producerObj = await localTransport.produce({
    kind: payload.kind,
    rtpParameters: payload.rtpParameters
  });

  room.peers[payload.peerId].producers.push(producerObj.id);
  await redis.set(`room:${roomId}`, JSON.stringify(room));

  // ✅ Confirm back to sender (to trigger mediasoup callback)
  io.to(payload.peerId).emit('produce-ok', { id: producerObj.id });

  // ✅ Notify other peers of new producer
  for (const id in room.peers) {
    if (id !== payload.peerId) {
      io.to(id).emit('new-producer', {
        producerId: producerObj.id,
        peerId: payload.peerId,
        kind: payload.kind,
        peerName: room.peers[payload.peerId].name
      });
    }
  }
}


async function handleConsume(roomId, payload) {
  const roomRaw = await redis.get(`room:${roomId}`);
  if (!roomRaw) return;
  const room = JSON.parse(roomRaw);

  const router = localRouters[roomId];
  if (!router) return;

  if (!router.canConsume({ producerId: payload.producerId, rtpCapabilities: payload.rtpCapabilities })) return;

  const recvTransportId = room.peers[payload.peerId].transports.find(t => t.direction === 'recv').id;
  const localTransport = router.transports.find(t => t.id === recvTransportId);
  if (!localTransport) return;

  const consumer = await localTransport.consume({
    producerId: payload.producerId,
    rtpCapabilities: payload.rtpCapabilities,
    paused: false
  });

  room.peers[payload.peerId].consumers.push(consumer.id);
  await redis.set(`room:${roomId}`, JSON.stringify(room));

  io.to(payload.peerId).emit('consume-success', {
    id: consumer.id,
    producerId: payload.producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters
  });
}

// ---------------- Kafka Init ----------------
async function initKafka() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: /signaling-room-/, fromBeginning: false });

  consumer.run({
    eachMessage: async ({ topic, message }) => {
      const payload = JSON.parse(message.value.toString());
      const roomId = topic.replace('signaling-room-', '');
      switch (payload.type) {
        case 'join': io.to(payload.peerId).emit('peer-joined', payload); break;
        case 'create-transport': await handleCreateTransport(roomId, payload); break;
        case 'connect-transport': await handleConnectTransport(roomId, payload); break;
        case 'produce': await handleProduce(roomId, payload); break;
        case 'consume': await handleConsume(roomId, payload); break;
        case 'leave': io.to(payload.peerId).emit('peer-left', payload); break;
      }
    }
  });
}
initKafka().catch(console.error);

// ---------------- Socket.IO ----------------
io.on('connection', socket => {
  console.log('Client connected', socket.id);

  socket.on('join', async ({ roomId, peerName }) => {
    try {
        // Ensure router exists locally for this room
        if (!localRouters[roomId]) {
            const worker = assignWorker();
            const router = await worker.createRouter({ mediaCodecs: getMediasoupCodecs() });
            localRouters[roomId] = router;
            // init local maps
            localTransports[roomId] = {};
            localProducers[roomId] = {};
            localConsumers[roomId] = {};
        }

        // Ensure room exists in Redis and add this peer
        let roomRaw = await redis.get(`room:${roomId}`);
        let room = roomRaw ? JSON.parse(roomRaw) : null;
        if (!room) room = { peers: {} };

        room.peers[socket.id] = { id: socket.id, name: peerName || 'Peer', transports: [], producers: [], consumers: [] };
        await redis.set(`room:${roomId}`, JSON.stringify(room));

        // Join socket.io room locally for convenience
        socket.join(roomId);

        // Notify others via Kafka (optional) — keeps other instances aware.
        await producer.send({
        topic: `signaling-room-${roomId}`,
        messages: [{ value: JSON.stringify({ type: 'join', roomId, peerId: socket.id, peerName }) }]
        });

        // Ack to client
        socket.emit('joined', { roomId, peerId: socket.id });

    } catch (err) {
        console.error('Join handler error', err);
        socket.emit('error', { message: 'join-failed', detail: err.message });
    }
    });



  //2. Create transport for sending and receiving
    socket.on('create-transport', async ({ roomId, direction }) => {
    try {
        // Ensure room exists in Redis
        const roomRaw = await redis.get(`room:${roomId}`);
        if (!roomRaw) return socket.emit('error', { message: 'room-not-found' });

        const router = localRouters[roomId];
        if (!router) return socket.emit('error', { message: 'router-not-on-this-node' });

        // Create the transport locally
        const transport = await createWebRtcTransport(router);

        // store locally
        localTransports[roomId] = localTransports[roomId] || {};
        localTransports[roomId][transport.id] = transport;

        // update Redis room metadata
        const room = JSON.parse(roomRaw);
        room.peers[socket.id] = room.peers[socket.id] || { id: socket.id, name: 'Peer', transports: [], producers: [], consumers: [] };
        room.peers[socket.id].transports.push({ id: transport.id, direction });
        await redis.set(`room:${roomId}`, JSON.stringify(room));

        // send transport info to this client
        socket.emit('transport-created', {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            direction
        });

        // Publish Kafka message to inform other instances that peer X created a transport (optional)
        // recommend message is informational so other instances can update UI if needed
        await producer.send({
        topic: `signaling-room-${roomId}`,
        messages: [{ value: JSON.stringify({ type: 'transport-created-notify', roomId, peerId: socket.id, transportId: transport.id, direction }) }]
        });

    } catch (err) {
        console.error('create-transport handler error', err);
        socket.emit('error', { message: 'create-transport-failed', detail: err.message });
    }
    });


  //3. After getting the transport informaton, connect it
  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }) => {
    try {
        const transport = (localTransports[roomId] || {})[transportId];
        if (!transport) {
        console.warn('connect-transport: transport not found locally', roomId, transportId);
        return socket.emit('error', { message: 'transport-not-found' });
        }

        await transport.connect({ dtlsParameters });

        // confirm to client (so the client's callback can be called)
        socket.emit('connect-transport-ok', { transportId });

        // optionally publish Kafka message (informational)
        await producer.send({
        topic: `signaling-room-${roomId}`,
        messages: [{ value: JSON.stringify({ type: 'transport-connected-notify', roomId, peerId: socket.id, transportId }) }]
        });

    } catch (err) {
        console.error('connect-transport error', err);
        socket.emit('connect-transport-failed', { reason: err.message });
    }
    });


  socket.on('produce', async ({ roomId, kind, rtpParameters }) => {
    try {
        const roomRaw = await redis.get(`room:${roomId}`);
        if (!roomRaw) return socket.emit('error', { message: 'room-not-found' });
        const room = JSON.parse(roomRaw);

        // find the send transport id for this peer
        const sendMeta = room.peers[socket.id].transports.find(t => t.direction === 'send');
        if (!sendMeta) return socket.emit('error', { message: 'send-transport-not-found' });

        const sendTransport = localTransports[roomId] && localTransports[roomId][sendMeta.id];
        if (!sendTransport) return socket.emit('error', { message: 'send-transport-local-not-found' });

        const producerObj = await sendTransport.produce({ kind, rtpParameters });

        // store locally
        localProducers[roomId] = localProducers[roomId] || {};
        localProducers[roomId][producerObj.id] = producerObj;

        // update redis
        room.peers[socket.id].producers.push(producerObj.id);
        await redis.set(`room:${roomId}`, JSON.stringify(room));

        // confirm to producing client so mediasoup-client callback can continue
        socket.emit('produce-ok', { id: producerObj.id });

        // notify other clients in the room (via socket.io directly)
        for (const peerSocketId in room.peers) {
        if (peerSocketId !== socket.id) {
            io.to(peerSocketId).emit('new-producer', {
            producerId: producerObj.id,
            peerId: socket.id,
            kind,
            peerName: room.peers[socket.id].name
            });
        }
        }

        // publish Kafka message for other instances to be informed (optional)
        await producer.send({
        topic: `signaling-room-${roomId}`,
        messages: [{ value: JSON.stringify({ type: 'produced', roomId, peerId: socket.id, producerId: producerObj.id, kind }) }]
        });

    } catch (err) {
        console.error('produce handler error', err);
        socket.emit('produce-failed', { reason: err.message });
    }
    });


    socket.on('consume', async ({ roomId, producerId, rtpCapabilities }) => {
    try {
        const router = localRouters[roomId];
        const recvTransport = Object.values(localTransports[roomId] || {}).find(
        t => t.appData && t.appData.direction === 'recv' && t.appData.peerId === socket.id
        );

        if (!router || !recvTransport) {
        console.error(`❌ Missing router or recv transport for room ${roomId}`);
        return;
        }

        if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.error(`❌ Router cannot consume producer ${producerId}`);
        return;
        }

        const consumer = await recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: false
        });

        // Store consumer
        if (!localConsumers[roomId]) localConsumers[roomId] = {};
        localConsumers[roomId][consumer.id] = consumer;

        // Send back consumer info
        socket.emit('consume-success', {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
        });

        console.log(`✅ Consumer created for ${producerId} in room ${roomId}`);
    } catch (err) {
        console.error('❌ Failed to handle consume:', err);
    }
    });


    socket.on('disconnect', async () => {
    try {
        const roomsRaw = await redis.keys('room:*');
        for (const rKey of roomsRaw) {
        const roomRaw = await redis.get(rKey);
        const room = JSON.parse(roomRaw);
        if (!room.peers[socket.id]) continue;

        // Close local objects if present
        const roomId = rKey.split(':')[1];

        // close local producers
        if (localProducers[roomId]) {
            for (const pid of room.peers[socket.id].producers || []) {
            const p = localProducers[roomId][pid];
            if (p) {
                try { await p.close(); } catch (e) { /* ignore */ }
                delete localProducers[roomId][pid];
            }
            }
        }

        // close local consumers
        if (localConsumers[roomId]) {
            for (const cid of room.peers[socket.id].consumers || []) {
            const c = localConsumers[roomId][cid];
            if (c) {
                try { await c.close(); } catch (e) { /* ignore */ }
                delete localConsumers[roomId][cid];
            }
            }
        }

        // close transports
        if (localTransports[roomId]) {
            for (const t of (room.peers[socket.id].transports || [])) {
            const tr = localTransports[roomId][t.id];
            if (tr) {
                try { await tr.close(); } catch (e) { /* ignore */ }
                delete localTransports[roomId][t.id];
            }
            }
        }

        // remove peer in Redis
        delete room.peers[socket.id];
        await redis.set(rKey, JSON.stringify(room));
        if (Object.keys(room.peers).length === 0) {
            await redis.del(rKey);
            delete localRouters[roomId];
        }

        await producer.send({
            topic: `signaling-room-${roomId}`,
            messages: [{ value: JSON.stringify({ type: 'leave', roomId, peerId: socket.id }) }]
        });
        }
    } catch (err) {
        console.error('disconnect cleanup error', err);
    }
    });

});

// ---------------- Express  ----------------
//When checking rtp capabilities we also check if the room we are trying to join is created or not,
//If not then we create and save it
// 1. Get RTP Capabilities
app.get("/getRtpCapabilities", async (req, res) => {
  try {
    const { roomId } = req.query;
    if (!roomId) return res.status(400).json({ error: "Missing roomId" });

    let roomRaw = await redis.get(`room:${roomId}`);
    let room = roomRaw ? JSON.parse(roomRaw) : null;

    // Create router if it doesn't exist locally
    if (!localRouters[roomId]) {
      const worker = assignWorker();
      const router = await worker.createRouter({ mediaCodecs: getMediasoupCodecs() });
      localRouters[roomId] = router;
    }

    // Ensure room exists in Redis
    if (!room) {
      room = { peers: {} };
      await redis.set(`room:${roomId}`, JSON.stringify(room));
    }

    const router = localRouters[roomId];
    if (!router) return res.status(500).json({ error: "Router not available" });

    return res.json(router.rtpCapabilities);

  } catch (err) {
    console.error("Error /getRtpCapabilities:", err);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Signaling server running on', PORT));
