import { Order } from "../models/order.model.js";
import { Payment } from "../models/payment.model.js";
import { releaseStock } from "../service/order.service.js";
import { syncLatestPayment } from "../service/payment.service.js";

/* =====================================================
   CANCEL UNPAID ONLINE ORDERS
===================================================== */
export const expireUnpaidOrders = async (minutes = 20) => {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);

  const orders = await Order.find({
    paymentMethod: "online",
    paymentStatus: "pending",
    status: "pending",
    createdAt: { $lt: cutoff },
  }).limit(50);

  for (const order of orders) {
    try {
      await syncLatestPayment(order._id);

      const cancelled = await Order.findOneAndUpdate(
        { _id: order._id, status: "pending", paymentStatus: "pending" },
        {
          $set: {
            status: "cancelled",
            paymentStatus: "failed",
            completedAt: new Date(),
          },
        },
        { new: true },
      );
      if (!cancelled) continue;

      await releaseStock(cancelled.items);
      await Payment.updateMany(
        { order: cancelled._id, status: "pending" },
        { $set: { status: "failed" } },
      );
    } catch (err) {
      console.error("[job] expire order failed", order._id, err);
    }
  }
};
