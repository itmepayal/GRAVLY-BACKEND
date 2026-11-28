import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { corsOptions } from "../config/cors.config.js";
import { serverConfig } from "../config/index.js";
import logger from "../config/logger.config.js";
import {
  createRedisDuplicate,
  getRedisClient,
  isTcpRedisConfigured,
} from "../config/redis.config.js";
import {
  SOCKET_ADAPTER_PREFIX,
  isRedisAvailable,
  redisEval,
  redisKeys,
} from "../infrastructure/redis/index.js";
import type {
  AppSocket,
  AppSocketServer,
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "./socket.types.js";
import { socketAuthMiddleware } from "./middleware/socketAuth.middleware.js";
import { joinDefaultIdentityRooms } from "./services/socketRoom.service.js";
import {
  clearAllTokenExpiryTimers,
  clearTokenExpiryTimer,
  scheduleTokenExpiryTimer,
  startRevocationSubscription,
  stopRevocationSubscription,
} from "./services/socketRevocation.service.js";
import {
  getSocketServers,
  registerSocketServer,
  unregisterSocketServer,
} from "./services/socketEmitter.service.js";
import { registerAuthHandlers } from "./handlers/auth.handler.js";
import { registerOrderHandlers } from "./handlers/order.handler.js";
import { registerCafeHandlers } from "./handlers/cafe.handler.js";
import {
  stopPresenceRefresh,
  trackPresenceConnect,
  trackPresenceDisconnect,
} from "./services/socketPresence.service.js";
import { SOCKET_EVENTS } from "./socket.events.js";

export interface SocketServerInitOptions {
  enableRedisAdapter?: boolean;
}

export interface SocketHealthStatus {
  initialized: boolean;
  workerId: string;
  serverCount: number;
  connectedSockets: number;
  redisAdapterAttached: boolean;
  adapterPubReady: boolean;
  adapterSubReady: boolean;
  transports: ("websocket" | "polling")[];
}

interface AdapterClients {
  pubClient: Redis;
  subClient: Redis;
}

const adapterClientsMap = new Map<AppSocketServer, AdapterClients>();
const httpServerToSocketMap = new WeakMap<HttpServer, AppSocketServer>();
const socketToHttpServerMap = new WeakMap<AppSocketServer, HttpServer>();
const activeUserSocketsMap = new WeakMap<
  AppSocketServer,
  Map<string, Set<string>>
>();

const getMaxConnectionsPerUser = (): number => {
  const raw = process.env.SOCKET_MAX_CONNECTIONS_PER_USER?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed >= 1 && parsed <= 500) {
      return parsed;
    }
  }
  return serverConfig.SOCKET_MAX_CONNECTIONS_PER_USER;
};

const ACQUIRE_SOCKET_SLOT_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local limit = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local expiresAtMs = tonumber(ARGV[4])
local ttlSec = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
local current = tonumber(redis.call('ZCARD', key) or 0)
if current >= limit then
  return { 0, current }
end
redis.call('ZADD', key, expiresAtMs, member)
redis.call('PEXPIRE', key, ttlSec * 1000)
return { 1, current + 1 }
`;

const RELEASE_SOCKET_SLOT_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local nowMs = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
redis.call('ZREM', key, member)
local remaining = tonumber(redis.call('ZCARD', key) or 0)
if remaining == 0 then
  redis.call('DEL', key)
end
return remaining
`;

const SOCKET_SLOT_TTL_SEC = 3600;

const trackUserSocketConnect = async (
  io: AppSocketServer,
  userId: string,
  socketId: string,
): Promise<{ allowed: boolean; currentCount: number; limit: number }> => {
  const limit = getMaxConnectionsPerUser();

  let userMap = activeUserSocketsMap.get(io);
  if (!userMap) {
    userMap = new Map<string, Set<string>>();
    activeUserSocketsMap.set(io, userMap);
  }
  let sockets = userMap.get(userId);
  if (!sockets) {
    sockets = new Set<string>();
    userMap.set(userId, sockets);
  }

  if (isRedisAvailable()) {
    try {
      const nowMs = Date.now();
      const expiresAtMs = nowMs + SOCKET_SLOT_TTL_SEC * 1000;
      const res = await redisEval<[number, number]>(
        ACQUIRE_SOCKET_SLOT_LUA,
        [redisKeys.socketUserConns(userId)],
        [socketId, limit, nowMs, expiresAtMs, SOCKET_SLOT_TTL_SEC],
      );
      const allowed = Number(res[0]) === 1;
      const currentCount = Number(res[1]);
      if (allowed) {
        sockets.add(socketId);
      }
      return { allowed, currentCount, limit };
    } catch {
      // Fallback to process-local cap
    }
  }

  if (sockets.size >= limit) {
    return { allowed: false, currentCount: sockets.size, limit };
  }
  sockets.add(socketId);
  return { allowed: true, currentCount: sockets.size, limit };
};

