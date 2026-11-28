import type { Request } from "express";
import type { DeviceType } from "../../models/session.model.js";
import { getTrustedClientIp } from "../../middlewares/rateLimiter.middleware.js";

export interface SessionClientMetadata {
  deviceName: string;
  deviceType: DeviceType;
  os: string;
  browser: string;
  userAgent: string;
  ipAddress: string;
}

const sanitizeText = (raw: unknown, maxLen: number): string => {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .trim()
    .slice(0, maxLen);
};

const parseOs = (ua: string): string => {
  if (!ua) return "Unknown";
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const m = ua.match(/OS (\d+[_\.]\d+)/i);
    return m ? `iOS ${m[1].replace("_", ".")}` : "iOS";
  }
  if (/Android/i.test(ua)) {
    const m = ua.match(/Android (\d+(?:\.\d+)?)/i);
    return m ? `Android ${m[1]}` : "Android";
  }
  if (/Windows NT 10\.0/i.test(ua)) return "Windows 10/11";
  if (/Windows NT 6\.\d/i.test(ua)) return "Windows";
  if (/Mac OS X/i.test(ua)) {
    const m = ua.match(/Mac OS X (\d+[_\.]\d+)/i);
    return m ? `macOS ${m[1].replace("_", ".")}` : "macOS";
  }
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux/i.test(ua)) return "Linux";
  if (/CFNetwork|Darwin/i.test(ua)) return "iOS/macOS";
  return "Unknown";
};

const parseBrowser = (ua: string): string => {
  if (!ua) return "Unknown";
  const edge = ua.match(/Edg(?:A|iOS)?\/(\d+(?:\.\d+)?)/i);
  if (edge) return `Edge ${edge[1]}`;

  const opera = ua.match(/(?:OPR|Opera)\/(\d+(?:\.\d+)?)/i);
  if (opera) return `Opera ${opera[1]}`;

  const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+(?:\.\d+)?)/i);
  if (chrome && !/Edg|OPR/i.test(ua)) return `Chrome ${chrome[1]}`;

  const firefox = ua.match(/(?:Firefox|FxiOS)\/(\d+(?:\.\d+)?)/i);
  if (firefox) return `Firefox ${firefox[1]}`;

  const safari = ua.match(/Version\/(\d+(?:\.\d+)?).*Safari/i);
  if (safari) return `Safari ${safari[1]}`;

  if (/Expo/i.test(ua)) return "Expo App";
  if (/okhttp|ReactNative|CFNetwork/i.test(ua)) return "Mobile App";
  if (/curl\/(\d+(?:\.\d+)?)/i.test(ua)) {
    const m = ua.match(/curl\/(\d+(?:\.\d+)?)/i);
    return m ? `curl ${m[1]}` : "curl";
  }
  return "Unknown";
};

const parseDeviceType = (ua: string): DeviceType => {
  if (!ua) return "Unknown";
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "Tablet";
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "Tablet";
  if (
    /Mobile|iPhone|iPod|Android.*Mobile|BlackBerry|IEMobile|Opera Mini|okhttp|CFNetwork|Expo/i.test(
      ua,
    )
  ) {
    return "Mobile";
  }
  if (/Laptop|Notebook/i.test(ua)) return "Laptop";
  if (/Windows NT|Macintosh|Mac OS X|X11|Linux x86_64|CrOS/i.test(ua)) {
    return "Desktop";
  }
  return "Unknown";
};

/**
 * Extracts and sanitizes untrusted client HTTP metadata for session tracking.
 * Never used as an authentication factor.
 */
export const extractClientMetadata = (
  req?: Request,
): SessionClientMetadata => {
  if (!req) {
    return {
      deviceName: "Unknown Device",
      deviceType: "Unknown",
      os: "Unknown",
      browser: "Unknown",
      userAgent: "",
      ipAddress: "unknown",
    };
  }

  const userAgent = sanitizeText(req.headers["user-agent"], 512);
  const ipAddress = sanitizeText(getTrustedClientIp(req), 64) || "unknown";
  const os = parseOs(userAgent);
  const browser = parseBrowser(userAgent);
  const deviceType = parseDeviceType(userAgent);

  let deviceName = "Unknown Device";
  if (browser !== "Unknown" && os !== "Unknown") {
    deviceName = `${browser.split(" ")[0]} on ${os.split(" ")[0]}`;
  } else if (os !== "Unknown") {
    deviceName = `${deviceType === "Unknown" ? "Device" : deviceType} (${os})`;
  } else if (browser !== "Unknown") {
    deviceName = browser;
  }

  return {
    deviceName: sanitizeText(deviceName, 120) || "Unknown Device",
    deviceType,
    os,
    browser,
    userAgent,
    ipAddress,
  };
};

/**
 * Masks client IP addresses for privacy in API responses.
 */
export const maskIpAddress = (ip?: string | null): string => {
  if (!ip || ip === "unknown") return "unknown";
  const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;

  if (clean.includes(".")) {
    const parts = clean.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
    }
  }

  if (clean.includes(":")) {
    const segments = clean.split(":").filter(Boolean);
    if (segments.length >= 2) {
      return `${segments.slice(0, 2).join(":")}::xxxx`;
    }
    return "::xxxx";
  }

  return "masked";
};
