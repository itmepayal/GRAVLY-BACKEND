import logger from "../../config/logger.config.js";
import { SOCKET_EVENTS } from "../socket.events.js";
import { ROOMS } from "../rooms/room.constants.js";
import type { AppSocket, SocketAck } from "../socket.types.js";
import {
  cafeSubscriptionSchema,
  validateSocketPayload,
} from "../validators/socket.validator.js";
import { allowSocketEvent } from "../services/socketRateLimit.service.js";
import { authorizeAndJoinCafeRoom } from "../services/socketRoom.service.js";

const sendAck = <T>(
  callback: ((ack: SocketAck<T>) => void) | undefined,
  ack: SocketAck<T>,
): void => {
  if (typeof callback === "function") callback(ack);
};

const registeredCafeSockets = new WeakSet<AppSocket>();

export const registerCafeHandlers = (socket: AppSocket): void => {
  if (registeredCafeSockets.has(socket)) return;
  registeredCafeSockets.add(socket);

  socket.on(SOCKET_EVENTS.CAFE_SUBSCRIBE, async (payload, callback) => {
    const requestId = socket.data.connectionId;
    try {
      const allowed = await allowSocketEvent(
        socket.data.userId,
        SOCKET_EVENTS.CAFE_SUBSCRIBE,
        30,
        60_000,
      );
      if (!allowed) {
        sendAck(callback, {
          ok: false,
          code: "RATE_LIMITED",
          message: "Too many cafe subscribe requests",
          requestId,
        });
        return;
      }

      const parsed = validateSocketPayload(cafeSubscriptionSchema, payload);
      if (!parsed.ok) {
        sendAck(callback, {
          ok: false,
          code: "VALIDATION_ERROR",
          message: parsed.message,
          requestId,
        });
        return;
      }

      const result = await authorizeAndJoinCafeRoom(socket, parsed.data.cafeId);
      sendAck(callback, result);
    } catch (err) {
      logger.warn("[socket] cafe:subscribe error", {
        socketId: socket.id,
        userId: socket.data.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendAck(callback, {
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Unable to subscribe to cafe",
        requestId,
      });
    }
  });

  socket.on(SOCKET_EVENTS.CAFE_UNSUBSCRIBE, async (payload, callback) => {
    const requestId = socket.data.connectionId;
    try {
      const allowed = await allowSocketEvent(
        socket.data.userId,
        SOCKET_EVENTS.CAFE_UNSUBSCRIBE,
        60,
        60_000,
      );
      if (!allowed) {
        sendAck(callback, {
          ok: false,
          code: "RATE_LIMITED",
          message: "Too many cafe unsubscribe requests",
          requestId,
        });
        return;
      }

      const parsed = validateSocketPayload(cafeSubscriptionSchema, payload);
      if (!parsed.ok) {
        sendAck(callback, {
          ok: false,
          code: "VALIDATION_ERROR",
          message: parsed.message,
          requestId,
        });
        return;
      }

      const room = ROOMS.cafe(parsed.data.cafeId);
      await socket.leave(room);
      if (parsed.data.cafeId !== socket.data.cafeId) {
        await socket.leave(ROOMS.cafePrivate(parsed.data.cafeId));
      }
      logger.debug("[socket] Left cafe room", {
        userId: socket.data.userId,
        cafeId: parsed.data.cafeId,
        room,
      });
      sendAck(callback, {
        ok: true,
        data: { room, cafeId: parsed.data.cafeId },
        requestId,
      });
    } catch (err) {
      logger.warn("[socket] cafe:unsubscribe error", {
        socketId: socket.id,
        userId: socket.data.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendAck(callback, {
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Unable to unsubscribe from cafe",
        requestId,
      });
    }
  });
};
