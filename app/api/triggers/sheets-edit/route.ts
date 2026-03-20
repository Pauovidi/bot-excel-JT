import { NextResponse } from "next/server";

import { getDemoV2Config, isDemoV2SingleRowEnabled } from "@/lib/demoV2";
import { processDemoV2SheetEdit } from "@/services/triggerService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SheetsEditPayload = {
  spreadsheetId?: string;
  sheetName?: string;
  rowNumber?: number;
  editId?: string;
  currentPhone?: string;
  currentDate?: string;
  currentAction?: string;
};

async function readPayload(request: Request): Promise<SheetsEditPayload> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return (await request.json()) as SheetsEditPayload;
  } catch {
    return {};
  }
}

function hasValidSecret(request: Request) {
  const expectedSecret = process.env.DEMO_V2_PUSH_SECRET?.trim();
  if (!expectedSecret) {
    return false;
  }

  const providedSecret = request.headers.get("x-demo-v2-secret")?.trim();
  return providedSecret === expectedSecret;
}

export async function POST(request: Request) {
  console.info("[api/triggers/sheets-edit] v2 push endpoint hit");

  if (!isDemoV2SingleRowEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: "El modo v2 push no está habilitado."
      },
      { status: 409 }
    );
  }

  if (!hasValidSecret(request)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Trigger push no autorizado."
      },
      { status: 401 }
    );
  }

  const payload = await readPayload(request);
  console.info("[api/triggers/sheets-edit] payload parsed", payload);
  const config = getDemoV2Config();
  const sheetName = payload.sheetName?.trim() || "";
  const rowNumber = Number(payload.rowNumber || config.rowIndex);

  if (!sheetName) {
    return NextResponse.json(
      {
        ok: false,
        error: "Falta sheetName."
      },
      { status: 400 }
    );
  }

  const result = await processDemoV2SheetEdit({
    spreadsheetId: payload.spreadsheetId,
    sheetName,
    rowNumber,
    correlationId: payload.editId?.trim() || undefined
  });

  return NextResponse.json({
    ok: true,
    mode: "google-sheets-push",
    result
  });
}
