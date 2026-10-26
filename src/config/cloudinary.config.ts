import fs from "fs";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import type { UploadApiOptions, UploadApiResponse } from "cloudinary";

import { serverConfig } from "./index.js";
import { BadRequestError } from "../utils/errors/app.error.js";
import { logger } from "./logger.config.js";

dotenv.config();

/* =====================================================
   TYPES
===================================================== */

export type CloudinaryResourceType = "image" | "video" | "raw";

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
  resourceType: string;
  format: string;
  bytes: number;
  isPrivate: boolean;
}

export interface CloudinaryFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/* =====================================================
   CLOUDINARY CONFIGURATION
===================================================== */

cloudinary.config({
  cloud_name: serverConfig.CLOUDINARY_NAME,
  api_key: serverConfig.CLOUDINARY_API_KEY,
  api_secret: serverConfig.CLOUDINARY_API_SECRET,
  secure: true,
});

/* =====================================================
   VALIDATE CONFIGURATION
===================================================== */

const validateCloudinaryConfig = (): void => {
  if (
    !serverConfig.CLOUDINARY_NAME ||
    !serverConfig.CLOUDINARY_API_KEY ||
    !serverConfig.CLOUDINARY_API_SECRET
  ) {
    throw new Error(
      "Cloudinary configuration is missing. Check environment variables.",
    );
  }
};

/* =====================================================
   REDACT SECRETS
===================================================== */

const redactCloudinarySecrets = (value?: string): string | undefined => {
  if (!value) return value;

  const secrets = [
    serverConfig.CLOUDINARY_API_KEY,
    serverConfig.CLOUDINARY_API_SECRET,
  ].filter(
    (secret): secret is string =>
      typeof secret === "string" && secret.length >= 4,
  );

  return secrets.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"),
    value,
  );
};

/* =====================================================
   REMOVE TEMPORARY FILE
===================================================== */

const removeLocalUpload = (filePath: string): void => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error: unknown) {
    logger.warn("Could not remove temporary upload file", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error ? error.message : "Unknown file cleanup error",
    });
  }
};

/* =====================================================
   UPLOAD IMAGE FROM MEMORY
===================================================== */
export const uploadImage = (
  file: CloudinaryFile,
  folder = "cafe-mart",
  isPrivate = false,
): Promise<CloudinaryUploadResult> =>
  new Promise((resolve, reject) => {
    try {
      validateCloudinaryConfig();

      if (!file?.buffer?.length) {
        return reject(new BadRequestError("Uploaded file is empty or missing"));
      }

      const options: UploadApiOptions = {
        folder,
        resource_type: "image",
        type: isPrivate ? "authenticated" : "upload",
        use_filename: false,
        unique_filename: true,
      };

      const stream = cloudinary.uploader.upload_stream(
        options,
        (error: Error | undefined, result?: UploadApiResponse) => {
          if (error || !result) {
            const original =
              error instanceof Error
                ? error
                : new Error("Cloudinary image upload failed");

            logger.error("Cloudinary image upload failed", {
              errorName: original.name,
              errorMessage: redactCloudinarySecrets(original.message),
            });

            return reject(new Error("Failed to upload image to Cloudinary"));
          }

          if (!result.secure_url || !result.public_id) {
            return reject(
              new Error("Cloudinary returned an invalid upload result"),
            );
          }

          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            resourceType: result.resource_type,
            format: result.format,
            bytes: result.bytes,
            isPrivate,
          });
        },
      );

      stream.end(file.buffer);
    } catch (error: unknown) {
      reject(error);
    }
  });

/* =====================================================
   UPLOAD FILE FROM TEMPORARY DISK
===================================================== */
export const uploadToCloudinary = async (
  filePath: string,
  folder = "cafe-mart",
  resourceType: CloudinaryResourceType = "image",
  isPrivate = false,
): Promise<CloudinaryUploadResult> => {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new BadRequestError(
      "Uploaded file is missing from temporary storage",
    );
  }

  try {
    validateCloudinaryConfig();

    const options: UploadApiOptions = {
      folder,
      resource_type: resourceType,
      type: isPrivate ? "authenticated" : "upload",
      use_filename: false,
      unique_filename: true,
    };

    const result: UploadApiResponse = await cloudinary.uploader.upload(
      filePath,
      options,
    );

    if (!result.secure_url || !result.public_id) {
      throw new Error("Cloudinary did not return a secure URL or public ID");
    }

    return {
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      format: result.format,
      bytes: result.bytes,
      isPrivate,
    };
  } catch (error: unknown) {
    const original =
      error instanceof Error
        ? error
        : new Error("Unknown Cloudinary upload error");

    logger.error("Cloudinary upload failed", {
      errorName: original.name,
      errorMessage: redactCloudinarySecrets(original.message),
      configurationMissing:
        !serverConfig.CLOUDINARY_NAME ||
        !serverConfig.CLOUDINARY_API_KEY ||
        !serverConfig.CLOUDINARY_API_SECRET,
    });

    throw error;
  } finally {
    removeLocalUpload(filePath);
  }
};

/* =====================================================
   GENERATE SIGNED URL FOR PRIVATE IMAGE
===================================================== */
export const signedUrl = (publicId: string): string => {
  if (!publicId?.trim()) {
    throw new BadRequestError("Cloudinary public ID is required");
  }

  validateCloudinaryConfig();

  return cloudinary.url(publicId, {
    resource_type: "image",
    type: "authenticated",
    sign_url: true,
    secure: true,
  });
};

/* =====================================================
   DELETE FILE FROM CLOUDINARY
===================================================== */
export const deleteFromCloudinary = async (
  publicId: string,
  resourceType: CloudinaryResourceType = "image",
  isPrivate = false,
): Promise<void> => {
  if (!publicId?.trim()) {
    throw new BadRequestError("Cloudinary public ID is required");
  }

  validateCloudinaryConfig();

  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: isPrivate ? "authenticated" : "upload",
      invalidate: true,
    });

    if (result.result !== "ok" && result.result !== "not found") {
      throw new Error(`Cloudinary deletion failed: ${result.result}`);
    }

    if (result.result === "not found") {
      logger.warn("Cloudinary asset was not found", {
        publicId,
        resourceType,
      });
    }
  } catch (error: unknown) {
    const original =
      error instanceof Error
        ? error
        : new Error("Unknown Cloudinary deletion error");

    logger.error("Cloudinary deletion failed", {
      publicId,
      resourceType,
      errorName: original.name,
      errorMessage: redactCloudinarySecrets(original.message),
    });

    throw error;
  }
};

/* =====================================================
   DEFAULT EXPORT
===================================================== */
export default cloudinary;
