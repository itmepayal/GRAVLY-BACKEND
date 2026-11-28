import { AsyncLocalStorage } from "node:async_hooks";
import cluster from "node:cluster";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

export interface RequestLogContext {
  requestId?: string;
  userId?: string;
  method?: string;
  route?: string;
  ip?: string;
}

const logContextStorage = new AsyncLocalStorage<RequestLogContext>();

export const runWithLogContext = <T>(
  ctx: RequestLogContext,
  fn: () => T,
): T => {
  const parent = logContextStorage.getStore();
  return logContextStorage.run(parent ? { ...parent, ...ctx } : { ...ctx }, fn);
};

export const getLogContext = (): RequestLogContext | undefined =>
  logContextStorage.getStore();

export const updateLogContext = (patch: Partial<RequestLogContext>): void => {
  const store = logContextStorage.getStore();
  if (!store) return;
  Object.assign(store, patch);
};

export const getWorkerId = (): string => {
  const pm2Instance = process.env.NODE_APP_INSTANCE?.trim();
  if (pm2Instance !== undefined && pm2Instance !== "") {
    return `worker-${pm2Instance}`;
  }
  if (cluster.isWorker && cluster.worker) {
    return `worker-${cluster.worker.id}`;
  }
  return "primary";
};

const SENSITIVE_KEY_PATTERN =
  /password|newpassword|currentpassword|token|secret|authorization|privatekey|cookie|set-cookie|credential|apikey|api_key|signature|otp|cvv|cardnumber|accountnumber|aadhaar|pannumber|passphrase|x-client-secret|x-webhook-signature|x-swagger-key|upstash_redis_rest_token|cashfree_secret_key|cloudinary_api_secret/i;

const MAX_STRING_LEN = 1000;
const MAX_OBJECT_KEYS = 50;
const MAX_ARRAY_LEN = 25;

export const sanitizeLogString = (val: string): string => {
  let cleaned = val.replace(/[\r\n\t]+/g, " ");
  cleaned = cleaned.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    "$1 [REDACTED]",
  );
  cleaned = cleaned.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED_JWT]",
  );
  cleaned = cleaned.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    "$1[REDACTED]$3",
  );
  cleaned = cleaned.replace(
    /\b(password|token|secret|apikey|api_key|authorization|refresh_?token|access_?token|signature)\b(\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi,
    "$1$2[REDACTED]",
  );
  return cleaned.slice(0, MAX_STRING_LEN);
};

export const sanitizeLogData = (
  input: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (depth > 5) return "[TRUNCATED]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return sanitizeLogString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "bigint") return input.toString();
  if (input instanceof Date) return input.toISOString();

  if (typeof input === "object") {
    if (seen.has(input)) {
      return "[CIRCULAR]";
    }
    seen.add(input);
  }

  if (input instanceof Error) {
    const errRec = input as Error & {
      code?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    const errOut: Record<string, unknown> = {
      name: input.name,
      message: sanitizeLogString(input.message),
    };
    if (errRec.code !== undefined) errOut.code = errRec.code;
    if (errRec.statusCode !== undefined) errOut.statusCode = errRec.statusCode;
    if (input.stack && process.env.NODE_ENV !== "production") {
      errOut.stack = sanitizeLogString(input.stack);
    } else if (input.stack && process.env.LOG_STACK_IN_PROD === "true") {
      errOut.stack = sanitizeLogString(input.stack);
    }
    if (errRec.cause !== undefined) {
      errOut.cause = sanitizeLogData(errRec.cause, depth + 1, seen);
    }
    return errOut;
  }

  if (Array.isArray(input)) {
    return input
      .slice(0, MAX_ARRAY_LEN)
      .map((item) => sanitizeLogData(item, depth + 1, seen));
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(input as Record<string, unknown>).slice(
      0,
      MAX_OBJECT_KEYS,
    );
    for (const [k, v] of entries) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeLogData(v, depth + 1, seen);
      }
    }
    return out;
  }

  return sanitizeLogString(String(input));
};

const resolveLogLevel = (): string => {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (
    configured &&
    ["error", "warn", "info", "http", "verbose", "debug", "silly"].includes(
      configured,
    )
  ) {
    return configured;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
};

const shouldWriteLogFiles = (): boolean => process.env.LOG_TO_FILE !== "false";

const buildTransports = (
  filenamePattern: string,
  maxFiles: string,
): winston.transport[] => {
  const transports: winston.transport[] = [new winston.transports.Console()];
  if (shouldWriteLogFiles()) {
    transports.push(
      new DailyRotateFile({
        filename: filenamePattern,
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles,
      }),
    );
  }
  return transports;
};

export const logger = winston.createLogger({
  level: resolveLogLevel(),
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    winston.format.printf(({ level, message, timestamp, ...data }) => {
      const ctx = getLogContext();
      const mergedData: Record<string, unknown> = {
        ...(ctx?.requestId && data.requestId === undefined
          ? { requestId: ctx.requestId }
          : {}),
        ...(ctx?.userId && data.userId === undefined
          ? { userId: ctx.userId }
          : {}),
        ...(ctx?.method && data.method === undefined
          ? { method: ctx.method }
          : {}),
        ...(ctx?.route && data.route === undefined ? { route: ctx.route } : {}),
        ...data,
      };

      const output = {
        timestamp,
        level,
        service: "cafemart-backend",
        env: process.env.NODE_ENV || "development",
        pid: process.pid,
        workerId: getWorkerId(),
        message:
          typeof message === "string"
            ? sanitizeLogString(message)
            : sanitizeLogData(message),
        data: sanitizeLogData(mergedData),
      };
      return JSON.stringify(output);
    }),
  ),
  transports: buildTransports("logs/%DATE%-app.log", "14d"),
});

