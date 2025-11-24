// ===============================
//   MINI ZOOM - CLIENT SCRIPT (ZOOM UI + HOST + HAND RAISE + SCREEN LAYOUT)
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
let btnParticipants, btnChat, btnCloseSidebar;
let sidebarEl, sidebarTabParticipants, sidebarTabChat;
let panelParticipantsEl, panelChatEl;

let hostId = null;
let currentScreenSharerId = null; // who is sharing screen right now

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
  const params = new URLSearchParams(window.location.search);
  roomId = params.get("room");
  username = params.get("name") || "Guest";

  const roomLabel = document.getElementById("roomLabel");
  const usernameLabel = document.getElementById("usernameLabel");
  if (roomLabel) roomLabel.textContent = roomId || "";
  if (usernameLabel) usernameLabel.textContent = username || "";

  // DOM refs
  chatFormEl = document.getElementById("chatForm");
  chatInputEl = document.getElementById("chatInput");
  chatMessagesEl = document.getElementById("chatMessages");
  participantsListEl = document.getElementById("participantsList");

  btnMic = document.getElementById("btnToggleMic");
  btnCam = document.getElementById("btnToggleCamera");
  btnScreen = document.getElementById("btnShareScreen");
  btnLeave = document.getElementById("btnLeave");
  btnRaise = document.getElementById("btnRaiseHand");

  btnParticipants = document.getElementById("btnParticipants");
  btnChat = document.getElementById("btnChat");
  btnCloseSidebar = document.getElementById("btnCloseSidebar");

  sidebarEl = document.getElementById("sidebar");
  sidebarTabParticipants = document.getElementById("tabParticipants");
  sidebarTabChat = document.getElementById("tabChat");
  panelParticipantsEl = document.getElementById("panelParticipants");
  panelChatEl = document.getElementById("panelChat");

  // Socket
  socket = io();

  registerSocketEvents();

  // Local media first
  await initLocalMedia();

  // Join room
  socket.emit("join-room", { roomId, name: username });

  // UI wiring
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

    const wrapper = document.createElement("div");
    wrapper.className = "remote-video-wrapper local-tile";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // avoids echo
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
  // users: { socketId: name, ... }
  socket.on("existing-users", (users) => {
    if (!users) return;
    Object.entries(users).forEach(([id, name]) => {
      if (!peers[id]) peers[id] = {};
      peers[id].username = name;
      createPeerConnection(id, true); // we initiate offers to existing users
    });
  });

  // new user joined -> broadcast to existing clients
  socket.on("user-joined", ({ socketId, name }) => {
    if (!peers[socketId]) peers[socketId] = {};
    peers[socketId].username = name;
    createPeerConnection(socketId, false); // we wait for offer
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
  socket.on("hand-raise", ({ socketId: sId, username: uname, raised }) => {
    const labelText = `${uname} has ${
      raised ? "raised" : "lowered"
    } their hand ✋`;
    addChatMessage("System", labelText);

    const targetTile =
      sId === socket.id
        ? document.querySelector(".local-tile")
        : remoteVideoElements[sId];

    if (targetTile) {
      targetTile.classList.toggle("hand-raised", raised);
    }
  });

  // host controls (mute all)
  socket.on("force-mute", () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (track) track.enabled = false;
    updateMicButton(false);
  });

  // kicked by host
  socket.on("kicked", () => {
    alert("You have been removed from the meeting by the host.");
    cleanupAndLeave();
  });

  // SCREEN SHARE LAYOUT EVENTS
  socket.on("screen-share-start", ({ socketId: sharerId }) => {
    currentScreenSharerId = sharerId;
    applyScreenShareLayout();
  });

  socket.on("screen-share-stop", () => {
    currentScreenSharerId = null;
    resetScreenShareLayout();
  });
}

