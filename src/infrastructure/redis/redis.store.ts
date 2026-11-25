import {
  recordCircuitState,
  recordRedisError,
  recordTcpCommand,
  type RedisCircuitState,
} from "./redis.metrics.js";
import { getRedisClient } from "./redis.tcp.js";
import {
  getUpstashRestClient,
  restDel,
  restEval,
  restGet,
  restMget,
  restSet,
  restZremAndDel,
} from "./redis.rest.js";
import logger from "../../config/logger.config.js";

export type RedisTransport = "tcp" | "rest" | "none";

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_COOLDOWN_MS = 5000;

let circuitState: RedisCircuitState = "CLOSED";
let consecutiveFailures = 0;
let circuitOpenedAt = 0;
let halfOpenInFlight = false;

export const getRedisCircuitState = (): RedisCircuitState => {
  if (
    circuitState === "OPEN" &&
    Date.now() - circuitOpenedAt >= CIRCUIT_OPEN_COOLDOWN_MS
  ) {
    return "HALF_OPEN";
  }
  return circuitState;
};

export const resetRedisCircuitBreaker = (): void => {
  circuitState = "CLOSED";
  consecutiveFailures = 0;
  circuitOpenedAt = 0;
  halfOpenInFlight = false;
  recordCircuitState("CLOSED");
};

const onCommandSuccess = (): void => {
  if (circuitState !== "CLOSED" || consecutiveFailures > 0) {
    circuitState = "CLOSED";
    consecutiveFailures = 0;
    circuitOpenedAt = 0;
    halfOpenInFlight = false;
    recordCircuitState("CLOSED");
  }
};

const onCommandFailure = (): void => {
  consecutiveFailures += 1;
  halfOpenInFlight = false;
  if (
    circuitState === "HALF_OPEN" ||
    consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD
  ) {
    const wasClosed = circuitState !== "OPEN";
    circuitState = "OPEN";
    circuitOpenedAt = Date.now();
    recordCircuitState("OPEN", wasClosed);
    if (wasClosed) {
      logger.warn("[redis] Circuit breaker OPEN after consecutive failures", {
        consecutiveFailures,
        cooldownMs: CIRCUIT_OPEN_COOLDOWN_MS,
      });
    }
  }
};

const checkCircuitAllowance = (): void => {
  const effective = getRedisCircuitState();
  if (effective === "OPEN") {
    throw new Error("Redis circuit breaker is OPEN");
  }
  if (effective === "HALF_OPEN") {
    if (halfOpenInFlight) {
      throw new Error("Redis circuit breaker is HALF_OPEN");
    }
    circuitState = "HALF_OPEN";
    halfOpenInFlight = true;
    recordCircuitState("HALF_OPEN");
  }
};

export const getActiveRedisTransport = (): RedisTransport => {
  const tcp = getRedisClient();
  if (tcp && tcp.status === "ready") {
    return "tcp";
  }
  if (getUpstashRestClient()) {
    return "rest";
  }
  return "none";
};

export const isRedisAvailable = (): boolean => {
  if (getActiveRedisTransport() === "none") {
    return false;
  }
  return getRedisCircuitState() !== "OPEN";
};

const runTcp = async <T>(
  fn: (tcp: NonNullable<ReturnType<typeof getRedisClient>>) => Promise<T>,
): Promise<T> => {
  const tcp = getRedisClient();
  if (!tcp || tcp.status !== "ready") {
    throw new Error("Redis TCP client is not ready");
  }
  const start = performance.now();
  try {
    const res = await fn(tcp);
    recordTcpCommand(performance.now() - start);
    return res;
  } catch (err) {
    recordRedisError();
    throw err;
  }
};

const runWithFailover = async <T>(
  tcpFn: (tcp: NonNullable<ReturnType<typeof getRedisClient>>) => Promise<T>,
  restFn: () => Promise<T>,
): Promise<T> => {
  const transport = getActiveRedisTransport();
  if (transport === "none") {
    throw new Error("Redis unavailable");
  }

  checkCircuitAllowance();

  try {
    let result: T;
    if (transport === "tcp") {
      try {
        result = await runTcp(tcpFn);
      } catch (tcpErr) {
        if (getUpstashRestClient()) {
          result = await restFn();
        } else {
          throw tcpErr;
        }
      }
    } else {
      result = await restFn();
    }
    onCommandSuccess();
    return result;
  } catch (err) {
    onCommandFailure();
    throw err;
  }
};

export const redisGet = async (key: string): Promise<string | null> => {
  return runWithFailover(
    (tcp) => tcp.get(key),
    () => restGet(key),
  );
};

export const redisMget = async (keys: string[]): Promise<(string | null)[]> => {
  if (keys.length === 0) return [];
  return runWithFailover(
    (tcp) => tcp.mget(...keys),
    () => restMget(keys),
  );
};

export const redisSet = async (
  key: string,
  value: string,
  options?: { ex?: number; nx?: boolean },
): Promise<"OK" | null> => {
  return runWithFailover(
    async (tcp) => {
      let res: string | null;
      if (options?.ex !== undefined && options?.nx) {
        res = await tcp.set(key, value, "EX", options.ex, "NX");
      } else if (options?.ex !== undefined) {
        res = await tcp.set(key, value, "EX", options.ex);
      } else if (options?.nx) {
        res = await tcp.set(key, value, "NX");
      } else {
        res = await tcp.set(key, value);
      }
      return res === "OK" ? "OK" : null;
    },
    () => restSet(key, value, options),
  );
};

export const redisIncr = async (key: string): Promise<number> => {
  return runWithFailover(
    (tcp) => tcp.incr(key),
    async () => {
      const val = await restEval<number>(
        "return redis.call('INCR', KEYS[1])",
        [key],
        [],
      );
      return Number(val);
    },
  );
};

export const redisDel = async (...keys: string[]): Promise<number> => {
  if (keys.length === 0) return 0;
  return runWithFailover(
    (tcp) => tcp.del(...keys),
    () => restDel(...keys),
  );
};

export const redisEval = async <T = unknown>(
  script: string,
  keys: string[],
  args: (string | number)[],
): Promise<T> => {
  return runWithFailover(
    (tcp) => tcp.eval(script, keys.length, ...keys, ...args) as Promise<T>,
    () => restEval<T>(script, keys, args),
  );
};

export const redisZremAndDel = async (
  zsetKey: string,
  member: string,
  delKey: string,
): Promise<void> => {
  await runWithFailover(
    async (tcp) => {
      const results = await tcp.pipeline().zrem(zsetKey, member).del(delKey).exec();
      if (results) {
        for (const [cmdErr] of results) {
          if (cmdErr) throw cmdErr;
        }
      }
    },
    () => restZremAndDel(zsetKey, member, delKey),
  );
};
