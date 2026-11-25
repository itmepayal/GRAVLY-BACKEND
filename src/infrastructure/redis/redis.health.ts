import { getRedisMetrics, type RedisCircuitState, type RedisMetricsSnapshot } from "./redis.metrics.js";
import { getRedisCircuitState } from "./redis.store.js";
import {
  getUpstashRestClient,
  isUpstashRestConfigured,
  restPing,
} from "./redis.rest.js";
import {
  getRedisClient,
  getRedisSubscriber,
  isTcpRedisConfigured,
  pingTcpRedis,
} from "./redis.tcp.js";

export interface RedisHealthReport {
  healthy: boolean;
  circuitState: RedisCircuitState;
  tcp: {
    configured: boolean;
    connected: boolean;
    status: string;
    subscriberStatus: string;
    latencyMs: number | null;
  };
  rest: {
    configured: boolean;
    healthy: boolean;
    latencyMs: number | null;
  };
  metrics: RedisMetricsSnapshot;
}

export const getRedisHealthDetails = async (): Promise<RedisHealthReport> => {
  const tcpConfigured = isTcpRedisConfigured();
  const restConfigured = isUpstashRestConfigured() && Boolean(getUpstashRestClient());

  const [tcpPing, restHealth] = await Promise.all([
    pingTcpRedis(),
    restConfigured ? restPing() : Promise.resolve({ ok: false, latencyMs: null }),
  ]);

  const tcpClient = getRedisClient();
  const subClient = getRedisSubscriber();

  const circuitState = getRedisCircuitState();
  const healthy = (tcpPing.ok || restHealth.ok) && circuitState !== "OPEN";

  return {
    healthy,
    circuitState,
    tcp: {
      configured: tcpConfigured,
      connected: tcpPing.ok,
      status: tcpClient?.status ?? "uninitialized",
      subscriberStatus: subClient?.status ?? "uninitialized",
      latencyMs: tcpPing.latencyMs,
    },
    rest: {
      configured: restConfigured,
      healthy: restHealth.ok,
      latencyMs: restHealth.latencyMs,
    },
    metrics: getRedisMetrics(),
  };
};

export const isRedisHealthy = async (): Promise<boolean> => {
  const tcpPing = await pingTcpRedis();
  if (tcpPing.ok) return true;

  if (getUpstashRestClient()) {
    const restHealth = await restPing();
    return restHealth.ok;
  }

  return false;
};
