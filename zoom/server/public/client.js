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

// Audio analyser
const audioCtx = new AudioContext();
let analyser, sourceNode;

function log(tag, msg, data) { console.log(`[FRONTEND][${tag}] ${msg}`, data || ""); }
function err(tag, msg, e) { console.error(`[FRONTEND][${tag}] ${msg}`, e); }

window.addEventListener('error', e => err('global-error', 'window error', e.error || e.message));
window.addEventListener('unhandledrejection', e => err('unhandledrejection', 'promise rejection', e.reason));

document.getElementById('join').onclick = () => joinRoom(roomInput.value, nameInput.value);
document.getElementById('leave').onclick = leaveRoom;

// ------------------- Socket Debug -------------------
socket.on('connect', () => log('socket', 'connected to signaling', socket.id));
socket.on('disconnect', reason => log('socket', 'disconnected', reason));
socket.onAny((ev, ...args) => log('socket-event', ev, args));

// ------------------- Transport Created -------------------
socket.on('transport-created', transportInfo => {
  log('socket', 'transport-created received', transportInfo);
  if (!device) {
    log('transport', 'device not initialized yet; deferring transport', transportInfo.direction);
    return;
  }

  if (transportInfo.direction === 'send') {
    log('transport', 'creating sendTransport');
    sendTransport = device.createSendTransport(transportInfo);

    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      let responded = false;
      socket.emit('connect-transport',
        { roomId: currentRoomId, transportId: sendTransport.id, dtlsParameters },
        (res) => {
          if (res.error) {
            errback(new Error(res.error));
          } else {
            callback(); // transport connected successfully
          }
        }
      );
      setTimeout(() => { if (!responded) { responded = true; errback(new Error('sendTransport connect timeout')); } }, 5000);
    });

    sendTransport.on('produce', ({ kind, rtpParameters }, callback, errCallback) => {
      log('transport', `sendTransport.produce requested kind=${kind}`);
      socket.emit('produce', { roomId: currentRoomId, kind, rtpParameters }, response => {
        if (response && response.id) callback({ id: response.id });
        else errCallback(new Error('produce failed or no id returned'));
      });
    });

    transportsReady.send = true;
    log('transport', 'sendTransport ready');
  } else if (transportInfo.direction === 'recv') {
    log('transport', 'creating recvTransport');
    recvTransport = device.createRecvTransport(transportInfo);

    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      let responded = false;
      socket.emit('connect-transport',
        { roomId: currentRoomId, transportId: recvTransport.id, dtlsParameters },
        (res) => {
          if (res.error) {
            errback(new Error(res.error));
          } else {
            callback(); // transport connected successfully
          }
        }
      );
      setTimeout(() => { if (!responded) { responded = true; errback(new Error('recvTransport connect timeout')); } }, 5000);
    });

    transportsReady.recv = true;
    log('transport', 'recvTransport ready');
  }

  if (transportsReady.send && transportsReady.recv) {
    log('transport', 'both transports ready — producing local tracks and requesting existing producers');
    produceLocalTracks();
    requestExistingProducers();
  }
});

// ------------------- Join Room -------------------
function joinRoom(roomId, name) {
  log('join', 'start', { roomId, name });
  currentRoomId = roomId;

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true })
    .then(s => {
      stream = s;
      localVideo.srcObject = stream;
      log('media', 'got local media', stream.getTracks().map(t => t.kind));

      device = new mediasoupClient.Device();
      fetch(`/getRtpCapabilities?roomId=${roomId}`)
        .then(r => r.json())
        .then(rtpCapabilities => {
          device.load({ routerRtpCapabilities: rtpCapabilities });
          log('mediasoup', 'device loaded');

          socket.emit('join', { roomId, peerName: name }, ack => log('socket', 'join ack', ack));
          createSendTransport(roomId);
          createRecvTransport(roomId);
        });
    })
    .catch(e => { err('media', 'getUserMedia failed', e); alert('Cannot access camera/mic'); });
}

// ------------------- Transport Helpers -------------------
function createSendTransport(roomId) { socket.emit('create-transport', { roomId, direction: 'send' }); }
function createRecvTransport(roomId) { socket.emit('create-transport', { roomId, direction: 'recv' }); }

// ------------------- Produce Local Tracks -------------------
function produceLocalTracks() {
  if (!stream || !sendTransport) return log('media', 'cannot produce: stream or sendTransport missing');
  stream.getTracks().forEach(track => {
    if (producers[track.id]) return;
    sendTransport.produce({ track }).then(producer => { producers[producer.id] = producer; });
  });
}

// ------------------- Consume Remote Producer -------------------
async function consumeProducer(producerId, peerId, peerName) {
  if (!recvTransport) return log('consume', 'recvTransport not ready yet');
  console.log(`Consuming: ProducerId:${producerId}, peerName: ${peerName}`);

  socket.emit(
    'consume',
    { roomId: currentRoomId, producerId, rtpCapabilities: device.rtpCapabilities },
    async (response) => {
      if (!response || !response.params) return;

      try {
        const consumer = await recvTransport.consume(response.params);
        consumers[consumer.id] = consumer;

        // Resume consumer so track starts flowing
        await consumer.resume();

        // Container per peer
        const peerContainerId = `remote-${peerId}`;
        let container = document.getElementById(peerContainerId);
        if (!container) {
          container = document.createElement('div');
          container.id = peerContainerId;
          container.className = 'video-container';
          container.style = `position:relative; display:inline-block; aspect-ratio:16/9; width:${localVideo.offsetWidth}px; height:${localVideo.offsetHeight}px; max-width:100%; margin:8px; border-radius:12px; overflow:hidden; background:black;`;

          const nameLabel = document.createElement('div');
          nameLabel.textContent = peerName || peerId;
          nameLabel.style = 'position:absolute; bottom:6px; left:10px; background:rgba(0,0,0,0.5); padding:2px 6px; border-radius:6px; font-size:13px; font-weight:bold;';
          container.appendChild(nameLabel);

          videosDiv.appendChild(container);
        }

        if (response.params.kind === 'video') {
          let video = container.querySelector('video');
          if (!video) {
            video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'cover';
            container.appendChild(video);
          }
          video.srcObject = new MediaStream([consumer.track]);

          // Mark if video doesn't start in 3s
          setTimeout(() => {
            if (video.readyState < 2) { // HAVE_CURRENT_DATA
              container.style.background = 'red';
              container.title = 'No video feed';
            }
          }, 3000);

        } else if (response.params.kind === 'audio') {
          let audio = container.querySelector('audio');
          if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            container.appendChild(audio);
          }
          audio.srcObject = new MediaStream([consumer.track]);
        }

      } catch (e) {
        err('consume', 'failed to consume producer', e);
      }
    }
  );
}


// ------------------- Existing Producers -------------------
function requestExistingProducers() { socket.emit('request-existing-producers', { roomId: currentRoomId }); }
socket.on('existing-producers', list => list.forEach(p => consumeProducer(p.producerId, p.peerId, p.peerName)));
socket.on('new-producer', p => consumeProducer(p.producerId, p.peerId, p.peerName));

// ------------------- Leave Room -------------------
function leaveRoom() {
  Object.values(producers).forEach(p => p.close?.());
  Object.values(consumers).forEach(c => c.close?.());
  sendTransport?.close(); recvTransport?.close();
  producers = {}; consumers = {}; sendTransport = null; recvTransport = null; stream = null;
  socket.emit('leave-room', { roomId: currentRoomId });
}

log('frontend', 'client script loaded');
