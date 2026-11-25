export const SOCKET_EVENTS = {
  AUTH_REFRESH: "auth:refresh",
  AUTH_REVOKED: "auth:revoked",
  AUTH_ERROR: "auth:error",

  ORDER_SUBSCRIBE: "order:subscribe",
  ORDER_UNSUBSCRIBE: "order:unsubscribe",
  ORDER_CREATED: "order:created",
  ORDER_CONFIRMED: "order:confirmed",
  ORDER_PREPARING: "order:preparing",
  ORDER_READY: "order:ready",
  ORDER_DELIVERED: "order:delivered",
  ORDER_CANCELLED: "order:cancelled",
  ORDER_REJECTED: "order:rejected",
  ORDER_STATUS_CHANGED: "order:status_changed",

  PAYMENT_INITIATED: "payment:initiated",
  PAYMENT_PROCESSING: "payment:processing",
  PAYMENT_SUCCESS: "payment:success",
  PAYMENT_FAILED: "payment:failed",
  PAYMENT_REFUNDED: "payment:refunded",
  PAYMENT_STATUS_UPDATED: "payment:status_updated",

  CAFE_SUBSCRIBE: "cafe:subscribe",
  CAFE_UNSUBSCRIBE: "cafe:unsubscribe",
  CAFE_APPROVAL_UPDATED: "cafe:approval_updated",
  CAFE_OPEN_STATUS_CHANGED: "cafe:open_status_changed",
  CAFE_PROFILE_UPDATED: "cafe:profile_updated",
} as const;

export type SocketEventName =
  (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
