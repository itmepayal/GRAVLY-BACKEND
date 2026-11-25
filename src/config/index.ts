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

  // JWT Claims
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;

  // Password Hashing
  BCRYPT_COST: number;

  // Session Policy
  SESSION_IDLE_TIMEOUT_MS: number;
  SESSION_ACTIVITY_THROTTLE_SEC: number;

  // Google OAuth
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  // Apple OAuth
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;

  // URLs & CORS
  CLIENT_URL: string;
  CORS_ORIGIN: string;
  CORS_ORIGINS: string[];
  TRUST_PROXY: boolean | number | string;
  API_BASE_URL: string;
  SERVER_URL: string;

  // Redis
  REDIS_URL?: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_USERNAME?: string;
  REDIS_PASSWORD?: string;
  REDIS_TLS: boolean;
  REDIS_TLS_REJECT_UNAUTHORIZED: boolean;
  REDIS_REVOCATION_FAIL_CLOSED: boolean;
  REDIS_COMMAND_TIMEOUT_MS: number;
  REDIS_CONNECT_TIMEOUT_MS: number;
  REDIS_REST_TIMEOUT_MS: number;
  REDIS_MAX_RETRIES_PER_REQUEST: number;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  // Socket.IO
  SOCKET_PING_INTERVAL_MS: number;
  SOCKET_PING_TIMEOUT_MS: number;
  SOCKET_TRANSPORTS: ("websocket" | "polling")[];
  SOCKET_MAX_CONNECTIONS_PER_USER: number;

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

  // Firebase
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
};

function getEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function parseCorsOrigins(rawCorsOrigin: string, clientUrl: string): string[] {
  const candidates = rawCorsOrigin
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (candidates.length === 0 && clientUrl) {
    candidates.push(clientUrl.trim().replace(/\/+$/, ""));
  }

  const normalized: string[] = [];
  for (const origin of candidates) {
    if (origin === "*") {
      throw new Error(
        "Wildcard '*' is not permitted in CORS_ORIGIN when credentials are enabled",
      );
    }
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported CORS origin protocol: ${origin}`);
      }
      normalized.push(parsed.origin);
    } catch {
      throw new Error(`Invalid CORS_ORIGIN entry: ${origin}`);
    }
  }

  return Array.from(new Set(normalized));
}

function parseTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === "false") {
    return false;
  }
  if (raw === "true") {
    return 1;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function parseBcryptCost(): number {
  const raw = process.env.BCRYPT_COST;
  if (!raw) return 12;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 14) {
    throw new Error("BCRYPT_COST must be an integer between 10 and 14");
  }
  return parsed;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseSocketTransports(
  raw: string | undefined,
): ("websocket" | "polling")[] {
  if (!raw || !raw.trim()) return ["websocket", "polling"];
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: ("websocket" | "polling")[] = [];
  for (const item of items) {
    if (item !== "websocket" && item !== "polling") {
      throw new Error(
        `Invalid SOCKET_TRANSPORTS entry '${item}'; expected 'websocket' or 'polling'`,
      );
    }
    if (!valid.includes(item)) {
      valid.push(item);
    }
  }
  if (valid.length === 0) {
    throw new Error("SOCKET_TRANSPORTS must include at least one transport");
  }
  return valid;
}

function validateRedisEnv(nodeEnvValue: string): {
  redisUrl?: string;
  upstashRestUrl?: string;
  upstashRestToken?: string;
} {
  const redisUrl =
    process.env.REDIS_URL?.trim() ||
    process.env.UPSTASH_REDIS_URL?.trim() ||
    undefined;
  const upstashRestUrl =
    process.env.UPSTASH_REDIS_REST_URL?.trim() || undefined;
  const upstashRestToken =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || undefined;

  if (Boolean(upstashRestUrl) !== Boolean(upstashRestToken)) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be provided when configuring Upstash REST",
    );
  }

  if (upstashRestUrl) {
    let parsedRest: URL;
    try {
      parsedRest = new URL(upstashRestUrl);
    } catch {
      throw new Error("Invalid UPSTASH_REDIS_REST_URL format");
    }
    if (nodeEnvValue === "production" && parsedRest.protocol !== "https:") {
      throw new Error("UPSTASH_REDIS_REST_URL must use https:// in production");
    }
    if (parsedRest.protocol !== "https:" && parsedRest.protocol !== "http:") {
      throw new Error(
        "UPSTASH_REDIS_REST_URL must use http:// or https:// protocol",
      );
    }
  }

  if (redisUrl) {
    let parsedTcp: URL;
    try {
      parsedTcp = new URL(redisUrl);
    } catch {
      throw new Error("Invalid REDIS_URL format");
    }
    if (parsedTcp.protocol !== "redis:" && parsedTcp.protocol !== "rediss:") {
      throw new Error("REDIS_URL must use redis:// or rediss:// protocol");
    }
    const isLocalTcp =
      parsedTcp.hostname === "127.0.0.1" || parsedTcp.hostname === "localhost";
    if (
      nodeEnvValue === "production" &&
      !isLocalTcp &&
      parsedTcp.protocol !== "rediss:" &&
      process.env.REDIS_TLS !== "true"
    ) {
      throw new Error(
        "REDIS_URL must use rediss:// (or REDIS_TLS=true) for non-local Redis in production",
      );
    }
  } else if (
    nodeEnvValue === "production" &&
    process.env.REDIS_TLS !== "true"
  ) {
    const redisHost = process.env.REDIS_HOST?.trim() || "127.0.0.1";
    if (redisHost !== "127.0.0.1" && redisHost !== "localhost") {
      throw new Error(
        "REDIS_TLS must be enabled ('true') for non-local Redis in production",
      );
    }
  }

  return { redisUrl, upstashRestUrl, upstashRestToken };
}

function loadEnv(): void {
  dotenv.config();
}

loadEnv();

const nodeEnv = process.env.NODE_ENV || "development";
const clientUrl = getEnv("CLIENT_URL");
const corsOrigin = getEnv("CORS_ORIGIN");
const corsOrigins = parseCorsOrigins(corsOrigin, clientUrl);
const validatedRedis = validateRedisEnv(nodeEnv);

export const serverConfig: ServerConfig = {
  NODE_ENV: nodeEnv,
  PORT: Number(process.env.PORT) || 8000,

  // Database
  MONGODB_URI: getEnv("MONGODB_URI"),

  // JWT Access Token
  JWT_ACCESS_SECRET: getEnv("JWT_ACCESS_SECRET"),
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || "15m",

  // JWT Refresh Token
  JWT_REFRESH_SECRET: getEnv("JWT_REFRESH_SECRET"),
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || "30d",

  // JWT Claims
  JWT_ISSUER: process.env.JWT_ISSUER || "cafemart-api",
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || "cafemart-client",

  // Password Hashing
  BCRYPT_COST: parseBcryptCost(),

  // Session Policy
  SESSION_IDLE_TIMEOUT_MS:
    Number(process.env.SESSION_IDLE_TIMEOUT_MS) || 7 * 24 * 60 * 60 * 1000,
  SESSION_ACTIVITY_THROTTLE_SEC:
    Number(process.env.SESSION_ACTIVITY_THROTTLE_SEC) || 60,

  // Google OAuth
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET"),

  // Apple OAuth
  APPLE_CLIENT_ID: getEnv("APPLE_CLIENT_ID"),
  APPLE_TEAM_ID: getEnv("APPLE_TEAM_ID"),
  APPLE_KEY_ID: getEnv("APPLE_KEY_ID"),

  // URLs & CORS
  CLIENT_URL: clientUrl,
  CORS_ORIGIN: corsOrigin,
  CORS_ORIGINS: corsOrigins,
  TRUST_PROXY: parseTrustProxy(),
  API_BASE_URL: getEnv("API_BASE_URL"),
  SERVER_URL: getEnv("SERVER_URL"),

  // Redis
  REDIS_URL: validatedRedis.redisUrl,
  REDIS_HOST: process.env.REDIS_HOST || "127.0.0.1",
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  REDIS_USERNAME: process.env.REDIS_USERNAME || undefined,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_TLS: process.env.REDIS_TLS === "true",
  REDIS_TLS_REJECT_UNAUTHORIZED:
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false",
  REDIS_REVOCATION_FAIL_CLOSED:
    process.env.REDIS_REVOCATION_FAIL_CLOSED !== "false",
  REDIS_COMMAND_TIMEOUT_MS: parseBoundedInt(
    process.env.REDIS_COMMAND_TIMEOUT_MS,
    2000,
    100,
    60000,
    "REDIS_COMMAND_TIMEOUT_MS",
  ),
  REDIS_CONNECT_TIMEOUT_MS: parseBoundedInt(
    process.env.REDIS_CONNECT_TIMEOUT_MS,
    5000,
    500,
    60000,
    "REDIS_CONNECT_TIMEOUT_MS",
  ),
  REDIS_REST_TIMEOUT_MS: parseBoundedInt(
    process.env.REDIS_REST_TIMEOUT_MS,
    3000,
    200,
    60000,
    "REDIS_REST_TIMEOUT_MS",
  ),
  REDIS_MAX_RETRIES_PER_REQUEST: parseBoundedInt(
    process.env.REDIS_MAX_RETRIES_PER_REQUEST,
    2,
    0,
    10,
    "REDIS_MAX_RETRIES_PER_REQUEST",
  ),
  UPSTASH_REDIS_REST_URL: validatedRedis.upstashRestUrl,
  UPSTASH_REDIS_REST_TOKEN: validatedRedis.upstashRestToken,

  // Socket.IO
  SOCKET_PING_INTERVAL_MS: parseBoundedInt(
    process.env.SOCKET_PING_INTERVAL_MS,
    25000,
    5000,
    120000,
    "SOCKET_PING_INTERVAL_MS",
  ),
  SOCKET_PING_TIMEOUT_MS: parseBoundedInt(
    process.env.SOCKET_PING_TIMEOUT_MS,
    20000,
    5000,
    120000,
    "SOCKET_PING_TIMEOUT_MS",
  ),
  SOCKET_TRANSPORTS: parseSocketTransports(process.env.SOCKET_TRANSPORTS),
  SOCKET_MAX_CONNECTIONS_PER_USER: parseBoundedInt(
    process.env.SOCKET_MAX_CONNECTIONS_PER_USER,
    25,
    1,
    500,
    "SOCKET_MAX_CONNECTIONS_PER_USER",
  ),

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

  // Firebase
  FIREBASE_PROJECT_ID: getEnv("FIREBASE_PROJECT_ID"),
  FIREBASE_CLIENT_EMAIL: getEnv("FIREBASE_CLIENT_EMAIL"),
  FIREBASE_PRIVATE_KEY: getEnv("FIREBASE_PRIVATE_KEY"),
};
