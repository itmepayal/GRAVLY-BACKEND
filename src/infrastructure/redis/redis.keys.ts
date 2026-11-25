import { REDIS_NAMESPACE } from "./redis.constants.js";

const UNSAFE_KEY_CHARS = /[\s\r\n\0*?:]/g;

const sanitizeSegment = (raw: string, label: string): string => {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(UNSAFE_KEY_CHARS, "_");
  if (!cleaned) {
    throw new Error(`Invalid empty Redis key segment for ${label}`);
  }
  return cleaned.slice(0, 128);
};

export const redisKeys = {
  userCache: (userId: string): string =>
    `${REDIS_NAMESPACE}:user:cache:${sanitizeSegment(userId, "userId")}`,

  sessionMeta: (sessionId: string): string =>
    `${REDIS_NAMESPACE}:session:meta:${sanitizeSegment(sessionId, "sessionId")}`,

  sessionRevoked: (sessionId: string): string =>
    `${REDIS_NAMESPACE}:session:revoked:${sanitizeSegment(sessionId, "sessionId")}`,

  jtiRevoked: (jti: string): string =>
    `${REDIS_NAMESPACE}:jti:revoked:${sanitizeSegment(jti, "jti")}`,

  userRevokedVersion: (userId: string): string =>
    `${REDIS_NAMESPACE}:user:revoked_version:${sanitizeSegment(userId, "userId")}`,

  sessionActivityThrottle: (sessionId: string): string =>
    `${REDIS_NAMESPACE}:session:activity_throttle:${sanitizeSegment(sessionId, "sessionId")}`,

  publicCafe: (cafeId: string): string =>
    `${REDIS_NAMESPACE}:cache:cafe:public:${sanitizeSegment(cafeId, "cafeId")}`,

  publicCafesVersion: (): string =>
    `${REDIS_NAMESPACE}:cache:cafes:version`,

  publicCafesList: (version: string, queryHash: string): string =>
    `${REDIS_NAMESPACE}:cache:cafes:list:v${sanitizeSegment(version, "version")}:${sanitizeSegment(queryHash, "queryHash")}`,

  cafeOrderableMeta: (cafeId: string): string =>
    `${REDIS_NAMESPACE}:cache:cafe:orderable:${sanitizeSegment(cafeId, "cafeId")}`,

  publicMenu: (cafeId: string, onlyOrderable: boolean): string =>
    `${REDIS_NAMESPACE}:cache:cafe:menu:${sanitizeSegment(cafeId, "cafeId")}:${
      onlyOrderable ? "orderable" : "all"
    }`,

  adminDashboard: (): string =>
    `${REDIS_NAMESPACE}:cache:admin:dashboard`,

  studentIdByUser: (userId: string): string =>
    `${REDIS_NAMESPACE}:identity:student_by_user:${sanitizeSegment(userId, "userId")}`,

  cafeIdByUser: (userId: string): string =>
    `${REDIS_NAMESPACE}:identity:cafe_by_user:${sanitizeSegment(userId, "userId")}`,

  idempotency: (scope: string, ownerId: string, key: string): string =>
    `${REDIS_NAMESPACE}:idem:${sanitizeSegment(scope, "scope")}:${sanitizeSegment(ownerId, "ownerId")}:${sanitizeSegment(key, "idemKey")}`,

  presenceUser: (userId: string): string =>
    `${REDIS_NAMESPACE}:presence:user:${sanitizeSegment(userId, "userId")}`,

  socketUserConns: (userId: string): string =>
    `${REDIS_NAMESPACE}:socket:user_conns:${sanitizeSegment(userId, "userId")}`,

  socketHandshakeLimit: (ip: string): string =>
    `${REDIS_NAMESPACE}:socket:ratelimit:handshake:${sanitizeSegment(ip || "unknown", "ip")}`,

  socketEventLimit: (userId: string, eventName: string): string =>
    `${REDIS_NAMESPACE}:socket:ratelimit:event:${sanitizeSegment(userId, "userId")}:${sanitizeSegment(eventName, "eventName")}`,

  rateLimit: (keyPrefix: string, identifier: string): string => {
    const seg = sanitizeSegment(identifier, "rateLimitKey");
    return `${keyPrefix}:{${seg}}`;
  },

  rateLimitPenalty: (keyPrefix: string, identifier: string): string => {
    const seg = sanitizeSegment(identifier, "rateLimitKey");
    return `${keyPrefix}:penalty:{${seg}}`;
  },

  rateLimitPenaltyLock: (keyPrefix: string, identifier: string): string => {
    const seg = sanitizeSegment(identifier, "rateLimitKey");
    return `${keyPrefix}:penalty:{${seg}}:lock`;
  },

  paymentInitiateLock: (orderId: string): string =>
    `${REDIS_NAMESPACE}:lock:payment:initiate:${sanitizeSegment(orderId, "orderId")}`,

  webhookSyncLock: (paymentId: string): string =>
    `${REDIS_NAMESPACE}:lock:payment:webhook:${sanitizeSegment(paymentId, "paymentId")}`,

  expireUnpaidOrdersLock: (): string =>
    `${REDIS_NAMESPACE}:job:expire_unpaid_orders:lock`,

  jobDeadLetter: (jobName: string): string =>
    `${REDIS_NAMESPACE}:job:dlq:${sanitizeSegment(jobName, "jobName")}`,
} as const;
