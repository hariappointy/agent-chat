import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { createMachineApiKey } from "@/lib/machine-keys";

const ONLINE_GRACE_MS = 45_000;

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(schema.machine)
    .where(eq(schema.machine.userId, session.user.id))
    .orderBy(desc(schema.machine.createdAt));

  const now = Date.now();
  const machines = rows.map((row) => {
    const lastSeenAt = row.lastSeenAt ? row.lastSeenAt.getTime() : null;
    const online = lastSeenAt ? now - lastSeenAt <= ONLINE_GRACE_MS : false;

    return {
      ...row,
      lastSeenAt,
      online,
    };
  });

  return NextResponse.json({ machines });
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "My Machine";

  const machineId = randomUUID();
  const deviceId = randomUUID();
  const { rawKey, keyHash, keyPrefix } = createMachineApiKey();

  await db.insert(schema.machine).values({
    id: machineId,
    userId: session.user.id,
    name,
    deviceId,
  });

  await db.insert(schema.machineKey).values({
    id: randomUUID(),
    machineId,
    keyHash,
    keyPrefix,
  });

  return NextResponse.json({
    apiKey: rawKey,
    machine: {
      id: machineId,
      name,
      deviceId,
    },
  });
}

export async function DELETE(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const machineId = typeof body.machineId === "string" ? body.machineId : "";
  if (!machineId) {
    return NextResponse.json({ error: "machineId is required" }, { status: 400 });
  }

  const [ownedMachine] = await db
    .select({ id: schema.machine.id })
    .from(schema.machine)
    .where(and(eq(schema.machine.id, machineId), eq(schema.machine.userId, session.user.id)))
    .limit(1);

  if (!ownedMachine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  const [deletedMachine] = await db
    .delete(schema.machine)
    .where(and(eq(schema.machine.id, machineId), eq(schema.machine.userId, session.user.id)))
    .returning({ id: schema.machine.id, userId: schema.machine.userId });

  if (!deletedMachine) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ success: true, machineId: deletedMachine.id });
}
