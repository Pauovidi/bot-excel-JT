import { randomUUID } from "node:crypto";

import { nowIso } from "@/lib/dateUtils";
import { buildTriggerHash, buildTriggerReopenHash } from "@/lib/hash";
import { readState, updateState } from "@/lib/stateStore";
import { hydrateOpenGuidedFlowRecord, prepareGuidedFlowStart } from "@/services/conversationFlowService";
import { logActivity } from "@/services/loggerService";
import { readAllRowsFromSpreadsheet, updateRecordInSpreadsheet } from "@/services/sheetsService";
import { sendWhatsApp } from "@/services/twilioService";
import type { DemoRecord } from "@/types/demo";

let triggerCheckInFlight: Promise<{ changed: number; sent: number }> | null = null;
const CLOSED_WHATSAPP_STATUSES = new Set<DemoRecord["estadoWhatsapp"]>([
  "respondido",
  "calendar_creado",
  "pendiente_reprogramacion",
  "rechazo"
]);

function shouldSkipTrigger(record: DemoRecord) {
  return !record.telefono || record.validationErrors.length > 0 || (record.tipoAccion === "recordatorio" && !record.fechaAccion);
}

function isConversationClosed(record: DemoRecord) {
  return CLOSED_WHATSAPP_STATUSES.has(record.estadoWhatsapp);
}

function isConversationOpen(record: DemoRecord) {
  if (record.conversationClosed) {
    return false;
  }

  return (
    record.estadoWhatsapp === "enviado" ||
    Boolean(record.flowType) ||
    Boolean(record.conversationState) ||
    Boolean(record.lastBotMessageType) ||
    Boolean(record.lastSentMessage)
  );
}

function clearConversationState(record: DemoRecord) {
  return {
    ...record,
    flowType: "",
    conversationState: "",
    lastBotMessageType: "",
    lastUserMessage: "",
    intentDetected: "",
    proposedSlots: [],
    selectedSlot: "",
    conversationClosed: false
  } satisfies DemoRecord;
}

