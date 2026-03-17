import { stripAccents } from "@/lib/normalization";
import type { ActionType, IntentType } from "@/types/demo";

function normalizeIncomingMessage(message: string) {
  return stripAccents(message).toLowerCase().trim().replace(/\s+/g, " ");
}

function matchesAny(text: string, candidates: string[]) {
  return candidates.some((candidate) => text === candidate || text.includes(candidate));
}

export function classifyIntent(message: string, actionType: ActionType): IntentType {
  const normalized = normalizeIncomingMessage(message);

  if (matchesAny(normalized, ["1", "confirmar", "ok", "si", "sí", "confirmar cita"])) {
    return "confirmar";
  }

  if (matchesAny(normalized, ["2", "cambiar", "cambiar cita", "cambiar mi cita", "otro dia", "otro día"])) {
    return "cambiar";
  }

  if (matchesAny(normalized, ["reservar", "quiero reservar", "me interesa", "si reservar"])) {
    return "reservar";
  }

  if (matchesAny(normalized, ["info", "mas info", "más info"])) {
    return "info";
  }

  if (matchesAny(normalized, ["no", "no gracias", "mas tarde", "más tarde"])) {
    return "rechazo";
  }

  return "otra";
}
