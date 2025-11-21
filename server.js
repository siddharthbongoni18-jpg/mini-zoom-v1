// ==========================
//      MINI ZOOM SERVER
// ==========================

import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  }
});

// Serve static files (public folder)
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==========================
//   IN-MEMORY ROOM STORAGE
// ==========================
//
// rooms = {
//   "1234": { socketId: "Name", ... }
// }
//
// roomHosts = { "1234": "socketId-of-host" }
// userRoom = { socketId: roomId }
//
let rooms = {};
let roomHosts = {};
let userRoom = {};

// ==========================
//     SOCKET.IO HANDLERS
// ==========================

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --------------------------
  // USER JOINS A ROOM
  // --------------------------
  socket.on("join-room", ({ roomId, name }) => {
    socket.join(roomId);
    userRoom[socket.id] = roomId;

    // Create room if not exist
    if (!rooms[roomId]) {
      rooms[roomId] = {};
      // first user becomes host
      roomHosts[roomId] = socket.id;
    }

    // Save user
    rooms[roomId][socket.id] = name || "Guest";

    console.log(`User ${socket.id} (${rooms[roomId][socket.id]}) joined room ${roomId}`);

    // Send existing users (id -> name) to the NEW user
    const existingUsers = {};
    for (const id in rooms[roomId]) {
      if (id !== socket.id) {
        existingUsers[id] = rooms[roomId][id];
      }
    }
    socket.emit("existing-users", existingUsers);

    // Notify others in the room that a new user joined
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      name: rooms[roomId][socket.id]
    });

    // Update participants list
    io.to(roomId).emit("room-users", rooms[roomId]);

    // Tell everyone who the host is
    io.to(roomId).emit("room-host", {
      hostId: roomHosts[roomId]
    });
  });

  // --------------------------
  // OFFER SENT TO A USER
  // --------------------------
  socket.on("offer", ({ offer, targetId }) => {
    io.to(targetId).emit("offer", {
      offer,
      senderId: socket.id
    });
  });

  // --------------------------
  // ANSWER SENT BACK
  // --------------------------
  socket.on("answer", ({ answer, targetId }) => {
    io.to(targetId).emit("answer", {
      answer,
      senderId: socket.id
    });
  });

  // --------------------------
  // ICE CANDIDATES
  // --------------------------
  socket.on("ice-candidate", ({ candidate, targetId }) => {
    io.to(targetId).emit("ice-candidate", {
      candidate,
      senderId: socket.id
    });
  });

  // --------------------------
  // CHAT MESSAGE
  // --------------------------
  socket.on("chat-message", ({ roomId, message, name }) => {
    io.to(roomId).emit("chat-message", {
      message,
      name,
      time: Date.now()
    });
  });

  // --------------------------
  // HAND RAISE
  // --------------------------
  socket.on("hand-raise", ({ roomId, username, raised }) => {
    io.to(roomId).emit("hand-raise", {
      socketId: socket.id,
      username,
      raised
    });
  });

  // --------------------------
  // SCREEN SHARE EVENTS
  // --------------------------
  socket.on("screen-share-start", ({ roomId }) => {
    io.to(roomId).emit("screen-share-start", {
      socketId: socket.id
    });
  });

  socket.on("screen-share-stop", ({ roomId }) => {
    io.to(roomId).emit("screen-share-stop", {
      socketId: socket.id
    });
  });

  // --------------------------
  // HOST: MUTE ALL
  // --------------------------
  socket.on("host-mute-all", ({ roomId }) => {
    if (roomHosts[roomId] !== socket.id) return;
    socket.to(roomId).emit("force-mute");
  });

  // --------------------------
  // HOST: KICK USER
  // --------------------------
  socket.on("host-kick-user", ({ roomId, targetId }) => {
    if (roomHosts[roomId] !== socket.id) return;
    if (!rooms[roomId] || !rooms[roomId][targetId]) return;

    // Notify kicked user
    io.to(targetId).emit("kicked");

    // Remove from room data
    delete rooms[roomId][targetId];
    delete userRoom[targetId];

    // Inform others
    io.to(roomId).emit("user-left", targetId);
    io.to(roomId).emit("room-users", rooms[roomId]);
  });

  // --------------------------
  // USER LEAVES VIA BUTTON
  // --------------------------
  socket.on("leave-room", () => {
    handleUserLeaving(socket);
  });

  // --------------------------
  // USER DISCONNECTS
  // --------------------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    handleUserLeaving(socket, true);
  });
});

// Helper: clean up when user leaves/disconnects
function handleUserLeaving(socket, isDisconnect = false) {
  const roomId = userRoom[socket.id];

  if (!roomId || !rooms[roomId]) return;

  // remove user from room
  const name = rooms[roomId][socket.id];
  delete rooms[roomId][socket.id];
  delete userRoom[socket.id];

  // Notify others
  socket.to(roomId).emit("user-left", socket.id);

  // Update participants list
  io.to(roomId).emit("room-users", rooms[roomId]);

  // If host left → choose a new one
  if (roomHosts[roomId] === socket.id) {
    const remainingIds = Object.keys(rooms[roomId]);
    roomHosts[roomId] = remainingIds[0] || null;
  }

  // Notify new host
  io.to(roomId).emit("room-host", {
    hostId: roomHosts[roomId]
  });

  // Remove empty room
  if (Object.keys(rooms[roomId]).length === 0) {
    delete rooms[roomId];
    delete roomHosts[roomId];
  }

  if (!isDisconnect) {
    socket.leave(roomId);
  }
}

// ==========================
//        START SERVER
// ==========================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
