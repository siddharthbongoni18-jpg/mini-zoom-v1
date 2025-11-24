// ===============================
//   MINI ZOOM - CLIENT SCRIPT (ZOOM UI + HOST + HAND RAISE)
// ===============================

let socket = null;
let localStream = null;

// peers[socketId] = { pc: RTCPeerConnection, username: string }
let peers = {};
// remoteVideoElements[socketId] = wrapper <div> that contains the video + label
let remoteVideoElements = {};

let roomId = null;
let username = null;

// DOM refs used on room page
let chatFormEl, chatInputEl, chatMessagesEl;
let participantsListEl;
let btnMic, btnCam, btnScreen, btnLeave, btnRaise;
let btnOpenParticipants, btnOpenChat, btnCloseSidebar;
let sidebarEl, sidebarTabParticipants, sidebarTabChat;
let sidebarViewParticipants, sidebarViewChat;
let hostId = null;

// ICE servers
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
//   HOME PAGE LOGIC
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
      alert("Camera / microphone is blocked. Please allow them.");
      return;
    }

    window.location.href = `room.html?room=${room}&name=${encodeURIComponent(
      name
    )}`;
  });
}

// ===============================
//   ROOM PAGE LOGIC
// ===============================
async function initRoomPage() {
  // ----- basic info -----
  const params = new URLSearchParams(window.location.search);
  roomId = params.get("room");
  username = params.get("name") || "Guest";

  document.getElementById("roomLabel").textContent = roomId || "";
  document.getElementById("usernameLabel").textContent = username || "";

  // ----- DOM refs -----
  chatFormEl = document.getElementById("chatForm");
  chatInputEl = document.getElementById("chatInput");
  chatMessagesEl = document.getElementById("chatMessages");
  participantsListEl = document.getElementById("participantsList");

  btnMic = document.getElementById("btnToggleMic");
  btnCam = document.getElementById("btnToggleCamera");
  btnScreen = document.getElementById("btnShareScreen");
  btnLeave = document.getElementById("btnLeave");
  btnRaise = document.getElementById("btnRaiseHand");

  btnOpenParticipants = document.getElementById("btnOpenParticipants");
  btnOpenChat = document.getElementById("btnOpenChat");
  btnCloseSidebar = document.getElementById("btnCloseSidebar");

  sidebarEl = document.getElementById("sidebarPanel");
  sidebarTabParticipants = document.getElementById("tabParticipants");
  sidebarTabChat = document.getElementById("tabChat");
  sidebarViewParticipants = document.getElementById("sidebarParticipantsView");
  sidebarViewChat = document.getElementById("sidebarChatView");

  // ----- connect socket -----
  socket = io();

  registerSocketEvents();

  // ----- get camera+mic -----
  await initLocalMedia();

  // join room on server (after stream)
  socket.emit("join-room", { roomId, name: username });

  // controls + chat + sidebar
  setupControls();
  setupChat();
  setupSidebar();
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

    // Create local video tile that looks exactly like remote ones
    const wrapper = document.createElement("div");
    wrapper.className = "remote-video-wrapper local-tile";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // avoid echo
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
    console.error("Media error:", err);
    alert("Failed to access camera/microphone.");
  }
}

