import crypto from "crypto";
import { serverConfig } from "./index.js";
import { ExternalServiceError } from "../utils/errors/app.error.js";

export class CashfreeApiError extends ExternalServiceError {
  httpStatus: number;
  retryable: boolean;

  constructor(message: string, httpStatus: number, retryable: boolean) {
    super(message, retryable ? 503 : httpStatus);
    this.name = "CashfreeApiError";
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

export const CASHFREE_BASE_URL =
  serverConfig.CASHFREE_ENV === "PRODUCTION"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

export const cashfreeHeaders = {
  "Content-Type": "application/json",
  "x-api-version": "2023-08-01",
  "x-client-id": serverConfig.CASHFREE_APP_ID!,
  "x-client-secret": serverConfig.CASHFREE_SECRET_KEY!,
};

const CASHFREE_TIMEOUT_MS = 8000;
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

const fetchCashfreeJson = async (
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: Record<string, any> }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CASHFREE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const rawText = await response.text();
    let data: Record<string, any> = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText) as Record<string, any>;
      } catch {
        data = { message: `Cashfree returned non-JSON response (${response.status})` };
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    throw new ExternalServiceError(
      error instanceof Error && error.name === "AbortError"
        ? "Payment gateway request timed out"
        : "Payment gateway is temporarily unavailable",
      503,
    );
  } finally {
    clearTimeout(timer);
  }
};

export const createCashfreeOrder = async (payload: {
  orderId: string;
  amount: number;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
}) => {
  const requestBody = {
    order_id: payload.orderId,
    order_amount: payload.amount,
    order_currency: "INR",

    customer_details: {
      customer_id: payload.customerId,
      customer_name: payload.customerName,
      customer_phone: payload.customerPhone,
      customer_email: payload.customerEmail,
    },

    order_meta: {
      return_url: `${serverConfig.CLIENT_URL.replace(/\/+$/, "")}/order/status?order_id={order_id}`,
      notify_url: `${serverConfig.SERVER_URL.replace(/\/+$/, "")}/api/v1/payments/webhook`,
    },
  };

  const { ok, status, data } = await fetchCashfreeJson(`${CASHFREE_BASE_URL}/orders`, {
    method: "POST",
    headers: cashfreeHeaders,
    body: JSON.stringify(requestBody),
  });

  if (!ok) {
    const retryable = status === 429 || status >= 500;
    throw new CashfreeApiError(
      String(data?.message || "Cashfree order creation failed"),
      status,
      retryable,
    );
  }

  return data;
};

export const verifyCashfreeOrder = async (cfOrderId: string) => {
  const { ok, status, data } = await fetchCashfreeJson(
    `${CASHFREE_BASE_URL}/orders/${encodeURIComponent(cfOrderId)}`,
    {
      method: "GET",
      headers: cashfreeHeaders,
    },
  );

  if (!ok) {
    const retryable = status === 429 || status >= 500;
    throw new CashfreeApiError(
      String(data?.message || "Cashfree order verification failed"),
      status,
      retryable,
    );
  }

  return data;
};

export const verifyCashfreeWebhookSignature = (
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean => {
  if (
    !rawBody ||
    !timestamp ||
    !signature ||
    !serverConfig.CASHFREE_SECRET_KEY
  ) {
    return false;
  }

  if (!/^\d{10,13}$/.test(timestamp.trim())) {
    return false;
  }

  const rawTs = Number(timestamp.trim());
  const tsMs = timestamp.trim().length <= 10 ? rawTs * 1000 : rawTs;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > WEBHOOK_REPLAY_WINDOW_MS) {
    return false;
  }

  const signedPayload = timestamp + rawBody;

  const expectedSignature = crypto
    .createHmac("sha256", serverConfig.CASHFREE_SECRET_KEY)
    .update(signedPayload)
    .digest("base64");

  const expectedBuffer = Buffer.from(expectedSignature);
  const receivedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
};

export const createCashfreeRefund = async (payload: {
  orderId: string;
  refundAmount: number;
  refundId: string;
  refundNote?: string;
}) => {
  const { ok, status, data } = await fetchCashfreeJson(
    `${CASHFREE_BASE_URL}/orders/${encodeURIComponent(payload.orderId)}/refunds`,
    {
      method: "POST",
      headers: {
        ...cashfreeHeaders,
        "x-idempotency-key": payload.refundId,
      },
      body: JSON.stringify({
        refund_amount: Number(payload.refundAmount.toFixed(2)),
        refund_id: payload.refundId,
        refund_note: payload.refundNote ?? "Order refund",
        refund_speed: "STANDARD",
      }),
    },
  );

  if (!ok) {
    const retryable = status === 429 || status >= 500;
    throw new CashfreeApiError(
      String(data?.message || "Cashfree refund creation failed"),
      status,
      retryable,
    );
  }

  return data;
};

export const verifyCashfreeRefund = async (
  orderId: string,
  refundId: string,
) => {
  const { ok, status, data } = await fetchCashfreeJson(
    `${CASHFREE_BASE_URL}/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
    {
      method: "GET",
      headers: cashfreeHeaders,
    },
  );

  if (status === 404) {
    return null;
  }

  if (!ok) {
    const retryable = status === 429 || status >= 500;
    throw new CashfreeApiError(
      String(data?.message || "Cashfree refund status verification failed"),
      status,
      retryable,
    );
  }

  return data;
};
