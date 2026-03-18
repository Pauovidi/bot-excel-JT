import { google } from "googleapis";

import { TECHNICAL_COLUMNS } from "@/lib/constants";
import { nowIso } from "@/lib/dateUtils";
import {
  normalizeActionTypeValue,
  normalizeDateValue,
  normalizeFlowTypeValue,
  normalizeNumberValue,
  normalizeTimeValue
} from "@/lib/normalization";
import { normalizePhoneForStorage } from "@/lib/phone";
import { readState, updateState } from "@/lib/stateStore";
import { createGoogleAuth } from "@/services/googleAuth";
import { logActivity } from "@/services/loggerService";
import type { DemoRecord, ImportSummary } from "@/types/demo";

const SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];
const PLACEHOLDER_SHEET_TITLES = new Set(["Hoja 1", "Sheet1"]);

function getSheetsClient() {
  return google.sheets({
    version: "v4",
    auth: createGoogleAuth(SHEETS_SCOPES)
  });
}

function getDriveClient() {
  return google.drive({
    version: "v3",
    auth: createGoogleAuth(SHEETS_SCOPES)
  });
}

function sanitizeSheetName(value: string) {
  const sanitized = value.replace(/[\[\]\*\/\\\?\:]/g, " ").replace(/\s+/g, " ").trim();
  return (sanitized || "Sin tratamiento").slice(0, 80);
}

function isPlaceholderSheetTitle(value: string) {
  return PLACEHOLDER_SHEET_TITLES.has(value.trim());
}

function buildSheetHeaders(records: DemoRecord[]) {
  const importedHeaders = Array.from(
    new Set(records.flatMap((record) => Object.keys(record.originalData)))
  );
  return [...importedHeaders, ...TECHNICAL_COLUMNS];
}

function buildImportSummaryFromRecords(records: DemoRecord[], fileName: string): ImportSummary {
  const groupCounts = records.reduce<Record<string, number>>((accumulator, record) => {
    const key = record.tratamientoRealizado || "Sin tratamiento";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
  const originalHeaders = Array.from(new Set(records.flatMap((record) => Object.keys(record.originalData))));

  return {
    fileName,
    uploadedAt: nowIso(),
    totalRows: records.length,
    totalGroups: Object.keys(groupCounts).length,
    groupCounts,
    originalHeaders,
    mappedHeaders: {},
    validationErrors: records.filter((record) => record.validationErrors.length > 0).length
  };
}

function recordToRow(record: DemoRecord, headers: string[]) {
  const values: Record<string, string> = {
    ...record.originalData,
    id_registro: record.id,
    tipo_accion: record.tipoAccion,
    fecha_accion: record.fechaAccion,
    hora_cita: record.horaCita,
    estado_whatsapp: record.estadoWhatsapp,
    ultima_respuesta: record.ultimaRespuesta,
    intencion: record.intencion,
    flow_type: record.flowType,
    conversation_state: record.conversationState,
    last_bot_message_type: record.lastBotMessageType,
    last_user_message: record.lastUserMessage,
    intent_detected: record.intentDetected,
    proposed_slots: record.proposedSlots.join(" || "),
    selected_slot: record.selectedSlot,
    conversation_closed: record.conversationClosed ? "true" : "false",
    calendar_event_id: record.calendarEventId,
    last_processed_hash: record.lastProcessedHash,
    updated_at_demo: record.updatedAtDemo
  };

  return headers.map((header) => values[header] ?? "");
}

function sheetRowToRecord(
  headers: string[],
  row: string[],
  sheetName: string,
  sheetRowNumber: number,
  existing?: DemoRecord
) {
  const data = Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()]));
  const originalData = Object.fromEntries(
    headers
      .filter((header) => !TECHNICAL_COLUMNS.includes(header as (typeof TECHNICAL_COLUMNS)[number]))
      .map((header) => [header, data[header]])
  );

  return {
    id: data.id_registro,
    sourceRowNumber: existing?.sourceRowNumber ?? sheetRowNumber,
    sheetName,
    sheetRowNumber,
    nombre: data["Nombre y apellidos"] || existing?.nombre || "",
    fechaNacimiento: normalizeDateValue(data["Fecha de nacimiento"] || existing?.fechaNacimiento || ""),
    telefono: normalizePhoneForStorage(data["Teléfono móvil"] || existing?.telefono || ""),
    tratamientoRealizado: data["Tratamiento realizado"] || existing?.tratamientoRealizado || "",
    fechaTratamiento: normalizeDateValue(data["Fecha del tratamiento"] || existing?.fechaTratamiento || ""),
    cantidadPagada:
      normalizeNumberValue(data["Cantidad pagada (€)"]) ?? existing?.cantidadPagada ?? null,
    casillaPresupuesto: data["Casilla de presupuesto"] || existing?.casillaPresupuesto || "",
    tipoAccion: normalizeActionTypeValue(data.tipo_accion || existing?.tipoAccion || "revision"),
    fechaAccion: normalizeDateValue(data.fecha_accion || existing?.fechaAccion || ""),
    horaCita: normalizeTimeValue(data.hora_cita || existing?.horaCita || ""),
    estadoWhatsapp:
      (data.estado_whatsapp || existing?.estadoWhatsapp || "pendiente") as DemoRecord["estadoWhatsapp"],
    ultimaRespuesta: data.ultima_respuesta || existing?.ultimaRespuesta || "",
    intencion: (data.intencion || existing?.intencion || "") as DemoRecord["intencion"],
    flowType: normalizeFlowTypeValue(data.flow_type || existing?.flowType || ""),
    conversationState:
      (data.conversation_state || existing?.conversationState || "") as DemoRecord["conversationState"],
    lastBotMessageType: data.last_bot_message_type || existing?.lastBotMessageType || "",
    lastUserMessage: data.last_user_message || existing?.lastUserMessage || "",
    intentDetected: data.intent_detected || existing?.intentDetected || "",
    proposedSlots: data.proposed_slots
      ? data.proposed_slots.split(" || ").map((slot) => slot.trim()).filter(Boolean)
      : (existing?.proposedSlots ?? []),
    selectedSlot: data.selected_slot || existing?.selectedSlot || "",
    conversationClosed:
      data.conversation_closed === "true"
        ? true
        : data.conversation_closed === "false"
          ? false
          : (existing?.conversationClosed ?? false),
    calendarEventId: data.calendar_event_id || existing?.calendarEventId || "",
    lastProcessedHash: data.last_processed_hash || existing?.lastProcessedHash || "",
    updatedAtDemo: data.updated_at_demo || nowIso(),
    validationErrors: existing?.validationErrors ?? [],
    originalData,
    lastSentMessage: existing?.lastSentMessage || ""
  } satisfies DemoRecord;
}

