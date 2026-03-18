import { randomUUID } from "node:crypto";

import { nowIso } from "@/lib/dateUtils";
import { buildTriggerHash, buildTriggerReopenHash } from "@/lib/hash";
import { normalizeActionTypeValue } from "@/lib/normalization";
import { readState, updateState } from "@/lib/stateStore";
import { hydrateOpenGuidedFlowRecord, prepareGuidedFlowStart } from "@/services/conversationFlowService";
import { logActivity } from "@/services/loggerService";
import {
  buildReconstructedImportSummary,
  getSpreadsheetUrl,
  readAllRowsFromSpreadsheet,
  readRecordByIdFromSpreadsheet,
  updateRecordInSpreadsheet
} from "@/services/sheetsService";
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
    estadoWhatsapp: "pendiente",
    ultimaRespuesta: "",
    intencion: "",
    flowType: "",
    conversationState: "",
    lastBotMessageType: "",
    lastUserMessage: "",
    intentDetected: "",
    proposedSlots: [],
    selectedSlot: "",
    conversationClosed: false,
    lastSentMessage: ""
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

  const resolvedSpreadsheetId =
    spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID?.trim() || state.spreadsheetId;
  const spreadsheetUrl = resolvedSpreadsheetId ? await getSpreadsheetUrl(resolvedSpreadsheetId) : state.spreadsheetUrl;
  const importSummary = state.importSummary ?? buildReconstructedImportSummary(sheetRecords);

  return updateState((current) => {
    const merged = [...current.records];
    for (const record of sheetRecords) {
      upsertRecord(merged, record);
    }
    current.records = merged;
    current.spreadsheetId = resolvedSpreadsheetId || current.spreadsheetId;
    current.spreadsheetUrl = spreadsheetUrl || current.spreadsheetUrl;
    current.importSummary = current.importSummary ?? importSummary;
    current.uploadedFilePath = current.uploadedFilePath || "reconstructed:google-sheets";
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

    const previousFlowType = latestRecord?.flowType ?? "";
    const previousTipoAccion = latestRecord?.tipoAccion ?? "";
    const previousTipoAccionNormalized = normalizeActionTypeValue(previousTipoAccion, previousTipoAccion);
    let currentTipoAccionRaw = record.tipoAccion;
    let currentTipoAccionNormalized = normalizeActionTypeValue(currentTipoAccionRaw, currentTipoAccionRaw);
    const reopenedHashChanged =
      buildTriggerReopenHash(latestRecord ?? record) !== buildTriggerReopenHash(record);
    const tipoAccionChanged = previousTipoAccionNormalized !== currentTipoAccionNormalized;
    const openConversation = latestRecord ? isConversationOpen(latestRecord) : false;
    const closedConversation = latestRecord
      ? latestRecord.conversationClosed || isConversationClosed(latestRecord)
      : false;
    let currentRecord = record;
    let flowTypeRecomputed = "";
    let staleFlowStateCleared = false;

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

    if ((openConversation || closedConversation) && reopenedHashChanged && tipoAccionChanged) {
      const reloadedRecord = await readRecordByIdFromSpreadsheet(record.id, spreadsheetId);
      if (!reloadedRecord) {
        console.info("[triggerService] outbound skipped due to stale flow", {
          correlationId,
          reason: "record_not_found_after_rehydrate",
          previousFlowType,
          previousTipoAccion,
          currentTipoAccionRaw,
          currentTipoAccionNormalized,
          flowTypeRecomputed: "",
          staleFlowStateCleared: false
        });
        await logActivity({
          correlationId,
          paciente: record.nombre,
          telefono: record.telefono,
          accion: "trigger_skipped_stale_flow",
          resultado: "record_not_found_after_rehydrate",
          detalle: "Se omitió el envío porque no se pudo recargar la fila actual desde Google Sheets."
        });
        continue;
      }

      const reloadedTipoAccionRaw = reloadedRecord.tipoAccion;
      const reloadedTipoAccionNormalized = normalizeActionTypeValue(
        reloadedTipoAccionRaw,
        reloadedTipoAccionRaw
      );

      if (reloadedTipoAccionNormalized !== currentTipoAccionNormalized) {
        console.info("[triggerService] outbound skipped due to stale flow", {
          correlationId,
          reason: "tipo_accion_changed_during_rehydrate",
          previousFlowType,
          previousTipoAccion,
          currentTipoAccionRaw: reloadedTipoAccionRaw,
          currentTipoAccionNormalized: reloadedTipoAccionNormalized,
          flowTypeRecomputed: "",
          staleFlowStateCleared: false
        });
        await logActivity({
          correlationId,
          paciente: reloadedRecord.nombre,
          telefono: reloadedRecord.telefono,
          accion: "trigger_skipped_stale_flow",
          resultado: "tipo_accion_changed_during_rehydrate",
          detalle: "Se omitió el envío porque la fila cambió durante la rehidratación y el flujo ya no era estable."
        });
        continue;
      }

      const rehydratedRecord = clearConversationState({
        ...reloadedRecord,
        tipoAccion: reloadedTipoAccionNormalized
      });
      const rehydratedFlow = prepareGuidedFlowStart(rehydratedRecord);

      currentTipoAccionRaw = reloadedTipoAccionRaw;
      currentTipoAccionNormalized = reloadedTipoAccionNormalized;
      flowTypeRecomputed = rehydratedFlow?.record.flowType ?? "";
      staleFlowStateCleared = Boolean(
        previousFlowType ||
          previousTipoAccion ||
          latestRecord?.conversationState ||
          latestRecord?.intentDetected ||
          latestRecord?.intencion ||
          latestRecord?.ultimaRespuesta
      );
      currentRecord = {
        ...rehydratedRecord,
        lastProcessedHash: buildTriggerHash(rehydratedRecord)
      };

      console.info("[triggerService] reopen detected", {
        correlationId,
        previousFlowType,
        previousTipoAccion,
        currentTipoAccionRaw,
        currentTipoAccionNormalized,
        flowTypeRecomputed,
        staleFlowStateCleared
      });
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
        paciente: currentRecord.nombre,
        telefono: currentRecord.telefono,
        accion: "trigger_detected",
        resultado: "ok",
        detalle: `Cambio detectado en ${currentRecord.sheetName} para ${currentRecord.tratamientoRealizado}.`
      });
    }
    processedCount += 1;

    if (shouldSkipTrigger(currentRecord)) {
      await updateState((current) => {
        upsertRecord(current.records, {
          ...currentRecord,
          updatedAtDemo: nowIso()
        });
        current.steps.trigger_detected = "done";
      });
      await updateRecordInSpreadsheet(currentRecord, spreadsheetId);
      console.info("[triggerService] outbound skipped reason", {
        correlationId,
        reason: "missing_date_or_validation",
        sheetStateBefore: summarizeSheetState(latestRecord),
        sheetStateAfter: summarizeSheetState(currentRecord)
      });
      await logActivity({
        correlationId,
        paciente: currentRecord.nombre,
        telefono: currentRecord.telefono,
        accion: "trigger_skipped",
        resultado: "sin_fecha_o_validacion",
        detalle: "Cambio detectado pero sin fecha válida o con error de validación."
      });
      continue;
    }

    const normalizedTipoAccion = normalizeActionTypeValue(
      currentRecord.tipoAccion,
      currentRecord.tipoAccion
    );
    const normalizedRecord = {
      ...currentRecord,
      tipoAccion: normalizedTipoAccion
    } satisfies DemoRecord;
    const flowStart = prepareGuidedFlowStart(clearConversationState(normalizedRecord));
    let outboundRecord = flowStart?.record ?? clearConversationState(normalizedRecord);
    const selectedFlowType = flowStart?.record.flowType ?? "";
    const selectedTemplate =
      selectedFlowType === "cumpleanos"
        ? "birthday"
        : flowStart
          ? flowStart.record.lastBotMessageType
          : normalizedTipoAccion;
    const reasonSelected =
      selectedFlowType === "cumpleanos"
        ? "explicit_birthday_tipo_accion"
        : flowStart
          ? "heuristic_guided_flow"
          : "generic_template_from_tipo_accion";

    console.info("[triggerService] outbound flow candidate", {
      correlationId,
      normalizedTipoAccion,
      selectedFlowType,
      selectedTemplate,
      reasonSelected,
      sheetStateBefore: summarizeSheetState(latestRecord)
    });
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
        ...currentRecord,
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
        paciente: currentRecord.nombre,
        telefono: currentRecord.telefono,
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
    if ((openConversation || closedConversation) && reopenedHashChanged && tipoAccionChanged) {
      console.info("[triggerService] outbound sent after rehydrate", {
        correlationId,
        previousFlowType,
        previousTipoAccion,
        currentTipoAccionRaw,
        currentTipoAccionNormalized,
        flowTypeRecomputed,
        staleFlowStateCleared,
        sentSid
      });
    }

    await logActivity({
      correlationId,
      paciente: currentRecord.nombre,
      telefono: currentRecord.telefono,
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
