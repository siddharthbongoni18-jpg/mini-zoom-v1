// ===============================
//   MINI ZOOM - CLIENT SCRIPT (ZOOM UI + FIXED SIGNALING)
// ===============================

let socket = null;
let localStream = null;

// peers[socketId] = { pc: RTCPeerConnection, username: string }
let peers = {};
// remoteVideoElements[socketId] = <div.wrapper>
let remoteVideoElements = {};

let roomId = null;
let username = null;

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

  const roomLabel = document.getElementById("roomLabel");
  const usernameLabel = document.getElementById("usernameLabel");

  if (roomLabel) roomLabel.textContent = roomId;
  if (usernameLabel) usernameLabel.textContent = username;

  socket = io();

  registerSocketEvents();
  await initLocalMedia();

  socket.emit("join-room", { roomId, name: username });

  setupChat();
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
    video.muted = true; // avoid echo on own device
    video.srcObject = localStream;
    video.className = "remote-video";

    const label = document.createElement("div");
    label.textContent = "You";
    label.className = "video-label";

    wrapper.appendChild(video);
    wrapper.appendChild(label);

    const grid = document.getElementById("remoteVideos");
    if (!grid) return;

    const existing = document.querySelector(".local-tile");
    if (existing) existing.remove();

    grid.insertBefore(wrapper, grid.firstChild);
  } catch (err) {
    console.error("Media error:", err);
    alert("Failed to access camera/mic.");
  }
}

// ===============================
//   SOCKET EVENTS
// ===============================
function registerSocketEvents() {
  // Existing users when WE join (array of socketIds)
  socket.on("existing-users", (userIds) => {
    if (!Array.isArray(userIds)) return;

    userIds.forEach((id) => {
      if (!peers[id]) peers[id] = {};
      createPeerConnection(id, true);
    });
  });

  // A new user joined (others get this)
  socket.on("user-joined", ({ socketId, name }) => {
    if (!peers[socketId]) peers[socketId] = {};
    peers[socketId].username = name || "Guest";
    createPeerConnection(socketId, false);
  });

  // Offer from another peer
  socket.on("offer", async ({ offer, senderId }) => {
    if (!peers[senderId]) peers[senderId] = {};
    createPeerConnection(senderId, false);

    const pc = peers[senderId].pc;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("answer", { answer, targetId: senderId });
    } catch (err) {
      console.error("Error handling offer:", err);
    }
  });

  // Answer to our offer
  socket.on("answer", async ({ answer, senderId }) => {
    const pc = peers[senderId]?.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error("Error handling answer:", err);
    }
  });

  // ICE candidate
  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    const pc = peers[senderId]?.pc;
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Error adding ice candidate:", err);
    }
  });

  // User leaves
  socket.on("user-left", (socketId) => {
    removePeer(socketId);
  });

  // Full room user list { socketId: name }
  socket.on("room-users", (users) => {
    updateParticipants(users);
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
function createPeerConnection(remoteId, initiator) {
  if (peers[remoteId].pc instanceof RTCPeerConnection) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId].pc = pc;

  // Add local tracks
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
    // Create tile if not present
    if (!remoteVideoElements[remoteId]) {
      const wrapper = document.createElement("div");
      wrapper.className = "remote-video-wrapper";

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.className = "remote-video";
      video.srcObject = event.streams[0];

      const label = document.createElement("div");
      label.className = "video-label";
      label.textContent = peers[remoteId]?.username || "Guest";

      wrapper.appendChild(video);
      wrapper.appendChild(label);

      const grid = document.getElementById("remoteVideos");
      if (grid) grid.appendChild(wrapper);
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

  if (initiator) {
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
    } catch {}
  }
  delete peers[socketId];

  if (remoteVideoElements[socketId]) {
    remoteVideoElements[socketId].remove();
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
    // store username in peers map
    if (!peers[id]) peers[id] = {};
    peers[id].username = name;

    // Update video label if tile exists
    if (remoteVideoElements[id]) {
      const labelEl =
        remoteVideoElements[id].querySelector(".video-label");
      if (labelEl) {
        labelEl.textContent = id === socket.id ? `${name} (You)` : name;
      }
    }

    const li = document.createElement("li");
    li.textContent = id === socket.id ? `${name} (You)` : name;
    list.appendChild(li);
  });
}