async function shareSpreadsheetIfNeeded(spreadsheetId: string) {
  const shareWith = process.env.GOOGLE_SHARE_WITH_EMAIL;
  if (!shareWith) {
    return;
  }

  const drive = getDriveClient();
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      sendNotificationEmail: false,
      requestBody: {
        type: "user",
        role: "writer",
        emailAddress: shareWith
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already")) {
      throw error;
    }
  }
}

export async function getOrCreateSpreadsheet(preferredSpreadsheetId?: string) {
  const state = await readState();
  const configuredSpreadsheetId = process.env.GOOGLE_SPREADSHEET_ID?.trim();
  const spreadsheetId = configuredSpreadsheetId || preferredSpreadsheetId || state.spreadsheetId;
  const sheets = getSheetsClient();

  if (spreadsheetId) {
    const existing = await sheets.spreadsheets.get({ spreadsheetId });
    return {
      spreadsheetId,
      spreadsheetUrl: existing.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
    };
  }

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `Clínica Dental Demo ${new Date().toISOString().slice(0, 10)}`
      }
    }
  });

  const newSpreadsheetId = created.data.spreadsheetId;
  if (!newSpreadsheetId) {
    throw new Error("No se pudo crear el Google Spreadsheet.");
  }

  await shareSpreadsheetIfNeeded(newSpreadsheetId);

  return {
    spreadsheetId: newSpreadsheetId,
    spreadsheetUrl:
      created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${newSpreadsheetId}/edit`
  };
}

export async function getSpreadsheetUrl(spreadsheetIdOverride?: string) {
  const { spreadsheetUrl } = await getOrCreateSpreadsheet(spreadsheetIdOverride);
  return spreadsheetUrl;
}

async function ensureSheetsExist(spreadsheetId: string, sheetNames: string[]) {
  const sheets = getSheetsClient();
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const existingNames = new Set(
    (metadata.data.sheets ?? []).map((sheet) => sheet.properties?.title).filter(Boolean)
  );

  const addRequests = sheetNames
    .filter((name) => !existingNames.has(name))
    .map((name) => ({
      addSheet: {
        properties: {
          title: name
        }
      }
    }));

  if (addRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: addRequests
      }
    });
  }
}

async function cleanupPlaceholderSheets(spreadsheetId: string, allowedSheetNames: string[]) {
  const sheets = getSheetsClient();
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const allowedNames = new Set(allowedSheetNames);
  const candidateSheets = (metadata.data.sheets ?? []).filter((sheet) => {
    const title = sheet.properties?.title;
    if (!title) {
      return false;
    }

    if (allowedNames.has(title)) {
      return false;
    }

    return isPlaceholderSheetTitle(title) || title === "_IGNORAR_HOJA_1";
  });

  for (const sheet of candidateSheets) {
    const sheetId = sheet.properties?.sheetId;
    const title = sheet.properties?.title;
    const allSheets = metadata.data.sheets ?? [];

    if (!sheetId || !title || allSheets.length <= 1) {
      continue;
    }

    if (title === "_IGNORAR_HOJA_1" || sheet.properties?.hidden) {
      await logActivity({
        correlationId: String(sheetId),
        paciente: "google_sheet",
        telefono: "",
        accion: "placeholder_sheet_ignored",
        resultado: "ok",
        detalle: `La hoja ${title} queda fuera del flujo de la demo.`
      });
      continue;
    }

    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteSheet: {
                sheetId
              }
            }
          ]
        }
      });
      await logActivity({
        correlationId: String(sheetId),
        paciente: "google_sheet",
        telefono: "",
        accion: "placeholder_sheet_deleted",
        resultado: "ok",
        detalle: `Se ha eliminado la hoja placeholder ${title}.`
      });
    } catch {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId,
                  title: "_IGNORAR_HOJA_1",
                  hidden: true
                },
                fields: "title,hidden"
              }
            }
          ]
        }
      });
      await logActivity({
        correlationId: String(sheetId),
        paciente: "google_sheet",
        telefono: "",
        accion: "placeholder_sheet_hidden",
        resultado: "ok",
        detalle: `La hoja ${title} se ha renombrado a _IGNORAR_HOJA_1 y se ha ocultado.`
      });
    }
  }
}

export async function syncRecordsToSpreadsheet(
  records: DemoRecord[],
  options?: { spreadsheetId?: string }
) {
  const { spreadsheetId, spreadsheetUrl } = await getOrCreateSpreadsheet(options?.spreadsheetId);
  const sheets = getSheetsClient();
  const groups = records.reduce<Record<string, DemoRecord[]>>((accumulator, record) => {
    const sheetName = sanitizeSheetName(record.tratamientoRealizado);
    record.sheetName = sheetName;
    accumulator[sheetName] = [...(accumulator[sheetName] ?? []), record];
    return accumulator;
  }, {});

  const sheetNames = Object.keys(groups);
  await ensureSheetsExist(spreadsheetId, sheetNames);

  for (const [sheetName, groupRecords] of Object.entries(groups)) {
    const headers = buildSheetHeaders(groupRecords);
    const values = [
      headers,
      ...groupRecords.map((record, index) => {
        record.sheetRowNumber = index + 2;
        return recordToRow(record, headers);
      })
    ];

    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${sheetName}'`
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values
      }
    });
  }

  await cleanupPlaceholderSheets(spreadsheetId, sheetNames);

  await updateState((state) => {
    state.spreadsheetId = spreadsheetId;
    state.spreadsheetUrl = spreadsheetUrl;
    state.records = records;
  });

  return {
    spreadsheetId,
    spreadsheetUrl
  };
}

