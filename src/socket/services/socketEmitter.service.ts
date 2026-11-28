import crypto from "crypto";
import logger from "../../config/logger.config.js";
import { SOCKET_EVENTS } from "../socket.events.js";
import { ROOMS } from "../rooms/room.constants.js";
import type {
  AppSocketServer,
  CafeApprovalEventPayload,
  CafeMenuEventPayload,
  CafeOpenStatusEventPayload,
  CafeProfileEventPayload,
  CartEventPayload,
  OrderEventPayload,
  PaymentEventPayload,
} from "../socket.types.js";
import type { OrderStatus } from "../../models/order.model.js";

const socketServers = new Set<AppSocketServer>();

export const registerSocketServer = (io: AppSocketServer): void => {
  socketServers.add(io);
};

export const unregisterSocketServer = (io: AppSocketServer): void => {
  socketServers.delete(io);
};

export const getSocketServers = (): AppSocketServer[] => {
  return Array.from(socketServers);
};

const primaryServer = (): AppSocketServer | undefined => {
  for (const srv of socketServers) return srv;
  return undefined;
};

const ORDER_STATUS_EVENT_MAP: Record<
  OrderStatus,
  | typeof SOCKET_EVENTS.ORDER_CREATED
  | typeof SOCKET_EVENTS.ORDER_CONFIRMED
  | typeof SOCKET_EVENTS.ORDER_PREPARING
  | typeof SOCKET_EVENTS.ORDER_READY
  | typeof SOCKET_EVENTS.ORDER_DELIVERED
  | typeof SOCKET_EVENTS.ORDER_CANCELLED
  | typeof SOCKET_EVENTS.ORDER_REJECTED
> = {
  pending: SOCKET_EVENTS.ORDER_CREATED,
  confirmed: SOCKET_EVENTS.ORDER_CONFIRMED,
  preparing: SOCKET_EVENTS.ORDER_PREPARING,
  ready: SOCKET_EVENTS.ORDER_READY,
  delivered: SOCKET_EVENTS.ORDER_DELIVERED,
  cancelled: SOCKET_EVENTS.ORDER_CANCELLED,
  rejected: SOCKET_EVENTS.ORDER_REJECTED,
};

