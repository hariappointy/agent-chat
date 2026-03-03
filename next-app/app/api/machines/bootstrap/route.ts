import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { authenticateMachine } from "@/lib/machine-auth";
import { createRelayToken } from "@/lib/token";

const TOKEN_TTL_MS = 1000 * 60 * 30;

function getRelayWsUrl() {
  return process.env.NEXT_PUBLIC_RELAY_WS_URL ?? "ws://localhost:8787/ws";
}

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  const body = await request.json().catch(() => ({}));

  if (bearer) {
    const authResult = await authenticateMachine(bearer);
    if (!authResult) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const { machine } = authResult;
    const hostName = typeof body.hostName === "string" ? body.hostName : undefined;
    const runtimes = Array.isArray(body.runtimes) ? body.runtimes : undefined;

    await db
      .update(schema.machine)
      .set({
        lastSeenAt: new Date(),
        hostName: hostName ?? machine.hostName,
        runtimes: runtimes ?? machine.runtimes,
        updatedAt: new Date(),
      })
      .where(eq(schema.machine.id, machine.id));

    const daemonToken = createRelayToken({
      deviceId: machine.deviceId,
      role: "daemon",
      ttlMs: TOKEN_TTL_MS,
    });

    await db.insert(schema.machineSession).values({
      id: randomUUID(),
      machineId: machine.id,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });

    return NextResponse.json({
      daemonToken,
      deviceId: machine.deviceId,
      machineId: machine.id,
      relayWsUrl: getRelayWsUrl(),
    });
  }

  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const browserToken = createRelayToken({
    deviceId: machine[0].deviceId,
    role: "browser",
    ttlMs: TOKEN_TTL_MS,
  });

  await db.insert(schema.machineSession).values({
    id: randomUUID(),
    machineId,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  return NextResponse.json({
    browserToken,
    deviceId: machine[0].deviceId,
    machineId,
    relayWsUrl: getRelayWsUrl(),
  });
}
