import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Deprecated: use /api/machines/* endpoints." },
    { status: 410 }
  );
}
