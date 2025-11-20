// ===============================
//   MINI ZOOM - CLIENT LOGIC
// ===============================

let socket = null;
let localStream = null;
let peers = {};               // socketId -> RTCPeerConnection
let remoteVideoElements = {}; // socketId -> video element
let roomId = null;
let username = null;

// ICE servers
const iceServers = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:global.stun.twilio.com:3478"
      ]
    },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

// ===============================
//   PAGE DETECTION
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

  if (page === "home") initHomePage();
  if (page === "room") initRoomPage();
});

// ===============================
//   HOME PAGE LOGIC
// ===============================
function initHomePage() {
  const joinForm = document.getElementById("joinForm");
  const roomInput = document.getElementById("roomInput");
  const nameInput = document.getElementById("nameInput");
  const errorBox = document.getElementById("homeError");

  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const room = roomInput.value.trim();
    const name = nameInput.value.trim() || "Guest";

    if (!room) {
      errorBox.textContent = "Please enter a room number.";
      return;
    }

    // TEST camera/mic before entering meeting
    try {
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
    } catch (err) {
      alert("Camera or mic error");
      return;
    }

    // GO TO ROOM
    window.location.href = `room.html?room=${room}&name=${encodeURIComponent(name)}`;
  });
}

// ===============================
//   ROOM PAGE LOGIC
// ===============================
async function initRoomPage() {
  // Get URL params
  const params = new URLSearchParams(window.location.search);
  roomId = params.get("room");
  username = params.get("name") || "Guest";

  document.getElementById("roomLabel").textContent = roomId;
  document.getElementById("usernameLabel").textContent = username;

  // Initialize socket
  socket = io();

  registerSocketEvents();

  // Get camera + mic
  await initLocalMedia();

  // Join room on server
  socket.emit("join-room", { roomId, name: username });

  // UI controls
  setupControls();
}

// ===============================
//   GET LOCAL CAMERA/MIC
// ===============================
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    const localVideo = document.getElementById("localVideo");
    localVideo.srcObject = localStream;

  } catch (err) {
    console.error("Media error:", err);
    alert("Unable to access camera/microphone.");
  }
}

// ===============================
//   SOCKET.IO EVENTS
// ===============================
function registerSocketEvents() {

  // List of existing users when we join
  socket.on("existing-users", (userIds) => {
    console.log("Existing users:", userIds);
    userIds.forEach((id) => createPeerConnection(id, true)); // we initiate offer
  });

  // A new user joined
  socket.on("user-joined", ({ socketId }) => {
    console.log("New user joined:", socketId);
    createPeerConnection(socketId, true); // send offer
  });

  // Receive offer
  socket.on("offer", async ({ offer, senderId }) => {
    console.log("Received offer from", senderId);
    await createPeerConnection(senderId, false); // we are the answerer

    await peers[senderId].setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peers[senderId].createAnswer();
    await peers[senderId].setLocalDescription(answer);

    socket.emit("answer", {
      answer,
      targetId: senderId
    });
  });

  // Receive answer
  socket.on("answer", async ({ answer, senderId }) => {
    console.log("Received answer from", senderId);
    await peers[senderId].setRemoteDescription(new RTCSessionDescription(answer));
  });

  // ICE candidate
  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    if (peers[senderId]) {
      try {
        await peers[senderId].addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("ICE add failed", e);
      }
    }
  });

  // A user left
  socket.on("user-left", (socketId) => {
    console.log("User left:", socketId);
    removePeer(socketId);
  });

  // Update participant list
  socket.on("room-users", (users) => {
    updateParticipants(users);
  });

  // Chat message
  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });
}

// ===============================
//   CREATE A PEER CONNECTION
// ===============================
function createPeerConnection(remoteId, isInitiator) {
  if (peers[remoteId]) return;

  console.log("Creating peer:", remoteId);

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId] = pc;

  // Add local tracks
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // ICE CANDIDATES
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate
      });
    }
  };

  // REMOTE STREAM
  pc.ontrack = (event) => {
    if (!remoteVideoElements[remoteId]) {
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.className = "video-element remote-video";
      video.srcObject = event.streams[0];

      document.getElementById("remoteVideos").appendChild(video);
      remoteVideoElements[remoteId] = video;
    }
  };

  // CREATE OFFER IF INITIATOR
  if (isInitiator) {
    setTimeout(async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("offer", {
        offer,
        targetId: remoteId
      });
    }, 300);
  }
}

// ===============================
//   REMOVE PEER WHEN USER LEAVES
// ===============================
function removePeer(socketId) {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }

  if (remoteVideoElements[socketId]) {
    remoteVideoElements[socketId].remove();
    delete remoteVideoElements[socketId];
  }
}

// ===============================
//   PARTICIPANT LIST UI
// ===============================
function updateParticipants(users) {
  const list = document.getElementById("participantsList");
  if (!list) return;

  list.innerHTML = "";

  Object.entries(users).forEach(([id, name]) => {
    const li = document.createElement("li");
    li.textContent = name + (id === socket.id ? " (You)" : "");
    list.appendChild(li);
  });
}

// ===============================
//   CHAT
// ===============================
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    socket.emit("chat-message", {
      roomId,
      message: msg,
      name: username
    });

    addChatMessage("You", msg);
    chatInput.value = "";
  });
}

function addChatMessage(name, msg) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${name}:</strong> ${msg}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===============================
//   CONTROLS (MUTE, CAMERA, SCREEN)
// ===============================
function setupControls() {
  const btnMic = document.getElementById("btnToggleMic");
  const btnCam = document.getElementById("btnToggleCamera");
  const btnScreen = document.getElementById("btnShareScreen");

  // Mic
  btnMic.addEventListener("click", () => {
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    btnMic.textContent = audioTrack.enabled ? "🎙️ Mute" : "🔇 Unmute";
  });

  // Camera
  btnCam.addEventListener("click", () => {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    btnCam.textContent = videoTrack.enabled ? "📷 Camera Off" : "📷 Camera On";
  });

  // Screen share
  btnScreen.addEventListener("click", async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true
      });

      const screenTrack = screenStream.getVideoTracks()[0];

      // Replace track for all peers
      for (const id in peers) {
        const sender = peers[id].getSenders().find(s => s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      }

      // When user stops screen share, revert to camera
      screenTrack.onended = () => {
        const cameraTrack = localStream.getVideoTracks()[0];
        for (const id in peers) {
          const sender = peers[id].getSenders().find(s => s.track.kind === "video");
          if (sender) sender.replaceTrack(cameraTrack);
        }
      };

    } catch (err) {
      console.error("Screen share error:", err);
    }
  });
}
