import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "sk_machine_";
const KEY_BYTES = 32;
const PREFIX_LENGTH = 16;

function getSecret() {
  return (
    process.env.MACHINE_KEY_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    "dev-only-machine-key-secret"
  );
}

function hashKey(key: string) {
  return createHmac("sha256", getSecret()).update(key).digest("hex");
}

export function createMachineApiKey() {
  const rawKey = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
  const keyPrefix = rawKey.slice(0, PREFIX_LENGTH);

  return {
    rawKey,
    keyPrefix,
    keyHash: hashKey(rawKey),
  };
}

export function getKeyPrefix(key: string) {
  return key.slice(0, PREFIX_LENGTH);
}

export function verifyMachineApiKey(key: string, expectedHash: string) {
  const receivedHash = hashKey(key);

  if (receivedHash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash));
}
