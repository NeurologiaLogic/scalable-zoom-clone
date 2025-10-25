// client.js
import * as mediasoupClient from "mediasoup-client";
import { io } from "socket.io-client";

console.log("[FRONTEND] starting client.js");

const socket = io();
let device;
let sendTransport;
let recvTransport;
let producers = {};
let consumers = {};
let transportsReady = { send: false, recv: false };

const localVideo = document.getElementById('local');
const videosDiv = document.getElementById('videos');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('name');
let stream = null;
let currentRoomId = null;

// audio analyser for active speaker
const audioCtx = new AudioContext();
let analyser;
let sourceNode;

function log(tag, msg, data) {
  console.log(`[FRONTEND][${tag}] ${msg}`, data || "");
}
function err(tag, msg, e) {
  console.error(`[FRONTEND][${tag}] ${msg}`, e);
}

window.addEventListener('error', (e) => err('global-error', 'window error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => err('unhandledrejection', 'promise rejection', e.reason));

document.getElementById('join').onclick = () => joinRoom(roomInput.value, nameInput.value);
document.getElementById('leave').onclick = leaveRoom;

// ------------------- Socket debug -------------------
socket.on('connect', () => log('socket', 'connected to signaling', socket.id));
socket.on('disconnect', (reason) => log('socket', 'disconnected', reason));
socket.onAny((ev, ...args) => log('socket-event', ev, args));

// ------------------- Transport created -------------------
socket.on('transport-created', async (transportInfo) => {
  log('socket', 'transport-created received', transportInfo);
  try {
    if (!device) {
      log('transport', 'device not initialized yet; deferring transport handling', transportInfo.direction);
    }

    if (transportInfo.direction === 'send') {
      log('transport', 'creating sendTransport');
      sendTransport = await device.createSendTransport(transportInfo);

      // --- SEND TRANSPORT CONNECT ---
      sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        console.log("[FRONTEND][transport] sendTransport.connect() -> emitting connect-transport");

        let timeoutId;
        let responded = false;

        // Emit connect request
        socket.emit("connect-transport", {
          roomId:currentRoomId,
          transportId: sendTransport.id,
          dtlsParameters
        });

        // Listen for success response
        socket.once("connect-transport-ok", (data) => {
          if (responded) return;
          responded = true;
          clearTimeout(timeoutId);

          console.log("[FRONTEND][transport] ✅ sendTransport connected (server ok):", data);
          try {
            callback(); // ✅ Must be called immediately when server confirms
          } catch (err) {
            console.error("[FRONTEND][transport] ❌ Error calling sendTransport callback:", err);
            errback(err);
          }
        });

        // Listen for error response (optional, if backend emits)
        socket.once("connect-transport-error", (err) => {
          if (responded) return;
          responded = true;
          clearTimeout(timeoutId);

          console.error("[FRONTEND][transport] ❌ sendTransport connect error:", err);
          errback(err);
        });

        // Timeout handler (fallback)
        timeoutId = setTimeout(() => {
          if (responded) return;
          responded = true;

          const error = new Error("connect-transport timeout (sendTransport)");
          console.error("[FRONTEND][transport] ⚠️", error);
          errback(error);
        }, 5000);
      });

      sendTransport.on('produce', ({ kind, rtpParameters }, callback, errCallback) => {
        log('transport', `sendTransport.produce requested kind=${kind}`);
        socket.emit('produce', { roomId: currentRoomId, kind, rtpParameters }, (response) => {
          log('socket', 'produce response', response);
          if (response && response.id) {
            callback({ id: response.id });
          } else {
            const e = new Error('produce failed or no id returned');
            err('transport', 'produce failed', e);
            errCallback(e);
          }
        });
        // backup timeout
        setTimeout(() => {
          const e = new Error('produce callback timeout');
          errCallback(e);
        }, 15000);
      });

      transportsReady.send = true;
      log('transport', 'sendTransport ready');
    } else if (transportInfo.direction === 'recv') {
      log('transport', 'creating recvTransport');
      recvTransport = device.createRecvTransport(transportInfo);

      // --- RECV TRANSPORT CONNECT ---
      recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        console.log("[FRONTEND][transport] recvTransport.connect() -> emitting connect-transport");

        let timeoutId;
        let responded = false;

        socket.emit("connect-transport", {
          roomId:currentRoomId,
          transportId: recvTransport.id,
          dtlsParameters
        });

        socket.once("connect-transport-ok", (data) => {
          if (responded) return;
          responded = true;
          clearTimeout(timeoutId);

          console.log("[FRONTEND][transport] ✅ recvTransport connected (server ok):", data);
          try {
            callback();
          } catch (err) {
            console.error("[FRONTEND][transport] ❌ Error calling recvTransport callback:", err);
            errback(err);
          }
        });

        socket.once("connect-transport-error", (err) => {
          if (responded) return;
          responded = true;
          clearTimeout(timeoutId);

          console.error("[FRONTEND][transport] ❌ recvTransport connect error:", err);
          errback(err);
        });

        timeoutId = setTimeout(() => {
          if (responded) return;
          responded = true;

          const error = new Error("connect-transport timeout (recvTransport)");
          console.error("[FRONTEND][transport] ⚠️", error);
          errback(error);
        }, 5000);
      });

      transportsReady.recv = true;
      log('transport', 'recvTransport ready');
    }

    if (transportsReady.send && transportsReady.recv) {
      log('transport', 'both transports ready — producing local tracks and requesting existing producers');
      await produceLocalTracks(); // safe: sendTransport exists
      requestExistingProducers(); // don't await so we don't block; listener will handle consuming
    }
  } catch (e) {
    err('transport-created', 'exception handling transport-created', e);
  }
});

