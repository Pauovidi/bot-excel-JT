import twilio from "twilio";

import { formatDisplayDate } from "@/lib/dateUtils";
import { requireEnv } from "@/lib/env";
import { toWhatsAppAddress } from "@/lib/phone";
import type { DemoRecord, IntentType } from "@/types/demo";

const templates = {
  recordatorio: (record: DemoRecord) => `RECORDATORIO DE CITA

Hola ${record.nombre},
Tienes una cita en Clínica Dental Juan Margarit el ${formatDisplayDate(record.fechaAccion)} a las ${record.horaCita || "10:00"}.
Responde:
1. CONFIRMAR CITA
2. CAMBIAR MI CITA`,
  cumpleanos: (record: DemoRecord) => `Hola ${record.nombre}, desde Clínica Dental Juan Margarit queremos felicitarte 🎉
Este mes tienes una promoción especial.
Responde:
1. QUIERO RESERVAR
2. MÁS INFO`,
  promo: (record: DemoRecord) => `Hola ${record.nombre}, hemos visto que tienes un presupuesto pendiente en Clínica Dental Juan Margarit.
Si quieres retomarlo, responde:
1. ME INTERESA
2. MÁS INFO`,
  revision: (record: DemoRecord) => `Hola ${record.nombre}, ya ha pasado el tiempo recomendado desde tu tratamiento de ${record.tratamientoRealizado}.
¿Quieres agendar una revisión?
Responde:
1. SÍ, RESERVAR
2. MÁS TARDE`
} satisfies Record<DemoRecord["tipoAccion"], (record: DemoRecord) => string>;

export function getTwilioClient() {
  return twilio(requireEnv("TWILIO_ACCOUNT_SID"), requireEnv("TWILIO_AUTH_TOKEN"));
}

export function buildWhatsappTemplate(record: DemoRecord) {
  return templates[record.tipoAccion](record);
}

export async function sendWhatsApp(
  record: DemoRecord,
  options?: {
    body?: string;
    mediaUrl?: string;
  }
) {
  const client = getTwilioClient();
  const body = options?.body ?? buildWhatsappTemplate(record);
  const requestBody: Parameters<typeof client.messages.create>[0] = {
    from: requireEnv("TWILIO_WHATSAPP_FROM"),
    to: toWhatsAppAddress(record.telefono),
    body
  };

  if (options?.mediaUrl) {
    requestBody.mediaUrl = [options.mediaUrl];
  }

  const message = await client.messages.create(requestBody);

  return {
    body,
    sid: message.sid
  };
}

export function buildAutoReply(intent: IntentType) {
  switch (intent) {
    case "confirmar":
      return "Tu cita ha quedado confirmada. ¡Gracias!";
    case "cambiar":
      return "Hemos registrado tu solicitud de cambio. Te contactaremos enseguida.";
    case "reservar":
      return "Tu solicitud de reserva ha sido registrada. Te confirmamos en breve.";
    case "info":
      return "Te enviamos la información solicitada. Un agente puede contactarte si lo necesitas.";
    case "rechazo":
      return "Gracias por tu respuesta.";
    default:
      return "Gracias. Hemos recibido tu mensaje y lo revisaremos.";
  }
}
