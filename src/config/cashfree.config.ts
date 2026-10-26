import crypto from "crypto";
import { serverConfig } from ".";

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
      return_url: `${process.env.CLIENT_URL}/order/status?order_id={order_id}`,
      notify_url: `${serverConfig.SERVER_URL}/api/v1/orders/webhook/cashfree`,
    },
  };

  const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
    method: "POST",
    headers: cashfreeHeaders,
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Cashfree order creation failed");
  }

  return data;
};

export const verifyCashfreeOrder = async (cfOrderId: string) => {
  const response = await fetch(`${CASHFREE_BASE_URL}/orders/${cfOrderId}`, {
    method: "GET",
    headers: cashfreeHeaders,
  });

  return await response.json();
};

export const verifyCashfreeWebhookSignature = (
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean => {
  const signedPayload = timestamp + rawBody;

  const expectedSignature = crypto
    .createHmac("sha256", serverConfig.CASHFREE_SECRET_KEY!)
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
  const response = await fetch(
    `${CASHFREE_BASE_URL}/orders/${encodeURIComponent(payload.orderId)}/refunds`,
    {
      method: "POST",
      headers: {
        ...cashfreeHeaders,
        "x-idempotency-key": payload.refundId,
      },
      body: JSON.stringify({
        refund_amount: payload.refundAmount,
        refund_id: payload.refundId,
        refund_note: payload.refundNote ?? "Order refund",
        refund_speed: "STANDARD",
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Cashfree refund creation failed");
  }

  return data;
};
