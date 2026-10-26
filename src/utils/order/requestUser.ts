import { Request } from "express";

import { Cafe } from "../../models/cafe.model";
import { BadRequestError, NotFoundError } from "../errors/app.error";

type AuthUser = { id?: string; _id?: string; userId?: string; role?: string };

const authUser = (req: Request): AuthUser | undefined =>
  (req as Request & { user?: AuthUser }).user;

export const userIdOf = (req: Request): string => {
  const u = authUser(req);
  const id = u?.id ?? u?._id ?? u?.userId;
  if (!id) throw new BadRequestError("Unauthorized");
  return String(id);
};

export const roleOf = (req: Request): string | undefined => authUser(req)?.role;

export const cafeIdOf = async (req: Request): Promise<string> => {
  const cafe = await Cafe.findOne({ owner: userIdOf(req) }).select("_id");
  if (!cafe) throw new NotFoundError("Cafe not found for this owner");
  return String(cafe._id);
};
