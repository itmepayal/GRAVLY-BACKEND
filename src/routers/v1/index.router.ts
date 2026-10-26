import express from "express";

import authRoutes from "./auth.router.js";
import cafeRoutes from "./cafe.router.js";
import menuRoutes from "./menu.router.js";
import cartRoutes from "./cart.router.js";
import orderRoutes from "./order.router.js";
import paymentRoutes from "./payment.router.js";
import adminRoutes from "./admin.router.js";

const v1Router = express.Router();

v1Router.use("/auth", authRoutes);
v1Router.use("/cafes", cafeRoutes);
v1Router.use("/menu", menuRoutes);
v1Router.use("/cart", cartRoutes);
v1Router.use("/orders", orderRoutes);
v1Router.use("/payments", paymentRoutes);
v1Router.use("/admin", adminRoutes);

export default v1Router;
