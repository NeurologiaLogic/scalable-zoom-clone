// const express = require('express'); 
// const http = require('http');
// const { Server } = require('socket.io');
// const { Kafka } = require('kafkajs');
// const mediasoup = require('mediasoup');

// //  ----------------- App Setup  -----------------
// const app = express();
// const server = http.createServer(app);
// const io = new Server(server, { cors: { origin: '*' } });
// //  ----------------- End App Setup  -----------------


// //  ----------------- Frontend Routes  -----------------
// app.use(express.static('public'));
// //  ----------------- End Frontend Routes  -----------------


// //  ----------------- Kafka -----------------
// const kafka = new Kafka({ clientId: 'hyperion-signaling', brokers: [
//   `kafka1:9094`,
//   `kafka2:9095`,
//   `kafka3:9096`,
// ] });
// const producer = kafka.producer();
// const consumer = kafka.consumer({ groupId: 'hyperion-signaling-group' });

// async function initKafka() {
//   await producer.connect();
//   await consumer.connect();

//   // Retry subscribe until leader is available
//   let retries = 10;
//   while (retries > 0) {
//     try {
//       await consumer.subscribe({ topic: /signaling-room-/, fromBeginning: false });
//       break; // success
//     } catch (err) {
//       if (err.type === 'LEADER_NOT_AVAILABLE') {
//         console.log('Kafka leader not ready yet, retrying in 5s...');
//         await new Promise(res => setTimeout(res, 20000));
//         retries--;
//       } else {
//         continue
//       }
//     }
//   }

//   consumer.run({
//     eachMessage: async ({ topic, partition, message }) => {
//       const payload = message.value.toString();
//       console.log('Kafka message', topic, payload);

//       // parse roomId from topic like signaling-room-{roomId}
//       const roomId = topic.replace('signaling-room-', '');
//       io.to(roomId).emit('signal', JSON.parse(payload));
//     }
//   });
// }


// initKafka().catch(err => console.error('Kafka init error', err));


// //  ----------------- End Kafka -----------------


// //  ----------------- SFU Worker -----------------
// const os = require('os');
// const numWorkers = os.cpus().length;

// const mediasoupWorkers = [];

// async function spawnWorker() {
//   if (!mediasoup) return null;

//   const worker = await mediasoup.createWorker();
//   mediasoupWorkers.push(worker);

//   worker.on('died', async () => {
//     console.error('Mediasoup worker died, respawning in 2 seconds...');
//     // Remove the dead worker from the array
//     const index = mediasoupWorkers.indexOf(worker);
//     if (index !== -1) mediasoupWorkers.splice(index, 1);

//     setTimeout(spawnWorker, 2000); // respawn
//   });

//   return worker;
// }

// // Spawn workers based on CPU cores
// (async () => {
//   for (let i = 0; i < numWorkers; i++) {
//     await spawnWorker();
//   }
// })();

// //  ----------------- End SFU Worker -----------------

// //  ----------------- Room SFU Worker -----------------
// let workerIndex = 0;

// function assignWorkerToRoom(roomId) {
//   if (mediasoupWorkers.length === 0) throw new Error('No Mediasoup workers available');

//   // simple round-robin assignment
//   const worker = mediasoupWorkers[workerIndex % mediasoupWorkers.length];
//   workerIndex++;

//   // store in rooms
//   rooms[roomId] = rooms[roomId] || { peers: {}, router: null, worker };

//   return worker;
// }

// //  ----------------- End Room SFU Worker -----------------


// // In-memory room state (for POC). For production use a persistent store.
// const rooms = {};


// //  ----------------- WebRTC -----------------

// async function createWebRtcTransport(router) {
//   return await router.createWebRtcTransport({
//     listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP || '127.0.0.1' }],
//     enableUdp: true,
//     enableTcp: true,
//     preferUdp: true,
//   });
// }

// function mediasoupSupportedCodecs() {
//   return [
//     {
//       kind: 'audio',
//       mimeType: 'audio/opus',
//       clockRate: 48000,
//       channels: 2,
//     },
//     {
//       kind: 'video',
//       mimeType: 'video/VP8',
//       clockRate: 90000,
//     }
//   ];
// }


// //  ----------------- End WebRTC -----------------


// //  ----------------- Main Logic -----------------
// io.on('connection', (socket) => {
//   console.log('client connected', socket.id);

