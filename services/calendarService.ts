import { google } from "googleapis";

import { CALENDAR_SLOT_OPTIONS } from "@/lib/constants";
import { addDays, makeDateTime, tomorrowIsoDate } from "@/lib/dateUtils";
import { requireEnv } from "@/lib/env";
import { createGoogleAuth } from "@/services/googleAuth";
import { logActivity } from "@/services/loggerService";
import type { DemoRecord, IntentType, WhatsAppStatus } from "@/types/demo";

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

function getCalendarClient() {
  return google.calendar({
    version: "v3",
    auth: createGoogleAuth(CALENDAR_SCOPES)
  });
}

function buildDescription(record: DemoRecord) {
  return [
    `Paciente: ${record.nombre}`,
    `Telefono: ${record.telefono}`,
    `Tratamiento: ${record.tratamientoRealizado}`,
    "Origen: WhatsApp demo",
    `id_registro: ${record.id}`
  ].join("\n");
}

function addMinutes(time: string, minutesToAdd: number) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setMinutes(date.getMinutes() + minutesToAdd);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function findAvailableSlot(baseDate: string) {
  const calendar = getCalendarClient();
  const calendarId = requireEnv("GOOGLE_CALENDAR_ID");
  let currentDate = baseDate || tomorrowIsoDate();

  for (let offset = 0; offset < 14; offset += 1) {
    const day = offset === 0 ? currentDate : addDays(currentDate, offset);
    const response = await calendar.events.list({
      calendarId,
      timeMin: `${day}T00:00:00`,
      timeMax: `${day}T23:59:59`,
      singleEvents: true,
      orderBy: "startTime"
    });

    const busySlots = new Set(
      (response.data.items ?? [])
        .map((item) => item.start?.dateTime?.slice(11, 16))
        .filter((value): value is string => Boolean(value))
    );

    const free = CALENDAR_SLOT_OPTIONS.find((slot) => !busySlots.has(slot));
    if (free) {
      return { date: day, time: free };
    }
  }

  currentDate = addDays(currentDate, 1);
  return { date: currentDate, time: CALENDAR_SLOT_OPTIONS[0] };
}

async function upsertEvent(record: DemoRecord, summary: string, durationMinutes: number) {
  const calendar = getCalendarClient();
  const calendarId = requireEnv("GOOGLE_CALENDAR_ID");
  const requestBody = {
    summary,
    description: buildDescription(record),
    start: makeDateTime(record.fechaAccion, record.horaCita || "10:00"),
    end: makeDateTime(record.fechaAccion, addMinutes(record.horaCita || "10:00", durationMinutes))
  };

  await logActivity({
    correlationId: record.id.slice(0, 8),
    paciente: record.nombre,
    telefono: record.telefono,
    accion: "calendar_attempt",
    resultado: "ok",
    detalle: `${summary} | ${record.fechaAccion} ${record.horaCita || "10:00"}`
  });

  if (record.calendarEventId) {
    try {
      const updated = await calendar.events.update({
        calendarId,
        eventId: record.calendarEventId,
        requestBody
      });
      const eventId = updated.data.id ?? record.calendarEventId;
      await logActivity({
        correlationId: record.id.slice(0, 8),
        paciente: record.nombre,
        telefono: record.telefono,
        accion: "calendar_updated",
        resultado: "updated",
        detalle: `Evento actualizado en Google Calendar (${eventId}).`
      });
      return eventId;
    } catch {
      // If the event was deleted manually, create a new one.
    }
  }

  try {
    const created = await calendar.events.insert({
      calendarId,
      requestBody
    });
    const eventId = created.data.id ?? "";
    await logActivity({
      correlationId: record.id.slice(0, 8),
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "calendar_updated",
      resultado: "created",
      detalle: eventId
        ? `Evento creado en Google Calendar (${eventId}).`
        : "Evento creado en Google Calendar sin id devuelto."
    });
    return eventId;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "No se pudo crear el evento en Google Calendar.";
    await logActivity({
      correlationId: record.id.slice(0, 8),
      paciente: record.nombre,
      telefono: record.telefono,
      accion: "calendar_error",
      resultado: "error",
      detalle: errorMessage
    });
    throw error;
  }
}

export async function createConversationCalendarEvent(
  record: DemoRecord,
  options: {
    summary: string;
    durationMinutes?: number;
  }
) {
  if (!record.fechaAccion || !record.horaCita) {
    throw new Error("Falta fecha u hora para crear la cita del flujo conversacional.");
  }

  return upsertEvent(record, options.summary, options.durationMinutes ?? 30);
}

export async function processIntentWithCalendar(record: DemoRecord, intent: IntentType) {
  if (intent === "confirmar") {
    if (!record.fechaAccion || !record.horaCita) {
      return {
        record,
        status: "respondido" as WhatsAppStatus
      };
    }

    const eventId = await upsertEvent(record, `Cita dental - ${record.nombre}`, 30);
    return {
      record: {
        ...record,
        calendarEventId: eventId
      },
      status: "calendar_creado" as WhatsAppStatus
    };
  }

  if (intent === "reservar") {
    const slot = await findAvailableSlot(record.fechaAccion || tomorrowIsoDate());
    const scheduledRecord = {
      ...record,
      fechaAccion: slot.date,
      horaCita: slot.time
    };
    const eventId = await upsertEvent(scheduledRecord, `Reserva dental - ${record.nombre}`, 30);
    return {
      record: {
        ...scheduledRecord,
        calendarEventId: eventId
      },
      status: "calendar_creado" as WhatsAppStatus
    };
  }

  if (intent === "cambiar") {
    const slot = await findAvailableSlot(tomorrowIsoDate());
    const followUpRecord = {
      ...record,
      fechaAccion: slot.date,
      horaCita: slot.time
    };
    const eventId = await upsertEvent(
      followUpRecord,
      `Reprogramar cita - ${record.nombre}`,
      15
    );
    return {
      record: {
        ...record,
        calendarEventId: eventId
      },
      status: "pendiente_reprogramacion" as WhatsAppStatus
    };
  }

  return {
    record,
    status: "respondido" as WhatsAppStatus
  };
}
