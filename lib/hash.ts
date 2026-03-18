import { createHash } from "node:crypto";

import type { DemoRecord } from "@/types/demo";

function digestParts(parts: string[]) {
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

export function buildTriggerHash(record: DemoRecord) {
  return digestParts([
    record.nombre ?? "",
    record.telefono ?? "",
    record.tratamientoRealizado ?? "",
    record.tipoAccion ?? "",
    record.fechaAccion ?? "",
    record.horaCita ?? ""
  ]);
}

export function buildTriggerReopenHash(record: DemoRecord) {
  return digestParts([record.tipoAccion ?? "", record.fechaAccion ?? "", record.horaCita ?? ""]);
}

export function buildDemoV2RelevantHash(phone: string, triggerDate: string, actionType: string) {
  return digestParts([phone ?? "", triggerDate ?? "", actionType ?? ""]);
}

export function buildDemoV2ObservationHash(record: DemoRecord) {
  return digestParts([
    record.sheetName ?? "",
    String(record.sheetRowNumber ?? ""),
    record.nombre ?? "",
    record.telefono ?? "",
    record.tratamientoRealizado ?? "",
    record.fechaTratamiento ?? "",
    record.tipoAccion ?? "",
    record.fechaAccion ?? "",
    record.horaCita ?? "",
    JSON.stringify(record.originalData ?? {})
  ]);
}