// ------------------- Join Room -------------------
async function joinRoom(roomId, name) {
  log('join', 'start', { roomId, name });
  try {
    currentRoomId = roomId;

    // get local media
    try {
      log('media', 'enumerating devices');
      navigator.mediaDevices.enumerateDevices().then(d => log('media', 'devices', d)).catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      localVideo.srcObject = stream;
      log('media', 'got local media', stream.getTracks().map(t => t.kind));
    } catch (e) {
      err('media', 'getUserMedia failed', e);
      alert('Cannot access camera/microphone: ' + (e.message || e));
      return;
    }

    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    sourceNode.connect(analyser);

    // create mediasoup device
    device = new mediasoupClient.Device();
    log('mediasoup', 'device created');

    // get rtp capabilities
    const rtpCapabilities = await fetch(`/getRtpCapabilities?roomId=${roomId}`).then(r => r.json());
    log('mediasoup', 'rtpCapabilities fetched', rtpCapabilities);
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    log('mediasoup', 'device loaded');

    // join signaling room
    socket.emit('join', { roomId, peerName: name }, (ack) => {
      log('socket', 'join ack', ack);
    });

    // request transports
    createSendTransport(roomId);
    createRecvTransport(roomId);

    startActiveSpeakerDetection();

    log('join', 'done (joinRoom)');
  } catch (e) {
    err('join', 'joinRoom failed', e);
    alert('Join failed: ' + (e.message || e));
  }
}

// ------------------- Transport Helpers -------------------
function createSendTransport(roomId) {
  log('transport', 'requesting create-transport send', { roomId });
  socket.emit('create-transport', { roomId, direction: 'send' }, (ack) => {
    log('socket', 'create-transport (send) ack', ack);
  });
}
function createRecvTransport(roomId) {
  log('transport', 'requesting create-transport recv', { roomId });
  socket.emit('create-transport', { roomId, direction: 'recv' }, (ack) => {
    log('socket', 'create-transport (recv) ack', ack);
  });
}

// ------------------- Produce Local Tracks -------------------
async function produceLocalTracks() {
  log('media', 'produceLocalTracks() start');
  if (!stream || !sendTransport) {
    log('media', 'cannot produce: stream or sendTransport missing', { stream: !!stream, sendTransport: !!sendTransport });
    return;
  }
  try {
    for (const track of stream.getTracks()) {
      if (producers[track.id]) {
        log('media', 'track already produced', track.id);
        continue;
      }
      log('media', 'calling sendTransport.produce for track', track.kind);
      const producer = await sendTransport.produce({ track });
      producers[producer.id] = producer;
      log('media', `producer created id=${producer.id} kind=${track.kind}`);
    }
    log('media', 'produceLocalTracks() done');
  } catch (e) {
    err('media', 'produceLocalTracks failed', e);
  }
}

