import dotenv from "dotenv";

dotenv.config();

type ServerConfig = {
  NODE_ENV: string;
  PORT: number;

  // Database
  MONGODB_URI: string;

  // JWT Access Token
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_EXPIRES: string;

  // JWT Refresh Token
  JWT_REFRESH_SECRET: string;
  JWT_REFRESH_EXPIRES: string;

  // Google OAuth
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  // Apple OAuth
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;

  // URLs
  CLIENT_URL: string;
  CORS_ORIGIN: string;
  API_BASE_URL: string;
  SERVER_URL: string;

  // Redis
  REDIS_HOST: string;
  REDIS_PORT: number;

  // Cloudinary
  CLOUDINARY_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;

  // Cashfree
  CASHFREE_APP_ID: string;
  CASHFREE_SECRET_KEY: string;
  CASHFREE_ENV: string;

  // Admin
  ADMIN_REGISTER_SECRET: string;
};

function getEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function loadEnv(): void {
  dotenv.config();
  console.log("Environment variables loaded");
}

loadEnv();

export const serverConfig: ServerConfig = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 8000,

  // Database
  MONGODB_URI: getEnv("MONGODB_URI"),

  // JWT Access Token
  JWT_ACCESS_SECRET: getEnv("JWT_ACCESS_SECRET"),
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || "15m",

  // JWT Refresh Token
  JWT_REFRESH_SECRET: getEnv("JWT_REFRESH_SECRET"),
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || "30d",

  // Google OAuth
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET"),

  // Apple OAuth
  APPLE_CLIENT_ID: getEnv("APPLE_CLIENT_ID"),
  APPLE_TEAM_ID: getEnv("APPLE_TEAM_ID"),
  APPLE_KEY_ID: getEnv("APPLE_KEY_ID"),

  // URLs
  CLIENT_URL: getEnv("CLIENT_URL"),
  CORS_ORIGIN: getEnv("CORS_ORIGIN"),
  API_BASE_URL: getEnv("API_BASE_URL"),
  SERVER_URL: getEnv("SERVER_URL"),

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || "127.0.0.1",
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,

  // Cloudinary
  CLOUDINARY_NAME: getEnv("CLOUDINARY_NAME"),
  CLOUDINARY_API_KEY: getEnv("CLOUDINARY_API_KEY"),
  CLOUDINARY_API_SECRET: getEnv("CLOUDINARY_API_SECRET"),

  // Cashfree
  CASHFREE_APP_ID: getEnv("CASHFREE_APP_ID"),
  CASHFREE_SECRET_KEY: getEnv("CASHFREE_SECRET_KEY"),
  CASHFREE_ENV: process.env.CASHFREE_ENV || "SANDBOX",

  // Admin
  ADMIN_REGISTER_SECRET: getEnv("ADMIN_REGISTER_SECRET"),
};