// ===============================
//   CREATE PEER CONNECTION
// ===============================
function createPeerConnection(remoteId, isInitiator) {
  if (!peers[remoteId]) peers[remoteId] = {};

  // avoid duplicates
  if (peers[remoteId].pc instanceof RTCPeerConnection) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId].pc = pc;

  // add local tracks
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

    // if someone is already sharing, update layout so new tile goes to side
    if (currentScreenSharerId) {
      applyScreenShareLayout();
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
//   SCREEN SHARE LAYOUT HELPERS
// ===============================
function applyScreenShareLayout() {
  const grid = document.getElementById("remoteVideos");
  if (!grid) return;

  grid.classList.add("screen-share-layout");

  const localTile = document.querySelector(".local-tile");

  // clear old classes
  if (localTile) {
    localTile.classList.remove("screen-share-tile", "thumbnail-tile");
  }
  Object.values(remoteVideoElements).forEach((el) => {
    el.classList.remove("screen-share-tile", "thumbnail-tile");
  });

  const sharerId = currentScreenSharerId;

  // mark tiles
  if (sharerId && remoteVideoElements[sharerId]) {
    // remote person is sharing
    remoteVideoElements[sharerId].classList.add("screen-share-tile");

    // local + others go to thumbnail column
    if (localTile) localTile.classList.add("thumbnail-tile");
    Object.entries(remoteVideoElements).forEach(([id, el]) => {
      if (id !== sharerId) el.classList.add("thumbnail-tile");
    });
  } else {
    // we (this client) might be sharing (others see our screen),
    // or we don't know sharer -> just put local as thumbnail
    if (localTile) localTile.classList.add("thumbnail-tile");
    Object.values(remoteVideoElements).forEach((el) =>
      el.classList.add("thumbnail-tile")
    );
  }
}

function resetScreenShareLayout() {
  const grid = document.getElementById("remoteVideos");
  if (!grid) return;

  grid.classList.remove("screen-share-layout");

  const localTile = document.querySelector(".local-tile");
  if (localTile) {
    localTile.classList.remove("screen-share-tile", "thumbnail-tile");
  }
  Object.values(remoteVideoElements).forEach((el) =>
    el.classList.remove("screen-share-tile", "thumbnail-tile")
  );
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

  // if the person who left was screen sharer, reset layout
  if (currentScreenSharerId === socketId) {
    currentScreenSharerId = null;
    resetScreenShareLayout();
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
//   CONTROL BUTTONS (MIC, CAM, SCREEN, HAND, LEAVE)
// ===============================
function setupControls() {
  // MIC
  if (btnMic) {
    btnMic.addEventListener("click", () => {
      if (!localStream) return;
      const track = localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      updateMicButton(track.enabled);
    });
  }

  // CAMERA
  if (btnCam) {
    btnCam.addEventListener("click", () => {
      if (!localStream) return;
      const track = localStream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      updateCameraButton(track.enabled);
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

        socket.emit("screen-share-start", { roomId });

        Object.values(peers).forEach((p) => {
          const sender = p.pc
            ?.getSenders()
            .find((s) => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        });

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
      updateRaiseHandButton(raised);

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

  // Host mute-all button (optional, if you add it in HTML)
  const btnMuteAll = document.getElementById("btnMuteAll");
  if (btnMuteAll) {
    btnMuteAll.addEventListener("click", () => {
      if (socket.id !== hostId) return;
      socket.emit("host-mute-all", { roomId });
    });
  }
}

function updateMicButton(enabled) {
  if (!btnMic) return;
  const icon = btnMic.querySelector(".control-icon");
  const label = btnMic.querySelector(".control-label");
  if (enabled) {
    if (icon) icon.textContent = "🎙️";
    if (label) label.textContent = "Mute";
  } else {
    if (icon) icon.textContent = "🔇";
    if (label) label.textContent = "Unmute";
  }
}

function updateCameraButton(enabled) {
  if (!btnCam) return;
  const icon = btnCam.querySelector(".control-icon");
  const label = btnCam.querySelector(".control-label");
  if (enabled) {
    if (icon) icon.textContent = "📷";
    if (label) label.textContent = "Stop Video";
  } else {
    if (icon) icon.textContent = "📷";
    if (label) label.textContent = "Start Video";
  }
}

function updateRaiseHandButton(raised) {
  if (!btnRaise) return;
  const icon = btnRaise.querySelector(".control-icon");
  const label = btnRaise.querySelector(".control-label");
  if (raised) {
    if (icon) icon.textContent = "🙌";
    if (label) label.textContent = "Hand Raised";
  } else {
    if (icon) icon.textContent = "✋";
    if (label) label.textContent = "Raise Hand";
  }
}

// Clean up everything & go back home
function cleanupAndLeave() {
  if (socket) {
    socket.emit("leave-room");
  }

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
    localStream = null;
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
  const closeSidebar = () => sidebarEl.classList.remove("sidebar-visible");

  if (btnParticipants)
    btnParticipants.addEventListener("click", openParticipants);
  if (btnChat) btnChat.addEventListener("click", openChat);
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
  sidebarEl.classList.add("sidebar-visible");
  switchSidebarTab(tab);
}

function switchSidebarTab(tab) {
  const isParticipants = tab === "participants";

  if (sidebarTabParticipants)
    sidebarTabParticipants.classList.toggle("active", isParticipants);
  if (sidebarTabChat)
    sidebarTabChat.classList.toggle("active", !isParticipants);

  if (panelParticipantsEl)
    panelParticipantsEl.classList.toggle("active", isParticipants);
  if (panelChatEl) panelChatEl.classList.toggle("active", !isParticipants);
}
