import { Redis as UpstashRedis } from "@upstash/redis";
import logger from "../../config/logger.config.js";
import { REDIS_DEFAULTS } from "./redis.constants.js";
import { recordRedisError, recordRestCommand } from "./redis.metrics.js";

export interface UpstashRestConfig {
  url: string;
  token: string;
  timeoutMs?: number;
}

let restClient: UpstashRedis | null = null;
let restDisabledByShutdown = false;

const getConfiguredCredentials = (
  override?: Partial<UpstashRestConfig>,
): UpstashRestConfig | null => {
  const url = (override?.url ?? process.env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (
    override?.token ?? process.env.UPSTASH_REDIS_REST_TOKEN
  )?.trim();

  if (!url || !token) {
    return null;
  }

  const timeoutMs =
    override?.timeoutMs ??
    (Number(process.env.REDIS_REST_TIMEOUT_MS) ||
      REDIS_DEFAULTS.REST_TIMEOUT_MS);

  return { url, token, timeoutMs };
};

export const isUpstashRestConfigured = (): boolean => {
  return getConfiguredCredentials() !== null;
};

/**
 * Only skip auto-binding `.env` Upstash REST credentials when explicitly
 * requested by an isolated local test harness (`REDIS_DISABLE_AUTO_REST=true`).
 */
export const isAutoRestDisabled = (): boolean => {
  return process.env.REDIS_DISABLE_AUTO_REST === "true";
};

export const initUpstashRest = (
  override?: Partial<UpstashRestConfig>,
): UpstashRedis | null => {
  restDisabledByShutdown = false;

  if (restClient && !override) {
    return restClient;
  }

  const creds = getConfiguredCredentials(override);
  if (!creds) {
    return null;
  }

  if (!override && isAutoRestDisabled()) {
    return null;
  }

  let parsedHost = "unknown";
  try {
    parsedHost = new URL(creds.url).host;
  } catch {
    logger.error("[redis-rest] Invalid UPSTASH_REDIS_REST_URL format");
    return null;
  }

  const timeoutMs = creds.timeoutMs ?? REDIS_DEFAULTS.REST_TIMEOUT_MS;

  restClient = new UpstashRedis({
    url: creds.url,
    token: creds.token,
    automaticDeserialization: false,
    signal: () => AbortSignal.timeout(timeoutMs),
    retry: {
      retries: REDIS_DEFAULTS.REST_RETRIES,
      backoff: (retryCount) =>
        Math.min(
          100 * 2 ** retryCount + Math.floor(Math.random() * 100),
          1000,
        ),
    },
  });

  logger.info("[redis-rest] Upstash REST client initialized", {
    host: parsedHost,
    timeoutMs,
  });

  return restClient;
};

export const getUpstashRestClient = (): UpstashRedis | null => {
  if (restDisabledByShutdown) {
    return null;
  }
  if (!restClient) {
    return initUpstashRest();
  }
  return restClient;
};

export const closeUpstashRest = (): void => {
  restClient = null;
  restDisabledByShutdown = true;
};

const measureRest = async <T>(
  operation: string,
  fn: (client: UpstashRedis) => Promise<T>,
): Promise<T> => {
  const client = getUpstashRestClient();
  if (!client) {
    throw new Error("Upstash REST client is not available");
  }
  const start = performance.now();
  try {
    const result = await fn(client);
    recordRestCommand(performance.now() - start);
    return result;
  } catch (err) {
    recordRedisError();
    logger.warn("[redis-rest] Command failed", {
      operation,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};

export const restPing = async (): Promise<{
  ok: boolean;
  latencyMs: number | null;
}> => {
  const client = getUpstashRestClient();
  if (!client) {
    return { ok: false, latencyMs: null };
  }
  const start = performance.now();
  try {
    const pong = await client.ping();
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;
    recordRestCommand(latencyMs);
    return { ok: pong === "PONG", latencyMs };
  } catch {
    recordRedisError();
    return { ok: false, latencyMs: null };
  }
};

export const isUpstashRestHealthy = async (): Promise<boolean> => {
  const result = await restPing();
  return result.ok;
};

export const restGet = async (key: string): Promise<string | null> => {
  const val = await measureRest("GET", (client) => client.get<string>(key));
  if (val === null || val === undefined) return null;
  return typeof val === "string" ? val : String(val);
};

export const restMget = async (
  keys: string[],
): Promise<(string | null)[]> => {
  if (keys.length === 0) return [];
  const res = await measureRest("MGET", (client) =>
    client.mget<(string | null)[]>(...keys),
  );
  if (!Array.isArray(res)) {
    return keys.map(() => null);
  }
  return res.map((v) => {
    if (v === null || v === undefined) return null;
    return typeof v === "string" ? v : String(v);
  });
};

export const restSet = async (
  key: string,
  value: string,
  options?: { ex?: number; nx?: boolean },
): Promise<"OK" | null> => {
  const res = await measureRest("SET", (client) => {
    const setOpts: Record<string, unknown> = {};
    if (options?.ex !== undefined) setOpts.ex = options.ex;
    if (options?.nx) setOpts.nx = true;
    return Object.keys(setOpts).length > 0
      ? client.set(key, value, setOpts as Parameters<UpstashRedis["set"]>[2])
      : client.set(key, value);
  });
  return res === "OK" ? "OK" : null;
};

export const restDel = async (...keys: string[]): Promise<number> => {
  if (keys.length === 0) return 0;
  return measureRest("DEL", (client) => client.del(...keys));
};

export const restEval = async <T = unknown>(
  script: string,
  keys: string[],
  args: (string | number)[],
): Promise<T> => {
  return measureRest("EVAL", (client) => client.eval<unknown[], T>(script, keys, args));
};

export const restZremAndDel = async (
  zsetKey: string,
  member: string,
  delKey: string,
): Promise<void> => {
  await measureRest("PIPELINE_ZREM_DEL", async (client) => {
    const pipeline = client.pipeline();
    pipeline.zrem(zsetKey, member);
    pipeline.del(delKey);
    await pipeline.exec();
  });
};
