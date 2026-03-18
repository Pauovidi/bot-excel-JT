import { normalizeDateValue, normalizeHeaderKey } from "@/lib/normalization";
import type { ActionType, DemoRecord, FlowType } from "@/types/demo";

type DemoV2SheetConfig = {
  sheetName: string;
  actionType: ActionType;
  flowType: FlowType;
  selectedFlowLabel: string;
};

const DEMO_V2_SHEET_CONFIGS: DemoV2SheetConfig[] = [
  {
    sheetName: "Limpieza dental",
    actionType: "cumpleanos",
    flowType: "cumpleanos",
    selectedFlowLabel: "cumpleanos"
  },
  {
    sheetName: "Blanqueamiento dental",
    actionType: "revision",
    flowType: "",
    selectedFlowLabel: "revision"
  },
  {
    sheetName: "Presupuesto pendiente",
    actionType: "promo",
    flowType: "",
    selectedFlowLabel: "promo"
  },
  {
    sheetName: "Implantología",
    actionType: "promo",
    flowType: "implantologia_recuperacion",
    selectedFlowLabel: "implantologia_recuperacion"
  },
  {
    sheetName: "Ortodoncia",
    actionType: "revision",
    flowType: "revision_ortodoncia",
    selectedFlowLabel: "revision_ortodoncia"
  }
];

export function isDemoV2SingleRowEnabled() {
  return process.env.DEMO_V2_SINGLE_ROW?.trim().toLowerCase() === "true";
}

export function getDemoV2RowIndex() {
  const parsed = Number.parseInt(process.env.DEMO_V2_ROW_INDEX?.trim() || "2", 10);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : 2;
}

export function getDemoV2ValidSheetNames() {
  return DEMO_V2_SHEET_CONFIGS.map((config) => config.sheetName);
}

export function getDemoV2Config() {
  return {
    enabled: isDemoV2SingleRowEnabled(),
    rowIndex: getDemoV2RowIndex(),
    validSheetNames: getDemoV2ValidSheetNames()
  };
}

export function getDemoV2SheetConfig(sheetName: string) {
  const normalized = normalizeHeaderKey(sheetName);
  return DEMO_V2_SHEET_CONFIGS.find((config) => normalizeHeaderKey(config.sheetName) === normalized) ?? null;
}

export function getDemoV2TriggerDate(record: Pick<DemoRecord, "fechaTratamiento">) {
  return normalizeDateValue(record.fechaTratamiento);
}

export function applyDemoV2SheetFlow(record: DemoRecord) {
  const config = getDemoV2SheetConfig(record.sheetName);
  if (!config) {
    return null;
  }

  const triggerDate = getDemoV2TriggerDate(record);

  return {
    config,
    record: {
      ...record,
      tipoAccion: config.actionType,
      flowType: "",
      fechaAccion: triggerDate
    } satisfies DemoRecord
  };
}
