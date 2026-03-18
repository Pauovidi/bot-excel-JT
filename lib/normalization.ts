import type { ActionType, FlowType } from "@/types/demo";

export function stripAccents(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeHeaderKey(value: string) {
  return stripAccents(value).toLowerCase().trim().replace(/\s+/g, " ");
}

export function normalizeDateValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${month}-${day}`;
  }

  return "";
}

export function normalizeTimeValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const totalMinutes = Math.round(value * 24 * 60);
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  const raw = String(value ?? "").trim().replace(".", ":");
  if (!raw) {
    return "";
  }

  const match = raw.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) {
    return "";
  }

  const hours = match[1].padStart(2, "0");
  const minutes = (match[2] ?? "00").padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function normalizeNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value ?? "")
    .trim()
    .replace(/[€\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeActionTypeValue(value: unknown, fallback: ActionType = "revision"): ActionType {
  const normalized = normalizeHeaderKey(String(value ?? ""));

  switch (normalized) {
    case "cumpleanos":
    case "cumple anos":
      return "cumpleanos";
    case "recordatorio":
    case "recordatorio cita":
      return "recordatorio";
    case "promo":
      return "promo";
    case "revision":
      return "revision";
    default:
      return fallback;
  }
}

export function normalizeFlowTypeValue(value: unknown, fallback: FlowType = ""): FlowType {
  const normalized = normalizeHeaderKey(String(value ?? ""));

  switch (normalized) {
    case "cumpleanos":
      return "cumpleanos";
    case "implantologia recuperacion":
    case "implantologia_recuperacion":
      return "implantologia_recuperacion";
    case "revision ortodoncia":
    case "revision_ortodoncia":
      return "revision_ortodoncia";
    default:
      return fallback;
  }
}
