import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|authorization|privatekey|cookie|credential|apikey/i;

const sanitizeString = (val: string): string =>
  val.replace(/[\r\n\t]+/g, " ").slice(0, 500);

export const sanitizeLogData = (input: unknown, depth = 0): unknown => {
  if (depth > 4) return "[TRUNCATED]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return sanitizeString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (input instanceof Error) {
    return {
      name: input.name,
      message: sanitizeString(input.message),
    };
  }
  if (Array.isArray(input)) {
    return input.slice(0, 20).map((item) => sanitizeLogData(item, depth + 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeLogData(v, depth + 1);
      }
    }
    return out;
  }
  return String(input);
};

export const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({ format: "MM-DD-YYYY HH:mm:ss" }),
    winston.format.json(),
    winston.format.printf(({ level, message, timestamp, ...data }) => {
      const output = {
        level,
        message:
          typeof message === "string" ? sanitizeString(message) : message,
        timestamp,
        data: sanitizeLogData(data),
      };
      return JSON.stringify(output);
    }),
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: "logs/%DATE%-app.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "14d",
    }),
  ],
});

const securityAuditLogger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: "logs/%DATE%-security-audit.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "90d",
    }),
  ],
});

export type SecurityAuditEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGOUT"
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
  | "UNAUTHORIZED_ACCESS_ATTEMPT";

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

export const logSecurityAudit = (event: SecurityAuditEvent): void => {
  try {
    const sanitized = sanitizeLogData({
      category: "SECURITY_AUDIT",
      timestamp: new Date().toISOString(),
      ...event,
    }) as Record<string, unknown>;

    if (event.success) {
      securityAuditLogger.info(event.eventType, sanitized);
    } else {
      securityAuditLogger.warn(event.eventType, sanitized);
    }
  } catch (err) {
    logger.error("Failed to record security audit event", {
      eventType: event.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default logger;
