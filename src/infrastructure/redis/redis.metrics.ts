export type RedisCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface RedisMetricsSnapshot {
  tcpCommands: number;
  restCommands: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  circuitTrips: number;
  circuitState: RedisCircuitState;
  lastTcpLatencyMs: number | null;
  lastRestLatencyMs: number | null;
}

const metrics: RedisMetricsSnapshot = {
  tcpCommands: 0,
  restCommands: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
  circuitTrips: 0,
  circuitState: "CLOSED",
  lastTcpLatencyMs: null,
  lastRestLatencyMs: null,
};

export const recordTcpCommand = (latencyMs: number): void => {
  metrics.tcpCommands += 1;
  metrics.lastTcpLatencyMs = Math.round(latencyMs * 100) / 100;
};

export const recordRestCommand = (latencyMs: number): void => {
  metrics.restCommands += 1;
  metrics.lastRestLatencyMs = Math.round(latencyMs * 100) / 100;
};

export const recordRedisError = (): void => {
  metrics.errors += 1;
};

export const recordCircuitState = (
  state: RedisCircuitState,
  tripped = false,
): void => {
  metrics.circuitState = state;
  if (tripped) {
    metrics.circuitTrips += 1;
  }
};

export const recordCacheHit = (): void => {
  metrics.cacheHits += 1;
};

export const recordCacheMiss = (): void => {
  metrics.cacheMisses += 1;
};

export const getRedisMetrics = (): RedisMetricsSnapshot => ({ ...metrics });

export const resetRedisMetrics = (): void => {
  metrics.tcpCommands = 0;
  metrics.restCommands = 0;
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.errors = 0;
  metrics.circuitTrips = 0;
  metrics.circuitState = "CLOSED";
  metrics.lastTcpLatencyMs = null;
  metrics.lastRestLatencyMs = null;
};
