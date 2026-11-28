import { Types } from "mongoose";
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
  aborted: boolean;
}

export interface ExpireUnpaidOrdersOptions {
  minutes?: number;
  batchSize?: number;
  maxPerRun?: number;
  shouldAbort?: () => boolean;
}

/* =====================================================
   CANCEL UNPAID ONLINE ORDERS
===================================================== */
export const expireUnpaidOrders = async (
  minutesOrOptions: number | ExpireUnpaidOrdersOptions = 20,
): Promise<ExpireUnpaidOrdersResult> => {
  const opts: ExpireUnpaidOrdersOptions =
    typeof minutesOrOptions === "number"
      ? { minutes: minutesOrOptions }
      : minutesOrOptions;

  const minutes = opts.minutes ?? 20;
  const batchSize = Math.min(100, Math.max(1, opts.batchSize ?? 50));
  const maxPerRun = Math.max(batchSize, opts.maxPerRun ?? 500);
  const shouldAbort = opts.shouldAbort ?? (() => false);

  const cutoff = new Date(Date.now() - minutes * 60 * 1000);

  let scanned = 0;
  let expired = 0;
  let skipped = 0;
  let failed = 0;
  const seenOrderIds = new Set<string>();
  const workerConcurrency = 5;

  while (scanned < maxPerRun && !shouldAbort()) {
    const excludedIds = Array.from(seenOrderIds).map(
      (id) => new Types.ObjectId(id),
    );
    const remainingBudget = maxPerRun - scanned;

    const orders = await Order.find({
      ...(excludedIds.length > 0 ? { _id: { $nin: excludedIds } } : {}),
      paymentMethod: "online",
      paymentStatus: "pending",
      status: "pending",
      createdAt: { $lt: cutoff },
    })
      .select("_id")
      .sort({ createdAt: 1, _id: 1 })
      .limit(Math.min(batchSize, remainingBudget))
      .lean();

    if (orders.length === 0) {
      break;
    }

    for (const o of orders) {
      seenOrderIds.add(String(o._id));
    }
    scanned += orders.length;

    for (let offset = 0; offset < orders.length; offset += workerConcurrency) {
      if (shouldAbort()) {
        break;
      }

      const chunk = orders.slice(offset, offset + workerConcurrency);
      await Promise.all(
        chunk.map(async (order) => {
          if (shouldAbort()) {
            skipped += 1;
            return;
          }

          try {
            await syncLatestPayment(order._id);

            const cancelled = await runWithOptionalTransaction(
              async (txSession) => {
                const sessionOpt = txSession ? { session: txSession } : {};
                const doc = await Order.findOneAndUpdate(
                  {
                    _id: order._id,
                    status: "pending",
                    paymentStatus: "pending",
                    stockReleased: { $ne: true },
                  },
                  {
                    $set: {
                      status: "cancelled",
                      paymentStatus: "failed",
                      completedAt: new Date(),
                      stockReleased: true,
                    },
                  },
                  { new: true, ...sessionOpt },
                );
                if (!doc) return null;

                try {
                  await releaseStock(doc.items, txSession);
                  await Payment.updateMany(
                    { order: doc._id, status: "pending" },
                    { $set: { status: "failed" } },
                    sessionOpt,
                  );
                  return doc;
                } catch (releaseErr) {
                  if (!txSession) {
                    await Order.updateOne(
                      {
                        _id: doc._id,
                        status: "cancelled",
                        stockReleased: true,
                      },
                      {
                        $set: {
                          status: "pending",
                          paymentStatus: "pending",
                          stockReleased: false,
                        },
                        $unset: { completedAt: 1 },
                      },
                    ).catch(() => {});
                  }
                  throw releaseErr;
                }
              },
            );

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
  }

  return {
    scanned,
    expired,
    skipped,
    failed,
    aborted: shouldAbort(),
  };
};
