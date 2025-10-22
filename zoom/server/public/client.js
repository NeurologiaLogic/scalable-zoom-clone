// client.js
import * as mediasoupClient from "mediasoup-client";
import { io } from "socket.io-client";
const socket = io();
let device;
let sendTransport;
let recvTransport;
let producers = {};
let consumers = {};

const localVideo = document.getElementById('local');
const videosDiv = document.getElementById('videos');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('name');
let stream = null


// -------------- socket events -----------------
socket.on('transport-created', async (transportInfo) => {
  // Use consistent direction key
  if (transportInfo.direction === "send") {
    try {
      // Create send transport
      sendTransport = device.createSendTransport(transportInfo);

      sendTransport.on('connect', async ({ dtlsParameters }, callback, errCallback) => {
        try {
          // Ask backend (through your socket gateway) to connect the transport
          socket.emit('connect-transport', { 
            roomId, 
            transportId: sendTransport.id, 
            dtlsParameters 
          });

          // Wait until Kafka (via backend) confirms
          socket.once('connect-transport-ok', () => {
            callback(); // mediasoup can continue
          });

          // Optional timeout to avoid deadlock
          setTimeout(() => {
            errCallback(new Error('connect-transport timeout'));
          }, 10000);
        } catch (err) {
          errCallback(err);
        }
      });


      sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errCallback) => {
        try {
          socket.emit('produce', { roomId, kind, rtpParameters });
          socket.once('produce-ok', ({ id }) => {
            callback({ id }); // mediasoup registers producer ID
          });

          setTimeout(() => {
            errCallback(new Error('produce timeout'));
          }, 5000);
        } catch (err) {
          errCallback(err);
        }
      });

      // Produce all local tracks
      for (const track of stream.getTracks()) {
        await sendTransport.produce({ track });
      }

      console.log("✅ Send transport created");
    } catch (err) {
      console.error("❌ Failed to create send transport:", err);
    }
  }

  else if (transportInfo.direction === "recv") {
    try {
      // Create recv transport
      recvTransport = device.createRecvTransport(transportInfo);

      recvTransport.on('connect', async ({ dtlsParameters }, callback, errCallback) => {
        try {
          // Send connect request to backend (via Kafka)
          socket.emit('connect-transport', {
            roomId,
            transportId: recvTransport.id,
            dtlsParameters
          });

          // Wait for backend confirmation before continuing
          socket.once('connect-transport-ok', () => {
            callback(); // allow mediasoup to continue
          });

          // Optional safety timeout
          setTimeout(() => {
            errCallback(new Error('connect-transport timeout'));
          }, 10000);
        } catch (err) {
          errCallback(err);
        }
      });

      console.log("✅ Recv transport created");
    } catch (err) {
      console.error("❌ Failed to create recv transport:", err);
    }
  }

});


// Buttons
document.getElementById('join').onclick = () => joinRoom(roomInput.value, nameInput.value);
document.getElementById('leave').onclick = leaveRoom;

async function joinRoom(roomId, name) {
  try {
    // 1. Get local media
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = stream;

    // 2. Create Mediasoup device
    device = new mediasoupClient.Device();

    // 3. Get router RTP capabilities from server
    const rtpCapabilities = await fetch(`/getRtpCapabilities?roomId=${roomId}`).then(res => res.json());
    socket.emit('join', { roomId, peerName: name });
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    // 4. Create transports
    await createSendTransport(roomId);
    await createRecvTransport(roomId);

    // 5. Listen for new producers
    socket.on('new-producer', ({ producerId, peerId, kind, peerName }) => {
      console.log(`🆕 New producer detected from ${peerName} (${kind})`);
      consumeProducer(producerId, peerId, kind, peerName);
    });

    // Active speaker detection for local video
    setInterval(() => {
      const level = getAudioLevel(stream);
      const localContainer = document.getElementById('local-container');
      if (level > 0.1) localContainer.classList.add('active-speaker');
      else localContainer.classList.remove('active-speaker');
    }, 200);

  } catch (err) {
    console.error('Join room failed:', err);
    alert('Join failed: ' + err);
  }
}

async function createSendTransport(roomId) {
  socket.emit('create-transport', { roomId, direction: 'send' });
}

async function createRecvTransport(roomId) {
  socket.emit('create-transport', { roomId, direction: 'recv' });
}

async function consumeProducer(producerId, peerId, kind, peerName) {
  try {
    // Request backend to create consumer
    socket.emit('consume', {
      roomId,
      producerId,
      rtpCapabilities: device.rtpCapabilities
    });

    // Wait for the backend to respond with consumer params
    socket.once('consume-success', async ({ id, producerId, kind, rtpParameters }) => {
      const consumer = await recvTransport.consume({
        id,
        producerId,
        kind,
        rtpParameters
      });

      const stream = new MediaStream();
      stream.addTrack(consumer.track);

      addRemoteStream(peerId, stream, peerName);

      consumer.resume();

      console.log(`✅ Consuming ${kind} from ${peerName}`);
    });
  } catch (err) {
    console.error('❌ Failed to consume producer:', err);
  }
}


// Simple audio level detection
function getAudioLevel(stream) {
  try {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / data.length);
    context.close();
    return rms;
  } catch (err) { return 0; }
}

async function leaveRoom() {
  try {
    for (const p of Object.values(producers)) sendTransport.close();
    for (const c of Object.values(consumers)) recvTransport.close();
    producers = {};
    consumers = {};

    if (sendTransport) await sendTransport.close();
    if (recvTransport) await recvTransport.close();

    localVideo.srcObject = null;
    videosDiv.innerHTML = `
      <div class="video-container" id="local-container">
        <video id="local" autoplay muted></video>
        <div class="name-label" id="local-label">Me</div>
      </div>
    `;

    socket.disconnect();
  } catch (err) {
    console.error('Leave room failed:', err);
  }
}
