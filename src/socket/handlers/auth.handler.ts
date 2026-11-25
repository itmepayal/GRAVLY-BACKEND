import { SOCKET_EVENTS } from "../socket.events.js";
import type { AppSocket } from "../socket.types.js";
import { handleAuthRefresh } from "../services/socketRevocation.service.js";

const registeredAuthSockets = new WeakSet<AppSocket>();

export const registerAuthHandlers = (socket: AppSocket): void => {
  if (registeredAuthSockets.has(socket)) return;
  registeredAuthSockets.add(socket);

  socket.on(SOCKET_EVENTS.AUTH_REFRESH, (payload, callback) => {
    void handleAuthRefresh(socket, payload, callback);
  });
};
