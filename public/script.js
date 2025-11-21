// ===============================
//   MINI ZOOM - CLIENT SCRIPT (FINAL)
// ===============================

let socket = null;
let localStream = null;
let peers = {};               // socketId -> RTCPeerConnection
let remoteVideoElements = {}; // socketId -> video tile wrapper
let participants = {};        // socketId -> name
let roomId = null;
let username = null;

// ICE SERVERS
const iceServers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
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

  if (!joinForm) return;

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

    window.location.href = `room.html?room=${room}&name=${encodeURIComponent(
      name
    )}`;
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
      audio: true,
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
  // Existing users when we join
  socket.on("existing-users", ({ users, selfId }) => {
    participants = users || {};
    updateParticipants(participants);

    // Create offers to all other users
    Object.entries(participants).forEach(([id, name]) => {
      if (id === selfId) return;
      createPeerConnection(id, true);
    });
  });

  // New user joined
  socket.on("user-joined", ({ socketId, name }) => {
    participants[socketId] = name || "Guest";
    updateParticipants(participants);
    createPeerConnection(socketId, false);
  });

  // Offer
  socket.on("offer", async ({ offer, senderId }) => {
    if (!peers[senderId]) {
      createPeerConnection(senderId, false);
    }
    const pc = peers[senderId];
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", { answer, targetId: senderId });
  });

  // Answer
  socket.on("answer", async ({ answer, senderId }) => {
    const pc = peers[senderId];
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  // ICE candidate
  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    const pc = peers[senderId];
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn("ICE add failed:", err);
    }
  });

  // User left
  socket.on("user-left", (socketId) => {
    removePeer(socketId);
  });

  // Full room users update
  socket.on("room-users", (users) => {
    participants = users || {};
    updateParticipants(participants);
    refreshVideoLabels();
  });

  // Chat message
  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // Hand raise broadcast
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
function createPeerConnection(remoteId, isInitiator) {
  if (peers[remoteId]) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId] = pc;

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate,
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
      video.className = "remote-video";
      video.srcObject = event.streams[0];

      const label = document.createElement("div");
      label.textContent = participants[remoteId] || "Guest";
      label.className = "video-label";

      wrapper.appendChild(video);
      wrapper.appendChild(label);

      document.getElementById("remoteVideos").appendChild(wrapper);
      remoteVideoElements[remoteId] = wrapper;
    } else {
      const videoEl = remoteVideoElements[remoteId].querySelector("video");
      if (videoEl) videoEl.srcObject = event.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      removePeer(remoteId);
    }
  };

  if (isInitiator) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { offer, targetId: remoteId });
      } catch (err) {
        console.error("Offer error:", err);
      }
    }, 200);
  }
}

// ===============================
//   REMOVE PEER
// ===============================
function removePeer(socketId) {
  if (peers[socketId]) {
    try {
      peers[socketId].close();
    } catch (e) {}
    delete peers[socketId];
  }

  if (remoteVideoElements[socketId]) {
    try {
      remoteVideoElements[socketId].remove();
    } catch (e) {}
    delete remoteVideoElements[socketId];
  }
}

// ===============================
//   PARTICIPANTS LIST
// ===============================
function updateParticipants(users) {
  const list = document.getElementById("participantsList");
  if (!list) return;
  list.innerHTML = "";

  Object.entries(users).forEach(([id, name]) => {
    const li = document.createElement("li");
    li.textContent = id === socket.id ? `${name} (You)` : name;
    list.appendChild(li);
  });
}

// Update labels on video tiles when names change
function refreshVideoLabels() {
  Object.entries(remoteVideoElements).forEach(([id, wrapper]) => {
    const label = wrapper.querySelector(".video-label");
    if (label) label.textContent = participants[id] || "Guest";
  });
}

// ===============================
//   CHAT SYSTEM
// ===============================
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    socket.emit("chat-message", { roomId, message: msg, name: username });
    addChatMessage("You", msg);
    chatInput.value = "";
  });
}

function addChatMessage(name, msg) {
  if (!chatMessages) return;
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

  if (!btnMic || !btnCam || !btnScreen || !btnLeave || !btnRaise) return;

  // MIC
  btnMic.addEventListener("click", () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    btnMic.textContent = track.enabled ? "🎙️ Mute" : "🔇 Unmute";
  });

  // CAMERA
  btnCam.addEventListener("click", () => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    btnCam.textContent = track.enabled ? "📷 Camera Off" : "📷 Camera On";
  });

  // SCREEN SHARE
  btnScreen.addEventListener("click", async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      for (const id in peers) {
        const sender = peers[id]
          .getSenders()
          .find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      }

      screenTrack.onended = () => {
        const camTrack = localStream?.getVideoTracks()[0];
        if (!camTrack) return;
        for (const id in peers) {
          const sender = peers[id]
            .getSenders()
            .find((s) => s.track && s.track.kind === "video");
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
      raised,
    });
  });

  // LEAVE
  btnLeave.addEventListener("click", () => {
    socket.emit("leave-room");

    Object.values(peers).forEach((pc) => {
      try {
        pc.close();
      } catch {}
    });

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }

    window.location.href = "index.html";
  });
}
