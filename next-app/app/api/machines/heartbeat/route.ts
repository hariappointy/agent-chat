import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { authenticateMachine } from "@/lib/machine-auth";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!bearer) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authResult = await authenticateMachine(bearer);
  if (!authResult) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const hostName = typeof body.hostName === "string" ? body.hostName : undefined;
  const runtimes = Array.isArray(body.runtimes) ? body.runtimes : undefined;

  await db
    .update(schema.machine)
    .set({
      lastSeenAt: new Date(),
      hostName: hostName ?? authResult.machine.hostName,
      runtimes: runtimes ?? authResult.machine.runtimes,
      updatedAt: new Date(),
    })
    .where(eq(schema.machine.id, authResult.machine.id));

  return NextResponse.json({ ok: true });
}