const untrackUserSocket = (
  io: AppSocketServer,
  userId: string,
  socketId: string,
): void => {
  const userMap = activeUserSocketsMap.get(io);
  if (userMap) {
    const sockets = userMap.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        userMap.delete(userId);
      }
    }
  }

  if (isRedisAvailable()) {
    void redisEval<number>(
      RELEASE_SOCKET_SLOT_LUA,
      [redisKeys.socketUserConns(userId)],
      [socketId, Date.now()],
    ).catch(() => {});
  }
};

const attachRedisAdapterIfReady = async (
  io: AppSocketServer,
): Promise<void> => {
  if (!isTcpRedisConfigured()) {
    logger.warn(
      "[socket] Native Redis TCP (REDIS_URL) is not configured; Socket.IO running with local in-memory adapter (single-instance only)",
    );
    return;
  }

  const baseRedis = getRedisClient();
  if (!baseRedis || baseRedis.status !== "ready") {
    logger.warn(
      "[socket] Redis TCP client unavailable; running Socket.IO with in-memory adapter",
    );
    return;
  }

  let pubClient: Redis | null = null;
  let subClient: Redis | null = null;

  try {
    pubClient = createRedisDuplicate();
    subClient = createRedisDuplicate({
      enableOfflineQueue: true,
      commandTimeout: undefined,
    });

    if (!pubClient || !subClient) {
      throw new Error("Could not create Redis duplicate clients for adapter");
    }

    pubClient.on("error", (err) => {
      logger.warn("[socket] Redis adapter pubClient error", {
        error: err.message,
      });
    });

    subClient.on("error", (err) => {
      logger.warn("[socket] Redis adapter subClient error", {
        error: err.message,
      });
    });

    pubClient.on("reconnecting", () => {
      logger.warn("[socket] Redis adapter pubClient reconnecting");
    });

    subClient.on("reconnecting", () => {
      logger.warn("[socket] Redis adapter subClient reconnecting");
    });

    subClient.on("ready", () => {
      logger.info("[socket] Redis adapter subClient ready");
    });

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(
      createAdapter(pubClient, subClient, {
        key: SOCKET_ADAPTER_PREFIX,
      }),
    );

    io.of("/").adapter.on("error", (err: unknown) => {
      logger.warn("[socket] Socket.IO Redis adapter runtime error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    adapterClientsMap.set(io, { pubClient, subClient });

    logger.info("[socket] @socket.io/redis-adapter attached cleanly", {
      prefix: SOCKET_ADAPTER_PREFIX,
    });
  } catch (err) {
    logger.warn(
      "[socket] Failed attaching Redis adapter; falling back to local adapter",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );

    if (pubClient) {
      try {
        pubClient.disconnect();
      } catch {
        // Ignore cleanup failure
      }
    }
    if (subClient) {
      try {
        subClient.disconnect();
      } catch {
        // Ignore cleanup failure
      }
    }
  }
};

export const initSocketServer = async (
  httpServer: HttpServer,
  options: SocketServerInitOptions = {},
): Promise<AppSocketServer> => {
  const existing = httpServerToSocketMap.get(httpServer);
  if (existing && getSocketServers().includes(existing)) {
    logger.warn("[socket] Socket.IO server already attached to HTTP server");
    return existing;
  }

  const io: AppSocketServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: corsOptions,
    transports: serverConfig.SOCKET_TRANSPORTS,
    allowEIO3: false,
    pingInterval: serverConfig.SOCKET_PING_INTERVAL_MS,
    pingTimeout: serverConfig.SOCKET_PING_TIMEOUT_MS,
    maxHttpBufferSize: 32 * 1024,
    perMessageDeflate: false,
    httpCompression: false,
    connectTimeout: 20_000,
    serveClient: false,
  });

  httpServerToSocketMap.set(httpServer, io);
  socketToHttpServerMap.set(io, httpServer);

  if (options.enableRedisAdapter !== false) {
    await attachRedisAdapterIfReady(io);
  }

  io.use(socketAuthMiddleware);

  io.on("connection", async (socket: AppSocket) => {
    const connCheck = await trackUserSocketConnect(io, socket.data.userId, socket.id);
    if (!socket.connected) {
      if (connCheck.allowed) {
        untrackUserSocket(io, socket.data.userId, socket.id);
      }
      return;
    }
    if (!connCheck.allowed) {
      logger.warn("[socket] Per-user concurrent connection limit exceeded", {
        socketId: socket.id,
        userId: socket.data.userId,
        activeConnections: connCheck.currentCount,
        limit: connCheck.limit,
      });
      socket.emit(SOCKET_EVENTS.AUTH_ERROR, {
        code: "CONNECTION_LIMIT_EXCEEDED",
        message: "Maximum concurrent connections reached for this account",
      });
      socket.disconnect(true);
      return;
    }

    try {
      await joinDefaultIdentityRooms(socket);
      trackPresenceConnect(socket.data.userId, socket.id);
      scheduleTokenExpiryTimer(socket);

      registerAuthHandlers(socket);
      registerOrderHandlers(socket);
      registerCafeHandlers(socket);

      logger.debug("[socket] Client connected", {
        socketId: socket.id,
        connectionId: socket.data.connectionId,
        userId: socket.data.userId,
        role: socket.data.role,
        sessionId: socket.data.sid,
        studentId: socket.data.studentId,
        cafeId: socket.data.cafeId,
        ip: socket.data.ip,
      });

      socket.on("disconnect", (reason) => {
        untrackUserSocket(io, socket.data.userId, socket.id);
        trackPresenceDisconnect(socket.data.userId, socket.id);
        clearTokenExpiryTimer(socket.id);
        logger.debug("[socket] Client disconnected", {
          socketId: socket.id,
          connectionId: socket.data.connectionId,
          userId: socket.data.userId,
          sessionId: socket.data.sid,
          reason,
        });
      });

      socket.on("error", (err) => {
        logger.warn("[socket] Socket error", {
          socketId: socket.id,
          userId: socket.data.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      untrackUserSocket(io, socket.data.userId, socket.id);
      trackPresenceDisconnect(socket.data.userId, socket.id);
      logger.error("[socket] Failed during connection setup", {
        socketId: socket.id,
        userId: socket.data.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      clearTokenExpiryTimer(socket.id);
      socket.disconnect(true);
    }
  });

  registerSocketServer(io);
  await startRevocationSubscription();

  return io;
};

export const getSocketHealthStatus = (): SocketHealthStatus => {
  const servers = getSocketServers();
  let connectedSockets = 0;
  let redisAdapterAttached = false;
  let adapterPubReady = false;
  let adapterSubReady = false;

  for (const io of servers) {
    connectedSockets += io.sockets.sockets.size;
    const clients = adapterClientsMap.get(io);
    if (clients) {
      redisAdapterAttached = true;
      adapterPubReady = clients.pubClient.status === "ready";
      adapterSubReady = clients.subClient.status === "ready";
    }
  }

  return {
    initialized: servers.length > 0,
    workerId:
      process.env.NODE_APP_INSTANCE?.trim() ||
      process.env.pm_id?.trim() ||
      "primary",
    serverCount: servers.length,
    connectedSockets,
    redisAdapterAttached,
    adapterPubReady,
    adapterSubReady,
    transports: [...serverConfig.SOCKET_TRANSPORTS],
  };
};

export const closeSocketServerInstance = async (
  io: AppSocketServer,
): Promise<void> => {
  unregisterSocketServer(io);

  const attachedHttp = socketToHttpServerMap.get(io);
  if (attachedHttp) {
    attachedHttp.closeIdleConnections?.();
    httpServerToSocketMap.delete(attachedHttp);
    socketToHttpServerMap.delete(io);
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      io.close(() => resolve());
    }),
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        attachedHttp?.closeAllConnections?.();
        resolve();
      }, 2000);
      if (t.unref) t.unref();
    }),
  ]);
  io.removeAllListeners();

  const adapterClients = adapterClientsMap.get(io);
  if (adapterClients) {
    adapterClientsMap.delete(io);
    const quitAdapter = (client: Redis) =>
      Promise.race([
        client.quit().catch(() => client.disconnect()),
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            client.disconnect();
            resolve();
          }, 1000);
          if (t.unref) t.unref();
        }),
      ]);
    await Promise.allSettled([
      quitAdapter(adapterClients.pubClient),
      quitAdapter(adapterClients.subClient),
    ]);
  }
};

export const closeSocketServer = async (): Promise<void> => {
  stopPresenceRefresh();
  clearAllTokenExpiryTimers();
  await stopRevocationSubscription();

  const servers = getSocketServers();
  for (const io of servers) {
    await closeSocketServerInstance(io);
  }

  logger.info("[socket] Socket.IO servers shut down cleanly");
};
