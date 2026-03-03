import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { createMachineApiKey } from "@/lib/machine-keys";

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const machineId = typeof body.machineId === "string" ? body.machineId : null;

  if (!machineId) {
    return NextResponse.json({ error: "machineId required" }, { status: 400 });
  }

  const machine = await db
    .select()
    .from(schema.machine)
    .where(and(eq(schema.machine.id, machineId), eq(schema.machine.userId, session.user.id)))
    .limit(1);

  if (!machine[0]) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  const now = new Date();
  await db
    .update(schema.machineKey)
    .set({ revokedAt: now })
    .where(and(eq(schema.machineKey.machineId, machineId), isNull(schema.machineKey.revokedAt)));

  const { rawKey, keyHash, keyPrefix } = createMachineApiKey();
  await db.insert(schema.machineKey).values({
    id: randomUUID(),
    machineId,
    keyHash,
    keyPrefix,
  });

  return NextResponse.json({ apiKey: rawKey });
}