export async function readAllRowsFromSpreadsheet(spreadsheetIdOverride?: string) {
  const state = await readState();
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID?.trim() || spreadsheetIdOverride || state.spreadsheetId;
  if (!spreadsheetId) {
    return [];
  }

  const sheets = getSheetsClient();
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = (metadata.data.sheets ?? [])
    .filter((sheet) => {
      const title = sheet.properties?.title;
      if (!title) {
        return false;
      }
      if (sheet.properties?.hidden) {
        return false;
      }
      return !isPlaceholderSheetTitle(title) && title !== "_IGNORAR_HOJA_1";
    })
    .map((sheet) => sheet.properties?.title)
    .filter((value): value is string => Boolean(value));

  const records: DemoRecord[] = [];
  for (const tab of tabs) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'`
    });

    const values = response.data.values ?? [];
    if (values.length <= 1) {
      continue;
    }

    const headers = values[0].map((value) => String(value));
    for (let index = 1; index < values.length; index += 1) {
      const row = values[index].map((value) => String(value ?? ""));
      const id = row[headers.indexOf("id_registro")] ?? "";
      const existing = state.records.find((record) => record.id === id);
      const record = sheetRowToRecord(headers, row, tab, index + 1, existing);
      if (record.id) {
        records.push(record);
      }
    }
  }

  return records;
}

export async function readRecordByIdFromSpreadsheet(recordId: string, spreadsheetIdOverride?: string) {
  const records = await readAllRowsFromSpreadsheet(spreadsheetIdOverride);
  return records.find((record) => record.id === recordId) ?? null;
}

export function buildReconstructedImportSummary(records: DemoRecord[]) {
  return buildImportSummaryFromRecords(records, "Reconstruido desde Google Sheets");
}

export async function updateRecordInSpreadsheet(record: DemoRecord, spreadsheetIdOverride?: string) {
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID?.trim() || spreadsheetIdOverride || (await readState()).spreadsheetId;
  if (!spreadsheetId) {
    throw new Error("No hay un Google Spreadsheet activo para actualizar.");
  }

  const sheets = getSheetsClient();
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${record.sheetName}'!1:1`
  });
  const headers = (headerResponse.data.values?.[0] ?? []).map((value) => String(value));
  if (headers.length === 0) {
    throw new Error(`La pestaña ${record.sheetName} no tiene cabeceras.`);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${record.sheetName}'!A${record.sheetRowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [recordToRow(record, headers)]
    }
  });
}
