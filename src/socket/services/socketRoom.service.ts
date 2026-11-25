import { Order } from "../../models/order.model.js";
import { Cafe } from "../../models/cafe.model.js";
import { Student } from "../../models/student.model.js";
import type { AppSocket, SocketAck } from "../socket.types.js";
import { ROOMS } from "../rooms/room.constants.js";

/**
 * Join immutable identity rooms derived exclusively from verified auth claims.
 */
export const joinDefaultIdentityRooms = async (
  socket: AppSocket,
): Promise<void> => {
  const rooms: string[] = [ROOMS.user(socket.data.userId)];

  if (socket.data.sid) {
    rooms.push(ROOMS.session(socket.data.sid));
  }
  if (socket.data.studentId) {
    rooms.push(ROOMS.student(socket.data.studentId));
  }
  if (socket.data.cafeId) {
    rooms.push(ROOMS.cafe(socket.data.cafeId));
    rooms.push(ROOMS.cafePrivate(socket.data.cafeId));
  }
  if (socket.data.role === "admin") {
    rooms.push(ROOMS.admin());
  }

  await socket.join(rooms);
};

/**
 * Authorize & subscribe a socket to an individual Order room.
 */
export const authorizeAndJoinOrderRoom = async (
  socket: AppSocket,
  orderId: string,
): Promise<SocketAck<{ room: string; orderId: string }>> => {
  const { userId, role, connectionId } = socket.data;
  let { studentId, cafeId } = socket.data;

  const order = await Order.findById(orderId).select("student cafe").lean();
  if (!order) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Order not found",
      requestId: connectionId,
    };
  }

  let authorized = false;
  if (role === "admin") {
    authorized = true;
  } else if (role === "student") {
    if (!studentId) {
      const studentDoc = await Student.findOne({ user: userId })
        .select("_id")
        .lean();
      if (studentDoc) {
        studentId = String(studentDoc._id);
        socket.data.studentId = studentId;
        await socket.join(ROOMS.student(studentId));
      }
    }
    const orderStudentStr = String(order.student);
    authorized =
      (Boolean(studentId) && orderStudentStr === studentId) ||
      orderStudentStr === userId; // Legacy User._id compatibility
  } else if (role === "cafeOwner") {
    if (!cafeId) {
      const cafeDoc = await Cafe.findOne({ owner: userId })
        .select("_id")
        .lean();
      if (cafeDoc) {
        cafeId = String(cafeDoc._id);
        socket.data.cafeId = cafeId;
        await socket.join([ROOMS.cafe(cafeId), ROOMS.cafePrivate(cafeId)]);
      }
    }
    authorized = Boolean(cafeId) && String(order.cafe) === cafeId;
  }

  if (!authorized) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Not authorized to subscribe to this order",
      requestId: connectionId,
    };
  }

  const room = ROOMS.order(orderId);
  await socket.join(room);
  return { ok: true, data: { room, orderId }, requestId: connectionId };
};

/**
 * Authorize & subscribe a socket to a Cafe room.
 * Approved visible cafes are subscribable by authenticated users for live public open/profile updates
 * (`ROOMS.cafe`), whereas private order/payment events are strictly restricted to `ROOMS.cafePrivate`
 * joined only by the owning cafeOwner or admin.
 */
export const authorizeAndJoinCafeRoom = async (
  socket: AppSocket,
  cafeId: string,
): Promise<SocketAck<{ room: string; cafeId: string }>> => {
  const { userId, role, connectionId } = socket.data;

  const cafe = await Cafe.findById(cafeId)
    .select("owner approvalStatus isApproved isVisible isActive")
    .lean();
  if (!cafe) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Cafe not found",
      requestId: connectionId,
    };
  }

  const isOwner = role === "cafeOwner" && String(cafe.owner) === userId;
  const isAdmin = role === "admin";
  const isPubliclyVisible =
    cafe.isApproved &&
    cafe.approvalStatus === "approved" &&
    cafe.isVisible &&
    cafe.isActive;

  if (!isOwner && !isAdmin && !isPubliclyVisible) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Not authorized to subscribe to this cafe",
      requestId: connectionId,
    };
  }

  const room = ROOMS.cafe(cafeId);
  if (isOwner || isAdmin) {
    await socket.join([room, ROOMS.cafePrivate(cafeId)]);
  } else {
    await socket.join(room);
  }
  return { ok: true, data: { room, cafeId }, requestId: connectionId };
};
