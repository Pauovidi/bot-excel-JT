import { createHash } from "node:crypto";

import * as XLSX from "xlsx";

import { COLUMN_ALIASES, REQUIRED_CANONICAL_FIELDS } from "@/lib/excelMapping";
import { normalizeDateValue, normalizeHeaderKey, normalizeNumberValue } from "@/lib/normalization";
import { normalizePhoneForStorage } from "@/lib/phone";
import type { ActionType, DemoRecord, ImportSummary } from "@/types/demo";

function resolveMappedHeaders(headers: string[]) {
  const normalized = new Map(headers.map((header) => [normalizeHeaderKey(header), header]));
  const result: Record<string, string> = {};

  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    const match = aliases
      .map((alias) => normalized.get(normalizeHeaderKey(alias)))
      .find(Boolean);

    if (match) {
      result[canonical] = match;
    }
  }

  return result;
}

function inferActionType(): ActionType {
  return "revision";
}

function buildRecordId(values: string[]) {
  return createHash("sha1").update(values.join("|")).digest("hex").slice(0, 14);
}

function normalizeCell(value: unknown) {
  return String(value ?? "").trim();
}

function inferActionTypeFromTreatment(tratamientoRealizado: string): ActionType {
  return normalizeHeaderKey(tratamientoRealizado) === "presupuesto pendiente" ? "promo" : "revision";
}

export function parseExcelBuffer(buffer: Buffer, fileName = "demo.xlsx") {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("El archivo Excel no contiene hojas.");
  }

  const worksheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: ""
  });

  const originalHeaders = (matrix[0] ?? []).map((cell) => normalizeCell(cell));
  if (originalHeaders.length === 0) {
    throw new Error("No se han encontrado cabeceras en la primera hoja del Excel.");
  }

  const mappedHeaders = resolveMappedHeaders(originalHeaders);
  const missingRequiredHeaders = REQUIRED_CANONICAL_FIELDS.filter((field) => !mappedHeaders[field]);
  if (missingRequiredHeaders.length > 0) {
    throw new Error(
      `Faltan columnas requeridas del Excel real: ${missingRequiredHeaders.join(", ")}. Ajusta el mapping en lib/excelMapping.ts.`
    );
  }

  const bodyRows = matrix.slice(1).filter((row) => row.some((value) => normalizeCell(value)));
  const records: DemoRecord[] = bodyRows.map((row, rowIndex) => {
    const originalData = Object.fromEntries(
      originalHeaders.map((header, index) => [header, normalizeCell(row[index])])
    );

    const nombre = normalizeCell(originalData[mappedHeaders.nombre ?? ""]);
    const fechaNacimiento = normalizeDateValue(originalData[mappedHeaders.fecha_nacimiento ?? ""]);
    const telefono = normalizePhoneForStorage(originalData[mappedHeaders.telefono ?? ""]);
    const tratamientoRealizado = normalizeCell(
      originalData[mappedHeaders.tratamiento_realizado ?? ""]
    );
    const fechaTratamiento = normalizeDateValue(originalData[mappedHeaders.fecha_tratamiento ?? ""]);
    const cantidadPagada = normalizeNumberValue(originalData[mappedHeaders.cantidad_pagada ?? ""]);
    const casillaPresupuesto = normalizeCell(originalData[mappedHeaders.casilla_presupuesto ?? ""]);
    const validationErrors: string[] = [];

    if (!nombre) {
      validationErrors.push("Falta columna o valor de nombre.");
    }

    if (!telefono) {
      validationErrors.push("Falta columna o valor de teléfono.");
    }

    if (!tratamientoRealizado) {
      validationErrors.push('Falta columna o valor de "Tratamiento realizado".');
    }

    const tipoAccion = inferActionTypeFromTreatment(tratamientoRealizado);
    const fechaAccion = fechaTratamiento;

    return {
      id: buildRecordId([nombre, telefono, tratamientoRealizado, String(rowIndex + 2)]),
      sourceRowNumber: rowIndex + 2,
      sheetName: "",
      sheetRowNumber: 0,
      nombre,
      fechaNacimiento,
      telefono,
      tratamientoRealizado,
      fechaTratamiento,
      cantidadPagada,
      casillaPresupuesto,
      tipoAccion,
      fechaAccion,
      horaCita: "",
      estadoWhatsapp: validationErrors.length > 0 ? "error" : "pendiente",
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
      calendarEventId: "",
      lastProcessedHash: "",
      updatedAtDemo: new Date().toISOString(),
      validationErrors,
      originalData,
      lastSentMessage: ""
    };
  });

  const groupCounts = records.reduce<Record<string, number>>((accumulator, record) => {
    const key = record.tratamientoRealizado || "Sin tratamiento";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});

  const summary: ImportSummary = {
    fileName,
    uploadedAt: new Date().toISOString(),
    totalRows: records.length,
    totalGroups: Object.keys(groupCounts).length,
    groupCounts,
    originalHeaders,
    mappedHeaders,
    validationErrors: records.filter((record) => record.validationErrors.length > 0).length
  };

  return {
    records,
    summary
  };
}
