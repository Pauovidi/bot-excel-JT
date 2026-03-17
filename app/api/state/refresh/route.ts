import { NextResponse } from "next/server";

import { readState } from "@/lib/stateStore";
import { syncStateFromSheets } from "@/services/triggerService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readPayload(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return (await request.json()) as {
      spreadsheetId?: string;
    };
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const payload = await readPayload(request);
  await syncStateFromSheets(payload.spreadsheetId);
  const state = await readState();
  return NextResponse.json({
    ok: true,
    state
  });
}
