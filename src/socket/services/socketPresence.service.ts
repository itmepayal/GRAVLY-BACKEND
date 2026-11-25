import {
  REDIS_TTLS,
  isRedisAvailable,
  redisDel,
  redisKeys,
  redisSet,
} from "../../infrastructure/redis/index.js";

const localActiveUsers = new Map<string, number>();

export const trackPresenceConnect = (userId: string): void => {
  const prev = localActiveUsers.get(userId) ?? 0;
  localActiveUsers.set(userId, prev + 1);

  if (prev === 0 && isRedisAvailable()) {
    void redisSet(redisKeys.presenceUser(userId), "online", {
      ex: REDIS_TTLS.PRESENCE_LEASE_SEC,
    }).catch(() => {});
  }
};

export const trackPresenceDisconnect = (userId: string): void => {
  const prev = localActiveUsers.get(userId) ?? 0;
  if (prev <= 1) {
    localActiveUsers.delete(userId);
    if (isRedisAvailable()) {
      void redisDel(redisKeys.presenceUser(userId)).catch(() => {});
    }
  } else {
    localActiveUsers.set(userId, prev - 1);
  }
};

export const refreshPresenceLease = (userId: string): void => {
  if (isRedisAvailable()) {
    void redisSet(redisKeys.presenceUser(userId), "online", {
      ex: REDIS_TTLS.PRESENCE_LEASE_SEC,
    }).catch(() => {});
  }
};

export const getLocalOnlineUserCount = (): number => localActiveUsers.size;