export const securityAuditLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    winston.format.printf(({ level, message, timestamp, ...data }) => {
      const ctx = getLogContext();
      const merged = {
        ...(ctx?.requestId && data.requestId === undefined
          ? { requestId: ctx.requestId }
          : {}),
        ...(ctx?.userId && data.userId === undefined
          ? { userId: ctx.userId }
          : {}),
        ...data,
      };
      return JSON.stringify({
        timestamp,
        level,
        service: "cafemart-backend",
        pid: process.pid,
        workerId: getWorkerId(),
        message:
          typeof message === "string" ? sanitizeLogString(message) : message,
        ...(sanitizeLogData(merged) as Record<string, unknown>),
      });
    }),
  ),
  transports: buildTransports("logs/%DATE%-security-audit.log", "90d"),
});

export type SecurityAuditEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGOUT"
  | "LOGOUT_FAILURE"
  | "LOGOUT_ALL"
  | "DEVICE_LOGOUT"
  | "SESSION_CREATED"
  | "SESSION_LIST_VIEWED"
  | "SESSION_EXPIRED"
  | "SESSION_REUSE_DETECTED"
  | "SESSION_INVALID_ACCESS_ATTEMPT"
  | "ADMIN_FORCED_SESSION_REVOCATION"
  | "PASSWORD_CHANGE"
  | "PASSWORD_RESET"
  | "REFRESH_SUCCESS"
  | "TOKEN_REFRESH_FAILURE"
  | "REFRESH_TOKEN_REUSE"
  | "SESSION_REVOKED"
  | "ACCOUNT_LOCKED"
  | "ADMIN_LOGIN"
  | "ADMIN_LOGIN_FAILURE"
  | "ADMIN_CREATED"
  | "ADMIN_ROLE_CHANGED"
  | "ADMIN_PASSWORD_CHANGED"
  | "ADMIN_ACCOUNT_DEACTIVATED"
  | "PRIVILEGE_ESCALATION_ATTEMPT"
  | "ACCOUNT_DEACTIVATED"
  | "ACCOUNT_REACTIVATED"
  | "ACCOUNT_DELETED"
  | "SUSPICIOUS_AUTHENTICATION"
  | "UNAUTHORIZED_ACCESS_ATTEMPT"
  | "UNAUTHORIZED_ROLE_ACCESS"
  | "RATE_LIMIT_TRIGGERED";

export interface SecurityAuditEvent {
  eventType: SecurityAuditEventType;
  userId?: string;
  actorId?: string;
  sessionId?: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  success: boolean;
  reasonCode: string;
  metadata?: Record<string, unknown>;
}

let securityAuditFailures = 0;
let lastSecurityAuditFailureAt: string | null = null;

export const getSecurityAuditStats = () => ({
  failures: securityAuditFailures,
  lastFailureAt: lastSecurityAuditFailureAt,
});

export const logSecurityAudit = (event: SecurityAuditEvent): void => {
  try {
    const ctx = getLogContext();
    const sanitized = sanitizeLogData({
      category: "SECURITY_AUDIT",
      timestamp: new Date().toISOString(),
      requestId: event.requestId ?? ctx?.requestId,
      ip: event.ip ?? ctx?.ip,
      ...event,
    }) as Record<string, unknown>;

    if (event.success) {
      securityAuditLogger.info(event.eventType, sanitized);
    } else {
      securityAuditLogger.warn(event.eventType, sanitized);
    }
  } catch (err) {
    securityAuditFailures += 1;
    lastSecurityAuditFailureAt = new Date().toISOString();
    try {
      logger.error("Failed to record security audit event", {
        eventType: event.eventType,
        securityAuditFailures,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      process.stderr.write(
        `[SECURITY_AUDIT_FAILURE] eventType=${event.eventType} failures=${securityAuditFailures}\n`,
      );
    }
  }
};

export const flushLoggers = async (timeoutMs = 2000): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  const waitForLogger = (wLogger: winston.Logger): Promise<void> =>
    new Promise((resolve) => {
      const streamsToFlush: NodeJS.EventEmitter[] = [];
      for (const t of wLogger.transports as unknown as Array<{
        _stream?: NodeJS.WritableStream & { writableEnded?: boolean };
        logStream?: NodeJS.EventEmitter & { end?: () => void };
        flush?: () => void;
      }>) {
        if (typeof t.flush === "function") {
          try {
            t.flush();
          } catch {
            // ignore transport flush error
          }
        }
        if (
          t._stream &&
          typeof t._stream.end === "function" &&
          t._stream !== process.stdout &&
          t._stream !== process.stderr
        ) {
          streamsToFlush.push(t._stream as unknown as NodeJS.EventEmitter);
        } else if (t.logStream && typeof t.logStream.end === "function") {
          streamsToFlush.push(t.logStream);
        }
      }
      if (streamsToFlush.length === 0) {
        resolve();
        return;
      }
      let remaining = streamsToFlush.length;
      let settled = false;
      const done = () => {
        remaining -= 1;
        if (remaining <= 0 && !settled) {
          settled = true;
          resolve();
        }
      };
      for (const s of streamsToFlush as Array<
        NodeJS.EventEmitter & { end?: () => void }
      >) {
        try {
          let streamDone = false;
          const finishOne = () => {
            if (streamDone) return;
            streamDone = true;
            done();
          };
          s.once("finish", finishOne);
          s.once("close", finishOne);
          s.once("error", finishOne);
          s.end?.();
        } catch {
          done();
        }
      }
    });

  await Promise.race([
    Promise.allSettled([
      waitForLogger(logger),
      waitForLogger(securityAuditLogger),
    ]).then(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      if (timer.unref) timer.unref();
    }),
  ]);
};

export default logger;