export const emitOrderEvent = (
  input: Omit<OrderEventPayload, "eventId" | "emittedAt">,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: OrderEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    const isUnpaidPendingOnlineOrder =
      payload.status === "pending" &&
      payload.paymentMethod === "online" &&
      payload.paymentStatus === "pending";

    const targets = [
      ROOMS.order(payload.orderId),
      ROOMS.student(payload.studentId),
      ...(!isUnpaidPendingOnlineOrder ? [ROOMS.cafePrivate(payload.cafeId)] : []),
      ROOMS.admin(),
    ];

    const specificEvent = ORDER_STATUS_EVENT_MAP[payload.status];
    io.to(targets).emit(specificEvent, payload);
    io.to(targets).emit(SOCKET_EVENTS.ORDER_STATUS_CHANGED, payload);
  } catch (err) {
    logger.warn("[socket] Failed emitting order event", {
      orderId: input.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const emitOrderCreatedToCafe = (
  input: Omit<OrderEventPayload, "eventId" | "emittedAt">,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: OrderEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    const targets = [ROOMS.cafePrivate(payload.cafeId)];
    io.to(targets).emit(SOCKET_EVENTS.ORDER_CREATED, payload);
    io.to(targets).emit(SOCKET_EVENTS.ORDER_STATUS_CHANGED, payload);
  } catch (err) {
    logger.warn("[socket] Failed emitting cafe paid order notification", {
      orderId: input.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

const PAYMENT_STATUS_EVENT_MAP: Record<
  PaymentEventPayload["status"],
  | typeof SOCKET_EVENTS.PAYMENT_INITIATED
  | typeof SOCKET_EVENTS.PAYMENT_SUCCESS
  | typeof SOCKET_EVENTS.PAYMENT_FAILED
  | typeof SOCKET_EVENTS.PAYMENT_REFUNDED
> = {
  pending: SOCKET_EVENTS.PAYMENT_INITIATED,
  success: SOCKET_EVENTS.PAYMENT_SUCCESS,
  failed: SOCKET_EVENTS.PAYMENT_FAILED,
  refunded: SOCKET_EVENTS.PAYMENT_REFUNDED,
};

export const emitPaymentEvent = (
  input: Omit<PaymentEventPayload, "eventId" | "emittedAt"> & {
    processing?: boolean;
  },
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const { processing, ...rest } = input;
    const payload: PaymentEventPayload = {
      ...rest,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    const targets = [
      ROOMS.order(payload.orderId),
      ROOMS.student(payload.studentId),
      ROOMS.cafePrivate(payload.cafeId),
      ROOMS.admin(),
    ];

    const specificEvent = processing
      ? SOCKET_EVENTS.PAYMENT_PROCESSING
      : PAYMENT_STATUS_EVENT_MAP[payload.status];
    io.to(targets).emit(specificEvent, payload);
    io.to(targets).emit(SOCKET_EVENTS.PAYMENT_STATUS_UPDATED, payload);
  } catch (err) {
    logger.warn("[socket] Failed emitting payment event", {
      paymentId: input.paymentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const emitCafeApprovalEvent = (
  input: Omit<CafeApprovalEventPayload, "eventId" | "emittedAt">,
  ownerUserId: string,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: CafeApprovalEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    io.to([ROOMS.user(ownerUserId), ROOMS.admin()]).emit(
      SOCKET_EVENTS.CAFE_APPROVAL_UPDATED,
      payload,
    );
  } catch (err) {
    logger.warn("[socket] Failed emitting cafe approval event", {
      cafeId: input.cafeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const emitCafeOpenStatusEvent = (
  input: Omit<CafeOpenStatusEventPayload, "eventId" | "emittedAt">,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: CafeOpenStatusEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    io.to([
      ROOMS.cafe(payload.cafeId),
      ROOMS.cafePrivate(payload.cafeId),
      ROOMS.admin(),
    ]).emit(
      SOCKET_EVENTS.CAFE_OPEN_STATUS_CHANGED,
      payload,
    );
  } catch (err) {
    logger.warn("[socket] Failed emitting cafe open status event", {
      cafeId: input.cafeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const emitCafeProfileEvent = (
  input: Omit<CafeProfileEventPayload, "eventId" | "emittedAt">,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: CafeProfileEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    io.to([
      ROOMS.cafe(payload.cafeId),
      ROOMS.cafePrivate(payload.cafeId),
      ROOMS.admin(),
    ]).emit(
      SOCKET_EVENTS.CAFE_PROFILE_UPDATED,
      payload,
    );
  } catch (err) {
    logger.warn("[socket] Failed emitting cafe profile event", {
      cafeId: input.cafeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const emitCafeMenuUpdatedEvent = (
  input: Omit<CafeMenuEventPayload, "eventId" | "emittedAt">,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: CafeMenuEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    io.to([
      ROOMS.cafe(payload.cafeId),
      ROOMS.cafePrivate(payload.cafeId),
    ]).emit(SOCKET_EVENTS.CAFE_MENU_UPDATED, payload);
  } catch (err) {
    logger.warn("[socket] Failed emitting cafe menu update event", {
      cafeId: input.cafeId,
      menuItemId: input.menuItemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const emitCartEvent = (
  input: Omit<CartEventPayload, "eventId" | "emittedAt">,
  legacyUserId?: string,
): void => {
  const io = primaryServer();
  if (!io) return;

  try {
    const payload: CartEventPayload = {
      ...input,
      eventId: crypto.randomUUID(),
      emittedAt: new Date().toISOString(),
    };

    const targets = [
      ROOMS.student(payload.studentId),
      ...(legacyUserId ? [ROOMS.user(legacyUserId)] : []),
    ];

    io.to(targets).emit(SOCKET_EVENTS.CART_UPDATED, payload);
    if (payload.action === "cleared") {
      io.to(targets).emit(SOCKET_EVENTS.CART_CLEARED, payload);
    }
  } catch (err) {
    logger.warn("[socket] Failed emitting cart event", {
      studentId: input.studentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
