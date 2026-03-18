export type StepKey =
  | "excel_loaded"
  | "data_parsed"
  | "sheet_updated"
  | "trigger_detected"
  | "whatsapp_sent"
  | "response_received"
  | "calendar_updated";

export type StepStatus = "idle" | "done" | "warning" | "error";

export type WhatsAppStatus =
  | "pendiente"
  | "enviado"
  | "respondido"
  | "rechazo"
  | "error"
  | "calendar_creado"
  | "pendiente_reprogramacion";

export type IntentType =
  | ""
  | "confirmar"
  | "cambiar"
  | "reservar"
  | "info"
  | "rechazo"
  | "otra";

export type ActionType = "recordatorio" | "cumpleanos" | "promo" | "revision";

export type FlowType =
  | ""
  | "cumpleanos"
  | "implantologia_recuperacion"
  | "revision_ortodoncia";

export type ConversationState =
  | ""
  | "birthday_offer_sent"
  | "birthday_waiting_week"
  | "birthday_waiting_slot"
  | "birthday_confirmed"
  | "implant_followup_sent"
  | "implant_waiting_reason"
  | "implant_waiting_acceptance"
  | "implant_waiting_slot"
  | "implant_confirmed"
  | "ortho_review_sent"
  | "ortho_waiting_adherence"
  | "ortho_waiting_acceptance"
  | "ortho_waiting_slot"
  | "ortho_confirmed"
  | "closed";

export type LogEntry = {
  id: string;
  correlationId: string;
  paciente: string;
  telefono: string;
  accion: string;
  resultado: string;
  detalle?: string;
  timestamp: string;
};

export type DemoRecord = {
  id: string;
  sourceRowNumber: number;
  sheetName: string;
  sheetRowNumber: number;
  nombre: string;
  fechaNacimiento: string;
  telefono: string;
  tratamientoRealizado: string;
  fechaTratamiento: string;
  cantidadPagada: number | null;
  casillaPresupuesto: string;
  tipoAccion: ActionType;
  fechaAccion: string;
  horaCita: string;
  estadoWhatsapp: WhatsAppStatus;
  ultimaRespuesta: string;
  intencion: IntentType;
  flowType: FlowType;
  conversationState: ConversationState;
  lastBotMessageType: string;
  lastUserMessage: string;
  intentDetected: string;
  proposedSlots: string[];
  selectedSlot: string;
  conversationClosed: boolean;
  calendarEventId: string;
  lastProcessedHash: string;
  updatedAtDemo: string;
  validationErrors: string[];
  originalData: Record<string, string>;
  lastSentMessage: string;
  lastObservedHash?: string;
  v2TriggerPhone?: string;
  v2TriggerDate?: string;
  v2TriggerAction?: string;
};

export type ImportSummary = {
  fileName: string;
  uploadedAt: string;
  totalRows: number;
  totalGroups: number;
  groupCounts: Record<string, number>;
  originalHeaders: string[];
  mappedHeaders: Record<string, string>;
  validationErrors: number;
};

export type DemoState = {
  version: number;
  spreadsheetId: string;
  spreadsheetUrl: string;
  uploadedFilePath: string;
  importSummary: ImportSummary | null;
  records: DemoRecord[];
  logs: LogEntry[];
  steps: Record<StepKey, StepStatus>;
  lastUpdatedAt: string;
};
