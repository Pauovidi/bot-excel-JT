import { NextResponse } from "next/server";
import twilio from "twilio";

import { nowIso } from "@/lib/dateUtils";
import { buildPublicUrl, isDemoStateless, requireEnv, resolveAppBaseUrl } from "@/lib/env";
import { toComparablePhone } from "@/lib/phone";
import { readState, updateState } from "@/lib/stateStore";
import { processIntentWithCalendar } from "@/services/calendarService";
import { hydrateOpenGuidedFlowRecord, progressGuidedFlow } from "@/services/conversationFlowService";
import { classifyIntent } from "@/services/intentService";
import { logActivity } from "@/services/loggerService";
import { readAllRowsFromSpreadsheet, updateRecordInSpreadsheet } from "@/services/sheetsService";
import { buildAutoReply } from "@/services/twilioService";
import type { DemoRecord } from "@/types/demo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildTwimlResponse(message: string) {
  const response = new twilio.twiml.MessagingResponse();
  response.message(message);
  return new NextResponse(response.toString(), {
    status: 200,
    headers: {
      "Content-Type": "text/xml"
    }
  });
}

function upsertStateRecord(records: DemoRecord[], record: DemoRecord) {
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    Object.assign(records[index], record);
    return;
  }

  records.push(record);
}

function summarizeSheetState(record?: DemoRecord | null) {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    estadoWhatsapp: record.estadoWhatsapp,
    conversationClosed: record.conversationClosed,
    flowType: record.flowType,
    conversationState: record.conversationState,
    tipoAccion: record.tipoAccion,
    fechaAccion: record.fechaAccion,
    horaCita: record.horaCita,
    lastProcessedHash: record.lastProcessedHash
  };
}

function buildInboundRecordKey(record: DemoRecord) {
  return record.id || `${record.sheetName}:${record.sheetRowNumber}`;
}

function scoreInboundCandidate(record: DemoRecord) {
  let score = 0;

  if (record.flowType) {
    score += 100;
  }
  if (record.conversationState) {
    score += 40;
  }
  if (!record.conversationClosed) {
    score += 30;
  }
  if (record.estadoWhatsapp === "enviado") {
    score += 20;
  }
  if (record.lastSentMessage) {
    score += 10;
  }

  return score;
}

function summarizeInboundCandidate(record: DemoRecord) {
  return {
    id: record.id,
    sheetName: record.sheetName,
    sheetRowNumber: record.sheetRowNumber,
    flowType: record.flowType,
    conversationState: record.conversationState,
    estadoWhatsapp: record.estadoWhatsapp,
    conversationClosed: record.conversationClosed,
    updatedAtDemo: record.updatedAtDemo
  };
}

function resolveInboundRecord(stateRecords: DemoRecord[], sheetRecords: DemoRecord[], phone: string) {
  const matchesByKey = new Map<string, DemoRecord>();

  for (const record of sheetRecords) {
    if (toComparablePhone(record.telefono) !== phone) {
      continue;
    }

    matchesByKey.set(buildInboundRecordKey(record), record);
  }

  for (const record of stateRecords) {
    if (toComparablePhone(record.telefono) !== phone) {
      continue;
    }

    const key = buildInboundRecordKey(record);
    const existing = matchesByKey.get(key);
    matchesByKey.set(
      key,
      existing
        ? ({
            ...existing,
            ...record
          } satisfies DemoRecord)
        : record
    );
  }

  const candidates = Array.from(matchesByKey.values())
    .map((record) => hydrateOpenGuidedFlowRecord(record))
    .sort((left, right) => {
      const scoreDiff = scoreInboundCandidate(right) - scoreInboundCandidate(left);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return Date.parse(right.updatedAtDemo || "") - Date.parse(left.updatedAtDemo || "");
    });

  return {
    record: candidates[0] ?? null,
    candidates: candidates.map(summarizeInboundCandidate)
  };
}

