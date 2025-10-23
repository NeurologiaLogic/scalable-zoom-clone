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
let stream = null;
let currentRoomId = null;

// Reusable AudioContext for level detection
const audioCtx = new AudioContext();
let analyser;
let sourceNode;

// ------------------- Buttons -------------------
document.getElementById('join').onclick = () => joinRoom(roomInput.value, nameInput.value);
document.getElementById('leave').onclick = leaveRoom;

// ------------------- Socket Events -------------------
socket.on('transport-created', async (transportInfo) => {
  try {
    if (transportInfo.direction === 'send') {
      sendTransport = await device.createSendTransport(transportInfo);
      
      //events when we try to connect 
      sendTransport.on('connect', async ({ dtlsParameters }, callback, errCallback) => {
        socket.emit('connect-transport', { roomId: currentRoomId, transportId: sendTransport.id, dtlsParameters });
        socket.once('connect-transport-ok', callback);
        setTimeout(() => errCallback(new Error('connect-transport timeout')), 10000);
      });

      // Events asks your app code to tell the server “hey, please create a producer for this track.”
      // Asking to create a producer on the server since we are sending new media stream
      sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errCallback) => {
        socket.emit('produce', { roomId: currentRoomId, kind, rtpParameters });
        socket.once('produce-ok', ({ id }) => callback({ id }));
        setTimeout(() => errCallback(new Error('produce timeout')), 15000);
      });

      //this is the trigger for sendTransport.on('produce') above
      await produceLocalTracks();
      console.log("✅ Send transport ready");
    } else if (transportInfo.direction === 'recv') {
      recvTransport = device.createRecvTransport(transportInfo);

      recvTransport.on('connect', async ({ dtlsParameters }, callback, errCallback) => {
        socket.emit('connect-transport', { roomId: currentRoomId, transportId: recvTransport.id, dtlsParameters });
        socket.once('connect-transport-ok', callback);
        setTimeout(() => errCallback(new Error('connect-transport timeout')), 10000);
      });

      console.log("✅ Recv transport ready");
    }
  } catch (err) {
    console.error('❌ transport error:', err);
  }
});

// Info from the server that there is a new media stream and we need to consume the producerId
socket.on('new-media-stream', async ({ producerId, peerId, peerName }) => {
  await consumeProducer(producerId, peerId, peerName);
});

socket.on('peer-left', ({ peerName }) => {
  alert(`${peerName} has Joined!`)
});

socket.on('peer-left', ({ peerId }) => {
  const container = document.getElementById(`remote-${peerId}`);
  if (container) container.remove();
});

// ------------------- Join Room -------------------
async function joinRoom(roomId, name) {
  try {
    currentRoomId = roomId;

    // 1. Get local media
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = stream;

    // Setup audio analyser
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    sourceNode.connect(analyser);

    // 2. Create Mediasoup device
    device = new mediasoupClient.Device();

    // 3. Load router capabilities
    const rtpCapabilities = await fetch(`/getRtpCapabilities?roomId=${roomId}`).then(res => res.json());
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    // 4. Join room
    socket.emit('join', { roomId, peerName: name });

    // 5. Create send transport & produce tracks
    await createSendTransport(roomId);

    // 6. Create recv transport
    await createRecvTransport(roomId);

    // 7. Listen for active speaker
    startActiveSpeakerDetection();

  } catch (err) {
    console.error('Join failed:', err);
    alert('Join failed: ' + err.message);
  }
}

// ------------------- Transport Helpers -------------------
async function createSendTransport(roomId) { socket.emit('create-transport', { roomId, direction: 'send' }); }
async function createRecvTransport(roomId) { socket.emit('create-transport', { roomId, direction: 'recv' }); }


// ------------------- Produce Local Tracks -------------------
async function produceLocalTracks() {
  // Sending our video Stream to the server
  if (!stream || !sendTransport) return;
  for (const track of stream.getTracks()) {
    if (producers[track.id]) continue;
    const producer = await sendTransport.produce({
      track
    });
    producers[producer.id] = producer;
    console.log(`✅ Produced track: ${track.kind}`);
  }
}

// ------------------- Consume Remote Producer -------------------
async function consumeProducer(producerId, peerId, peerName) {
  try {
    // Consuming Streams of Producers
    if (!recvTransport) return console.error('Recv transport not ready');

    // Telling our Recv Transporter in the server to consume the new producer Id
    socket.emit('consume', {
      roomId: currentRoomId,
      producerId:producerId,
      rtpCapabilities: device.rtpCapabilities
    });
    
    // If the server successfully consume the producer it
    // we will now get new media streams from the participants in the meeting
    socket.once('consume-success', async ({ id, producerId, kind, rtpParameters }) => {

      // The Kind which is Sound/Image that we got is just a metadate,
      // We need to consume it using our recvTransporter

      const consumer = await recvTransport.consume({ id, producerId, kind, rtpParameters });
      consumers[consumer.id] = consumer;

      // Ensure remote container exists
      let container = document.getElementById('remote-' + peerId);
      if (!container) {
        container = document.createElement('div');
        container.className = 'video-container';
        container.id = 'remote-' + peerId;

        const videoEl = document.createElement('video');
        videoEl.autoplay = true;
        videoEl.playsInline = true;

        container.stream = new MediaStream();
        videoEl.srcObject = container.stream;

        const label = document.createElement('div');
        label.className = 'name-label';
        label.textContent = peerName;

        container.appendChild(videoEl);
        container.appendChild(label);
        videosDiv.appendChild(container);
      }

      // Add track to the container's stream
      container.stream.addTrack(consumer.track);

      await consumer.resume();
      console.log(`✅ Consuming ${kind} from ${peerName}`);
    });
  } catch (err) {
    console.error('❌ Failed to consume producer:', err);
  }
}

// ------------------- Active Speaker -------------------
function startActiveSpeakerDetection() {
  if (!analyser) return;
  analyser.fftSize = 512;
  const bufferLength = analyser.fftSize;
  const data = new Uint8Array(bufferLength);

  setInterval(() => {
    analyser.getByteTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, v) => sum + ((v - 128)/128)**2, 0) / bufferLength);
    const localContainer = document.getElementById('local-container');
    if (!localContainer) return;
    if (rms > 0.1) localContainer.classList.add('active-speaker');
    else localContainer.classList.remove('active-speaker');
  }, 200);
}

// ------------------- Leave Room -------------------
async function leaveRoom() {
  try {
    for (const p of Object.values(producers)) await p.close();
    for (const c of Object.values(consumers)) await c.close();
    if (sendTransport) await sendTransport.close();
    if (recvTransport) await recvTransport.close();

    producers = {};
    consumers = {};
    sendTransport = null;
    recvTransport = null;
    stream = null;
    
    // Triggers the consumers and producers in the backend
    socket.emit("leave-room")
  } catch (err) {
    console.error('Leave failed:', err);
  }
}
