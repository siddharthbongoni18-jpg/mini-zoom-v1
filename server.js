// ==========================
//      MEDZOOM AI SERVER
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

// SOCKET.IO (CORS relaxed for local dev)
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
//   IN-MEMORY ROOM STORAGE
// ==========================
let rooms = {};
let roomHosts = {};
let userRoom = {};

// Rate limiting
const messageLimits = new Map();

// ==========================
//     SOCKET.IO HANDLERS
// ==========================

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --------------------------
  // USER JOINS A ROOM
  // --------------------------
  socket.on("join-room", ({ roomId, name }) => {
    try {
      // VALIDATION (6-digit room)
      if (!roomId || !/^\d{6}$/.test(roomId)) {
        socket.emit("error", { message: "Invalid room ID. Must be 6 digits." });
        return;
      }

      const trimmedName = (name || "Guest").trim();
      if (!trimmedName || trimmedName.length === 0) {
        socket.emit("error", { message: "Name is required." });
        return;
      }

      // Check for duplicate names in room
      const existingNames = Object.values(rooms[roomId] || {});
      if (existingNames.includes(trimmedName)) {
        socket.emit("error", {
          message:
            "Name already taken in this room. Please choose a different name.",
        });
        return;
      }

      socket.join(roomId);
      userRoom[socket.id] = roomId;

      // Create room if not exist
      if (!rooms[roomId]) {
        rooms[roomId] = {};
        roomHosts[roomId] = socket.id;
      }

      // Save user
      rooms[roomId][socket.id] = trimmedName;

      console.log(`User ${socket.id} (${trimmedName}) joined room ${roomId}`);

      // Send existing users to the NEW user
      const existingUsers = {};
      for (const id in rooms[roomId]) {
        if (id !== socket.id) {
          existingUsers[id] = rooms[roomId][id];
        }
      }
      socket.emit("existing-users", existingUsers);

      // Notify others in the room
      socket.to(roomId).emit("user-joined", {
        socketId: socket.id,
        name: trimmedName,
      });

      // Update participants list
      io.to(roomId).emit("room-users", rooms[roomId]);

      // Tell everyone who the host is
      io.to(roomId).emit("room-host", {
        hostId: roomHosts[roomId],
      });
    } catch (error) {
      console.error("Error in join-room:", error);
      socket.emit("error", { message: "Failed to join room" });
    }
  });

  // --------------------------
  // OFFER SENT TO A USER
  // --------------------------
  socket.on("offer", ({ offer, targetId }) => {
    if (!targetId || !rooms[userRoom[socket.id]]?.[targetId]) {
      socket.emit("error", { message: "Invalid target user" });
      return;
    }
    io.to(targetId).emit("offer", {
      offer,
      senderId: socket.id,
    });
  });

  // --------------------------
  // ANSWER SENT BACK
  // --------------------------
  socket.on("answer", ({ answer, targetId }) => {
    if (!targetId || !rooms[userRoom[socket.id]]?.[targetId]) {
      socket.emit("error", { message: "Invalid target user" });
      return;
    }
    io.to(targetId).emit("answer", {
      answer,
      senderId: socket.id,
    });
  });

  // --------------------------
  // ICE CANDIDATES
  // --------------------------
  socket.on("ice-candidate", ({ candidate, targetId }) => {
    if (!targetId || !rooms[userRoom[socket.id]]?.[targetId]) {
      return;
    }
    io.to(targetId).emit("ice-candidate", {
      candidate,
      senderId: socket.id,
    });
  });

  // --------------------------
  // CHAT MESSAGE (WITH RATE LIMITING)
  // --------------------------
  socket.on("chat-message", ({ roomId, message, name }) => {
    try {
      const now = Date.now();
      const userKey = `${socket.id}-chat`;

      if (messageLimits.has(userKey)) {
        const lastMessageTime = messageLimits.get(userKey);
        if (now - lastMessageTime < 500) {
          socket.emit("error", {
            message: "Message rate limit exceeded. Please wait a moment.",
          });
          return;
        }
      }

      messageLimits.set(userKey, now);

      const trimmedMessage = (message || "").trim();
      if (!trimmedMessage) {
        socket.emit("error", { message: "Message cannot be empty" });
        return;
      }

      if (trimmedMessage.length > 1000) {
        socket.emit("error", { message: "Message too long" });
        return;
      }

      io.to(roomId).emit("chat-message", {
        message: trimmedMessage,
        name: name || "Unknown",
        time: now,
      });
    } catch (error) {
      console.error("Error in chat-message:", error);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  // --------------------------
  // HAND RAISE
  // --------------------------
  socket.on("hand-raise", ({ roomId, username, raised }) => {
    if (!rooms[roomId]?.[socket.id]) {
      return;
    }
    io.to(roomId).emit("hand-raise", {
      socketId: socket.id,
      username,
      raised,
    });
  });

  // --------------------------
  // SCREEN SHARE EVENTS
  // --------------------------
  socket.on("screen-share-start", ({ roomId }) => {
    if (!rooms[roomId]?.[socket.id]) {
      return;
    }
    io.to(roomId).emit("screen-share-start", {
      socketId: socket.id,
    });
  });

  socket.on("screen-share-stop", ({ roomId }) => {
    if (!rooms[roomId]?.[socket.id]) {
      return;
    }
    io.to(roomId).emit("screen-share-stop", {
      socketId: socket.id,
    });
  });

  // --------------------------
  // HOST: MUTE ALL
  // --------------------------
  socket.on("host-mute-all", ({ roomId }) => {
    if (roomHosts[roomId] !== socket.id) {
      socket.emit("error", { message: "Only host can mute all" });
      return;
    }
    socket.to(roomId).emit("force-mute");
  });

  // --------------------------
  // HOST: KICK USER
  // --------------------------
  socket.on("host-kick-user", ({ roomId, targetId }) => {
    if (roomHosts[roomId] !== socket.id) {
      socket.emit("error", { message: "Only host can kick users" });
      return;
    }
    if (!rooms[roomId] || !rooms[roomId][targetId]) {
      socket.emit("error", { message: "User not found" });
      return;
    }

    io.to(targetId).emit("kicked");

    delete rooms[roomId][targetId];
    delete userRoom[targetId];

    io.to(roomId).emit("user-left", targetId);
    io.to(roomId).emit("room-users", rooms[roomId]);
  });

  // --------------------------
  // ERROR HANDLING FROM CLIENT
  // --------------------------
  socket.on("error", (error) => {
    console.error("Client error from", socket.id, ":", error);
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
  socket.on("disconnect", (reason) => {
    console.log("Disconnected:", socket.id, "Reason:", reason);
    handleUserLeaving(socket, true);
  });
});

// Helper: clean up when user leaves/disconnects
function handleUserLeaving(socket, isDisconnect = false) {
  const roomId = userRoom[socket.id];

  if (!roomId || !rooms[roomId]) return;

  const name = rooms[roomId][socket.id];
  delete rooms[roomId][socket.id];
  delete userRoom[socket.id];

  messageLimits.delete(`${socket.id}-chat`);

  socket.to(roomId).emit("user-left", socket.id);
  io.to(roomId).emit("room-users", rooms[roomId]);

  if (roomHosts[roomId] === socket.id) {
    const remainingIds = Object.keys(rooms[roomId]);
    roomHosts[roomId] = remainingIds[0] || null;

    io.to(roomId).emit("room-host", {
      hostId: roomHosts[roomId],
    });
  }

  if (Object.keys(rooms[roomId]).length === 0) {
    delete rooms[roomId];
    delete roomHosts[roomId];
    console.log(`Room ${roomId} deleted (empty)`);
  }

  if (!isDisconnect) {
    socket.leave(roomId);
  }

  console.log(`User ${socket.id} (${name}) left room ${roomId}`);
}

// ==========================
//        START SERVER
// ==========================
const PORT = process.env.PORT || 3000;

// Global error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🏥 MedZoom AI Server running on http://localhost:${PORT}`);
  console.log(`📊 Rooms active: ${Object.keys(rooms).length}`);
});
