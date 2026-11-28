import { Redis, RedisOptions } from "ioredis";
import { serverConfig } from "../../config/index.js";
import logger from "../../config/logger.config.js";
import { REDIS_DEFAULTS } from "./redis.constants.js";
import { recordRedisError, recordTcpCommand } from "./redis.metrics.js";
import {
  closeUpstashRest,
  initUpstashRest,
  isUpstashRestConfigured,
} from "./redis.rest.js";

let redisClient: Redis | null = null;
let redisSubscriber: Redis | null = null;
let subscriberConnectPromise: Promise<Redis | null> | null = null;
let subscriberReconnectTimer: NodeJS.Timeout | undefined;
let isConnected = false;
let isClosing = false;

export type ChannelHandler = (channel: string, message: string) => void;
export type ReconnectHandler = () => void;

const channelHandlers = new Map<string, Set<ChannelHandler>>();
const reconnectHandlers = new Set<ReconnectHandler>();

const getConfiguredTcpUrl = (): string | undefined => {
  return (
    process.env.REDIS_URL?.trim() ||
    process.env.UPSTASH_REDIS_URL?.trim() ||
    undefined
  );
};

export const isTcpRedisConfigured = (): boolean => {
  if (getConfiguredTcpUrl()) return true;
  if (process.env.REDIS_HOST?.trim()) return true;
  if (process.env.REDIS_PORT?.trim()) return true;
  if (
    (process.env.NODE_ENV || serverConfig.NODE_ENV) !== "production" &&
    !isUpstashRestConfigured()
  ) {
    return true;
  }
  return false;
};