// ===============================
//   CHAT SYSTEM
// ===============================
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

function setupChat() {
  if (!chatForm) return;

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
//   CONTROLS + SIDEBAR
// ===============================
function setupControls() {
  const btnMic = document.getElementById("btnToggleMic");
  const btnCam = document.getElementById("btnToggleCamera");
  const btnScreen = document.getElementById("btnShareScreen");
  const btnLeave = document.getElementById("btnLeave");
  const btnRaise = document.getElementById("btnRaiseHand");
  const btnParticipants = document.getElementById("btnParticipants");
  const btnChat = document.getElementById("btnChat");

  const sidebar = document.getElementById("sidebar");
  const btnCloseSidebar = document.getElementById("btnCloseSidebar");
  const tabParticipants = document.getElementById("tabParticipants");
  const tabChat = document.getElementById("tabChat");
  const panelParticipants = document.getElementById("panelParticipants");
  const panelChat = document.getElementById("panelChat");

  // ---- MIC ----
  if (btnMic) {
    btnMic.addEventListener("click", () => {
      const track = localStream?.getAudioTracks?.()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      btnMic.querySelector(".control-label").textContent = track.enabled
        ? "Mute"
        : "Unmute";
    });
  }

  // ---- CAMERA ----
  if (btnCam) {
    btnCam.addEventListener("click", () => {
      const track = localStream?.getVideoTracks?.()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      btnCam.querySelector(".control-label").textContent = track.enabled
        ? "Stop Video"
        : "Start Video";
    });
  }

  // ---- SCREEN SHARE ----
  if (btnScreen) {
    btnScreen.addEventListener("click", async () => {
      try {
        const screenStream =
          await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        Object.values(peers).forEach((p) => {
          const sender = p.pc
            ?.getSenders()
            .find((s) => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        });

        screenTrack.onended = () => {
          const camTrack = localStream?.getVideoTracks?.()[0];
          Object.values(peers).forEach((p) => {
            const sender = p.pc
              ?.getSenders()
              .find((s) => s.track && s.track.kind === "video");
            if (sender && camTrack) sender.replaceTrack(camTrack);
          });
        };
      } catch (err) {
        console.error("Screen share error:", err);
      }
    });
  }

  // ---- HAND RAISE ----
  if (btnRaise) {
    btnRaise.addEventListener("click", () => {
      const raised = btnRaise.classList.toggle("raised");
      btnRaise.querySelector(".control-label").textContent = raised
        ? "Hand Raised"
        : "Raise Hand";

      socket.emit("hand-raise", { roomId, username, raised });
    });
  }

  // ---- LEAVE ----
  if (btnLeave) {
    btnLeave.addEventListener("click", () => {
      socket.emit("leave-room");

      Object.values(peers).forEach((p) => {
        if (p.pc) {
          try {
            p.pc.close();
          } catch {}
        }
      });

      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }

      window.location.href = "index.html";
    });
  }

  // ---- SIDEBAR HELPERS ----
  function openSidebar(mode) {
    if (!sidebar) return;
    sidebar.classList.add("sidebar-visible");

    setSidebarTab(mode || "participants");
  }

  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove("sidebar-visible");
  }

  function setSidebarTab(mode) {
    if (!tabParticipants || !tabChat || !panelParticipants || !panelChat)
      return;

    if (mode === "chat") {
      tabChat.classList.add("active");
      tabParticipants.classList.remove("active");
      panelChat.classList.add("active");
      panelParticipants.classList.remove("active");
    } else {
      tabParticipants.classList.add("active");
      tabChat.classList.remove("active");
      panelParticipants.classList.add("active");
      panelChat.classList.remove("active");
    }
  }

  // Buttons to open sidebar
  if (btnParticipants) {
    btnParticipants.addEventListener("click", () => openSidebar("participants"));
  }
  if (btnChat) {
    btnChat.addEventListener("click", () => openSidebar("chat"));
  }

  // Tabs inside sidebar
  if (tabParticipants) {
    tabParticipants.addEventListener("click", () =>
      setSidebarTab("participants")
    );
  }
  if (tabChat) {
    tabChat.addEventListener("click", () => setSidebarTab("chat"));
  }

  // Close sidebar
  if (btnCloseSidebar) {
    btnCloseSidebar.addEventListener("click", closeSidebar);
  }
}