//   socket.on('join', async ({ roomId, peerName }) => {
//     console.log(`${peerName} joins ${roomId}`);
//     socket.join(roomId);

//     // assign worker and create router if it doesn't exist
//     const room = rooms[roomId] || {};
//     if (!room.router) {
//       const worker = assignWorkerToRoom(roomId);
//       room.router = await worker.createRouter({ mediaCodecs: mediasoupSupportedCodecs() });
//       rooms[roomId] = room;
//     }

//     room.peers[socket.id] = { id: socket.id, name: peerName, transports: [], producers: [], consumers: [] };
//     rooms[roomId] = room;
//     // End room router

//     // Kafka broadcast
//     const event = { type: 'user-joined', roomId, peerId: socket.id, peerName, ts: Date.now() };
//     await producer.send({ topic: `signaling-room-${roomId}`, messages: [{ value: JSON.stringify(event) }] });

//     io.to(roomId).emit('room-update', room);
//   });


//   // Kafka and Socket
//   socket.on('signal', async ({ roomId, payload }) => {
//     // publish to Kafka so all signaling servers can pick it up
//     await producer.send({ topic: `signaling-room-${roomId}`, messages: [{ value: JSON.stringify(payload) }] });
//   });
  
//   socket.on('produce', async ({ roomId, kind, rtpParameters }) => {
//     const room = rooms[roomId];
//     const peer = room.peers[socket.id];
//     const transport = peer.transports[0]; // assume send transport is first
//     const producer = await transport.produce({ kind, rtpParameters });
//     peer.producers.push(producer);

//     // notify other peers to consume
//     for (const otherId of Object.keys(room.peers)) {
//       if (otherId === socket.id) continue;
//       io.to(otherId).emit('new-producer', { producerId: producer.id, peerId: socket.id, kind });
//     }

//     return producer.id;
//   });

//   socket.on('consume', async ({ roomId, producerId, rtpCapabilities }) => {
//     const room = rooms[roomId];
//     const router = room.router;
//     if (!router.canConsume({ producerId, rtpCapabilities })) return;

//     const transport = room.peers[socket.id].transports[1]; // assume recv transport
//     const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
//     room.peers[socket.id].consumers.push(consumer);

//     return {
//       id: consumer.id,
//       producerId,
//       kind: consumer.kind,
//       rtpParameters: consumer.rtpParameters
//     };
//   });

//   socket.on('create-transport', async ({ roomId, direction }) => {
//     const room = rooms[roomId];
//     const router = room.router;
//     const transport = await createWebRtcTransport(router);

//     // store transport
//     const peer = room.peers[socket.id];
//     peer.transports.push(transport);

//     return {
//       id: transport.id,
//       iceParameters: transport.iceParameters,
//       iceCandidates: transport.iceCandidates,
//       dtlsParameters: transport.dtlsParameters
//     };
//   });
  
//   socket.on('connect-transport', async ({ transportId, dtlsParameters }) => {
//     const room = Object.values(rooms).find(r => r.peers[socket.id]);
//     const peer = room.peers[socket.id];
//     const transport = peer.transports.find(t => t.id === transportId);
//     await transport.connect({ dtlsParameters });
//   });

//   // End Kafka and Socket

//   socket.on('chat', async ({ roomId, message, from }) => {
//     const msgEvent = { type: 'chat', roomId, from, message, ts: Date.now() };
//     await producer.send({ topic: `chat-messages-room-${roomId}`, messages: [{ value: JSON.stringify(msgEvent) }] });
//   });

//   socket.on('disconnect', async () => {
//     const roomEntries = Object.entries(rooms);
//     for (const [roomId, room] of roomEntries) {
//       const peer = room.peers[socket.id];
//       if (!peer) continue;

//       peer.producers.forEach(p => p.close());
//       peer.consumers.forEach(c => c.close());
//       peer.transports.forEach(t => t.close());

//       delete room.peers[socket.id];

//       // Kafka notification
//       const event = { type: 'user-left', roomId, peerId: socket.id, ts: Date.now() };
//       await producer.send({ topic: `signaling-room-${roomId}`, messages: [{ value: JSON.stringify(event) }] });

//       io.to(roomId).emit('room-update', room);
//     }
//   });
// });


// //  ----------------- End Main Logic -----------------

// app.get('/', (req, res) => res.send('Hyperion signaling server up'));
// const PORT = process.env.PORT || 3000;
// server.listen(PORT, () => console.log('Signaling server listening on', PORT));



