import crypto from "crypto";
import logger from "../../config/logger.config.js";
import {
  subscribeToChannel,
  unsubscribeFromChannel,
} from "../../config/redis.config.js";
import {
  AUTH_INVALIDATION_CHANNEL,
  verifyAuthenticatedCredential,
} from "../../middlewares/authenticate.middleware.js";
import { SOCKET_EVENTS } from "../socket.events.js";
import { ROOMS } from "../rooms/room.constants.js";
import type { AppSocket, AppSocketServer, SocketAck } from "../socket.types.js";
import {
  authRefreshSchema,
  validateSocketPayload,
} from "../validators/socket.validator.js";
import { allowSocketEvent } from "./socketRateLimit.service.js";
import { getSocketServers } from "./socketEmitter.service.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const expiryTimers = new Map<string, NodeJS.Timeout>();

interface InvalidationEventPayload {
  type?: "user_cache_clear" | "session_revoked" | "user_revoked";
  userId?: string;
  sessionId?: string;
  minTokenVersion?: number;
}

const sendAck = <T>(
  callback: ((ack: SocketAck<T>) => void) | undefined,
  ack: SocketAck<T>,
): void => {
  if (typeof callback === "function") {
    callback(ack);
  }
};

const emitRevokedAndDisconnect = (
  socket: AppSocket,
  reason: string,
  sessionId?: string,
): void => {
  clearTokenExpiryTimer(socket.id);
  try {
    socket.emit(SOCKET_EVENTS.AUTH_REVOKED, {
      eventId: crypto.randomUUID(),
      reason,
      sessionId,
      emittedAt: new Date().toISOString(),
    });
  } catch {
    // Best-effort notice before closing socket
  }
  socket.disconnect(true);
};

export const clearTokenExpiryTimer = (socketId: string): void => {
  const existing = expiryTimers.get(socketId);
  if (existing) {
    clearTimeout(existing);
    expiryTimers.delete(socketId);
  }
};

export const clearAllTokenExpiryTimers = (): void => {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
};

export const scheduleTokenExpiryTimer = (socket: AppSocket): void => {
  clearTokenExpiryTimer(socket.id);

  const exp = socket.data.exp;
  if (!exp || !Number.isFinite(exp)) return;

  const remainingMs = exp * 1000 - Date.now();
  if (remainingMs <= 0) {
    emitRevokedAndDisconnect(socket, "token_expired", socket.data.sid);
    return;
  }

  const waitMs = Math.min(remainingMs, MAX_TIMEOUT_MS);
  const timer = setTimeout(() => {
    expiryTimers.delete(socket.id);
    if (!socket.connected) return;

    const nowRemaining = (socket.data.exp ?? 0) * 1000 - Date.now();
    if (nowRemaining > 0) {
      scheduleTokenExpiryTimer(socket);
      return;
    }

    emitRevokedAndDisconnect(socket, "token_expired", socket.data.sid);
  }, waitMs);

  if (timer.unref) timer.unref();
  expiryTimers.set(socket.id, timer);
};