function upsertRecord(records: DemoRecord[], record: DemoRecord) {
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    records[index] = {
      ...records[index],
      ...record
    };
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

export async function syncStateFromSheets(spreadsheetId?: string) {
  const state = await readState();
  const sheetRecords = (await readAllRowsFromSpreadsheet(spreadsheetId)).map(hydrateOpenGuidedFlowRecord);

  if (sheetRecords.length === 0) {
    return state;
  }

  return updateState((current) => {
    const merged = [...current.records];
    for (const record of sheetRecords) {
      upsertRecord(merged, record);
    }
    current.records = merged;
  });
}

async function runTriggerCheck(spreadsheetId?: string) {
  const correlationId = randomUUID().slice(0, 8);
  const state = await readState();
  const sheetRecords = (await readAllRowsFromSpreadsheet(spreadsheetId)).map(hydrateOpenGuidedFlowRecord);
  const changed = sheetRecords
    .map((record) => {
      const existing = state.records.find((item) => item.id === record.id);
      const merged = hydrateOpenGuidedFlowRecord({
        ...(existing ? hydrateOpenGuidedFlowRecord(existing) : record),
        ...record
      });
      const currentHash = buildTriggerHash(merged);
      const previousHash = existing?.lastProcessedHash || record.lastProcessedHash;
      if (currentHash === previousHash) {
        return null;
      }

      return {
        ...merged,
        lastProcessedHash: currentHash
      };
    })
    .filter((record): record is DemoRecord => Boolean(record));
  let processedCount = 0;
  let sentCount = 0;

  for (const record of changed) {
    const latestState = await readState();
    const latestRecord = hydrateOpenGuidedFlowRecord(
      latestState.records.find((item) => item.id === record.id) ??
        sheetRecords.find((item) => item.id === record.id) ??
        record
    );
    if (latestRecord?.lastProcessedHash === record.lastProcessedHash) {
      continue;
    }

    const reopenedHashChanged =
      buildTriggerReopenHash(latestRecord ?? record) !== buildTriggerReopenHash(record);
    const openConversation = latestRecord ? isConversationOpen(latestRecord) : false;
    const closedConversation = latestRecord
      ? latestRecord.conversationClosed || isConversationClosed(latestRecord)
      : false;

    console.info("[triggerService] outbound candidate", {
      correlationId,
      reopenedHashChanged,
      openConversation,
      closedConversation,
      sheetStateBefore: summarizeSheetState(latestRecord),
      sheetStateAfter: summarizeSheetState(record)
    });

    if ((openConversation || closedConversation) && !reopenedHashChanged) {
      const preservedRecord = latestRecord ?? record;
      const skippedRecord = {
        ...record,
        estadoWhatsapp: preservedRecord.estadoWhatsapp,
        ultimaRespuesta: preservedRecord.ultimaRespuesta,
        intencion: preservedRecord.intencion,
        flowType: preservedRecord.flowType,
        conversationState: preservedRecord.conversationState,
        lastBotMessageType: preservedRecord.lastBotMessageType,
        lastUserMessage: preservedRecord.lastUserMessage,
        intentDetected: preservedRecord.intentDetected,
        proposedSlots: preservedRecord.proposedSlots,
        selectedSlot: preservedRecord.selectedSlot,
        conversationClosed: preservedRecord.conversationClosed,
        calendarEventId: preservedRecord.calendarEventId,
        lastSentMessage: preservedRecord.lastSentMessage,
        lastProcessedHash: record.lastProcessedHash,
        updatedAtDemo: nowIso()
      } satisfies DemoRecord;

      await updateState((current) => {
        upsertRecord(current.records, skippedRecord);
        current.steps.trigger_detected = "done";
      });

      await updateRecordInSpreadsheet(skippedRecord, spreadsheetId);

      console.info("[triggerService] outbound skipped reason", {
        correlationId,
        reason: openConversation ? "conversation_already_open" : "conversation_already_closed",
        reopenedHashChanged,
        sheetStateBefore: summarizeSheetState(latestRecord),
        sheetStateAfter: summarizeSheetState(skippedRecord)
      });

      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: openConversation ? "trigger_skipped_open_conversation" : "trigger_skipped_already_closed",
        resultado: "ok",
        detalle: openConversation
          ? "La conversación ya estaba abierta y no hubo cambio en tipo_accion, fecha_accion u hora_cita."
          : "La conversación ya estaba cerrada y no hubo cambio en tipo_accion, fecha_accion u hora_cita."
      });
      processedCount += 1;
      continue;
    }

    if ((openConversation || closedConversation) && reopenedHashChanged) {
      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "trigger_reopened_due_to_new_change",
        resultado: "ok",
        detalle: "Se reabre el flujo porque cambió tipo_accion, fecha_accion u hora_cita."
      });
    } else {
      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "trigger_detected",
        resultado: "ok",
        detalle: `Cambio detectado en ${record.sheetName} para ${record.tratamientoRealizado}.`
      });
    }
    processedCount += 1;

    if (shouldSkipTrigger(record)) {
      await updateState((current) => {
        upsertRecord(current.records, {
          ...record,
          updatedAtDemo: nowIso()
        });
        current.steps.trigger_detected = "done";
      });
      await updateRecordInSpreadsheet(record, spreadsheetId);
      console.info("[triggerService] outbound skipped reason", {
        correlationId,
        reason: "missing_date_or_validation",
        sheetStateBefore: summarizeSheetState(latestRecord),
        sheetStateAfter: summarizeSheetState(record)
      });
      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "trigger_skipped",
        resultado: "sin_fecha_o_validacion",
        detalle: "Cambio detectado pero sin fecha válida o con error de validación."
      });
      continue;
    }

    const flowStart = prepareGuidedFlowStart(clearConversationState(record));
    let outboundRecord = flowStart?.record ?? clearConversationState(record);
    let sentBody = "";
    let sentSid = "";
    try {
      const sent = await sendWhatsApp(outboundRecord, {
        body: flowStart?.message,
        mediaUrl: flowStart?.mediaUrl
      });
      sentBody = sent.body;
      sentSid = sent.sid;
      sentCount += 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "No se pudo enviar el WhatsApp por Twilio.";
      const failedRecord = {
        ...record,
        estadoWhatsapp: "error" as const,
        updatedAtDemo: nowIso()
      };

      await updateState((current) => {
        upsertRecord(current.records, failedRecord);
        current.steps.trigger_detected = "done";
        current.steps.whatsapp_sent = "error";
      });

      await updateRecordInSpreadsheet(failedRecord, spreadsheetId);
      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "whatsapp_error",
        resultado: "error",
        detalle: errorMessage
      });
      continue;
    }

    const updatedRecord = {
      ...outboundRecord,
      estadoWhatsapp: "enviado" as const,
      ultimaRespuesta: "",
      intencion: "" as const,
      lastUserMessage: "",
      intentDetected: "",
      selectedSlot: "",
      conversationClosed: false,
      lastSentMessage: sentBody,
      updatedAtDemo: nowIso()
    };

    await updateState((current) => {
      upsertRecord(current.records, updatedRecord);
      current.steps.trigger_detected = "done";
      current.steps.whatsapp_sent = "done";
    });

    try {
      await updateRecordInSpreadsheet(updatedRecord, spreadsheetId);
    } catch (error) {
      console.warn("[triggerService] could not sync outbound WhatsApp state to Google Sheets", error);
    }

    console.info("[triggerService] outbound sent", {
      correlationId,
      sentSid,
      sheetStateBefore: summarizeSheetState(latestRecord),
      sheetStateAfter: summarizeSheetState(updatedRecord)
    });

    await logActivity({
      correlationId,
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "whatsapp_sent",
      resultado: "ok",
      detalle: `Mensaje enviado por Twilio (${sentSid}).`
    });

    for (const flowLog of flowStart?.logs ?? []) {
      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: flowLog.accion,
        resultado: flowLog.resultado,
        detalle: flowLog.detalle
      });
    }
  }

  return {
    changed: processedCount,
    sent: sentCount
  };
}

export async function checkForSheetChanges(spreadsheetId?: string) {
  if (triggerCheckInFlight) {
    return triggerCheckInFlight;
  }

  triggerCheckInFlight = runTriggerCheck(spreadsheetId).finally(() => {
    triggerCheckInFlight = null;
  });

  return triggerCheckInFlight;
}
