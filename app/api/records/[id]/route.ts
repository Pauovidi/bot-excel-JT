import { NextResponse } from "next/server";

import { nowIso } from "@/lib/dateUtils";
import { normalizeActionTypeValue, normalizeDateValue, normalizeTimeValue } from "@/lib/normalization";
import { readState, updateState } from "@/lib/stateStore";
import { logActivity } from "@/services/loggerService";
import { readAllRowsFromSpreadsheet, updateRecordInSpreadsheet } from "@/services/sheetsService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const payload = (await request.json()) as {
    tipoAccion?: string;
    fechaAccion?: string;
    horaCita?: string;
    spreadsheetId?: string;
  };

  const state = await readState();
  const record =
    state.records.find((item) => item.id === id) ??
    (await readAllRowsFromSpreadsheet(payload.spreadsheetId)).find((item) => item.id === id);
  if (!record) {
    return NextResponse.json(
      {
        ok: false,
        error: "No se ha encontrado el registro."
      },
      { status: 404 }
    );
  }

  record.tipoAccion = normalizeActionTypeValue(payload.tipoAccion ?? record.tipoAccion, record.tipoAccion);
  record.fechaAccion = payload.fechaAccion ? normalizeDateValue(payload.fechaAccion) : record.fechaAccion;
  record.horaCita = payload.horaCita ? normalizeTimeValue(payload.horaCita) : record.horaCita;
  record.ultimaRespuesta = "";
  record.intencion = "";
  record.flowType = "";
  record.conversationState = "";
  record.lastBotMessageType = "";
  record.lastUserMessage = "";
  record.intentDetected = "";
  record.proposedSlots = [];
  record.selectedSlot = "";
  record.conversationClosed = false;
  record.updatedAtDemo = nowIso();

  await updateRecordInSpreadsheet(record, payload.spreadsheetId);
  await updateState((current) => {
    const targetIndex = current.records.findIndex((item) => item.id === id);
    if (targetIndex >= 0) {
      Object.assign(current.records[targetIndex], record);
    } else {
      current.records.push(record);
    }
  });

  await logActivity({
    correlationId: id.slice(0, 8),
    paciente: record.nombre,
    telefono: record.telefono,
    accion: "record_updated",
    resultado: "ok",
    detalle: `Edición manual: ${record.tipoAccion} / ${record.fechaAccion} / ${record.horaCita}`
  });

  const nextState = await readState();

  return NextResponse.json({
    ok: true,
    record,
    state: nextState
  });
}
