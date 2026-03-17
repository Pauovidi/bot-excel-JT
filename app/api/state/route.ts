import { NextResponse } from "next/server";

import { getCalendarUrl } from "@/lib/calendarUrl";
import { getInitialDemoState, readState } from "@/lib/stateStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const state = await readState();
    return NextResponse.json({
      ok: true,
      state,
      calendarUrl: getCalendarUrl()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo cargar el estado de la demo.";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        code: "STATE_LOAD_ERROR",
        state: getInitialDemoState(),
        calendarUrl: getCalendarUrl()
      },
      { status: 500 }
    );
  }
}
