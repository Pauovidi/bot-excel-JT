import { randomUUID } from "node:crypto";

import { nowIso } from "@/lib/dateUtils";
import { getDemoV2Config, getDemoV2TriggerDate, isDemoV2SingleRowEnabled, isDemoV2ValidSheet } from "@/lib/demoV2";
import { buildDemoV2ObservationHash, buildDemoV2RelevantHash, buildTriggerHash, buildTriggerReopenHash } from "@/lib/hash";
import { normalizeActionTypeValue, normalizeHeaderKey } from "@/lib/normalization";
import { readState, updateState } from "@/lib/stateStore";
import { hydrateOpenGuidedFlowRecord, prepareGuidedFlowStart } from "@/services/conversationFlowService";
import { logActivity } from "@/services/loggerService";
import {
  buildReconstructedImportSummary,
  getSpreadsheetUrl,
  readAllRowsFromSpreadsheet,
  readRecordByIdFromSpreadsheet,
  readSheetRowFromSpreadsheet,
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
    v2TriggerDate: record.v2TriggerDate,
    v2TriggerAction: record.v2TriggerAction
  };
}

function getDemoV2FlowDecision(record: DemoRecord) {
  const normalizedAction = normalizeActionTypeValue(record.tipoAccion, record.tipoAccion);
  const normalizedSheet = normalizeHeaderKey(record.sheetName || record.tratamientoRealizado);

  if (normalizedAction === "cumpleanos") {
    return {
      normalizedAction,
      decision: "cumpleanos",
      normalizedRecord: {
        ...record,
        tipoAccion: "cumpleanos",
        fechaAccion: getDemoV2TriggerDate(record),
        flowType: ""
      } satisfies DemoRecord
    };
  }

  if (normalizedAction === "promo" && normalizedSheet.includes("implant")) {
    return {
      normalizedAction,
      decision: "implantologia_recuperacion",
      normalizedRecord: {
        ...record,
        tipoAccion: "promo",
        fechaAccion: getDemoV2TriggerDate(record),
        flowType: ""
      } satisfies DemoRecord
    };
  }

  if (normalizedAction === "revision" && normalizedSheet.includes("ortodon")) {
    return {
      normalizedAction,
      decision: "revision_ortodoncia",
      normalizedRecord: {
        ...record,
        tipoAccion: "revision",
        fechaAccion: getDemoV2TriggerDate(record),
        flowType: ""
      } satisfies DemoRecord
    };
  }

  if (normalizedAction === "revision" && normalizedSheet.includes("limpieza")) {
    return {
      normalizedAction,
      decision: "revision_limpieza_generica",
      normalizedRecord: {
        ...record,
        tipoAccion: "revision",
        fechaAccion: getDemoV2TriggerDate(record),
        flowType: ""
      } satisfies DemoRecord
    };
  }

  return {
    normalizedAction,
    decision: `generic_${normalizedAction || "revision"}`,
    normalizedRecord: {
      ...record,
      tipoAccion: normalizedAction,
      fechaAccion: getDemoV2TriggerDate(record),
      flowType: ""
    } satisfies DemoRecord
  };
}

type DemoV2PushResult = {
  ok: boolean;
  reason:
    | "processed"
    | "sheet_not_allowed"
    | "row_not_allowed"
    | "record_not_found"
    | "only_phone_changed"
    | "only_date_changed"
    | "non_relevant_change"
    | "duplicate";
  changed: number;
  sent: number;
  sheetName: string;
  rowNumber: number;
};

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

