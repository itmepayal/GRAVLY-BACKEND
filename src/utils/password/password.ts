import bcrypt from "bcryptjs";
import { serverConfig } from "../../config/index.js";
import { BadRequestError } from "../errors/app.error.js";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_UTF8_BYTES = 72;

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passw0rd",
  "p@ssword",
  "p@ssw0rd",
  "admin123",
  "admin1234",
  "administrator",
  "12345678",
  "123456789",
  "1234567890",
  "87654321",
  "987654321",
  "00000000",
  "11111111",
  "qwerty123",
  "qwertyuiop",
  "letmein1",
  "letmein123",
  "welcome1",
  "welcome123",
  "changeme",
  "changeme123",
  "cafemart",
  "cafemart123",
  "iloveyou",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "trustno1",
  "monkey123",
  "dragon123",
  "master123",
  "shadow123",
]);

const isSequentialPattern = (value: string): boolean => {
  const lower = value.toLowerCase();
  if (lower.length < 8) return false;

  let asc = true;
  let desc = true;
  for (let i = 1; i < lower.length; i++) {
    const diff = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    if (diff !== 1) asc = false;
    if (diff !== -1) desc = false;
  }
  return asc || desc;
};

const DUMMY_HASH = bcrypt.hashSync(
  "dummy-password-for-timing-protection",
  serverConfig.BCRYPT_COST,
);

export const validatePasswordPolicy = (password: unknown): string => {
  if (typeof password !== "string" || !password) {
    throw new BadRequestError("Password is required");
  }

  if (password.includes("\0")) {
    throw new BadRequestError("Password contains invalid characters");
  }

  const chars = Array.from(password);
  if (chars.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength > MAX_PASSWORD_UTF8_BYTES) {
    throw new BadRequestError(
      `Password must not exceed ${MAX_PASSWORD_UTF8_BYTES} bytes`,
    );
  }

  const uniqueChars = new Set(chars);
  if (uniqueChars.size < 3) {
    throw new BadRequestError(
      "Password is too repetitive. Use a stronger combination of characters",
    );
  }

  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized) || isSequentialPattern(password)) {
    throw new BadRequestError(
      "Password is too common or predictable. Choose a stronger password",
    );
  }

  return password;
};

export const hashPassword = async (password: string): Promise<string> => {
  const valid = validatePasswordPolicy(password);
  return bcrypt.hash(valid, serverConfig.BCRYPT_COST);
};

export const verifyPassword = async (
  candidatePassword: unknown,
  storedHash?: string | null,
): Promise<boolean> => {
  if (
    typeof candidatePassword !== "string" ||
    !candidatePassword ||
    Buffer.byteLength(candidatePassword, "utf8") > 256
  ) {
    await bcrypt.compare("invalid", DUMMY_HASH);
    return false;
  }

  const targetHash = storedHash || DUMMY_HASH;
  const matches = await bcrypt.compare(candidatePassword, targetHash);
  return Boolean(storedHash) && matches;
};