function validateTwilioRequest(request: Request, params: Record<string, string>) {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    return {
      valid: true,
      matchedUrl: "unsigned"
    };
  }

  const requestPath = new URL(request.url).pathname;
  const candidates = Array.from(
    new Set(
      [
        buildPublicUrl(requestPath, request),
        resolveAppBaseUrl(request) ? `${resolveAppBaseUrl(request)}${requestPath}` : "",
        request.url
      ].filter(Boolean)
    )
  );

  for (const candidate of candidates) {
    if (twilio.validateRequest(requireEnv("TWILIO_AUTH_TOKEN"), signature, candidate, params)) {
      return {
        valid: true,
        matchedUrl: candidate
      };
    }
  }

  return {
    valid: false,
    matchedUrl: candidates[0] ?? ""
  };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const params = Object.fromEntries(
      Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    );
    const correlationId = String(params.MessageSid || params.SmsSid || params.From || Date.now()).slice(0, 24);
    const inboundMessage = String(params.Body ?? "").trim();
    const rawPhone = String(params.From ?? "");

    console.info("[twilio-webhook] inbound", {
      correlationId,
      from: rawPhone,
      hasSignature: Boolean(request.headers.get("x-twilio-signature")),
      appBaseUrl: resolveAppBaseUrl(request),
      stateless: isDemoStateless()
    });

    await logActivity({
      correlationId,
      paciente: "desconocido",
      telefono: rawPhone,
      accion: "webhook_received",
      resultado: "ok",
      detalle: `Inbound recibido desde ${rawPhone || "sin telefono"} con body "${inboundMessage || "[vacio]"}".`
    });

    if (!params.From || !params.Body) {
      await logActivity({
        correlationId,
        paciente: "desconocido",
        telefono: rawPhone,
        accion: "webhook_route_error",
        resultado: "invalid_payload",
        detalle: "Twilio webhook recibido sin From o Body."
      });
      return new NextResponse("Payload inválido", { status: 400 });
    }

    const validation = validateTwilioRequest(request, params);
    console.info("[twilio-webhook] signature valid", {
      correlationId,
      valid: validation.valid,
      matchedUrl: validation.matchedUrl
    });
    if (!validation.valid) {
      await logActivity({
        correlationId,
        paciente: "desconocido",
        telefono: rawPhone,
        accion: "webhook_route_error",
        resultado: "invalid_signature",
        detalle: `La firma del webhook de Twilio no es valida para ${validation.matchedUrl || "sin URL resuelta"}.`
      });
      return new NextResponse("Firma de Twilio inválida", { status: 403 });
    }

    const phone = toComparablePhone(params.From);
    console.info("[twilio-webhook] normalized phone", {
      correlationId,
      rawPhone,
      normalizedPhone: phone
    });
    const state = await readState();
    const sheetRecords = await readAllRowsFromSpreadsheet();
    const inboundSelection = resolveInboundRecord(state.records, sheetRecords, phone);
    const record = inboundSelection.record;

    console.info("[twilio-webhook] patient found", {
      correlationId,
      found: Boolean(record),
      candidates: inboundSelection.candidates,
      sheetStateBefore: summarizeSheetState(record)
    });

    if (!record) {
      await logActivity({
        correlationId,
        paciente: "desconocido",
        telefono: rawPhone,
        accion: "webhook_route_error",
        resultado: "record_not_found",
        detalle: "No se ha encontrado ningun paciente asociado al telefono entrante."
      });
      return buildTwimlResponse("No hemos encontrado tu ficha en la demo.");
    }

    console.info("[twilio-webhook] conversation found", {
      correlationId,
      open: !record.conversationClosed,
      flowType: record.flowType,
      conversationState: record.conversationState
    });
    console.info("[twilio-webhook] inbound flowType loaded", {
      correlationId,
      value: record.flowType || "simple_intent"
    });
    console.info("[twilio-webhook] inbound conversationState loaded", {
      correlationId,
      value: record.conversationState || ""
    });

    await logActivity({
      correlationId: record.id.slice(0, 8),
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "webhook_route_ok",
      resultado: record.flowType || "simple_intent",
      detalle: "Webhook inbound validado y asociado a un paciente."
    });

    if (record.flowType && !record.conversationClosed) {
      console.info("[twilio-webhook] flow selected", {
        correlationId,
        flowType: record.flowType,
        conversationState: record.conversationState
      });
      try {
        const progressed = await progressGuidedFlow(record, inboundMessage);
        if (progressed) {
          const updatedRecord: DemoRecord = {
            ...progressed.record,
            ultimaRespuesta: inboundMessage,
            lastUserMessage: inboundMessage,
            updatedAtDemo: nowIso()
          };

          await updateState((current) => {
            upsertStateRecord(current.records, updatedRecord);
            current.steps.response_received = "done";
            if (progressed.calendarUpdated || updatedRecord.calendarEventId) {
              current.steps.calendar_updated = "done";
            }
          });

          console.info("[twilio-webhook] sheet state after", {
            correlationId,
            sheetStateAfter: summarizeSheetState(updatedRecord)
          });
          if (progressed.calendarUpdated || updatedRecord.calendarEventId) {
            console.info("[twilio-webhook] calendar step reached", {
              correlationId,
              flowType: updatedRecord.flowType,
              conversationState: updatedRecord.conversationState,
              calendarEventId: updatedRecord.calendarEventId,
              selectedSlot: updatedRecord.selectedSlot
            });
          }

          try {
            await updateRecordInSpreadsheet(updatedRecord);
          } catch (sheetError) {
            console.warn("[twilio-webhook] could not sync guided flow update to Google Sheets", sheetError);
          }

          await logActivity({
            correlationId: record.id.slice(0, 8),
            paciente: record.nombre,
            telefono: record.telefono,
            accion: "response_received",
            resultado: updatedRecord.intentDetected || "guided",
            detalle: `Mensaje entrante: ${inboundMessage}`
          });

          for (const flowLog of progressed.logs) {
            await logActivity({
              correlationId: record.id.slice(0, 8),
              paciente: record.nombre,
              telefono: record.telefono,
              accion: flowLog.accion,
              resultado: flowLog.resultado,
              detalle: flowLog.detalle
            });
          }

          return buildTwimlResponse(progressed.replyMessage);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Error desconocido en flujo guiado.";
        await logActivity({
          correlationId: record.id.slice(0, 8),
          paciente: record.nombre,
          telefono: record.telefono,
          accion: "webhook_route_error",
          resultado: "guided_flow_error",
          detalle: message
        });
        return buildTwimlResponse("Hemos recibido tu mensaje y lo estamos revisando manualmente.");
      }
    }

    const intent = classifyIntent(inboundMessage, record.tipoAccion);
    console.info("[twilio-webhook] intent parsed", {
      correlationId,
      intent,
      flowType: record.flowType || "simple_intent"
    });
    let updatedRecord: DemoRecord = {
      ...record,
      ultimaRespuesta: inboundMessage,
      lastUserMessage: inboundMessage,
      intencion: intent,
      intentDetected: intent,
      estadoWhatsapp: intent === "rechazo" ? "rechazo" : "respondido",
      conversationClosed: intent === "rechazo",
      updatedAtDemo: nowIso()
    };
    let replyMessage = buildAutoReply(intent);
    let calendarResultStatus: string | null = null;

    try {
      const processed = await processIntentWithCalendar(
        {
          ...record,
          ultimaRespuesta: inboundMessage,
          intencion: intent
        },
        intent
      );
      const resolvedStatus = intent === "rechazo" ? "rechazo" : processed.status;

      updatedRecord = {
        ...updatedRecord,
        ...processed.record,
        estadoWhatsapp: resolvedStatus,
        conversationClosed:
          resolvedStatus === "rechazo" ||
          resolvedStatus === "calendar_creado" ||
          resolvedStatus === "pendiente_reprogramacion",
        updatedAtDemo: nowIso()
      };
      calendarResultStatus = resolvedStatus;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "No se pudo crear o actualizar Google Calendar.";

      await updateState((current) => {
        upsertStateRecord(current.records, updatedRecord);
        current.steps.response_received = "done";
        current.steps.calendar_updated = "error";
      });

      console.info("[twilio-webhook] sheet state after", {
        correlationId,
        sheetStateAfter: summarizeSheetState(updatedRecord)
      });

      try {
        await updateRecordInSpreadsheet(updatedRecord);
      } catch (sheetError) {
        console.warn("[twilio-webhook] could not sync calendar error state to Google Sheets", sheetError);
      }
      await logActivity({
        correlationId: record.id.slice(0, 8),
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "response_received",
        resultado: intent,
        detalle: `Mensaje entrante: ${inboundMessage}`
      });
      await logActivity({
        correlationId: record.id.slice(0, 8),
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "webhook_route_error",
        resultado: "calendar_processing_error",
        detalle: errorMessage
      });
      return buildTwimlResponse("Hemos recibido tu mensaje y estamos revisando tu solicitud.");
    }

    await updateState((current) => {
      upsertStateRecord(current.records, updatedRecord);
      current.steps.response_received = "done";
      if (calendarResultStatus === "calendar_creado" || calendarResultStatus === "pendiente_reprogramacion") {
        current.steps.calendar_updated = "done";
      }
    });

    console.info("[twilio-webhook] sheet state after", {
      correlationId,
      sheetStateAfter: summarizeSheetState(updatedRecord)
    });

    try {
      await updateRecordInSpreadsheet(updatedRecord);
    } catch (sheetError) {
      console.warn("[twilio-webhook] could not sync inbound update to Google Sheets", sheetError);
    }
    await logActivity({
      correlationId: record.id.slice(0, 8),
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "response_received",
      resultado: intent,
      detalle: `Mensaje entrante: ${inboundMessage}`
    });

    return buildTwimlResponse(replyMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado en el webhook inbound.";
    try {
      await logActivity({
        correlationId: "webhook",
        paciente: "desconocido",
        telefono: "",
        accion: "webhook_route_error",
        resultado: "unexpected_error",
        detalle: message
      });
    } catch {
      console.warn("[twilio-webhook] failed to log unexpected inbound error", error);
    }
    return buildTwimlResponse("Hemos recibido tu mensaje y lo estamos revisando manualmente.");
  }
}
