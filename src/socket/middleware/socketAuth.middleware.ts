import crypto from "crypto";
import net from "net";
import { serverConfig } from "../../config/index.js";
import logger, { logSecurityAudit } from "../../config/logger.config.js";
import { verifyAuthenticatedCredential } from "../../middlewares/authenticate.middleware.js";
import {
  resolveOptionalCafeIdByUserId,
  resolveOptionalStudentIdByUserId,
} from "../../utils/order/requestUser.js";
import type { AppSocket } from "../socket.types.js";
import { allowSocketHandshake } from "../services/socketRateLimit.service.js";

const normalizeIp = (rawIp: string): string => {
  const trimmed = rawIp.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
};

const extractSocketIp = (socket: AppSocket): string => {
  const directIp = normalizeIp(socket.handshake.address || "unknown");
  const trustProxy = serverConfig.TRUST_PROXY;

  if (!trustProxy) {
    return directIp;
  }

  const forwardedHeader = socket.handshake.headers["x-forwarded-for"];
  const rawForwarded = Array.isArray(forwardedHeader)
    ? forwardedHeader.join(",")
    : forwardedHeader;

  if (typeof rawForwarded === "string" && rawForwarded.trim().length > 0) {
    const chain = rawForwarded
      .split(",")
      .map((part) => normalizeIp(part))
      .filter((ip) => ip.length > 0 && net.isIP(ip) > 0);

    if (chain.length > 0) {
      const hops =
        typeof trustProxy === "number" && Number.isInteger(trustProxy) && trustProxy > 0
          ? trustProxy
          : 1;
      const candidateIndex = Math.max(0, chain.length - hops);
      return chain[candidateIndex] ?? directIp;
    }
  }

  return directIp;
};

const extractSocketToken = (socket: AppSocket): string | null => {
  const authPayload = socket.handshake.auth as
    | Record<string, unknown>
    | undefined;
  if (authPayload && typeof authPayload.token === "string") {
    const trimmed = authPayload.token.trim();
    if (trimmed) return trimmed;
  }

  const authHeader = socket.handshake.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const trimmed = authHeader.slice(7).trim();
    if (trimmed) return trimmed;
  }

  return null;
};

export const socketAuthMiddleware = async (
  socket: AppSocket,
  next: (err?: Error) => void,
): Promise<void> => {
  const connectionId = crypto.randomUUID();
  const ip = extractSocketIp(socket);

  try {
    if (
      socket.handshake.query &&
      Object.prototype.hasOwnProperty.call(socket.handshake.query, "token")
    ) {
      logger.warn("[socket] Rejected handshake with query string token", {
        connectionId,
        ip,
      });
      next(
        new Error(
          "UNAUTHORIZED: Authentication token must not be passed in URL query parameters",
        ),
      );
      return;
    }

    const allowed = await allowSocketHandshake(ip);
    if (!allowed) {
      logger.warn("[socket] Handshake rate limited", { connectionId, ip });
      logSecurityAudit({
        eventType: "RATE_LIMIT_TRIGGERED",
        requestId: connectionId,
        ip,
        success: false,
        reasonCode: "SOCKET_HANDSHAKE_RATE_LIMITED",
      });
      next(new Error("RATE_LIMITED: Too many WebSocket connection attempts"));
      return;
    }

    const token = extractSocketToken(socket);
    if (!token) {
      logSecurityAudit({
        eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
        requestId: connectionId,
        ip,
        success: false,
        reasonCode: "SOCKET_MISSING_TOKEN",
      });
      next(new Error("UNAUTHORIZED: Access token required"));
      return;
    }

    const verified = await verifyAuthenticatedCredential(token, {
      requestId: connectionId,
      ip,
      updateActivity: true,
    });

    if (!verified.ok) {
      logSecurityAudit({
        eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
        requestId: connectionId,
        ip,
        success: false,
        reasonCode:
          verified.statusCode === 503
            ? "SOCKET_AUTH_SERVICE_UNAVAILABLE"
            : "SOCKET_AUTH_REJECTED",
      });
      const code =
        verified.statusCode === 503 ? "SERVICE_UNAVAILABLE" : "UNAUTHORIZED";
      next(new Error(`${code}: ${verified.message}`));
      return;
    }

    const { user, auth } = verified;
    let studentId: string | undefined;
    let cafeId: string | undefined;

    if (user.role === "student") {
      studentId = await resolveOptionalStudentIdByUserId(String(user._id));
    } else if (user.role === "cafeOwner") {
      cafeId = await resolveOptionalCafeIdByUserId(String(user._id));
    }

    socket.data = {
      userId: String(user._id),
      role: user.role,
      sid: auth.sid,
      jti: auth.jti,
      tv: auth.tv,
      exp: auth.exp,
      studentId,
      cafeId,
      connectedAt: new Date().toISOString(),
      connectionId,
      ip,
    };

    next();
  } catch (err) {
    logger.error("[socket] Unexpected handshake authentication error", {
      connectionId,
      ip,
      error: err instanceof Error ? err.message : String(err),
    });
    next(new Error("INTERNAL_ERROR: Socket authentication failed"));
  }
};
