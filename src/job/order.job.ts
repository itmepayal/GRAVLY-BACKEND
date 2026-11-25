import { Order } from "../models/order.model.js";
import { Payment } from "../models/payment.model.js";
import { runWithOptionalTransaction } from "../config/db.config.js";
import { releaseStock } from "../service/order.service.js";
import { syncLatestPayment } from "../service/payment.service.js";
import logger from "../config/logger.config.js";
import { emitOrderEvent } from "../socket/index.js";
import { invalidatePublicMenuCaches } from "../service/cafe.service.js";

export interface ExpireUnpaidOrdersResult {
  scanned: number;
  expired: number;
  skipped: number;
  failed: number;
}

/* =====================================================
   CANCEL UNPAID ONLINE ORDERS
===================================================== */
export const expireUnpaidOrders = async (
  minutes = 20,
): Promise<ExpireUnpaidOrdersResult> => {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);

  const orders = await Order.find({
    paymentMethod: "online",
    paymentStatus: "pending",
    status: "pending",
    createdAt: { $lt: cutoff },
  })
    .select("_id")
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  let expired = 0;
  let skipped = 0;
  let failed = 0;

  const workerConcurrency = 5;
  for (let offset = 0; offset < orders.length; offset += workerConcurrency) {
    const batch = orders.slice(offset, offset + workerConcurrency);
    await Promise.all(
      batch.map(async (order) => {
        try {
          await syncLatestPayment(order._id);

          const cancelled = await runWithOptionalTransaction(async (txSession) => {
            const sessionOpt = txSession ? { session: txSession } : {};
            const doc = await Order.findOneAndUpdate(
              { _id: order._id, status: "pending", paymentStatus: "pending" },
              {
                $set: {
                  status: "cancelled",
                  paymentStatus: "failed",
                  completedAt: new Date(),
                },
              },
              { new: true, ...sessionOpt },
            );
            if (!doc) return null;

            await releaseStock(doc.items, txSession);
            await Payment.updateMany(
              { order: doc._id, status: "pending" },
              { $set: { status: "failed" } },
              sessionOpt,
            );
            return doc;
          });

          if (!cancelled) {
            skipped += 1;
            return;
          }

          expired += 1;
          await invalidatePublicMenuCaches(String(cancelled.cafe));

          emitOrderEvent({
            orderId: String(cancelled._id),
            orderNumber: cancelled.orderNumber,
            cafeId: String(cancelled.cafe),
            studentId: String(cancelled.student),
            status: cancelled.status,
            paymentStatus: cancelled.paymentStatus,
            paymentMethod: cancelled.paymentMethod,
            totalAmount: cancelled.totalAmount,
            rejectionReason: cancelled.rejectionReason ?? null,
            updatedAt: cancelled.updatedAt?.toISOString(),
          });
        } catch (err) {
          failed += 1;
          logger.error("[job] expire order failed", {
            orderId: String(order._id),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  return {
    scanned: orders.length,
    expired,
    skipped,
    failed,
  };
};