export async function processDemoV2SheetEdit(input: {
  spreadsheetId?: string;
  sheetName: string;
  rowNumber: number;
  correlationId?: string;
}) {
  const correlationId = input.correlationId || randomUUID().slice(0, 8);
  const config = getDemoV2Config();

  console.info("[triggerService] v2 push trigger received", {
    correlationId,
    sheetName: input.sheetName,
    rowNumber: input.rowNumber,
    rowLocked: config.rowIndex
  });

  if (!isDemoV2ValidSheet(input.sheetName)) {
    console.info("[triggerService] ignored push event unsupported sheet", {
      correlationId,
      sheetName: input.sheetName
    });
    return {
      ok: true,
      reason: "sheet_not_allowed",
      changed: 0,
      sent: 0,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber
    } satisfies DemoV2PushResult;
  }

  if (input.rowNumber !== config.rowIndex) {
    console.info("[triggerService] ignored row because not row 2", {
      correlationId,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber,
      rowLocked: config.rowIndex
    });
    return {
      ok: true,
      reason: "row_not_allowed",
      changed: 0,
      sent: 0,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber
    } satisfies DemoV2PushResult;
  }

  const liveRecord = await readSheetRowFromSpreadsheet(input.sheetName, input.rowNumber, input.spreadsheetId);
  if (!liveRecord) {
    console.info("[triggerService] ignored push event missing row", {
      correlationId,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber
    });
    return {
      ok: true,
      reason: "record_not_found",
      changed: 0,
      sent: 0,
      sheetName: input.sheetName,
      rowNumber: input.rowNumber
    } satisfies DemoV2PushResult;
  }

  const state = await readState();
  const existing =
    state.records.find((item) => item.id === liveRecord.id) ??
    state.records.find(
      (item) => item.sheetName === liveRecord.sheetName && item.sheetRowNumber === liveRecord.sheetRowNumber
    ) ??
    null;
  const triggerDate = getDemoV2TriggerDate(liveRecord);
  const currentAction = normalizeActionTypeValue(liveRecord.tipoAccion, liveRecord.tipoAccion);
  const relevantHash = buildDemoV2RelevantHash(liveRecord.telefono, triggerDate, currentAction);
  const observationHash = buildDemoV2ObservationHash(liveRecord);
  const previousObservationHash = existing ? existing.lastObservedHash ?? buildDemoV2ObservationHash(existing) : "";
  const baselinePhone = existing?.v2TriggerPhone ?? existing?.telefono ?? liveRecord.telefono;
  const baselineDate = existing?.v2TriggerDate ?? getDemoV2TriggerDate(existing ?? liveRecord);
  const baselineAction =
    existing?.v2TriggerAction ??
    normalizeActionTypeValue(existing?.tipoAccion ?? liveRecord.tipoAccion, liveRecord.tipoAccion);
  const trackedRecord = {
    ...liveRecord,
    lastObservedHash: observationHash,
    lastProcessedHash: existing?.lastProcessedHash ?? relevantHash,
    v2TriggerPhone: existing?.v2TriggerPhone ?? baselinePhone,
    v2TriggerDate: existing?.v2TriggerDate ?? baselineDate,
    v2TriggerAction: existing?.v2TriggerAction ?? baselineAction
  } satisfies DemoRecord;

  console.info("[triggerService] v2 push received", {
    correlationId,
    sheetName: liveRecord.sheetName,
    rowNumber: liveRecord.sheetRowNumber
  });
  console.info("[triggerService] sheet valid", {
    correlationId,
    sheetName: liveRecord.sheetName,
    rowNumber: liveRecord.sheetRowNumber
  });
  console.info("[triggerService] row valid", {
    correlationId,
    sheetName: liveRecord.sheetName,
    rowLocked: config.rowIndex
  });
  console.info("[triggerService] baseline processed values", {
    correlationId,
    phone: baselinePhone,
    date: baselineDate,
    action: baselineAction
  });
  console.info("[triggerService] current row values", {
    correlationId,
    phone: liveRecord.telefono,
    date: triggerDate,
    action: currentAction
  });
  console.info("[triggerService] current tipo_accion", {
    correlationId,
    value: currentAction
  });

  if (!existing) {
    await updateState((current) => {
      upsertRecord(current.records, {
        ...trackedRecord,
        lastProcessedHash: relevantHash,
        v2TriggerPhone: liveRecord.telefono,
        v2TriggerDate: triggerDate,
        v2TriggerAction: currentAction
      });
      current.steps.trigger_detected = "done";
    });

    console.info("[triggerService] outbound skipped no relevant triple-change", {
      correlationId,
      reason: "initial_baseline_seeded",
      sheetName: liveRecord.sheetName
    });
    console.info("[triggerService] skip reason", {
      correlationId,
      reason: "initial_baseline_seeded"
    });
    return {
      ok: true,
      reason: "duplicate",
      changed: 0,
      sent: 0,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber
    } satisfies DemoV2PushResult;
  }

  const phoneChanged = liveRecord.telefono !== baselinePhone;
  const dateChanged = triggerDate !== baselineDate;
  const actionChanged = currentAction !== baselineAction;
  const observedChanged = previousObservationHash !== observationHash;
  const birthdayTripleChangeRequired = currentAction === "cumpleanos" && actionChanged;
  const triggerMode = birthdayTripleChangeRequired ? "birthday_triple" : "standard_double";

  console.info("[triggerService] phone changed", {
    correlationId,
    value: phoneChanged
  });
  console.info("[triggerService] date changed", {
    correlationId,
    value: dateChanged
  });
  console.info("[triggerService] tipo_accion changed", {
    correlationId,
    value: actionChanged
  });
  console.info("[triggerService] trigger mode selected", {
    correlationId,
    mode: triggerMode
  });
  if (birthdayTripleChangeRequired) {
    console.info("[triggerService] birthday triple-change required", {
      correlationId,
      baselineAction,
      currentAction
    });
  }

  if (!phoneChanged && !dateChanged && !actionChanged) {
    if (observedChanged) {
      console.info("[triggerService] ignored non-relevant change", {
        correlationId,
        sheetName: liveRecord.sheetName,
        rowNumber: liveRecord.sheetRowNumber,
        before: summarizeDemoV2State(existing),
        after: summarizeDemoV2State(trackedRecord)
      });
      await updateState((current) => {
        upsertRecord(current.records, trackedRecord);
        current.steps.trigger_detected = "done";
      });
    } else {
      console.info("[triggerService] outbound skipped no relevant triple-change", {
        correlationId,
        reason: "duplicate_pair",
        sheetName: liveRecord.sheetName
      });
      console.info("[triggerService] skip reason", {
        correlationId,
        reason: "duplicate_pair"
      });
    }
    return {
      ok: true,
      reason: observedChanged ? "non_relevant_change" : "duplicate",
      changed: observedChanged ? 1 : 0,
      sent: 0,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber
    } satisfies DemoV2PushResult;
  }

  const standardDoubleAccepted = !birthdayTripleChangeRequired && phoneChanged && dateChanged;
  const birthdayTripleAccepted = birthdayTripleChangeRequired && phoneChanged && dateChanged && actionChanged;

  if (!(standardDoubleAccepted || birthdayTripleAccepted)) {
    if (actionChanged && !phoneChanged && !dateChanged) {
      console.info("[triggerService] ignored because only tipo_accion changed", {
        correlationId,
        sheetName: liveRecord.sheetName,
        rowNumber: liveRecord.sheetRowNumber,
        baselineAction,
        currentAction
      });
    } else {
      console.info("[triggerService] ignored because only phone/date changed", {
        correlationId,
        sheetName: liveRecord.sheetName,
        rowNumber: liveRecord.sheetRowNumber,
        baselinePhone,
        currentPhone: liveRecord.telefono,
        baselineDate,
        currentDate: triggerDate,
        baselineAction,
        currentAction
      });
    }
    await updateState((current) => {
      upsertRecord(current.records, trackedRecord);
      current.steps.trigger_detected = "done";
    });
    console.info("[triggerService] outbound skipped no relevant triple-change", {
      correlationId,
      sheetName: liveRecord.sheetName,
      phoneChanged,
      dateChanged,
      actionChanged
    });
    console.info("[triggerService] skip reason", {
      correlationId,
      reason:
        actionChanged && !phoneChanged && !dateChanged
          ? "only_action_changed"
          : birthdayTripleChangeRequired
            ? "birthday_requires_triple_change"
            : "standard_requires_double_change"
    });
    return {
      ok: true,
      reason: "non_relevant_change",
      changed: 1,
      sent: 0,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber
    } satisfies DemoV2PushResult;
  }

  if (birthdayTripleAccepted) {
    console.info("[triggerService] relevant triple-change detected", {
      correlationId,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber,
      previousPhone: baselinePhone,
      currentPhone: liveRecord.telefono,
      previousDate: baselineDate,
      currentDate: triggerDate,
      previousAction: baselineAction,
      currentAction
    });
    console.info("[triggerService] triple change accepted", {
      correlationId,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber
    });
  } else {
    console.info("[triggerService] standard double-change accepted", {
      correlationId,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber,
      previousPhone: baselinePhone,
      currentPhone: liveRecord.telefono,
      previousDate: baselineDate,
      currentDate: triggerDate,
      baselineAction,
      currentAction
    });
  }

  const flowDecision = getDemoV2FlowDecision(liveRecord);
  console.info("[triggerService] flow selected from tipo_accion + sheet context", {
    correlationId,
    sheetName: liveRecord.sheetName,
    tipoAccion: currentAction,
    decision: flowDecision.decision
  });

  const outboundBase = clearConversationState({
    ...flowDecision.normalizedRecord,
    flowType: ""
  });
  const flowStart = prepareGuidedFlowStart(outboundBase);
  const outboundRecord = flowStart?.record ?? outboundBase;

  if (shouldSkipTrigger(outboundRecord)) {
    await updateState((current) => {
      upsertRecord(current.records, {
        ...trackedRecord,
        updatedAtDemo: nowIso()
      });
      current.steps.trigger_detected = "done";
    });
    console.info("[triggerService] outbound skipped no relevant triple-change", {
      correlationId,
      reason: "validation_or_missing_date",
      sheetName: liveRecord.sheetName
    });
    console.info("[triggerService] skip reason", {
      correlationId,
      reason: "validation_or_missing_date"
    });
    return {
      ok: true,
      reason: "non_relevant_change",
      changed: 1,
      sent: 0,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber
    } satisfies DemoV2PushResult;
  }

  let sentBody = "";
  let sentSid = "";
  try {
    console.info("[triggerService] whatsapp dispatch attempted", {
      correlationId,
      sheetName: liveRecord.sheetName,
      rowNumber: liveRecord.sheetRowNumber,
      telefono: liveRecord.telefono,
      flowDecision: flowDecision.decision
    });
    const sent = await sendWhatsApp(outboundRecord, {
      body: flowStart?.message,
      mediaUrl: flowStart?.mediaUrl
    });
    sentBody = sent.body;
    sentSid = sent.sid;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "No se pudo enviar el WhatsApp por Twilio.";
    const failedRecord = {
      ...outboundRecord,
      estadoWhatsapp: "error" as const,
      lastObservedHash: observationHash,
      lastProcessedHash: relevantHash,
      v2TriggerPhone: liveRecord.telefono,
      v2TriggerDate: triggerDate,
      v2TriggerAction: currentAction,
      updatedAtDemo: nowIso()
    } satisfies DemoRecord;

    await updateState((current) => {
      upsertRecord(current.records, failedRecord);
      current.steps.trigger_detected = "done";
      current.steps.whatsapp_sent = "error";
    });
    await updateRecordInSpreadsheet(failedRecord, input.spreadsheetId);
    await logActivity({
      correlationId,
      paciente: liveRecord.nombre,
      telefono: liveRecord.telefono,
      accion: "whatsapp_error",
      resultado: "error",
      detalle: errorMessage
    });
    throw error;
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
    v2TriggerPhone: liveRecord.telefono,
    v2TriggerDate: triggerDate,
    v2TriggerAction: currentAction,
    updatedAtDemo: nowIso()
  } satisfies DemoRecord;

  await updateState((current) => {
    upsertRecord(current.records, updatedRecord);
    current.steps.trigger_detected = "done";
    current.steps.whatsapp_sent = "done";
  });

  try {
    await updateRecordInSpreadsheet(updatedRecord, input.spreadsheetId);
  } catch (error) {
    console.warn("[triggerService] could not sync outbound WhatsApp state to Google Sheets", error);
  }

  console.info("[triggerService] outbound sent in v2", {
    correlationId,
    sentSid,
    sheetName: liveRecord.sheetName,
    rowNumber: liveRecord.sheetRowNumber,
    flowDecision: flowDecision.decision,
    sheetStateAfter: summarizeDemoV2State(updatedRecord)
  });

  await logActivity({
    correlationId,
    paciente: liveRecord.nombre,
    telefono: liveRecord.telefono,
    accion: "trigger_detected_v2",
    resultado: "ok",
    detalle: `Push de Google Sheets aceptado para ${liveRecord.sheetName} fila ${config.rowIndex}.`
  });
  await logActivity({
    correlationId,
    paciente: liveRecord.nombre,
    telefono: liveRecord.telefono,
    accion: "whatsapp_sent",
    resultado: "ok",
    detalle: `Mensaje enviado por Twilio (${sentSid}) en modo v2 push.`
  });

  for (const flowLog of flowStart?.logs ?? []) {
    await logActivity({
      correlationId,
      paciente: liveRecord.nombre,
      telefono: liveRecord.telefono,
      accion: flowLog.accion,
      resultado: flowLog.resultado,
      detalle: flowLog.detalle
    });
  }

  return {
    ok: true,
    reason: "processed",
    changed: 1,
    sent: 1,
    sheetName: liveRecord.sheetName,
    rowNumber: liveRecord.sheetRowNumber
  } satisfies DemoV2PushResult;
}

async function runDemoV2TriggerCheck(spreadsheetId?: string) {
  const config = getDemoV2Config();

  for (const sheetName of config.validSheetNames) {
    const result = await processDemoV2SheetEdit({
      spreadsheetId,
      sheetName,
      rowNumber: config.rowIndex
    });

    if (result.sent > 0) {
      return {
        changed: result.changed,
        sent: result.sent
      };
    }
  }

  return {
    changed: 0,
    sent: 0
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
