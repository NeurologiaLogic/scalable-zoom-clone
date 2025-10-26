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

document.getElementById('join').onclick = () => {
  joinRoom(roomInput.value, nameInput.value);
  document.body.click(); // simulate first interaction
};
document.getElementById('leave').onclick = leaveRoom;

// ------------------- Socket Debug -------------------
socket.on('connect', () => log('socket', 'connected to signaling', socket.id));
socket.on('disconnect', reason => log('socket', 'disconnected', reason));
socket.onAny((ev, ...args) => log('socket-event', ev, args));

// ------------------- Transport Created -------------------
socket.on('transport-created', async transportInfo => {
  log('socket', 'transport-created received', transportInfo);
  if (!device) {
    log('transport', 'device not initialized yet; deferring transport', transportInfo.direction);
    return;
  }

  const createTransportCallbacks = (transport, direction) => {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      let responded = false;
      socket.emit('connect-transport',
        { roomId: currentRoomId, transportId: transport.id, dtlsParameters },
        (res) => {
          if (res.error) errback(new Error(res.error));
          else callback();
        });
      setTimeout(() => { if (!responded) { responded = true; errback(new Error('connect timeout')); } }, 5000);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters }, callback, errCallback) => {
        log('transport', `sendTransport.produce requested kind=${kind}`);
        socket.emit('produce', { roomId: currentRoomId, kind, rtpParameters }, response => {
          if (response && response.id) callback({ id: response.id });
          else errCallback(new Error('produce failed or no id returned'));
        });
      });
    }
  };

  if (transportInfo.direction === 'send') {
    sendTransport = device.createSendTransport(transportInfo);
    createTransportCallbacks(sendTransport, 'send');
    transportsReady.send = true;
    log('transport', 'sendTransport ready');
  } else if (transportInfo.direction === 'recv') {
    recvTransport = device.createRecvTransport(transportInfo);
    createTransportCallbacks(recvTransport, 'recv');
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
    track.enabled = true;
    sendTransport.produce({ track })
      .then(producer => {
        producers[producer.id] = producer;
        log('produce', `produced ${track.kind} track id=${producer.id}`);
      })
      .catch(err => log('produce', 'produce failed', err));
  });
}

// ------------------- Consume Producer -------------------
// ------------------- Consume Producer -------------------
function consumeProducer(producerId, peerId, peerName) {
  if (!recvTransport) return log('consume', 'recvTransport not ready');

  log('consume', `Consuming producerId=${producerId} peerName=${peerName}`);
  socket.emit(
    'consume',
    { roomId: currentRoomId, producerId, rtpCapabilities: device.rtpCapabilities },
    async response => {
      if (!response?.params) return log('consume', 'consume failed', response?.error);

      const consumer = await recvTransport.consume(response.params);
      consumers[consumer.id] = consumer;

      console.log('[consume] consumer track:', consumer.track);
      console.log('[consume] kind:', consumer.kind);
      console.log('[consume] readyState:', consumer.track.readyState);
      console.log('[consume] muted:', consumer.track.muted);

      consumer.on('transportclose', () => console.log('[consume] consumer transport closed'));
      consumer.on('trackended', () => console.log('[consume] consumer track ended'));

      // Create or get peer container
      const peerContainerId = `remote-${peerId}`;
      let container = document.getElementById(peerContainerId);
      if (!container) {
        container = document.createElement('div');
        container.id = peerContainerId;
        container.className = 'video-container';
        container.style = `
          position: relative;
          display: inline-block;
          width: 320px;
          height: 240px;
          margin: 8px;
          border-radius: 12px;
          overflow: hidden;
          background: black;
        `;
        const nameLabel = document.createElement('div');
        nameLabel.textContent = peerName || peerId;
        nameLabel.style = `
          position:absolute;
          bottom:6px;
          left:10px;
          background:rgba(0,0,0,0.5);
          padding:2px 6px;
          border-radius:6px;
          font-size:13px;
          font-weight:bold;
        `;
        container.appendChild(nameLabel);
        videosDiv.appendChild(container);
      }

      if (response.params.kind === 'video') {
        let video = container.querySelector('video');
        if (!video) {
          video = document.createElement('video'); // ✅ create video
          // video.src = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
          video.muted = true; // allow autoplay
          video.playsInline = true;
          video.autoplay = true;     // ✅ add this
          video.style.width = '100%';
          video.style.height = '100%';
          video.style.objectFit = 'cover';
          container.appendChild(video); // ✅ append to DOM
        }
        
        // For real Mediasoup usage, uncomment this:
        // Create a new MediaStream for this consumer
        const stream = new MediaStream();
        stream.addTrack(consumer.track);
        video.srcObject = stream;
        console.log('video element muted:', video.muted);
        console.log('video element autoplay:', video.autoplay);
        console.log('track muted:', consumer.track.muted);
        console.log('Stream tracks:', stream.getTracks());
        console.log('Audio tracks:', stream.getAudioTracks());
        console.log('Video tracks:', stream.getVideoTracks());
        stream.getTracks().forEach(track => {
          console.log(track.kind, 'readyState:', track.readyState, 'muted:', track.muted);
        });
        function checkFrames(video) {
            let lastTime = 0;
            function loop() {
              if (video.readyState >= 2) { // HAVE_CURRENT_DATA
                if (video.currentTime !== lastTime) {
                  console.log('Video is playing frame', video.currentTime);
                  lastTime = video.currentTime;
                }
              }
              requestAnimationFrame(loop);
            }
            loop();
          }

        checkFrames(video);


        // video.play().catch(console.warn);
        video.onloadedmetadata = () => {
          video.play().catch(e => console.warn('Autoplay blocked', e));
          container.style.background = 'transparent';
          console.log('[consume] video playing');
        };

      } else if (response.params.kind === 'audio') {
        let audio = container.querySelector('audio');
        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          container.appendChild(audio);
          audio.srcObject = new MediaStream();
        }

        // Add the audio track
        audio.srcObject.addTrack(consumer.track);
      }
    }
  );
}



// ------------------- Existing Producers -------------------
function requestExistingProducers() {
  socket.emit('request-existing-producers', { roomId: currentRoomId }, response => {
    const list = response?.params || [];
    list.forEach(p => { if (p.peerId !== socket.id) consumeProducer(p.producerId, p.peerId, p.peerName); });
  });
}

socket.on('new-producer', p => { if (p.peerId !== socket.id) consumeProducer(p.producerId, p.peerId, p.peerName); });

// ------------------- Leave Room -------------------
function leaveRoom() {
  Object.values(producers).forEach(p => p.close?.());
  Object.values(consumers).forEach(c => c.close?.());
  sendTransport?.close(); recvTransport?.close();
  producers = {}; consumers = {}; sendTransport = null; recvTransport = null; stream = null;
  socket.emit('leave-room', { roomId: currentRoomId });
}

log('frontend', 'client script loaded');
