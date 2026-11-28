import multer, { FileFilterCallback, MulterError } from "multer";
import type {
  Request,
  Response,
  NextFunction,
  RequestHandler,
  ErrorRequestHandler,
} from "express";

import logger from "../config/logger.config.js";
import { BadRequestError } from "../utils/errors/app.error.js";

/* =====================================================
   CONFIG
===================================================== */

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 16;

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMime = (typeof ALLOWED_MIME_TYPES)[number];

/* =====================================================
   MAGIC-BYTE IMAGE SIGNATURE VALIDATION
===================================================== */
export const detectImageMimeFromMagicBytes = (
  buffer: Buffer,
): AllowedImageMime | null => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WEBP: "RIFF" <4 bytes size> "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

export const assertValidImageMagicBytes = (
  buffer: Buffer,
  declaredMime?: string,
): AllowedImageMime => {
  const detected = detectImageMimeFromMagicBytes(buffer);
  if (!detected) {
    throw new BadRequestError(
      "Invalid image file content. Only valid JPG, PNG, and WEBP images are allowed",
    );
  }

  if (declaredMime && declaredMime !== detected) {
    throw new BadRequestError(
      "Uploaded file signature does not match the declared image MIME type",
    );
  }

  return detected;
};

/* =====================================================
   FILE FILTER (MIME pre-check before buffering completes)
===================================================== */
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype as AllowedImageMime)) {
    cb(new BadRequestError("Only JPG, PNG and WEBP images are allowed"));
    return;
  }

  cb(null, true);
};

/* =====================================================
   MULTER INSTANCE
===================================================== */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
  fileFilter,
});

/* =====================================================
   POST-MULTER MAGIC-BYTE BUFFER VALIDATION MIDDLEWARE
===================================================== */
export const validateUploadedImagesMiddleware: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  try {
    if (req.file) {
      assertValidImageMagicBytes(req.file.buffer, req.file.mimetype);
    }

    if (req.files) {
      const allFiles = Array.isArray(req.files)
        ? req.files
        : Object.values(req.files).flat();

      for (const file of allFiles) {
        assertValidImageMagicBytes(file.buffer, file.mimetype);
      }
    }

    next();
  } catch (err) {
    logger.warn("[upload] Uploaded image validation failed", {
      userId: req.user?._id ? String(req.user._id) : undefined,
      route: req.originalUrl.split("?")[0],
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
};

/* =====================================================
   MULTER ERROR HANDLER
===================================================== */
export const multerErrorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (err instanceof MulterError) {
    logger.warn("[upload] Multer upload rejected", {
      code: err.code,
      field: err.field,
      userId: req.user?._id ? String(req.user._id) : undefined,
      route: req.originalUrl.split("?")[0],
    });
    const messages: Record<string, string> = {
      LIMIT_FILE_SIZE: "File too large. Maximum size is 5 MB per file",
      LIMIT_FILE_COUNT: `Too many files. Maximum ${MAX_FILES} files allowed`,
      LIMIT_UNEXPECTED_FILE: `Unexpected file field: ${err.field ?? "unknown"}`,
    };

    next(new BadRequestError(messages[err.code] ?? err.message));
    return;
  }

  next(err);
};