// ===============================
//   SOCKET.IO EVENTS
// ===============================
function registerSocketEvents() {
  // existing users -> only new client receives this
  socket.on("existing-users", (users) => {
    // users is: { socketId: name, ... }
    if (!users) return;

    Object.entries(users).forEach(([id, name]) => {
      if (!peers[id]) peers[id] = {};
      peers[id].username = name;
      createPeerConnection(id, true); // we are initiator towards existing users
    });
  });

  // new user joined -> broadcast to existing clients
  socket.on("user-joined", ({ socketId, name }) => {
    if (!peers[socketId]) peers[socketId] = {};
    peers[socketId].username = name;
    createPeerConnection(socketId, false); // we wait to receive offer
  });

  // offer -> we must answer
  socket.on("offer", async ({ offer, senderId }) => {
    if (!peers[senderId]) peers[senderId] = {};
    createPeerConnection(senderId, false);

    const pc = peers[senderId].pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("answer", { answer, targetId: senderId });
    } catch (err) {
      console.error("Error handling offer:", err);
    }
  });

  // answer -> only offer creator receives this
  socket.on("answer", async ({ answer, senderId }) => {
    const pc = peers[senderId]?.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error("Error setting remote description (answer):", err);
    }
  });

  // ICE candidates
  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    const pc = peers[senderId]?.pc;
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("ICE add error:", err);
    }
  });

  // someone left
  socket.on("user-left", (socketId) => {
    removePeer(socketId);
  });

  // participants list
  socket.on("room-users", (users) => {
    updateParticipants(users);
  });

  // host info
  socket.on("room-host", ({ hostId: hId }) => {
    hostId = hId;
    highlightHost();
  });

  // chat
  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // hand raise
  socket.on("hand-raise", ({ socketId, username, raised }) => {
    const labelText = `${username} has ${
      raised ? "raised" : "lowered"
    } their hand ✋`;
    addChatMessage("System", labelText);

    if (socketId === socket.id) {
      const localTile = document.querySelector(".local-tile");
      if (localTile) {
        localTile.classList.toggle("hand-raised", raised);
      }
    } else if (remoteVideoElements[socketId]) {
      remoteVideoElements[socketId].classList.toggle("hand-raised", raised);
    }
  });

  // host controls (mute all)
  socket.on("force-mute", () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (track) track.enabled = false;
    if (btnMic) btnMic.textContent = "🔇 Unmute";
  });

  // kicked by host
  socket.on("kicked", () => {
    alert("You have been removed from the meeting by the host.");
    cleanupAndLeave();
  });

  // screen share layout events (optional, mainly for UI)
  socket.on("screen-share-start", ({ socketId }) => {
    document.body.classList.add("screen-share-active");
    document.body.dataset.screenSharer = socketId;
  });

  socket.on("screen-share-stop", () => {
    document.body.classList.remove("screen-share-active");
    delete document.body.dataset.screenSharer;
  });
}

// ===============================
//   CREATE PEER CONNECTION
// ===============================
function createPeerConnection(remoteId, isInitiator) {
  // peers[remoteId] object must exist
  if (!peers[remoteId]) peers[remoteId] = {};

  // avoid duplicates
  if (peers[remoteId].pc instanceof RTCPeerConnection) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId].pc = pc;

  // add local tracks to this connection
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE -> send to remote
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        targetId: remoteId,
        candidate: event.candidate,
      });
    }
  };

  // remote tracks
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;

    if (!remoteVideoElements[remoteId]) {
      const wrapper = document.createElement("div");
      wrapper.className = "remote-video-wrapper";
      wrapper.dataset.socketId = remoteId;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.className = "remote-video";
      video.srcObject = stream;

      const label = document.createElement("div");
      label.textContent = peers[remoteId]?.username || "Guest";
      label.className = "video-label";

      wrapper.appendChild(video);
      wrapper.appendChild(label);

      document.getElementById("remoteVideos").appendChild(wrapper);
      remoteVideoElements[remoteId] = wrapper;
    } else {
      const video = remoteVideoElements[remoteId].querySelector("video");
      if (video) video.srcObject = stream;
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected"
    ) {
      removePeer(remoteId);
    }
  };

  // if we are the initiator, create & send offer
  if (isInitiator) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("offer", { offer, targetId: remoteId });
      } catch (err) {
        console.error("Error creating offer:", err);
      }
    }, 200);
  }
}

// ===============================
//   REMOVE PEER
// ===============================
function removePeer(socketId) {
  if (peers[socketId]?.pc) {
    try {
      peers[socketId].pc.close();
    } catch (e) {}
  }
  delete peers[socketId];

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
  if (!participantsListEl) return;
  participantsListEl.innerHTML = "";

  if (!users) return;

  Object.entries(users).forEach(([id, name]) => {
    if (!peers[id]) peers[id] = {};
    peers[id].username = name;

    const li = document.createElement("li");
    li.textContent = id === socket.id ? `${name} (You)` : name;
    if (id === hostId) li.textContent += " ⭐ (Host)";
    participantsListEl.appendChild(li);
  });

  highlightHost();
}

function highlightHost() {
  if (!participantsListEl) return;
  const items = participantsListEl.querySelectorAll("li");
  items.forEach((li) => {
    if (li.textContent.includes("⭐ (Host)")) {
      li.classList.add("host-item");
    }
  });
}

// ===============================
//   CHAT
// ===============================
function setupChat() {
  if (!chatFormEl) return;

  chatFormEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInputEl.value.trim();
    if (!msg) return;

    socket.emit("chat-message", { roomId, message: msg, name: username });
    addChatMessage("You", msg);
    chatInputEl.value = "";
  });
}

