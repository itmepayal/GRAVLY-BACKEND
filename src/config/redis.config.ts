/**
 * =========================================================
 * REDIS CONFIG FACADE (BACKWARD-COMPATIBLE RE-EXPORTS)
 * =========================================================
 * Delegates to the centralized `src/infrastructure/redis` subsystem
 * so existing callers continue using `src/config/redis.config.js`
 * without creating duplicate clients.
 */
export {
  initRedis,
  closeRedis,
  getRedisClient,
  getRedisSubscriber,
  createRedisDuplicate,
  subscribeToChannel,
  unsubscribeFromChannel,
  publishEvent,
  onRedisReconnect,
  isTcpRedisConfigured,
  isRedisHealthy,
  getRedisHealthDetails,
  initUpstashRest,
  getUpstashRestClient,
  closeUpstashRest,
  isUpstashRestConfigured,
  isUpstashRestHealthy,
} from "../infrastructure/redis/index.js";
export type {
  ChannelHandler,
  ReconnectHandler,
  RedisHealthReport,
} from "../infrastructure/redis/index.js";
