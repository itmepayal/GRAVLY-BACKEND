import express from "express";

import authRoutes from "./auth.router";
import cafeRoutes from "./cafe.router";
import menuRoutes from "./menu.router";
import cartRoutes from "./cart.router";
import orderRoutes from "./order.router";
import paymentRoutes from "./payment.router";
import adminRoutes from "./admin.router";

const v1Router = express.Router();

v1Router.use("/auth", authRoutes);
v1Router.use("/cafes", cafeRoutes);
v1Router.use("/menu", menuRoutes);
v1Router.use("/cart", cartRoutes);
v1Router.use("/orders", orderRoutes);
v1Router.use("/payments", paymentRoutes);
v1Router.use("/admin", adminRoutes);

export default v1Router;
