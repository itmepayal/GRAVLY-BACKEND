import logger from "../../config/logger.config.js";
import { SOCKET_EVENTS } from "../socket.events.js";
import { ROOMS } from "../rooms/room.constants.js";
import type { AppSocket, SocketAck } from "../socket.types.js";
import {
  orderSubscriptionSchema,
  validateSocketPayload,
} from "../validators/socket.validator.js";
import { allowSocketEvent } from "../services/socketRateLimit.service.js";
import { authorizeAndJoinOrderRoom } from "../services/socketRoom.service.js";

const sendAck = <T>(
  callback: ((ack: SocketAck<T>) => void) | undefined,
  ack: SocketAck<T>,
): void => {
  if (typeof callback === "function") callback(ack);
};

const registeredOrderSockets = new WeakSet<AppSocket>();

export const registerOrderHandlers = (socket: AppSocket): void => {
  if (registeredOrderSockets.has(socket)) return;
  registeredOrderSockets.add(socket);

  socket.on(SOCKET_EVENTS.ORDER_SUBSCRIBE, async (payload, callback) => {
    const requestId = socket.data.connectionId;
    try {
      const allowed = await allowSocketEvent(
        socket.data.userId,
        SOCKET_EVENTS.ORDER_SUBSCRIBE,
        30,
        60_000,
      );
      if (!allowed) {
        sendAck(callback, {
          ok: false,
          code: "RATE_LIMITED",
          message: "Too many order subscribe requests",
          requestId,
        });
        return;
      }

      const parsed = validateSocketPayload(orderSubscriptionSchema, payload);
      if (!parsed.ok) {
        sendAck(callback, {
          ok: false,
          code: "VALIDATION_ERROR",
          message: parsed.message,
          requestId,
        });
        return;
      }

      const result = await authorizeAndJoinOrderRoom(
        socket,
        parsed.data.orderId,
      );
      sendAck(callback, result);
    } catch (err) {
      logger.warn("[socket] order:subscribe error", {
        socketId: socket.id,
        userId: socket.data.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendAck(callback, {
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Unable to subscribe to order",
        requestId,
      });
    }
  });

  socket.on(SOCKET_EVENTS.ORDER_UNSUBSCRIBE, async (payload, callback) => {
    const requestId = socket.data.connectionId;
    try {
      const allowed = await allowSocketEvent(
        socket.data.userId,
        SOCKET_EVENTS.ORDER_UNSUBSCRIBE,
        60,
        60_000,
      );
      if (!allowed) {
        sendAck(callback, {
          ok: false,
          code: "RATE_LIMITED",
          message: "Too many order unsubscribe requests",
          requestId,
        });
        return;
      }

      const parsed = validateSocketPayload(orderSubscriptionSchema, payload);
      if (!parsed.ok) {
        sendAck(callback, {
          ok: false,
          code: "VALIDATION_ERROR",
          message: parsed.message,
          requestId,
        });
        return;
      }

      const room = ROOMS.order(parsed.data.orderId);
      await socket.leave(room);
      logger.debug("[socket] Left order room", {
        userId: socket.data.userId,
        orderId: parsed.data.orderId,
        room,
      });
      sendAck(callback, {
        ok: true,
        data: { room, orderId: parsed.data.orderId },
        requestId,
      });
    } catch (err) {
      logger.warn("[socket] order:unsubscribe error", {
        socketId: socket.id,
        userId: socket.data.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendAck(callback, {
        ok: false,
        code: "INTERNAL_ERROR",
        message: "Unable to unsubscribe from order",
        requestId,
      });
    }
  });
};