const parseRedisUrlOptions = (rawUrl: string): Partial<RedisOptions> => {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port ? Number(parsed.port) : 6379;
  const username = parsed.username
    ? decodeURIComponent(parsed.username)
    : undefined;
  const password = parsed.password
    ? decodeURIComponent(parsed.password)
    : undefined;
  const isRediss = parsed.protocol === "rediss:";
  const dbPath = parsed.pathname?.replace(/^\//, "");
  const db =
    dbPath && /^\d+$/.test(dbPath) ? Number.parseInt(dbPath, 10) : undefined;

  return {
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(isRediss ? { tls: {} } : {}),
  };
};

export const buildRedisOptions = (
  overrideOptions?: Partial<RedisOptions>,
): RedisOptions => {
  const rawRedisUrl = getConfiguredTcpUrl();
  const urlOpts = rawRedisUrl ? parseRedisUrlOptions(rawRedisUrl) : {};

  const host =
    urlOpts.host ||
    process.env.REDIS_HOST?.trim() ||
    serverConfig.REDIS_HOST ||
    "127.0.0.1";
  const port =
    urlOpts.port ||
    Number(process.env.REDIS_PORT) ||
    Number(serverConfig.REDIS_PORT) ||
    6379;
  const password =
    urlOpts.password ??
    process.env.REDIS_PASSWORD ??
    serverConfig.REDIS_PASSWORD ??
    undefined;
  const username =
    urlOpts.username ??
    process.env.REDIS_USERNAME ??
    serverConfig.REDIS_USERNAME ??
    undefined;

  const useTls =
    urlOpts.tls !== undefined
      ? true
      : process.env.REDIS_TLS !== undefined
        ? process.env.REDIS_TLS === "true"
        : serverConfig.REDIS_TLS;
  const rejectUnauthorized =
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== undefined
      ? process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false"
      : serverConfig.REDIS_TLS_REJECT_UNAUTHORIZED;

  const commandTimeout =
    Number(process.env.REDIS_COMMAND_TIMEOUT_MS) ||
    serverConfig.REDIS_COMMAND_TIMEOUT_MS ||
    REDIS_DEFAULTS.COMMAND_TIMEOUT_MS;
  const connectTimeout =
    Number(process.env.REDIS_CONNECT_TIMEOUT_MS) ||
    serverConfig.REDIS_CONNECT_TIMEOUT_MS ||
    REDIS_DEFAULTS.CONNECT_TIMEOUT_MS;
  const maxRetriesPerRequest =
    process.env.REDIS_MAX_RETRIES_PER_REQUEST !== undefined
      ? Number(process.env.REDIS_MAX_RETRIES_PER_REQUEST)
      : serverConfig.REDIS_MAX_RETRIES_PER_REQUEST;

  return {
    host,
    port,
    ...(urlOpts.db !== undefined ? { db: urlOpts.db } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(useTls
      ? {
          tls: {
            rejectUnauthorized,
            servername:
              host !== "127.0.0.1" && host !== "localhost" ? host : undefined,
          },
        }
      : {}),
    maxRetriesPerRequest: Number.isInteger(maxRetriesPerRequest)
      ? maxRetriesPerRequest
      : REDIS_DEFAULTS.MAX_RETRIES_PER_REQUEST,
    commandTimeout,
    connectTimeout,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy(times: number) {
      if (times > 20) {
        logger.warn("Redis reconnect attempts paused; retrying every 30s");
        return 30_000;
      }
      const delay = Math.min(times * 200 + Math.random() * 100, 5000);
      logger.warn(
        `Redis reconnecting attempt ${times} in ${Math.round(delay)}ms`,
      );
      return delay;
    },
    ...overrideOptions,
  };
};

const notifyReconnectHandlers = (): void => {
  for (const handler of reconnectHandlers) {
    try {
      handler();
    } catch (err) {
      logger.warn("Redis reconnect handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

const attachSubscriber = async (
  baseOptions: RedisOptions,
): Promise<Redis | null> => {
  if (redisSubscriber && redisSubscriber.status === "ready") {
    return redisSubscriber;
  }
  if (subscriberConnectPromise) {
    return subscriberConnectPromise;
  }

  subscriberConnectPromise = (async () => {
    try {
      if (
        !redisSubscriber ||
        redisSubscriber.status === "end" ||
        redisSubscriber.status === "close"
      ) {
        redisSubscriber = new Redis({
          ...baseOptions,
          commandTimeout: undefined,
        });

        let hasConnectedBefore = false;

        redisSubscriber.on("ready", async () => {
          if (hasConnectedBefore) {
            notifyReconnectHandlers();
          }
          hasConnectedBefore = true;

          const channels = Array.from(channelHandlers.keys());
          if (channels.length > 0 && redisSubscriber) {
            try {
              await redisSubscriber.subscribe(...channels);
            } catch (err) {
              recordRedisError();
              logger.warn("Redis subscriber failed to subscribe channels", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        });

        redisSubscriber.on("message", (channel: string, message: string) => {
          const handlers = channelHandlers.get(channel);
          if (!handlers) return;
          for (const handler of handlers) {
            try {
              handler(channel, message);
            } catch (err) {
              logger.warn("Redis pub/sub message handler failed", {
                channel,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        });

        redisSubscriber.on("error", (err: Error) => {
          recordRedisError();
          logger.warn("Redis subscriber error", {
            error: { name: err.name, message: err.message },
          });
        });

        redisSubscriber.on("end", () => {
          if (isClosing || !redisClient || redisClient.status === "end") {
            return;
          }
          logger.warn("Redis subscriber ended unexpectedly; scheduling re-attach");
          redisSubscriber = null;
          if (!subscriberReconnectTimer) {
            subscriberReconnectTimer = setTimeout(() => {
              subscriberReconnectTimer = undefined;
              if (!isClosing && redisClient && redisClient.status !== "end") {
                void attachSubscriber(baseOptions);
              }
            }, 100);
            if (subscriberReconnectTimer.unref) {
              subscriberReconnectTimer.unref();
            }
          }
        });
      }

      if (
        redisSubscriber.status !== "ready" &&
        redisSubscriber.status !== "connecting" &&
        redisSubscriber.status !== "connect"
      ) {
        await redisSubscriber.connect();
      }
      return redisSubscriber;
    } catch (error) {
      recordRedisError();
      logger.warn("Redis subscriber failed to connect", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      subscriberConnectPromise = null;
    }
  })();

  return subscriberConnectPromise;
};

export const initRedis = async (
  overrideOptions?: Partial<RedisOptions>,
): Promise<Redis | null> => {
  isClosing = false;
  initUpstashRest();

  if (!overrideOptions && !isTcpRedisConfigured()) {
    logger.warn(
      "[redis] Native Redis TCP (REDIS_URL) is not configured; using Upstash REST for HTTP Redis operations. Socket.IO Redis Adapter and cross-instance Pub/Sub require REDIS_URL.",
    );
    return null;
  }

  if (
    redisClient &&
    redisClient.status !== "end" &&
    redisClient.status !== "close"
  ) {
    if (
      !redisSubscriber ||
      redisSubscriber.status === "end" ||
      redisSubscriber.status === "close"
    ) {
      await attachSubscriber(buildRedisOptions(overrideOptions));
    }
    return redisClient;
  }

  const redisOptions = buildRedisOptions(overrideOptions);

  try {
    redisClient = new Redis(redisOptions);
    let hasBeenReady = false;

    redisClient.on("connect", () => {
      logger.info(
        `Redis connecting to ${redisOptions.host}:${redisOptions.port}...`,
      );
    });

    redisClient.on("ready", () => {
      isConnected = true;
      logger.info("Redis connection established and ready");
      void import("./redis.store.js").then((m) => m.resetRedisCircuitBreaker());
      if (
        !redisSubscriber ||
        redisSubscriber.status === "end" ||
        redisSubscriber.status === "close"
      ) {
        void attachSubscriber(redisOptions);
      }
      if (
        hasBeenReady &&
        (!redisSubscriber || redisSubscriber.status !== "ready")
      ) {
        notifyReconnectHandlers();
      }
      hasBeenReady = true;
    });

    redisClient.on("error", (err: Error) => {
      isConnected = false;
      recordRedisError();
      logger.error("Redis connection error", {
        error: {
          name: err.name,
          message: err.message,
        },
      });
    });

    redisClient.on("close", () => {
      isConnected = false;
      logger.warn("Redis connection closed");
    });

    redisClient.on("reconnecting", () => {
      isConnected = false;
      logger.warn("Redis client reconnecting...");
    });

    await redisClient.connect();
    await attachSubscriber(redisOptions);
    return redisClient;
  } catch (error) {
    isConnected = false;
    recordRedisError();
    logger.warn(
      "Redis initial connection failed; continuing with fallback handlers",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return redisClient;
  }
};

export const getRedisClient = (): Redis | null => {
  return redisClient;
};

export const getRedisSubscriber = (): Redis | null => {
  return redisSubscriber;
};

export const createRedisDuplicate = (
  overrideOptions?: Partial<RedisOptions>,
): Redis => {
  return new Redis(
    buildRedisOptions({
      lazyConnect: true,
      ...overrideOptions,
    }),
  );
};

export const unsubscribeFromChannel = async (
  channel: string,
  handler: ChannelHandler,
): Promise<void> => {
  const handlers = channelHandlers.get(channel);
  if (!handlers) return;
  handlers.delete(handler);
  if (handlers.size === 0) {
    channelHandlers.delete(channel);
    if (redisSubscriber && redisSubscriber.status === "ready") {
      try {
        await redisSubscriber.unsubscribe(channel);
      } catch (err) {
        logger.warn("Failed to unsubscribe from Redis channel", {
          channel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
};

export const subscribeToChannel = async (
  channel: string,
  handler: ChannelHandler,
): Promise<void> => {
  let handlers = channelHandlers.get(channel);
  const isNewChannel = !handlers;
  if (!handlers) {
    handlers = new Set();
    channelHandlers.set(channel, handlers);
  }
  handlers.add(handler);

  if (isNewChannel && redisSubscriber && redisSubscriber.status === "ready") {
    try {
      await redisSubscriber.subscribe(channel);
    } catch (err) {
      logger.warn("Failed to subscribe to Redis channel", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

export const publishEvent = async (
  channel: string,
  payload: unknown,
): Promise<void> => {
  if (!redisClient || redisClient.status !== "ready") {
    return;
  }
  const start = performance.now();
  try {
    await redisClient.publish(channel, JSON.stringify(payload));
    recordTcpCommand(performance.now() - start);
  } catch (err) {
    recordRedisError();
    logger.warn("Failed to publish Redis event", {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const onRedisReconnect = (handler: ReconnectHandler): void => {
  reconnectHandlers.add(handler);
};

export const pingTcpRedis = async (): Promise<{
  ok: boolean;
  latencyMs: number | null;
}> => {
  if (!redisClient || !isConnected || redisClient.status !== "ready") {
    return { ok: false, latencyMs: null };
  }
  const start = performance.now();
  try {
    const res = await redisClient.ping();
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;
    recordTcpCommand(latencyMs);
    return { ok: res === "PONG", latencyMs };
  } catch {
    recordRedisError();
    return { ok: false, latencyMs: null };
  }
};

const quitWithTimeout = async (client: Redis, timeoutMs = 1000): Promise<void> => {
  try {
    await Promise.race([
      client.quit(),
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          client.disconnect();
          resolve();
        }, timeoutMs);
        if (t.unref) t.unref();
      }),
    ]);
  } catch {
    client.disconnect();
  }
};

export const closeRedis = async (): Promise<void> => {
  isClosing = true;
  if (subscriberReconnectTimer) {
    clearTimeout(subscriberReconnectTimer);
    subscriberReconnectTimer = undefined;
  }
  closeUpstashRest();

  if (redisSubscriber) {
    const sub = redisSubscriber;
    redisSubscriber = null;
    await quitWithTimeout(sub);
  }

  if (redisClient) {
    logger.info("Closing Redis connection...");
    const cli = redisClient;
    redisClient = null;
    isConnected = false;
    await quitWithTimeout(cli);
  }
};
