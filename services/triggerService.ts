import { randomUUID } from "node:crypto";

import { nowIso } from "@/lib/dateUtils";
import { applyDemoV2SheetFlow, getDemoV2Config, getDemoV2TriggerDate, isDemoV2SingleRowEnabled } from "@/lib/demoV2";
import { buildDemoV2ObservationHash, buildDemoV2RelevantHash, buildTriggerHash, buildTriggerReopenHash } from "@/lib/hash";
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

function summarizeDemoV2State(record?: DemoRecord | null) {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    sheetName: record.sheetName,
    sheetRowNumber: record.sheetRowNumber,
    telefono: record.telefono,
    fechaTratamiento: record.fechaTratamiento,
    fechaAccion: record.fechaAccion,
    tipoAccion: record.tipoAccion,
    flowType: record.flowType,
    estadoWhatsapp: record.estadoWhatsapp,
    lastProcessedHash: record.lastProcessedHash,
    v2TriggerPhone: record.v2TriggerPhone,
    v2TriggerDate: record.v2TriggerDate
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

async function runDemoV2TriggerCheck(spreadsheetId?: string) {
  const correlationId = randomUUID().slice(0, 8);
  const config = getDemoV2Config();
  const state = await readState();
  const sheetRecords = await readAllRowsFromSpreadsheet(spreadsheetId);
  const orderedRecords = config.validSheetNames.flatMap((sheetName) =>
    sheetRecords
      .filter((record) => record.sheetName === sheetName)
      .sort((left, right) => left.sheetRowNumber - right.sheetRowNumber)
  );
  const trackedRecords = [...state.records];
  let processedCount = 0;
  let sentCount = 0;

  console.info("[triggerService] v2 single-row mode enabled", {
    correlationId,
    validSheets: config.validSheetNames,
    rowLocked: config.rowIndex
  });

  async function persistTrackedRecord(record: DemoRecord) {
    await updateState((current) => {
      upsertRecord(current.records, record);
      current.steps.trigger_detected = "done";
    });

    upsertRecord(trackedRecords, record);
  }

  for (const record of orderedRecords) {
    const existing =
      trackedRecords.find((item) => item.id === record.id) ??
      trackedRecords.find(
        (item) => item.sheetName === record.sheetName && item.sheetRowNumber === record.sheetRowNumber
      ) ??
      null;
    const triggerDate = getDemoV2TriggerDate(record);
    const baselinePhone = existing?.v2TriggerPhone ?? existing?.telefono ?? record.telefono;
    const baselineDate = existing?.v2TriggerDate ?? getDemoV2TriggerDate(existing ?? record);
    const relevantHash = buildDemoV2RelevantHash(record.telefono, triggerDate);
    const observationHash = buildDemoV2ObservationHash(record);
    const previousObservationHash = existing ? existing.lastObservedHash ?? buildDemoV2ObservationHash(existing) : "";
    const trackedRecord = {
      ...record,
      lastObservedHash: observationHash,
      lastProcessedHash: existing?.lastProcessedHash ?? relevantHash,
      v2TriggerPhone: existing?.v2TriggerPhone ?? baselinePhone,
      v2TriggerDate: existing?.v2TriggerDate ?? baselineDate
    } satisfies DemoRecord;

    console.info("[triggerService] sheet detected", {
      correlationId,
      sheetName: record.sheetName,
      rowNumber: record.sheetRowNumber
    });

    if (record.sheetRowNumber !== config.rowIndex) {
      if (previousObservationHash !== observationHash) {
        console.info("[triggerService] ignored row because not row 2", {
          correlationId,
          sheetName: record.sheetName,
          rowNumber: record.sheetRowNumber,
          rowLocked: config.rowIndex
        });
        await persistTrackedRecord(trackedRecord);
        processedCount += 1;
      }
      continue;
    }

    console.info("[triggerService] row locked = 2", {
      correlationId,
      sheetName: record.sheetName,
      rowLocked: config.rowIndex
    });

    if (!existing) {
      await persistTrackedRecord({
        ...trackedRecord,
        lastProcessedHash: relevantHash,
        v2TriggerPhone: record.telefono,
        v2TriggerDate: triggerDate
      });
      continue;
    }

    const phoneChanged = record.telefono !== baselinePhone;
    const dateChanged = triggerDate !== baselineDate;
    const observedChanged = previousObservationHash !== observationHash;

    if (!phoneChanged && !dateChanged) {
      if (observedChanged) {
        console.info("[triggerService] ignored non-relevant change", {
          correlationId,
          sheetName: record.sheetName,
          rowNumber: record.sheetRowNumber,
          before: summarizeDemoV2State(existing),
          after: summarizeDemoV2State(trackedRecord)
        });
        console.info("[triggerService] outbound skipped no relevant double-change", {
          correlationId,
          sheetName: record.sheetName,
          phoneChanged,
          dateChanged
        });
        await persistTrackedRecord(trackedRecord);
        processedCount += 1;
      }
      continue;
    }

    if (phoneChanged !== dateChanged) {
      console.info(
        phoneChanged
          ? "[triggerService] ignored because only phone changed"
          : "[triggerService] ignored because only date changed",
        {
          correlationId,
          sheetName: record.sheetName,
          rowNumber: record.sheetRowNumber,
          baselinePhone,
          currentPhone: record.telefono,
          baselineDate,
          currentDate: triggerDate
        }
      );
      console.info("[triggerService] outbound skipped no relevant double-change", {
        correlationId,
        sheetName: record.sheetName,
        phoneChanged,
        dateChanged
      });
      await persistTrackedRecord(trackedRecord);
      processedCount += 1;
      continue;
    }

    const appliedFlow = applyDemoV2SheetFlow(record);
    if (!appliedFlow) {
      console.info("[triggerService] ignored non-relevant change", {
        correlationId,
        reason: "sheet_without_v2_flow_mapping",
        sheetName: record.sheetName
      });
      await persistTrackedRecord(trackedRecord);
      processedCount += 1;
      continue;
    }

    console.info("[triggerService] relevant double-change detected", {
      correlationId,
      sheetName: record.sheetName,
      rowNumber: record.sheetRowNumber,
      previousPhone: baselinePhone,
      currentPhone: record.telefono,
      previousDate: baselineDate,
      currentDate: triggerDate
    });
    console.info("[triggerService] flow selected from sheet", {
      correlationId,
      sheetName: record.sheetName,
      selectedFlow: appliedFlow.config.selectedFlowLabel
    });

    const outboundBase = clearConversationState({
      ...appliedFlow.record,
      flowType: ""
    });
    const flowStart = prepareGuidedFlowStart(outboundBase);
    let outboundRecord = flowStart?.record ?? outboundBase;
    const selectedFlowType = flowStart?.record.flowType ?? appliedFlow.config.flowType;
    const selectedTemplate = flowStart?.record.lastBotMessageType ?? appliedFlow.record.tipoAccion;
    const reasonSelected = `sheet:${record.sheetName}`;

    console.info("[triggerService] outbound flow candidate", {
      correlationId,
      selectedFlowType,
      selectedTemplate,
      reasonSelected,
      sheetStateBefore: summarizeDemoV2State(existing)
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
      const errorMessage =
        error instanceof Error ? error.message : "No se pudo enviar el WhatsApp por Twilio.";
      const failedRecord = {
        ...outboundRecord,
        estadoWhatsapp: "error" as const,
        lastObservedHash: observationHash,
        lastProcessedHash: relevantHash,
        v2TriggerPhone: record.telefono,
        v2TriggerDate: triggerDate,
        updatedAtDemo: nowIso()
      } satisfies DemoRecord;

      await updateState((current) => {
        upsertRecord(current.records, failedRecord);
        current.steps.trigger_detected = "done";
        current.steps.whatsapp_sent = "error";
      });

      upsertRecord(trackedRecords, failedRecord);

      await updateRecordInSpreadsheet(failedRecord, spreadsheetId);
      await logActivity({
        correlationId,
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "whatsapp_error",
        resultado: "error",
        detalle: errorMessage
      });
      processedCount += 1;
      break;
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
      lastObservedHash: observationHash,
      lastProcessedHash: relevantHash,
      v2TriggerPhone: record.telefono,
      v2TriggerDate: triggerDate,
      updatedAtDemo: nowIso()
    } satisfies DemoRecord;

    await updateState((current) => {
      upsertRecord(current.records, updatedRecord);
      current.steps.trigger_detected = "done";
      current.steps.whatsapp_sent = "done";
    });

    upsertRecord(trackedRecords, updatedRecord);

    try {
      await updateRecordInSpreadsheet(updatedRecord, spreadsheetId);
    } catch (error) {
      console.warn("[triggerService] could not sync outbound WhatsApp state to Google Sheets", error);
    }

    console.info("[triggerService] outbound sent in v2", {
      correlationId,
      sentSid,
      sheetName: record.sheetName,
      rowNumber: record.sheetRowNumber,
      sheetStateAfter: summarizeDemoV2State(updatedRecord)
    });

    await logActivity({
      correlationId,
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "trigger_detected_v2",
      resultado: "ok",
      detalle: `Cambio doble detectado en fila ${config.rowIndex} de ${record.sheetName}.`
    });
    await logActivity({
      correlationId,
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "whatsapp_sent",
      resultado: "ok",
      detalle: `Mensaje enviado por Twilio (${sentSid}) en modo v2.`
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

    processedCount += 1;
    break;
  }

  return {
    changed: processedCount,
    sent: sentCount
  };
}

async function runTriggerCheck(spreadsheetId?: string) {
  if (isDemoV2SingleRowEnabled()) {
    return runDemoV2TriggerCheck(spreadsheetId);
  }

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
