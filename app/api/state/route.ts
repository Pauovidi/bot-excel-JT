import { NextResponse } from "next/server";

import { getCalendarUrl } from "@/lib/calendarUrl";
import { getInitialDemoState, readState } from "@/lib/stateStore";
import { syncStateFromSheets } from "@/services/triggerService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    let state = await readState();
    const configuredSpreadsheetId = process.env.GOOGLE_SPREADSHEET_ID?.trim();

    if (
      configuredSpreadsheetId &&
      (!state.spreadsheetId || !state.importSummary || state.records.length === 0)
    ) {
      await syncStateFromSheets(configuredSpreadsheetId);
      state = await readState();
    }

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
