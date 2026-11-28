import { ZodError } from "zod";
import { NextFunction, Request, Response } from "express";
import { AnyZodObject } from "zod";
import logger from "../config/logger.config.js";

const summarizeZodIssues = (error: unknown): string[] => {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
  }
  return [];
};

export const validateRequestBody = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const route = req.originalUrl.split("?")[0];
    try {
      await schema.parseAsync(req.body);
      logger.debug("Request body validated", {
        route,
        operation: "VALIDATE_BODY",
      });
      next();
    } catch (error) {
      logger.warn("Request body validation failed", {
        route,
        issues: summarizeZodIssues(error),
        operation: "VALIDATE_BODY",
      });
      res.status(400).json({
        message: "Invalid request body",
        success: false,
        error: error,
      });
    }
  };
};

export const validateQueryParams = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const route = req.originalUrl.split("?")[0];
    try {
      await schema.parseAsync(req.query);
      logger.debug("Query parameters validated", {
        route,
        operation: "VALIDATE_QUERY",
      });
      next();
    } catch (error) {
      logger.warn("Query parameter validation failed", {
        route,
        issues: summarizeZodIssues(error),
        operation: "VALIDATE_QUERY",
      });
      res.status(400).json({
        message: "Invalid query params",
        success: false,
        error: error,
      });
    }
  };
};
