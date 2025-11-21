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
  },
});

// Serve static files (public folder)
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==========================
//   IN-MEMORY USER STORAGE
// ==========================
let rooms = {};
/*
rooms = {
  "1234": {
    "SocketID1": "Alice",
    "SocketID2": "Siddu"
  }
}
*/

// Helper to remove user from rooms
function removeUserFromRooms(socket) {
  for (const roomId in rooms) {
    if (rooms[roomId][socket.id]) {
      const name = rooms[roomId][socket.id];
      console.log(`User ${socket.id} (${name}) left room ${roomId}`);

      delete rooms[roomId][socket.id];

      // Notify others
      socket.to(roomId).emit("user-left", socket.id);

      // Update participants list
      io.to(roomId).emit("room-users", rooms[roomId]);

      // Remove room if empty
      if (Object.keys(rooms[roomId]).length === 0) {
        delete rooms[roomId];
      }
      break;
    }
  }
}

// ==========================
//     SOCKET.IO HANDLERS
// ==========================
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --------------------------
  // USER JOINS A ROOM
  // --------------------------
  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId) return;

    socket.join(roomId);

    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = name || "Guest";

    console.log(`User ${socket.id} (${rooms[roomId][socket.id]}) joined room ${roomId}`);

    // Send all users in this room to the newly joined client
    // (including themselves so they know their own socket id)
    socket.emit("existing-users", {
      users: rooms[roomId], // { socketId: name }
      selfId: socket.id,
    });

    // Notify others in the room that a new user joined
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      name: rooms[roomId][socket.id],
    });

    // Update participants list for everyone
    io.to(roomId).emit("room-users", rooms[roomId]);
  });

  // --------------------------
  // OFFER / ANSWER / ICE
  // --------------------------
  socket.on("offer", ({ offer, targetId }) => {
    io.to(targetId).emit("offer", {
      offer,
      senderId: socket.id,
    });
  });

  socket.on("answer", ({ answer, targetId }) => {
    io.to(targetId).emit("answer", {
      answer,
      senderId: socket.id,
    });
  });

  socket.on("ice-candidate", ({ candidate, targetId }) => {
    io.to(targetId).emit("ice-candidate", {
      candidate,
      senderId: socket.id,
    });
  });

  // --------------------------
  // CHAT MESSAGE
  // --------------------------
  socket.on("chat-message", ({ roomId, message, name }) => {
    if (!roomId) return;
    io.to(roomId).emit("chat-message", {
      message,
      name,
      time: Date.now(),
    });
  });

  // --------------------------
  // HAND RAISE
  // --------------------------
  socket.on("hand-raise", ({ roomId, username, raised }) => {
    if (!roomId) return;
    io.to(roomId).emit("hand-raise", { username, raised });
  });

  // --------------------------
  // OPTIONAL LEAVE-ROOM
  // --------------------------
  socket.on("leave-room", () => {
    removeUserFromRooms(socket);
  });

  // --------------------------
  // USER DISCONNECTS
  // --------------------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    removeUserFromRooms(socket);
  });
});

// ==========================
//        START SERVER
// ==========================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
