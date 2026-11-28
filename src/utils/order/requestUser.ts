import { Request } from "express";

import { Cafe } from "../../models/cafe.model.js";
import { Student } from "../../models/student.model.js";
import { NotFoundError, UnauthorizedError } from "../errors/app.error.js";
import {
  REDIS_TTLS,
  isRedisAvailable,
  redisDel,
  redisGet,
  redisKeys,
  redisSet,
} from "../../infrastructure/redis/index.js";

type AuthUser = { id?: string; _id?: string; userId?: string; role?: string };

const MAX_LOCAL_IDENTITY_ENTRIES = 10_000;
const LOCAL_IDENTITY_TTL_MS = 60_000;

interface CachedIdentityEntry {
  id: string;
  expiresAt: number;
}

const localStudentByUser = new Map<string, CachedIdentityEntry>();
const localCafeByUser = new Map<string, CachedIdentityEntry>();
const inFlightStudentLookups = new Map<string, Promise<string | undefined>>();
const inFlightCafeLookups = new Map<string, Promise<string | undefined>>();

const setBoundedIdentity = (
  map: Map<string, CachedIdentityEntry>,
  userId: string,
  id: string,
): void => {
  if (map.size >= MAX_LOCAL_IDENTITY_ENTRIES && !map.has(userId)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(userId, { id, expiresAt: Date.now() + LOCAL_IDENTITY_TTL_MS });
};

const identitySweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of localStudentByUser.entries()) {
    if (now >= v.expiresAt) localStudentByUser.delete(k);
  }
  for (const [k, v] of localCafeByUser.entries()) {
    if (now >= v.expiresAt) localCafeByUser.delete(k);
  }
}, 60_000);
if (identitySweepInterval.unref) identitySweepInterval.unref();

const authUser = (req: Request): AuthUser | undefined =>
  (req as Request & { user?: AuthUser }).user;

export const userIdOf = (req: Request): string => {
  const u = authUser(req);
  const id = u?.id ?? u?._id ?? u?.userId;
  if (!id) throw new UnauthorizedError("Unauthorized");
  return String(id);
};

export const roleOf = (req: Request): string | undefined => authUser(req)?.role;

export const invalidateCafeIdCache = async (ownerId: string): Promise<void> => {
  localCafeByUser.delete(ownerId);
  if (isRedisAvailable()) {
    await redisDel(redisKeys.cafeIdByUser(ownerId)).catch(() => {});
  }
};

export const invalidateStudentIdCache = async (
  userId: string,
): Promise<void> => {
  localStudentByUser.delete(userId);
  if (isRedisAvailable()) {
    await redisDel(redisKeys.studentIdByUser(userId)).catch(() => {});
  }
};

export const resolveOptionalCafeIdByUserId = async (
  userId: string,
): Promise<string | undefined> => {
  const now = Date.now();
  const local = localCafeByUser.get(userId);
  if (local && now < local.expiresAt) {
    return local.id;
  }

  const inFlight = inFlightCafeLookups.get(userId);
  if (inFlight) return inFlight;

  const work = (async (): Promise<string | undefined> => {
    if (isRedisAvailable()) {
      try {
        const cached = await redisGet(redisKeys.cafeIdByUser(userId));
        if (cached && /^[a-f\d]{24}$/i.test(cached)) {
          setBoundedIdentity(localCafeByUser, userId, cached);
          return cached;
        }
      } catch {
        // Fall through to DB
      }
    }

    const cafe = await Cafe.findOne({ owner: userId }).select("_id").lean();
    if (!cafe) return undefined;

    const cafeId = String(cafe._id);
    setBoundedIdentity(localCafeByUser, userId, cafeId);
    if (isRedisAvailable()) {
      await redisSet(redisKeys.cafeIdByUser(userId), cafeId, {
        ex: REDIS_TTLS.IDENTITY_MAPPING_SEC,
      }).catch(() => {});
    }
    return cafeId;
  })().finally(() => {
    inFlightCafeLookups.delete(userId);
  });

  inFlightCafeLookups.set(userId, work);
  return work;
};

export const resolveOptionalStudentIdByUserId = async (
  userId: string,
): Promise<string | undefined> => {
  const now = Date.now();
  const local = localStudentByUser.get(userId);
  if (local && now < local.expiresAt) {
    return local.id;
  }

  const inFlight = inFlightStudentLookups.get(userId);
  if (inFlight) return inFlight;

  const work = (async (): Promise<string | undefined> => {
    if (isRedisAvailable()) {
      try {
        const cached = await redisGet(redisKeys.studentIdByUser(userId));
        if (cached && /^[a-f\d]{24}$/i.test(cached)) {
          setBoundedIdentity(localStudentByUser, userId, cached);
          return cached;
        }
      } catch {
        // Fall through to DB
      }
    }

    const student = await Student.findOne({ user: userId }).select("_id").lean();
    if (!student) return undefined;

    const studentId = String(student._id);
    setBoundedIdentity(localStudentByUser, userId, studentId);
    if (isRedisAvailable()) {
      await redisSet(redisKeys.studentIdByUser(userId), studentId, {
        ex: REDIS_TTLS.IDENTITY_MAPPING_SEC,
      }).catch(() => {});
    }
    return studentId;
  })().finally(() => {
    inFlightStudentLookups.delete(userId);
  });

  inFlightStudentLookups.set(userId, work);
  return work;
};

export const cafeIdOf = async (req: Request): Promise<string> => {
  const cafeId = await resolveOptionalCafeIdByUserId(userIdOf(req));
  if (!cafeId) throw new NotFoundError("Cafe not found for this owner");
  return cafeId;
};

export const resolveStudentIdByUserId = async (
  userId: string,
): Promise<string> => {
  const studentId = await resolveOptionalStudentIdByUserId(userId);
  if (!studentId) throw new NotFoundError("Student profile not found");
  return studentId;
};

export const studentIdOf = async (req: Request): Promise<string> => {
  return resolveStudentIdByUserId(userIdOf(req));
};

export const studentIdentityOf = async (
  req: Request,
): Promise<{ studentId: string; userId: string }> => {
  const userId = userIdOf(req);
  const studentId = await resolveStudentIdByUserId(userId);
  return { studentId, userId };
};
