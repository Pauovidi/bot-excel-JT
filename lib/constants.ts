import type { ActionType, StepKey } from "@/types/demo";

export const TECHNICAL_COLUMNS = [
  "id_registro",
  "tipo_accion",
  "fecha_accion",
  "hora_cita",
  "estado_whatsapp",
  "ultima_respuesta",
  "intencion",
  "flow_type",
  "conversation_state",
  "last_bot_message_type",
  "last_user_message",
  "intent_detected",
  "proposed_slots",
  "selected_slot",
  "conversation_closed",
  "calendar_event_id",
  "last_processed_hash",
  "updated_at_demo"
] as const;

export const STEP_KEYS: StepKey[] = [
  "excel_loaded",
  "data_parsed",
  "sheet_updated",
  "trigger_detected",
  "whatsapp_sent",
  "response_received",
  "calendar_updated"
];

export const ACTION_OPTIONS: ActionType[] = [
  "recordatorio",
  "cumpleanos",
  "promo",
  "revision"
];

export const CALENDAR_SLOT_OPTIONS = ["10:00", "11:00", "17:00"];
