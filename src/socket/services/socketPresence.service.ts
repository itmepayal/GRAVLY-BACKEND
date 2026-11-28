import logger from "../../config/logger.config.js";
import {
  REDIS_TTLS,
  isRedisAvailable,
  redisEval,
  redisKeys,
} from "../../infrastructure/redis/index.js";

const localActiveUsers = new Map<string, Set<string>>();

const PRESENCE_REFRESH_INTERVAL_MS = 60_000;
let refreshTimer: NodeJS.Timeout | null = null;

// Atomically prunes expired socket leases across all workers, upserts the
// current socket lease, refreshes the ZSET expiry, and marks presence online.
const PRESENCE_CONNECT_LUA = `
local zkey = KEYS[1]
local ukey = KEYS[2]
local nowMs = tonumber(ARGV[1])
local expiresAtMs = tonumber(ARGV[2])
local ttlSec = tonumber(ARGV[3])
local socketId = ARGV[4]

redis.call('ZREMRANGEBYSCORE', zkey, '-inf', nowMs)
redis.call('ZADD', zkey, expiresAtMs, socketId)
redis.call('PEXPIRE', zkey, ttlSec * 1000)
redis.call('SET', ukey, 'online', 'EX', ttlSec)
return redis.call('ZCARD', zkey)
`;

// Atomically removes the disconnecting socket and expired leases across workers;
// only deletes the global online presence key when zero active sockets remain.
const PRESENCE_DISCONNECT_LUA = `
local zkey = KEYS[1]
local ukey = KEYS[2]
local nowMs = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local socketId = ARGV[3]

redis.call('ZREMRANGEBYSCORE', zkey, '-inf', nowMs)
redis.call('ZREM', zkey, socketId)
local remaining = tonumber(redis.call('ZCARD', zkey) or 0)
if remaining <= 0 then
  redis.call('DEL', zkey)
  redis.call('DEL', ukey)
  return 0
end
redis.call('PEXPIRE', zkey, ttlSec * 1000)
redis.call('SET', ukey, 'online', 'EX', ttlSec)
return remaining
`;

const syncSocketPresence = async (
  userId: string,
  socketId: string,
): Promise<void> => {
  if (!isRedisAvailable()) {
    return;
  }

  const nowMs = Date.now();
  const ttlSec = REDIS_TTLS.PRESENCE_LEASE_SEC;
  const expiresAtMs = nowMs + ttlSec * 1000;

  await redisEval(
    PRESENCE_CONNECT_LUA,
    [redisKeys.presenceSockets(userId), redisKeys.presenceUser(userId)],
    [nowMs, expiresAtMs, ttlSec, socketId],
  ).catch((err) => {
    logger.warn("[socket] Failed syncing Redis presence lease", {
      userId,
      socketId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
};

const ensureRefreshTimerStarted = (): void => {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setInterval(() => {
    if (!isRedisAvailable() || localActiveUsers.size === 0) {
      return;
    }

    for (const [userId, sockets] of localActiveUsers.entries()) {
      for (const socketId of sockets) {
        void syncSocketPresence(userId, socketId);
      }
    }
  }, PRESENCE_REFRESH_INTERVAL_MS);

  if (refreshTimer.unref) {
    refreshTimer.unref();
  }
};

export const trackPresenceConnect = (
  userId: string,
  socketId = "default",
): void => {
  let sockets = localActiveUsers.get(userId);
  if (!sockets) {
    sockets = new Set<string>();
    localActiveUsers.set(userId, sockets);
  }
  sockets.add(socketId);

  ensureRefreshTimerStarted();
  void syncSocketPresence(userId, socketId);
};

export const trackPresenceDisconnect = (
  userId: string,
  socketId = "default",
): void => {
  const sockets = localActiveUsers.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      localActiveUsers.delete(userId);
    }
  }

  if (isRedisAvailable()) {
    const nowMs = Date.now();
    const ttlSec = REDIS_TTLS.PRESENCE_LEASE_SEC;

    void redisEval(
      PRESENCE_DISCONNECT_LUA,
      [redisKeys.presenceSockets(userId), redisKeys.presenceUser(userId)],
      [nowMs, ttlSec, socketId],
    ).catch((err) => {
      logger.warn("[socket] Failed releasing Redis presence lease", {
        userId,
        socketId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
};

export const refreshPresenceLease = (
  userId: string,
  socketId?: string,
): void => {
  if (!isRedisAvailable()) {
    return;
  }

  if (socketId) {
    void syncSocketPresence(userId, socketId);
    return;
  }

  const sockets = localActiveUsers.get(userId);
  if (sockets && sockets.size > 0) {
    for (const activeSocketId of sockets) {
      void syncSocketPresence(userId, activeSocketId);
    }
  }
};

export const stopPresenceRefresh = (): void => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  localActiveUsers.clear();
};

export const getLocalOnlineUserCount = (): number => localActiveUsers.size;
