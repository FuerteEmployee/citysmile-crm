const { Server } = require("socket.io");

const User = require("../models/user_model");
const fcmService = require("./fcm_service");

const initSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: true, methods: ["GET", "POST"], credentials: true },
    allowEIO3: true,
    transports: ["websocket", "polling"],
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.on("connection", (socket) => {
    socket.on("join-room", (room) => {
      if (typeof room !== "string" || room.length > 100) return;
      socket.join(room);
    });

    socket.on("location_update", (data) => {
      if (!data || typeof data.lat !== "number" || typeof data.lng !== "number") return;
      if (data.storeId) socket.to(`store-${data.storeId}`).emit("location_update", data);
      socket.to("global-tracking").emit("location_update", data);
    });

    socket.on("force_location_update_request", async (data) => {
      if (data && data.employeeId) {
        const roomName = `user-${data.employeeId}`;
        const room = io.sockets.adapter.rooms.get(roomName);

        if (room && room.size > 0) {
          socket.to(roomName).emit("force_location_update");
          socket.emit("ping_status", { status: "sent_via_socket", employeeId: data.employeeId });
        } else {
          try {
            const user = await User.findById(data.employeeId);
            if (user && user.fcmToken) {
              await fcmService.sendDataMessage({
                token: user.fcmToken,
                data: { employeeId: data.employeeId.toString() },
              });
              socket.emit("ping_status", { status: "sent_via_fcm", employeeId: data.employeeId });
            } else {
              console.warn(`[Socket] Cannot send FCM fallback: No fcmToken found for user ${data.employeeId}`);
              socket.emit("ping_status", { status: "no_token", employeeId: data.employeeId });
            }
          } catch (err) {
            console.error("[Socket] Error during FCM fallback lookup:", err.message);
            socket.emit("ping_status", { status: "error", employeeId: data.employeeId, message: err.message });
          }
        }
      }
    });

    socket.on("error", (err) => console.error(`[Socket] Error on ${socket.id}:`, err.message));
    socket.on("disconnect", () => {});
  });

  return io;
};

module.exports = initSocket;
