import { NextResponse } from "next/server";

import { getDemoV2TriggerDate, isDemoV2SingleRowEnabled } from "@/lib/demoV2";
import { logRuntimeEnvDiagnostics } from "@/lib/env";
import { buildDemoV2ObservationHash, buildDemoV2RelevantHash, buildTriggerHash } from "@/lib/hash";
import { readState, readUploadedExcelBuffer, updateState } from "@/lib/stateStore";
import { parseExcelBuffer } from "@/services/excelService";
import { logActivity } from "@/services/loggerService";
import { syncRecordsToSpreadsheet } from "@/services/sheetsService";
import type { DemoRecord, ImportSummary } from "@/types/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProcessPayload = {
  records?: DemoRecord[];
  importSummary?: ImportSummary | null;
  spreadsheetId?: string;
};

async function readPayload(request: Request): Promise<ProcessPayload> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return (await request.json()) as ProcessPayload;
  } catch {
    return {};
  }
}

function buildErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Error inesperado al procesar Google Sheets.";
  const normalizedMessage = message.toLowerCase();

  let code: "ENV_MISSING" | "GOOGLE_AUTH_ERROR" | "UNKNOWN" = "UNKNOWN";
  if (message.includes("Missing required env var")) {
    code = "ENV_MISSING";
  } else if (
    normalizedMessage.includes("google") ||
    normalizedMessage.includes("auth") ||
    normalizedMessage.includes("credential") ||
    normalizedMessage.includes("spreadsheet")
  ) {
    code = "GOOGLE_AUTH_ERROR";
  }

  return NextResponse.json(
    {
      ok: false,
      error: message,
      code
    },
    {
      status: 500
    }
  );
}

export async function POST(request: Request) {
  try {
    const state = await readState();
    const payload = await readPayload(request);
    logRuntimeEnvDiagnostics("api/process");

    const uploadedBuffer = await readUploadedExcelBuffer();
    const fallbackParsed =
      !state.records.length && !payload.records?.length && uploadedBuffer
        ? parseExcelBuffer(uploadedBuffer, state.importSummary?.fileName)
        : null;
    const baseRecords =
      state.records.length > 0
        ? state.records
        : payload.records?.length
          ? payload.records
          : (fallbackParsed?.records ?? []);
    const importSummary = state.importSummary ?? payload.importSummary ?? fallbackParsed?.summary ?? null;

    if (baseRecords.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Primero sube y procesa un Excel en esta sesión. Si el deployment se ha reiniciado, vuelve a subirlo.",
          code: "UNKNOWN"
        },
        { status: 400 }
      );
    }

    const preparedRecords = baseRecords.map((record) => {
      if (isDemoV2SingleRowEnabled()) {
        const triggerDate = getDemoV2TriggerDate(record);
        return {
          ...record,
          lastProcessedHash: buildDemoV2RelevantHash(record.telefono, triggerDate, record.tipoAccion),
          lastObservedHash: buildDemoV2ObservationHash(record),
          v2TriggerPhone: record.telefono,
          v2TriggerDate: triggerDate,
          v2TriggerAction: record.tipoAccion
        };
      }

      return {
        ...record,
        lastProcessedHash: buildTriggerHash(record),
        lastObservedHash: undefined,
        v2TriggerPhone: undefined,
        v2TriggerDate: undefined,
        v2TriggerAction: undefined
      };
    });
    const spreadsheet = await syncRecordsToSpreadsheet(preparedRecords, {
      spreadsheetId: payload.spreadsheetId || state.spreadsheetId
    });

    await updateState((current) => {
      current.importSummary = importSummary;
      current.records = preparedRecords;
      current.spreadsheetId = spreadsheet.spreadsheetId;
      current.spreadsheetUrl = spreadsheet.spreadsheetUrl;
      current.steps.sheet_updated = "done";
    });

    await logActivity({
      correlationId: spreadsheet.spreadsheetId.slice(0, 8),
      paciente: "google_sheet",
      telefono: "",
      accion: "sheet_synced",
      resultado: "ok",
      detalle: `Spreadsheet sincronizado con ${preparedRecords.length} filas.`
    });

    const nextState = await readState();

    return NextResponse.json({
      ok: true,
      spreadsheet,
      state: nextState
    });
  } catch (error) {
    console.error("[api/process] failed", error);
    return buildErrorResponse(error);
  }
}