export const handleAuthRefresh = async (
  socket: AppSocket,
  payload: unknown,
  callback?: (ack: SocketAck<{ expiresAt?: string }>) => void,
): Promise<void> => {
  const requestId = socket.data.connectionId;

  try {
    const allowed = await allowSocketEvent(
      socket.data.userId,
      SOCKET_EVENTS.AUTH_REFRESH,
      10,
      60_000,
    );
    if (!allowed) {
      sendAck(callback, {
        ok: false,
        code: "RATE_LIMITED",
        message: "Too many auth refresh requests",
        requestId,
      });
      return;
    }

    const parsed = validateSocketPayload(authRefreshSchema, payload);
    if (!parsed.ok) {
      sendAck(callback, {
        ok: false,
        code: "VALIDATION_ERROR",
        message: parsed.message,
        requestId,
      });
      return;
    }

    const verified = await verifyAuthenticatedCredential(parsed.data.token, {
      requestId,
      ip: socket.data.ip,
      updateActivity: true,
    });

    if (!verified.ok) {
      const code =
        verified.statusCode === 503
          ? "AUTH_SERVICE_UNAVAILABLE"
          : "UNAUTHORIZED";
      sendAck(callback, {
        ok: false,
        code,
        message: verified.message,
        requestId,
      });
      if (verified.statusCode === 401) {
        socket.emit(SOCKET_EVENTS.AUTH_ERROR, {
          code,
          message: verified.message,
        });
        emitRevokedAndDisconnect(socket, "refresh_failed", socket.data.sid);
      }
      return;
    }

    if (
      String(verified.user._id) !== socket.data.userId ||
      (verified.auth.sid ?? undefined) !== (socket.data.sid ?? undefined)
    ) {
      sendAck(callback, {
        ok: false,
        code: "SESSION_MISMATCH",
        message: "Refreshed token does not match connected session identity",
        requestId,
      });
      emitRevokedAndDisconnect(socket, "session_mismatch", socket.data.sid);
      return;
    }

    socket.data.jti = verified.auth.jti;
    socket.data.tv = verified.auth.tv;
    socket.data.exp = verified.auth.exp;
    socket.data.role = verified.user.role;

    scheduleTokenExpiryTimer(socket);

    sendAck(callback, {
      ok: true,
      data: {
        expiresAt: verified.auth.exp
          ? new Date(verified.auth.exp * 1000).toISOString()
          : undefined,
      },
      requestId,
    });
  } catch (err) {
    logger.warn("[socket] auth:refresh failed unexpectedly", {
      socketId: socket.id,
      userId: socket.data.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    sendAck(callback, {
      ok: false,
      code: "INTERNAL_ERROR",
      message: "Failed to refresh socket credentials",
      requestId,
    });
  }
};

const getLocalSocketsInRoom = (
  io: AppSocketServer,
  room: string,
): AppSocket[] => {
  const roomSocketIds = io.of("/").adapter.rooms.get(room);
  if (!roomSocketIds || roomSocketIds.size === 0) return [];

  const matched: AppSocket[] = [];
  for (const socketId of roomSocketIds) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) matched.push(sock);
  }
  return matched;
};

const processRevocationMessage = (rawMessage: string): void => {
  let msg: InvalidationEventPayload;
  try {
    msg = JSON.parse(rawMessage) as InvalidationEventPayload;
  } catch {
    return;
  }

  const servers = getSocketServers();
  if (servers.length === 0) return;

  if (msg.type === "session_revoked" && msg.sessionId) {
    const room = ROOMS.session(msg.sessionId);
    for (const io of servers) {
      const sockets = getLocalSocketsInRoom(io, room);
      for (const sock of sockets) {
        logger.info("[socket] Disconnecting revoked session socket", {
          socketId: sock.id,
          userId: sock.data.userId,
          sessionId: msg.sessionId,
        });
        emitRevokedAndDisconnect(sock, "session_revoked", msg.sessionId);
      }
    }
    return;
  }

  if (msg.type === "user_revoked" && msg.userId) {
    const minTv = msg.minTokenVersion ?? Number.MAX_SAFE_INTEGER;
    const room = ROOMS.user(msg.userId);
    for (const io of servers) {
      const sockets = getLocalSocketsInRoom(io, room);
      for (const sock of sockets) {
        if (sock.data.tv < minTv) {
          logger.info("[socket] Disconnecting user-revoked socket", {
            socketId: sock.id,
            userId: msg.userId,
            socketTv: sock.data.tv,
            minTokenVersion: minTv,
          });
          emitRevokedAndDisconnect(sock, "user_revoked", sock.data.sid);
        }
      }
    }
  }
};

let isSubscribed = false;

const revocationChannelHandler = (_channel: string, message: string): void => {
  processRevocationMessage(message);
};

export const startRevocationSubscription = async (): Promise<void> => {
  if (isSubscribed) return;
  await subscribeToChannel(AUTH_INVALIDATION_CHANNEL, revocationChannelHandler);
  isSubscribed = true;
};

export const stopRevocationSubscription = async (): Promise<void> => {
  if (!isSubscribed) return;
  isSubscribed = false;
  await unsubscribeFromChannel(
    AUTH_INVALIDATION_CHANNEL,
    revocationChannelHandler,
  );
};
