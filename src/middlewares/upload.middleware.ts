import multer, { FileFilterCallback, MulterError } from "multer";
import type {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
} from "express";

import { BadRequestError } from "../utils/errors/app.error.js";

/* =====================================================
   CONFIG
===================================================== */

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 16;

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

/* =====================================================
   FILE FILTER (sirf images allow)
===================================================== */
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
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
   MULTER ERROR HANDLER
===================================================== */
export const multerErrorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (err instanceof MulterError) {
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
