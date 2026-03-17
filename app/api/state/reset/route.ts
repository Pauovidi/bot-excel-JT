import { NextResponse } from "next/server";

import { resetDemoState } from "@/lib/stateStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const state = await resetDemoState();
  return NextResponse.json({
    ok: true,
    state
  });
}