function addChatMessage(name, msg) {
  if (!chatMessagesEl) return;
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(msg)}`;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ===============================
//   CONTROLS (MIC, CAM, SCREEN, HAND, LEAVE)
// ===============================
function setupControls() {
  // MIC
  if (btnMic) {
    btnMic.addEventListener("click", () => {
      if (!localStream) return;
      const track = localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      btnMic.textContent = track.enabled ? "🎙️ Mute" : "🔇 Unmute";
    });
  }

  // CAMERA
  if (btnCam) {
    btnCam.addEventListener("click", () => {
      if (!localStream) return;
      const track = localStream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      btnCam.textContent = track.enabled ? "📷 Camera Off" : "📷 Camera On";
    });
  }

  // SCREEN SHARE
  if (btnScreen) {
    btnScreen.addEventListener("click", async () => {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        const screenTrack = screenStream.getVideoTracks()[0];

        // notify others for layout
        socket.emit("screen-share-start", { roomId });

        // replace video track in each peer connection
        Object.values(peers).forEach((p) => {
          const sender = p.pc
            ?.getSenders()
            .find((s) => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        });

        // when share stops -> revert
        screenTrack.onended = () => {
          const camTrack = localStream.getVideoTracks()[0];
          Object.values(peers).forEach((p) => {
            const sender = p.pc
              ?.getSenders()
              .find((s) => s.track && s.track.kind === "video");
            if (sender && camTrack) sender.replaceTrack(camTrack);
          });
          socket.emit("screen-share-stop", { roomId });
        };
      } catch (err) {
        console.error("Screen share error:", err);
      }
    });
  }

  // HAND RAISE
  if (btnRaise) {
    btnRaise.addEventListener("click", () => {
      const raised = btnRaise.classList.toggle("raised");
      btnRaise.textContent = raised ? "🙌 Hand Raised" : "✋ Raise Hand";

      // local badge
      const localTile = document.querySelector(".local-tile");
      if (localTile) localTile.classList.toggle("hand-raised", raised);

      socket.emit("hand-raise", { roomId, username, raised });
    });
  }

  // LEAVE
  if (btnLeave) {
    btnLeave.addEventListener("click", () => {
      cleanupAndLeave();
    });
  }

  // HOST CONTROLS (if you added host buttons in HTML)
  const btnMuteAll = document.getElementById("btnMuteAll");
  if (btnMuteAll) {
    btnMuteAll.addEventListener("click", () => {
      if (socket.id !== hostId) return;
      socket.emit("host-mute-all", { roomId });
    });
  }
}

// Clean up streams + peers + go back home
function cleanupAndLeave() {
  socket.emit("leave-room");

  Object.values(peers).forEach((p) => {
    if (p.pc) {
      try {
        p.pc.close();
      } catch (e) {}
    }
  });
  peers = {};
  remoteVideoElements = {};

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  window.location.href = "index.html";
}

// ===============================
//   SIDEBAR (PARTICIPANTS / CHAT)
// ===============================
function setupSidebar() {
  if (!sidebarEl) return;

  const openParticipants = () => openSidebar("participants");
  const openChat = () => openSidebar("chat");
  const closeSidebar = () => sidebarEl.classList.remove("visible");

  if (btnOpenParticipants) btnOpenParticipants.addEventListener("click", openParticipants);
  if (btnOpenChat) btnOpenChat.addEventListener("click", openChat);
  if (btnCloseSidebar) btnCloseSidebar.addEventListener("click", closeSidebar);

  if (sidebarTabParticipants) {
    sidebarTabParticipants.addEventListener("click", () =>
      switchSidebarTab("participants")
    );
  }
  if (sidebarTabChat) {
    sidebarTabChat.addEventListener("click", () =>
      switchSidebarTab("chat")
    );
  }
}

function openSidebar(tab) {
  if (!sidebarEl) return;
  sidebarEl.classList.add("visible");
  switchSidebarTab(tab);
}

function switchSidebarTab(tab) {
  if (!sidebarEl) return;

  const isParticipants = tab === "participants";

  if (sidebarTabParticipants)
    sidebarTabParticipants.classList.toggle("active", isParticipants);
  if (sidebarTabChat)
    sidebarTabChat.classList.toggle("active", !isParticipants);

  if (sidebarViewParticipants)
    sidebarViewParticipants.style.display = isParticipants ? "block" : "none";
  if (sidebarViewChat)
    sidebarViewChat.style.display = !isParticipants ? "flex" : "none";
}
