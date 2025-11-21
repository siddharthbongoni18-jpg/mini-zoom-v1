// ===============================
//   MINI ZOOM - CLIENT SCRIPT (FINAL WITH SCREEN SHARE + HAND + HOST)
// ===============================

let socket = null;
let localStream = null;

// peers[ socketId ] = { pc: RTCPeerConnection, username: string }
let peers = {};
// remoteVideoElements[ socketId ] = wrapper div for that user's tile
let remoteVideoElements = {};

let roomId = null;
let username = null;

let currentHostId = null;
let isHost = false;
let currentScreenSharerId = null;

// Chat elements (only for room page)
let chatForm = null;
let chatInput = null;
let chatMessages = null;

// ICE SERVERS
const iceServers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
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

  // chat elements
  chatForm = document.getElementById("chatForm");
  chatInput = document.getElementById("chatInput");
  chatMessages = document.getElementById("chatMessages");

  socket = io();

  registerSocketEvents();
  await initLocalMedia();
  setupChat();

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

    // store local tile too, using our own socket id later
    remoteVideoElements["local"] = wrapper; // temporary key; will fix when socket.id known

  } catch (err) {
    console.error(err);
    alert("Failed to access camera/mic.");
  }
}

// ===============================
//   SOCKET EVENTS
// ===============================
function registerSocketEvents() {
  // existing users when WE join
  socket.on("existing-users", (users) => {
    // users is { socketId: name }
    Object.entries(users).forEach(([id, name]) => {
      if (!peers[id]) peers[id] = {};
      peers[id].username = name;
      createPeerConnection(id, true);
    });
  });

  // new user joined (other people)
  socket.on("user-joined", ({ socketId, name }) => {
    if (!peers[socketId]) peers[socketId] = {};
    peers[socketId].username = name;
    createPeerConnection(socketId, false);
  });

  socket.on("offer", async ({ offer, senderId }) => {
    if (!peers[senderId]) peers[senderId] = {};
    createPeerConnection(senderId, false);

    const pc = peers[senderId].pc;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("answer", { answer, targetId: senderId });
  });

  socket.on("answer", async ({ answer, senderId }) => {
    const pc = peers[senderId]?.pc;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    const pc = peers[senderId]?.pc;
    if (!pc) return;
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  socket.on("user-left", (socketId) => {
    removePeer(socketId);
  });

  socket.on("room-users", (users) => {
    updateParticipants(users);
  });

  socket.on("room-host", ({ hostId }) => {
    currentHostId = hostId;
    isHost = socket.id === hostId;
    updateHostUI();
    // refresh participant labels (Host tag)
    // we don't have users here, but next room-users will handle text; this just toggles buttons
  });

  socket.on("chat-message", ({ message, name }) => {
    addChatMessage(name, message);
  });

  // HAND RAISE
  socket.on("hand-raise", ({ socketId, username, raised }) => {
    setHandRaised(socketId, username, raised);
    addChatMessage(
      "System",
      `${username} has ${raised ? "raised" : "lowered"} their hand ✋`
    );
  });

  // SCREEN SHARE LAYOUT
  socket.on("screen-share-start", ({ socketId }) => {
    applyScreenShareLayout(true, socketId);
  });

  socket.on("screen-share-stop", ({ socketId }) => {
    applyScreenShareLayout(false, socketId);
  });

  // HOST: FORCE MUTE
  socket.on("force-mute", () => {
    const track = localStream?.getAudioTracks?.()[0];
    const btnMic = document.getElementById("btnToggleMic");
    if (track) track.enabled = false;
    if (btnMic) btnMic.textContent = "🔇 Unmute";
  });

  // HOST: KICKED
  socket.on("kicked", () => {
    alert("You were removed by the host.");
    cleanupAndLeave();
  });
}

// ===============================
//   CREATE PEER CONNECTION
// ===============================
function createPeerConnection(remoteId, initiator) {
  if (peers[remoteId].pc instanceof RTCPeerConnection) return;

  const pc = new RTCPeerConnection(iceServers);
  peers[remoteId].pc = pc;

  // add local tracks
  localStream.getTracks().forEach((track) => {
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
    let wrapper = remoteVideoElements[remoteId];
    if (!wrapper) {
      wrapper = document.createElement("div");
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

      const grid = document.getElementById("remoteVideos");
      remoteVideoElements[remoteId] = wrapper;

      // if someone is already sharing screen and this is their tile, put in main
      if (currentScreenSharerId === remoteId) {
        const main = document.getElementById("mainVideo");
        main.appendChild(wrapper);
      } else {
        grid.appendChild(wrapper);
      }
    } else {
      const video = wrapper.querySelector("video");
      if (video) video.srcObject = event.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      removePeer(remoteId);
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

  const tile = remoteVideoElements[socketId];
  if (tile) tile.remove();
  delete remoteVideoElements[socketId];

  // if screen sharer left, reset layout
  if (currentScreenSharerId === socketId) {
    applyScreenShareLayout(false, socketId);
  }
}

// ===============================
//   PARTICIPANTS LIST
// ===============================
function updateParticipants(users) {
  const list = document.getElementById("participantsList");
  list.innerHTML = "";

  Object.entries(users).forEach(([id, name]) => {
    if (!peers[id]) peers[id] = {};
    peers[id].username = name;

    const li = document.createElement("li");

    let text = name;
    if (id === socket.id) text += " (You)";
    if (id === currentHostId) text += " [Host]";

    const labelSpan = document.createElement("span");
    labelSpan.textContent = text;
    li.appendChild(labelSpan);

    // host can remove others
    if (isHost && id !== socket.id) {
      const btnKick = document.createElement("button");
      btnKick.textContent = "Remove";
      btnKick.className = "kick-btn";
      btnKick.addEventListener("click", () => {
        socket.emit("host-kick-user", { roomId, targetId: id });
      });
      li.appendChild(btnKick);
    }

    list.appendChild(li);
  });

  // fix local tile mapping now that we know our socket.id
  if (remoteVideoElements["local"]) {
    remoteVideoElements[socket.id] = remoteVideoElements["local"];
    delete remoteVideoElements["local"];
  }
}

// ===============================
//   HAND RAISE BADGE
// ===============================
function setHandRaised(socketId, username, raised) {
  const tile =
    remoteVideoElements[socketId] ||
    (socketId === socket.id
      ? document.querySelector(".local-tile")
      : null);
  if (!tile) return;

  let badge = tile.querySelector(".hand-badge");

  if (raised) {
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "hand-badge";
      badge.textContent = "✋";
      tile.appendChild(badge);
    }
    tile.classList.add("hand-raised");
  } else {
    if (badge) badge.remove();
    tile.classList.remove("hand-raised");
  }
}

// ===============================
//   SCREEN SHARE LAYOUT
// ===============================
function applyScreenShareLayout(active, sharerId) {
  const layout = document.querySelector(".video-layout");
  const mainSlot = document.getElementById("mainVideo");
  const grid = document.getElementById("remoteVideos");
  if (!layout || !mainSlot || !grid) return;

  currentScreenSharerId = active ? sharerId : null;

  const tile =
    remoteVideoElements[sharerId] ||
    (sharerId === socket.id
      ? document.querySelector(".local-tile")
      : null);

  if (active && tile) {
    layout.classList.add("has-screen");
    mainSlot.innerHTML = "";
    mainSlot.appendChild(tile);
  } else if (!active && tile) {
    layout.classList.remove("has-screen");
    mainSlot.innerHTML = "";
    grid.appendChild(tile);
  } else if (!active) {
    layout.classList.remove("has-screen");
    mainSlot.innerHTML = "";
  }
}

// ===============================
//   CHAT SETUP
// ===============================
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
//   HOST UI TOGGLE
// ===============================
function updateHostUI() {
  if (isHost) {
    document.body.classList.add("is-host");
  } else {
    document.body.classList.remove("is-host");
  }
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
  const btnMuteAll = document.getElementById("btnMuteAll");

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

  // SCREEN SHARE (start + auto stop)
  btnScreen.addEventListener("click", async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      // replace outgoing video tracks
      for (const id in peers) {
        const pc = peers[id].pc;
        if (!pc) continue;
        const sender = pc
          .getSenders()
          .find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      }

      // notify layout
      socket.emit("screen-share-start", { roomId });
      applyScreenShareLayout(true, socket.id);

      screenTrack.onended = () => {
        const camTrack = localStream.getVideoTracks()[0];
        for (const id in peers) {
          const pc = peers[id].pc;
          if (!pc) continue;
          const sender = pc
            .getSenders()
            .find((s) => s.track && s.track.kind === "video");
          if (sender && camTrack) sender.replaceTrack(camTrack);
        }
        socket.emit("screen-share-stop", { roomId });
        applyScreenShareLayout(false, socket.id);
      };
    } catch (err) {
      console.error("Screen share error:", err);
    }
  });

  // HAND RAISE
  btnRaise.addEventListener("click", () => {
    const raised = !btnRaise.classList.contains("raised");
    btnRaise.classList.toggle("raised", raised);
    btnRaise.textContent = raised ? "🙌 Hand Raised" : "✋ Raise Hand";

    // update our own tile
    setHandRaised(socket.id, username, raised);

    socket.emit("hand-raise", {
      roomId,
      username,
      raised
    });
  });

  // HOST: MUTE ALL
  if (btnMuteAll) {
    btnMuteAll.addEventListener("click", () => {
      if (!isHost) return;
      socket.emit("host-mute-all", { roomId });
    });
  }

  // LEAVE
  btnLeave.addEventListener("click", () => {
    cleanupAndLeave();
  });
}

// ===============================
//   CLEANUP & LEAVE
// ===============================
function cleanupAndLeave() {
  socket.emit("leave-room");

  Object.values(peers).forEach((p) => {
    if (p.pc) p.pc.close();
  });

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  window.location.href = "index.html";
}
