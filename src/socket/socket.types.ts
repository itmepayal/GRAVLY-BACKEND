import type { Server, Socket } from "socket.io";
import type { UserRole } from "../models/user.model.js";
import type { OrderStatus } from "../models/order.model.js";
import type { CafeApprovalStatus } from "../models/cafe.model.js";
import type { SOCKET_EVENTS } from "./socket.events.js";

export type SocketAck<T = unknown> =
  | {
      ok: true;
      data?: T;
      requestId?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      requestId?: string;
    };

export interface AuthRevokedPayload {
  eventId: string;
  reason: string;
  sessionId?: string;
  emittedAt: string;
}

export interface AuthErrorPayload {
  code: string;
  message: string;
}

export interface OrderEventPayload {
  eventId: string;
  orderId: string;
  orderNumber: string;
  cafeId: string;
  studentId: string;
  status: OrderStatus;
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
  paymentMethod: "online" | "cash";
  totalAmount: number;
  rejectionReason?: string | null;
  emittedAt: string;
  updatedAt?: string;
}

export interface PaymentEventPayload {
  eventId: string;
  paymentId: string;
  orderId: string;
  cafeId: string;
  studentId: string;
  status: "pending" | "success" | "failed" | "refunded";
  orderPaymentStatus: "pending" | "paid" | "failed" | "refunded";
  method: "card" | "upi" | "wallet" | "cashfree" | "cash";
  amount: number;
  emittedAt: string;
}

export interface CafeApprovalEventPayload {
  eventId: string;
  cafeId: string;
  name: string;
  approvalStatus: CafeApprovalStatus;
  isApproved: boolean;
  rejectionReason?: string | null;
  emittedAt: string;
}

export interface CafeOpenStatusEventPayload {
  eventId: string;
  cafeId: string;
  name: string;
  isOpen: boolean;
  emittedAt: string;
}

export interface CafeProfileEventPayload {
  eventId: string;
  cafeId: string;
  name: string;
  emittedAt: string;
}

export interface ClientToServerEvents {
  [SOCKET_EVENTS.AUTH_REFRESH]: (
    payload: unknown,
    callback?: (ack: SocketAck<{ expiresAt?: string }>) => void,
  ) => void;
  [SOCKET_EVENTS.ORDER_SUBSCRIBE]: (
    payload: unknown,
    callback?: (ack: SocketAck<{ room: string; orderId: string }>) => void,
  ) => void;
  [SOCKET_EVENTS.ORDER_UNSUBSCRIBE]: (
    payload: unknown,
    callback?: (ack: SocketAck<{ room: string; orderId: string }>) => void,
  ) => void;
  [SOCKET_EVENTS.CAFE_SUBSCRIBE]: (
    payload: unknown,
    callback?: (ack: SocketAck<{ room: string; cafeId: string }>) => void,
  ) => void;
  [SOCKET_EVENTS.CAFE_UNSUBSCRIBE]: (
    payload: unknown,
    callback?: (ack: SocketAck<{ room: string; cafeId: string }>) => void,
  ) => void;
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.AUTH_REVOKED]: (payload: AuthRevokedPayload) => void;
  [SOCKET_EVENTS.AUTH_ERROR]: (payload: AuthErrorPayload) => void;
  [SOCKET_EVENTS.ORDER_CREATED]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_CONFIRMED]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_PREPARING]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_READY]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_DELIVERED]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_CANCELLED]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_REJECTED]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.ORDER_STATUS_CHANGED]: (payload: OrderEventPayload) => void;
  [SOCKET_EVENTS.PAYMENT_INITIATED]: (payload: PaymentEventPayload) => void;
  [SOCKET_EVENTS.PAYMENT_PROCESSING]: (payload: PaymentEventPayload) => void;
  [SOCKET_EVENTS.PAYMENT_SUCCESS]: (payload: PaymentEventPayload) => void;
  [SOCKET_EVENTS.PAYMENT_FAILED]: (payload: PaymentEventPayload) => void;
  [SOCKET_EVENTS.PAYMENT_REFUNDED]: (payload: PaymentEventPayload) => void;
  [SOCKET_EVENTS.PAYMENT_STATUS_UPDATED]: (
    payload: PaymentEventPayload,
  ) => void;
  [SOCKET_EVENTS.CAFE_APPROVAL_UPDATED]: (
    payload: CafeApprovalEventPayload,
  ) => void;
  [SOCKET_EVENTS.CAFE_OPEN_STATUS_CHANGED]: (
    payload: CafeOpenStatusEventPayload,
  ) => void;
  [SOCKET_EVENTS.CAFE_PROFILE_UPDATED]: (
    payload: CafeProfileEventPayload,
  ) => void;
}

export interface InterServerEvents {
  ping?: () => void;
}

export interface SocketData {
  userId: string;
  role: UserRole;
  sid?: string;
  jti?: string;
  tv: number;
  exp?: number;
  studentId?: string;
  cafeId?: string;
  connectedAt: string;
  connectionId: string;
  ip: string;
}

export type AppSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
