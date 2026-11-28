import { z } from "zod";

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

export const objectIdSchema = z
  .string()
  .trim()
  .regex(OBJECT_ID_REGEX, "Invalid ObjectId format");

export const orderSubscriptionSchema = z
  .object({
    orderId: objectIdSchema,
  })
  .strict();

export const cafeSubscriptionSchema = z
  .object({
    cafeId: objectIdSchema,
  })
  .strict();

export const authRefreshSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(10, "Access token is required")
      .max(4096, "Access token exceeds maximum length"),
  })
  .strict();

export type OrderSubscriptionInput = z.infer<typeof orderSubscriptionSchema>;
export type CafeSubscriptionInput = z.infer<typeof cafeSubscriptionSchema>;
export type AuthRefreshInput = z.infer<typeof authRefreshSchema>;

export const validateSocketPayload = <T>(
  schema: z.ZodType<T>,
  payload: unknown,
): { ok: true; data: T } | { ok: false; message: string } => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: issue
        ? `${issue.path.join(".") || "payload"}: ${issue.message}`
        : "Invalid event payload",
    };
  }
  return { ok: true, data: parsed.data };
};
