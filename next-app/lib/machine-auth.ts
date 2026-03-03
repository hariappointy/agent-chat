import { and, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getKeyPrefix, verifyMachineApiKey } from "@/lib/machine-keys";

type MachineAuthResult = {
  machine: typeof schema.machine.$inferSelect;
  machineKeyId: string;
};

export async function authenticateMachine(apiKey: string): Promise<MachineAuthResult | null> {
  const prefix = getKeyPrefix(apiKey);

  const results = await db
    .select({
      machine: schema.machine,
      machineKeyId: schema.machineKey.id,
      keyHash: schema.machineKey.keyHash,
    })
    .from(schema.machineKey)
    .innerJoin(schema.machine, eq(schema.machineKey.machineId, schema.machine.id))
    .where(and(eq(schema.machineKey.keyPrefix, prefix), isNull(schema.machineKey.revokedAt)))
    .limit(1);

  const record = results[0];
  if (!record) {
    return null;
  }

  const isValid = verifyMachineApiKey(apiKey, record.keyHash);
  if (!isValid) {
    return null;
  }

  return {
    machine: record.machine,
    machineKeyId: record.machineKeyId,
  };
}
