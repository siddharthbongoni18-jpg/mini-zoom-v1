// ===============================
//   MINI ZOOM - CLIENT SCRIPT (FINAL FIXED)
// ===============================

let socket = null;
let localStream = null;
let peers = {};               // socketId -> RTCPeerConnection
let remoteVideoElements = {}; // socketId -> video tile wrapper
let roomId = null;
let username = null;

// ICE SERVERS
const iceServers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
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
//   HOME PAGE
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

    try {
      await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      alert("Camera/mic blocked.");
      return;
    }

    window.location.href = `room.html?room=${room}&name=${encodeURIComponent(name)}`;
  });
}

// ===============================
//   ROOM PAGE
// ===============================
async function initRoomPage() {
  const params = new URLSearchParams(window.location.search);
  roomId = params.get("room");
  username = params.get("name") || "Guest";

  document.getElementById("roomLabel").textContent = roomId;
  document.getElementById("usernameLabel").textContent = username;

  socket = io();

  registerSocketEvents();
  await initLocalMedia();

  socket.emit("join-room", { roomId, name: username });

  setupControls();
}

// ===============================
//   INIT LOCAL MEDIA
// ===============================
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    const wrapper = document.createElement("div");
    wrapper.className = "remote-video-wrapper local-tile";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = localStream;
    video.className = "remote-video";

    const label = document.createElement("div");
    label.textContent = "You";
    label.className = "video-label";

    wrapper.appendChild(video);
    wrapper.appendChild(label);

    const grid = document.getElementById("remoteVideos");
    const existing = document.querySelector(".local-tile");
    if (existing) existing.remove();

    grid.insertBefore(wrapper, grid.firstChild);

  } catch (err) {
    console.error(err);
    alert("Failed to access camera/mic.");
  }
}

// ===============================
//   SOCKET EVENTS
// ===============================
function registerSocketEvents() {

  socket.on("existing-users", (users) => {
    Object.entries(users).forEach(([id, name]) => {
      peers[id] = { username: name };
      createPeerConnection(id, true);
    });
  });

  socket.on("user-joined", ({ socketId, name }) => {
    peers[socketId] = { username: name };
    createPeerConnection(socketId, false);
  });

  socket.on("offer", async ({ offer, senderId }) => {
    if (!peers[senderId]) peers[senderId] = {};
    createPeerConnection(senderId, false);

    await peers[senderId].pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peers[senderId].pc.createAnswer();

    await peers[senderId].pc.setLocalDescription(answer);

    socket.emit("answer", { answer, targetId: senderId });
  });

  socket.on("answer", async ({ answer, senderId }) => {
    if (peers[senderId]?.pc) {
      await peers[senderId].pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    if (peers[senderId]?.pc) {
      await peers[senderId].pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });

  socket.on("user-left", (socketId) => {
    removePeer(socketId);
  });

  socket.on("room-users", (users) => {
    updateParticipants(users);
  });

  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // HAND RAISE
  socket.on("hand-raise", ({ username, raised }) => {
    addChatMessage(
      "System",
      `${username} has ${raised ? "raised" : "lowered"} their hand ✋`
    );
  });
}

// ===============================
//   CREATE PEER CONNECTION
// ===============================
function createPeerConnection(remoteId, initiator) {
  if (peers[remoteId].pc instanceof RTCPeerConnection) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId].pc = pc;

  // Add local tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    if (!remoteVideoElements[remoteId]) {

      const wrapper = document.createElement("div");
      wrapper.className = "remote-video-wrapper";

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = event.streams[0];
      video.className = "remote-video";

      const label = document.createElement("div");
      label.textContent = peers[remoteId]?.username || "Guest";
      label.className = "video-label";

      wrapper.appendChild(video);
      wrapper.appendChild(label);

      document.getElementById("remoteVideos").appendChild(wrapper);
      remoteVideoElements[remoteId] = wrapper;

    } else {
      remoteVideoElements[remoteId].querySelector("video").srcObject = event.streams[0];
    }
  };

  if (initiator) {
    setTimeout(async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("offer", { offer, targetId: remoteId });
    }, 200);
  }
}

// ===============================
//   REMOVE PEER
// ===============================
function removePeer(socketId) {
  if (peers[socketId]?.pc) {
    peers[socketId].pc.close();
  }

  delete peers[socketId];

  if (remoteVideoElements[socketId]) {
    remoteVideoElements[socketId].remove();
    delete remoteVideoElements[socketId];
  }
}

// ===============================
//   UPDATE PARTICIPANTS LIST
// ===============================
function updateParticipants(users) {
  const list = document.getElementById("participantsList");
  list.innerHTML = "";

  Object.entries(users).forEach(([id, name]) => {
    if (!peers[id]) peers[id] = {};
    peers[id].username = name;

    const li = document.createElement("li");
    li.textContent = (id === socket.id) ? `${name} (You)` : name;
    list.appendChild(li);
  });
}

// ===============================
//   CHAT
// ===============================
function addChatMessage(name, msg) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${name}:</strong> ${msg}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===============================
//   CONTROL BUTTONS
// ===============================
function setupControls() {
  const btnMic = document.getElementById("btnToggleMic");
  const btnCam = document.getElementById("btnToggleCamera");
  const btnScreen = document.getElementById("btnShareScreen");
  const btnLeave = document.getElementById("btnLeave");
  const btnRaise = document.getElementById("btnRaiseHand");

  // MIC
  btnMic.addEventListener("click", () => {
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    btnMic.textContent = track.enabled ? "🎙️ Mute" : "🔇 Unmute";
  });

  // CAMERA
  btnCam.addEventListener("click", () => {
    const track = localStream.getVideoTracks()[0];
    track.enabled = !track.enabled;
    btnCam.textContent = track.enabled ? "📷 Camera Off" : "📷 Camera On";
  });

  // SCREEN SHARE
  btnScreen.addEventListener("click", async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      for (const id in peers) {
        const sender = peers[id].pc.getSenders().find(s => s.track?.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      }

      screenTrack.onended = () => {
        const camTrack = localStream.getVideoTracks()[0];
        for (const id in peers) {
          const sender = peers[id].pc.getSenders().find(s => s.track?.kind === "video");
          if (sender) sender.replaceTrack(camTrack);
        }
      };

    } catch (err) {
      console.error("Screen share error:", err);
    }
  });

  // HAND RAISE
  btnRaise.addEventListener("click", () => {
    const raised = btnRaise.classList.toggle("raised");
    btnRaise.textContent = raised ? "🙌 Hand Raised" : "✋ Raise Hand";

    socket.emit("hand-raise", {
      roomId,
      username,
      raised
    });
  });

  // LEAVE
  btnLeave.addEventListener("click", () => {
    socket.emit("leave-room");

    Object.values(peers).forEach(p => {
      if (p.pc) p.pc.close();
    });

    localStream.getTracks().forEach(t => t.stop());

    window.location.href = "index.html";
  });
}