// ------------------- Consume Remote Producer -------------------
async function consumeProducer(producerId, peerId, peerName) {
  log('consume', 'start', { producerId, peerId, peerName });
  if (!recvTransport) {
    log('consume', 'recvTransport not ready yet');
    return;
  }
  try {
    // emit consume with callback (server responds via callback)
    socket.emit('consume', { roomId: currentRoomId, producerId, rtpCapabilities: device.rtpCapabilities }, async (response) => {
      log('socket', 'consume response', response);
      const params = response?.params;
      if (!params) {
        log('consume', `no params for producer ${producerId}`);
        return;
      }
      // recvTransport.consume expects an object with id, producerId, kind, rtpParameters
      const consumer = await recvTransport.consume(params);
      consumers[consumer.id] = consumer;
      log('consume', `consumer created: ${consumer.id} kind=${consumer.kind}`);

      // create element
      const containerId = `remote-${peerId}-${params.producerId}`;
      if (!document.getElementById(containerId)) {
        const container = document.createElement('div');
        container.id = containerId;
        container.className = 'video-container';

        const label = document.createElement('div');
        label.className = 'name-label';
        label.textContent = peerName || peerId || 'Anonymous';

        if (params.kind === 'video') {
          const video = document.createElement('video');
          video.autoplay = true;
          video.playsInline = true;
          video.srcObject = new MediaStream([consumer.track]);
          container.appendChild(video);
        } else {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = new MediaStream([consumer.track]);
          container.appendChild(audio);
        }

        container.appendChild(label);
        videosDiv.appendChild(container);
      }

      await consumer.resume();
      log('consume', `consumer resumed for ${params.producerId}`);
    });
  } catch (e) {
    err('consume', 'consumeProducer failed', e);
  }
}

// ------------------- Existing Producers request/listener -------------------
function requestExistingProducers() {
  log('socket', 'emitting request-existing-producers', { roomId: currentRoomId });
  socket.emit('request-existing-producers', { roomId: currentRoomId });
}

// keep a persistent listener (safer than once)
socket.on('existing-producers', async (list) => {
  log('socket', 'existing-producers received', list);
  try {
    for (const { producerId, peerId, peerName } of list) {
      log('socket', 'will attempt consume for', { producerId, peerId, peerName });
      await consumeProducer(producerId, peerId, peerName);
    }
  } catch (e) {
    err('socket', 'existing-producers handler failed', e);
  }
});

// notify existing peers about a single new producer
socket.on('new-producer', async ({ producerId, peerId, peerName }) => {
  log('socket', 'new-producer event received', { producerId, peerId, peerName });
  try {
    await consumeProducer(producerId, peerId, peerName);
  } catch (e) {
    err('socket', 'new-producer handler failed', e);
  }
});

// ------------------- Active Speaker -------------------
function startActiveSpeakerDetection() {
  log('media', 'startActiveSpeakerDetection()');
  if (!analyser && stream) {
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    sourceNode.connect(analyser);
  }
  if (!analyser) return log('media', 'no analyser available');
  analyser.fftSize = 512;
  const buf = new Uint8Array(analyser.fftSize);
  setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + ((v - 128) / 128) ** 2, 0) / buf.length);
    const el = document.getElementById('local-container');
    if (!el) return;
    el.classList.toggle('active-speaker', rms > 0.1);
  }, 200);
}

// ------------------- Leave Room -------------------
async function leaveRoom() {
  log('leave', 'leaveRoom() start');
  try {
    Object.values(producers).forEach(p => p.close?.());
    Object.values(consumers).forEach(c => c.close?.());
    if (sendTransport) await sendTransport.close();
    if (recvTransport) await recvTransport.close();
    producers = {}; consumers = {};
    sendTransport = null; recvTransport = null; stream = null;
    socket.emit('leave-room', { roomId: currentRoomId }, (ack) => log('socket', 'leave-room ack', ack));
    log('leave', 'leaveRoom() done');
  } catch (e) {
    err('leave', 'leaveRoom failed', e);
  }
}

log('frontend', 'client script loaded');
