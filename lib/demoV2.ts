import { normalizeDateValue, normalizeHeaderKey } from "@/lib/normalization";
import type { DemoRecord } from "@/types/demo";

const DEMO_V2_VALID_SHEETS = ["Ortodoncia", "Implantología", "Limpieza dental"] as const;
const DEMO_V2_TRIGGER_COLUMNS = {
  phone: "Teléfono móvil",
  treatmentDate: "Fecha del tratamiento",
  actionType: "tipo_accion"
} as const;

export function isDemoV2SingleRowEnabled() {
  return process.env.DEMO_V2_SINGLE_ROW?.trim().toLowerCase() === "true";
}

export function getDemoV2RowIndex() {
  const parsed = Number.parseInt(process.env.DEMO_V2_ROW_INDEX?.trim() || "2", 10);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : 2;
}

export function getDemoV2ValidSheetNames() {
  return [...DEMO_V2_VALID_SHEETS];
}

export function getDemoV2Config() {
  return {
    enabled: isDemoV2SingleRowEnabled(),
    rowIndex: getDemoV2RowIndex(),
    validSheetNames: getDemoV2ValidSheetNames(),
    triggerColumns: DEMO_V2_TRIGGER_COLUMNS
  };
}

export function isDemoV2ValidSheet(sheetName: string) {
  const normalized = normalizeHeaderKey(sheetName);
  return getDemoV2ValidSheetNames().some((sheetNameCandidate) => normalizeHeaderKey(sheetNameCandidate) === normalized);
}

export function getDemoV2TriggerColumns() {
  return DEMO_V2_TRIGGER_COLUMNS;
}

export function getDemoV2TriggerDate(record: Pick<DemoRecord, "fechaTratamiento">) {
  return normalizeDateValue(record.fechaTratamiento);
}
