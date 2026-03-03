import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

type TokenRole = "browser" | "daemon";

type TokenPayload = {
  deviceId: string;
  exp: number;
  role: TokenRole;
};

const DEFAULT_SECRET = "dev-relay-secret";
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 4;

function getSecret() {
  return process.env.RELAY_SHARED_SECRET ?? DEFAULT_SECRET;
}

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string) {
  return createHmac("sha256", getSecret()).update(value).digest("base64url");
}

type RelayTokenInput = {
  deviceId: string;
  role: TokenRole;
  ttlMs?: number;
};

export function createRelayToken({ deviceId, role, ttlMs }: RelayTokenInput) {
  return createSignedToken({
    deviceId,
    exp: Date.now() + (ttlMs ?? DEFAULT_TTL_MS),
    role,
  });
}

export function createDeviceTokens() {
  const deviceId = randomUUID();

  return {
    deviceId,
    browserToken: createRelayToken({ deviceId, role: "browser" }),
    daemonToken: createRelayToken({ deviceId, role: "daemon" }),
  };
}

export function createSignedToken(payload: TokenPayload) {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload);

  return `${encodedPayload}.${signature}`;
}

export function verifySignedToken(token: string, expectedRole?: TokenRole) {
  const [encodedPayload, receivedSignature] = token.split(".");

  if (!encodedPayload || !receivedSignature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  if (receivedSignature.length !== expectedSignature.length) {
    return null;
  }

  const isValid = timingSafeEqual(
    Buffer.from(receivedSignature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    return null;
  }

  let payload: TokenPayload;

  try {
    payload = JSON.parse(fromBase64Url(encodedPayload)) as TokenPayload;
  } catch {
    return null;
  }

  if (payload.exp < Date.now()) {
    return null;
  }

  if (expectedRole && payload.role !== expectedRole) {
    return null;
  }

  return payload;
}

export type { TokenPayload, TokenRole };
