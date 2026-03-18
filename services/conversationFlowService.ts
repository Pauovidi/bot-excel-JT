import { formatDisplayDate, nowIso } from "@/lib/dateUtils";
import { normalizeActionTypeValue, normalizeFlowTypeValue, normalizeHeaderKey, stripAccents } from "@/lib/normalization";
import { createConversationCalendarEvent } from "@/services/calendarService";
import type { ActionType, ConversationState, DemoRecord, FlowType } from "@/types/demo";

type FlowLog = {
  accion: string;
  resultado: string;
  detalle: string;
};

type SlotOption = {
  label: string;
  date: string;
  time: string;
};

type FlowStartResult = {
  record: DemoRecord;
  message: string;
  mediaUrl?: string;
  logs: FlowLog[];
};

type FlowProgressResult = {
  record: DemoRecord;
  replyMessage: string;
  logs: FlowLog[];
  calendarUpdated: boolean;
};

export type FlowSpecialization = "cumpleanos" | "implantologia" | "ortodoncia" | "none";

export type FlowSelection = {
  normalizedActionType: ActionType;
  normalizedContext: string;
  specialization: FlowSpecialization;
  flowType: FlowType;
  selectedTemplate: string;
  fallbackUsed: boolean;
};

function normalizeMessage(message: string) {
  return stripAccents(message).toLowerCase().trim().replace(/\s+/g, " ");
}

function tokenizeMessage(message: string) {
  return normalizeMessage(message)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasTokenSequence(text: string, candidate: string) {
  const textTokens = tokenizeMessage(text);
  const candidateTokens = tokenizeMessage(candidate);

  if (candidateTokens.length === 0 || candidateTokens.length > textTokens.length) {
    return false;
  }

  for (let start = 0; start <= textTokens.length - candidateTokens.length; start += 1) {
    let matches = true;
    for (let index = 0; index < candidateTokens.length; index += 1) {
      if (textTokens[start + index] !== candidateTokens[index]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return false;
}

function hasAny(text: string, candidates: string[]) {
  return candidates.some((candidate) => hasTokenSequence(text, candidate));
}

function matchesConversationRejection(message: string) {
  const normalized = normalizeMessage(message);
  return (
    normalized === "no" ||
    hasAny(normalized, [
      "no gracias",
      "ahora no",
      "otro momento",
      "mas tarde",
      "más tarde",
      "prefiero no",
      "de momento no"
    ])
  );
}

function serializeSlot(slot: SlotOption) {
  return `${slot.label}@@${slot.date}@@${slot.time}`;
}

function deserializeSlots(values: string[]) {
  return values
    .map((value) => {
      const [label, date, time] = value.split("@@");
      if (!label || !date || !time) {
        return null;
      }

      return {
        label,
        date,
        time
      } satisfies SlotOption;
    })
    .filter((slot): slot is SlotOption => Boolean(slot));
}

function getNextWeekdayDate(targetWeekday: number, weekOffset = 0) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const currentWeekday = start.getDay();
  let delta = (targetWeekday - currentWeekday + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  delta += weekOffset * 7;
  start.setDate(start.getDate() + delta);
  return start.toISOString().slice(0, 10);
}

function buildSlot(label: string, weekday: number, weekOffset: number, time: string) {
  const date = getNextWeekdayDate(weekday, weekOffset);
  return {
    label,
    date,
    time
  } satisfies SlotOption;
}

function buildBirthdayThisWeekSlots() {
  return [
    buildSlot("Jueves a las 10:00", 4, 0, "10:00"),
    buildSlot("Viernes a las 17:00", 5, 0, "17:00")
  ];
}

function buildBirthdayNextWeekSlots() {
  return [
    buildSlot("Martes a las 11:00", 2, 1, "11:00"),
    buildSlot("Jueves a las 18:00", 4, 1, "18:00")
  ];
}

function buildClinicReviewSlots() {
  return [
    buildSlot("Martes a las 11:00", 2, 0, "11:00"),
    buildSlot("Jueves a las 18:00", 4, 0, "18:00")
  ];
}

function matchesSlot(message: string, slot: SlotOption) {
  const normalized = normalizeMessage(message);
  const slotText = normalizeMessage(slot.label);
  const hour = slot.time.slice(0, 2);

  return (
    (normalized.includes("martes") && slotText.includes("martes")) ||
    (normalized.includes("jueves") && slotText.includes("jueves")) ||
    (normalized.includes("viernes") && slotText.includes("viernes")) ||
    normalized.includes(slot.time) ||
    normalized.includes(hour)
  );
}

function resolveSelectedSlot(record: DemoRecord, message: string) {
  return deserializeSlots(record.proposedSlots).find((slot) => matchesSlot(message, slot));
}

function getSummaryForFlow(flowType: FlowType, record: DemoRecord) {
  switch (flowType) {
    case "cumpleanos":
      return `Limpieza regalo cumpleaños - ${record.nombre}`;
    case "implantologia_recuperacion":
      return `Revision implantologia - ${record.nombre}`;
    case "revision_ortodoncia":
      return `Revision ortodoncia - ${record.nombre}`;
    default:
      return `Cita dental - ${record.nombre}`;
  }
}

function getInitialConversationState(flowType: FlowType): ConversationState {
  switch (flowType) {
    case "cumpleanos":
      return "birthday_offer_sent";
    case "implantologia_recuperacion":
      return "implant_followup_sent";
    case "revision_ortodoncia":
      return "ortho_review_sent";
    default:
      return "";
  }
}

function getInitialBotMessageType(flowType: FlowType) {
  switch (flowType) {
    case "cumpleanos":
      return "birthday_initial";
    case "implantologia_recuperacion":
      return "implant_initial";
    case "revision_ortodoncia":
      return "ortho_initial";
    default:
      return "";
  }
}

function withClosedConversation(
  record: DemoRecord,
  status: DemoRecord["estadoWhatsapp"],
  conversationState: ConversationState,
  selectedSlot?: SlotOption
) {
  return {
    ...record,
    estadoWhatsapp: status,
    conversationClosed: true,
    conversationState,
    selectedSlot: selectedSlot?.label ?? record.selectedSlot,
    proposedSlots: selectedSlot ? [serializeSlot(selectedSlot)] : record.proposedSlots,
    updatedAtDemo: nowIso()
  } satisfies DemoRecord;
}

function buildNormalizedFlowContext(record: DemoRecord) {
  return normalizeHeaderKey(
    [record.sheetName, record.tratamientoRealizado, record.casillaPresupuesto].filter(Boolean).join(" ")
  );
}

export function resolveConversationFlowSelection(record: DemoRecord): FlowSelection {
  const normalizedActionType = normalizeActionTypeValue(record.tipoAccion);
  const normalizedContext = buildNormalizedFlowContext(record);

  if (normalizedActionType === "cumpleanos") {
    return {
      normalizedActionType,
      normalizedContext,
      specialization: "cumpleanos",
      flowType: "cumpleanos",
      selectedTemplate: "birthday_initial",
      fallbackUsed: false
    };
  }

  if (normalizedActionType === "promo" && normalizedContext.includes("implant")) {
    return {
      normalizedActionType,
      normalizedContext,
      specialization: "implantologia",
      flowType: "implantologia_recuperacion",
      selectedTemplate: "implant_initial",
      fallbackUsed: false
    };
  }

  if (normalizedActionType === "revision" && normalizedContext.includes("ortodon")) {
    return {
      normalizedActionType,
      normalizedContext,
      specialization: "ortodoncia",
      flowType: "revision_ortodoncia",
      selectedTemplate: "ortho_initial",
      fallbackUsed: false
    };
  }

  return {
    normalizedActionType,
    normalizedContext,
    specialization: "none",
    flowType: "",
    selectedTemplate: normalizedActionType,
    fallbackUsed: true
  };
}

function resolveFlowType(record: DemoRecord): FlowType {
  return resolveConversationFlowSelection(record).flowType;
}

function baseFlowRecord(
  record: DemoRecord,
  flowType: FlowType,
  conversationState: ConversationState,
  lastBotMessageType: string
) {
  return {
    ...record,
    flowType,
    conversationState,
    lastBotMessageType,
    lastUserMessage: "",
    intentDetected: "",
    proposedSlots: [],
    selectedSlot: "",
    conversationClosed: false,
    updatedAtDemo: nowIso()
  } satisfies DemoRecord;
}

function buildBirthdayConfirmation(record: DemoRecord, slot: SlotOption) {
  const weekday = normalizeMessage(slot.label).includes("viernes") ? "viernes" : "jueves";
  return `¡Cita confirmada, ${record.nombre}! 🎉

Te esperamos este ${weekday} a las ${slot.time} para disfrutar tu limpieza dental de cumpleaños.

Si necesitas cambiar la hora, solo dímelo por aquí.`;
}

function buildImplantConfirmation(record: DemoRecord, slot: SlotOption) {
  const weekday = normalizeMessage(slot.label).includes("jueves") ? "jueves" : "martes";
  return `Genial, ${record.nombre}.

Te reservo el ${weekday} a las ${slot.time} para revisar la zona del implante y actualizar la valoración si es necesario.

Si necesitas cambiar la hora, solo dímelo por aquí.`;
}

function buildOrthoConfirmation(record: DemoRecord, slot: SlotOption) {
  const weekday = normalizeMessage(slot.label).includes("jueves") ? "jueves" : "martes";
  return `Genial, ${record.nombre}.

Te reservo el ${weekday} a las ${slot.time} para revisar tu ortodoncia y asegurarnos de que todo sigue avanzando correctamente.

Si necesitas cambiar la hora, solo dímelo por aquí.`;
}

export function prepareGuidedFlowStart(record: DemoRecord): FlowStartResult | null {
  const flowType = resolveFlowType(record);
  if (!flowType) {
    return null;
  }

  if (flowType === "cumpleanos") {
    return {
      record: baseFlowRecord(record, flowType, "birthday_offer_sent", "birthday_initial"),
      message: `Feliz cumpleaños, ${record.nombre} 🎉

En Clínica Dental Mar queremos celebrarlo contigo regalándote una limpieza dental profesional.

Si quieres disfrutar tu regalo, responde “Pedir cita” y te reservo hora.`,
      mediaUrl: process.env.TWILIO_CUMPLEANOS_MEDIA_URL?.trim() || undefined,
      logs: [
        {
          accion: "flow_started",
          resultado: flowType,
          detalle: "Flujo guiado de cumpleaños iniciado."
        }
      ]
    };
  }

  if (flowType === "implantologia_recuperacion") {
    return {
      record: baseFlowRecord(record, flowType, "implant_followup_sent", "implant_initial"),
      message: `Hola ${record.nombre}, soy de la Clínica Dental Mar.

Hace unos meses viniste porque tenías molestias en la zona donde valoramos colocar un implante.

Solo quería saber cómo has estado desde entonces y si esa zona te ha dado problemas o ha mejorado.`,
      logs: [
        {
          accion: "flow_started",
          resultado: flowType,
          detalle: "Flujo de recuperación de implantología iniciado."
        }
      ]
    };
  }

  return {
    record: baseFlowRecord(record, flowType, "ortho_review_sent", "ortho_initial"),
    message: `Hola ${record.nombre}, soy de la Clínica Dental Mar.

Hemos estado revisando tu expediente y hemos visto que tenías prevista una revisión de ortodoncia hace un tiempo y no llegaste a venir.

Solo quería asegurarme de que todo sigue bien y que no has notado cambios en el movimiento de los dientes o en los alineadores.`,
    logs: [
      {
        accion: "flow_started",
        resultado: flowType,
        detalle: "Flujo de revisión pendiente de ortodoncia iniciado."
      }
    ]
  };
}

export function hydrateOpenGuidedFlowRecord(record: DemoRecord) {
  if (record.conversationClosed || record.estadoWhatsapp !== "enviado") {
    return record;
  }

  const flowType = resolveFlowType(record);
  if (!flowType) {
    if (!record.flowType && !record.conversationState && !record.lastBotMessageType) {
      return record;
    }

    return {
      ...record,
      flowType: "",
      conversationState: "",
      lastBotMessageType: "",
      lastUserMessage: "",
      intentDetected: "",
      proposedSlots: [],
      selectedSlot: ""
    } satisfies DemoRecord;
  }

  if (record.flowType === flowType && record.conversationState) {
    return {
      ...record,
      lastBotMessageType: record.lastBotMessageType || getInitialBotMessageType(flowType)
    } satisfies DemoRecord;
  }

  return {
    ...record,
    flowType,
    conversationState: getInitialConversationState(flowType),
    lastBotMessageType: getInitialBotMessageType(flowType),
    lastUserMessage: "",
    intentDetected: "",
    proposedSlots: [],
    selectedSlot: ""
  } satisfies DemoRecord;
}

function wantsBirthdayBooking(message: string) {
  return hasAny(message, [
    "pedir cita",
    "quiero pedir cita",
    "quiero cita",
    "reservar",
    "reservar cita",
    "agendar cita"
  ]);
}

function matchesRevisionChangeSignal(message: string) {
  return hasAny(message, [
    "he notado cambios",
    "noto cambios",
    "si he notado cambios",
    "sí he notado cambios",
    "he notado algo",
    "si noto cambios",
    "sí noto cambios",
    "cambios",
    "han cambiado",
    "se han movido",
    "noto movimiento",
    "los alineadores han cambiado",
    "los dientes se han movido",
    "cambio",
    "movimiento",
    "mueve",
    "alineadores",
    "dientes"
  ]);
}

function matchesRevisionAdherenceIssue(message: string) {
  return hasAny(message, [
    "no mucho",
    "un poco",
    "si un poco",
    "sí un poco",
    "algo",
    "bastante",
    "no demasiado",
    "regular",
    "mal",
    "poco",
    "a veces",
    "me ha costado"
  ]);
}

function matchesRevisionAcceptance(message: string) {
  return hasAny(message, [
    "si",
    "sí",
    "vale",
    "ok",
    "de acuerdo",
    "quiero",
    "me va bien",
    "acepto",
    "agendemos",
    "agendemos una cita",
    "si agendemos una cita",
    "sí agendemos una cita",
    "cita"
  ]);
}

async function confirmSlot(
  record: DemoRecord,
  slot: SlotOption,
  conversationState: ConversationState
) {
  const scheduledRecord = {
    ...record,
    fechaAccion: slot.date,
    horaCita: slot.time,
    selectedSlot: slot.label
  };
  const eventId = await createConversationCalendarEvent(scheduledRecord, {
    summary: getSummaryForFlow(record.flowType, record)
  });

  return {
    ...withClosedConversation(scheduledRecord, "calendar_creado", conversationState, slot),
    calendarEventId: eventId,
    lastBotMessageType: "slot_confirmed"
  } satisfies DemoRecord;
}

export async function progressGuidedFlow(
  record: DemoRecord,
  inboundMessage: string
): Promise<FlowProgressResult | null> {
  const activeFlowType = normalizeFlowTypeValue(record.flowType);
  if (!activeFlowType || record.conversationClosed) {
    return null;
  }

  const normalized = normalizeMessage(inboundMessage);
  const withInbound = {
    ...record,
    flowType: activeFlowType,
    ultimaRespuesta: inboundMessage,
    lastUserMessage: inboundMessage,
    updatedAtDemo: nowIso()
  } satisfies DemoRecord;

  if (activeFlowType === "revision_ortodoncia") {
    console.info("[conversationFlowService] revision inbound received", {
      recordId: record.id,
      inboundMessage,
      normalizedInbound: normalized
    });
    console.info("[conversationFlowService] revision step current", {
      recordId: record.id,
      conversationState: record.conversationState
    });
  }

  if (matchesConversationRejection(normalized)) {
    return {
      record: withClosedConversation(
        {
          ...withInbound,
          intentDetected: "rechazo",
          lastBotMessageType: "conversation_closed"
        },
        "rechazo",
        "closed"
      ),
      replyMessage: "Perfecto, lo dejamos aquí. Si más adelante te encaja, escríbenos y retomamos la cita.",
      logs: [
        {
          accion: "conversation_closed",
          resultado: "rechazo",
          detalle: "La conversación se cerró por rechazo del paciente."
        }
      ],
      calendarUpdated: false
    };
  }

  if (activeFlowType === "cumpleanos") {
    if (record.conversationState === "birthday_offer_sent" && wantsBirthdayBooking(normalized)) {
      return {
        record: {
          ...withInbound,
          conversationState: "birthday_waiting_week",
          lastBotMessageType: "birthday_ask_week",
          intentDetected: "pedir_cita"
        },
        replyMessage: `Genial, ${record.nombre}. Me alegra que quieras aprovechar tu regalo.

¿Prefieres venir esta semana o la próxima?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "birthday_offer_sent",
            detalle: "El mensaje coincide con el paso de pedir cita del flujo de cumpleaños."
          },
          {
            accion: "flow_progressed",
            resultado: "pedir_cita",
            detalle: "El paciente quiere pedir cita en el flujo de cumpleaños."
          }
        ],
        calendarUpdated: false
      };
    }

    if (record.conversationState === "birthday_waiting_week") {
      const wantsThisWeek = normalized.includes("esta semana");
      const wantsNextWeek = normalized.includes("la proxima") || normalized.includes("la próxima") || normalized.includes("proxima");

      if (wantsThisWeek || wantsNextWeek) {
        const slots = wantsThisWeek ? buildBirthdayThisWeekSlots() : buildBirthdayNextWeekSlots();
        return {
          record: {
            ...withInbound,
            conversationState: "birthday_waiting_slot",
            lastBotMessageType: "birthday_slot_offer",
            intentDetected: wantsThisWeek ? "esta_semana" : "proxima",
            proposedSlots: slots.map(serializeSlot)
          },
          replyMessage: `Perfecto. Tengo dos huecos disponibles:
- ${slots[0].label}
- ${slots[1].label}

¿Cuál te viene mejor?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "birthday_waiting_week",
            detalle: "El mensaje coincide con la selección de semana del flujo de cumpleaños."
          },
          {
            accion: "flow_progressed",
            resultado: wantsThisWeek ? "esta_semana" : "proxima",
              detalle: "El paciente eligió la franja temporal del flujo de cumpleaños."
            },
            {
              accion: "slot_offered",
              resultado: "ok",
              detalle: `Slots ofrecidos: ${slots.map((slot) => slot.label).join(" / ")}.`
            }
          ],
          calendarUpdated: false
        };
      }
    }

    if (record.conversationState === "birthday_waiting_slot") {
      const selectedSlot = resolveSelectedSlot(record, inboundMessage);
      if (selectedSlot) {
        const updated = await confirmSlot(
          {
            ...withInbound,
            intentDetected: normalizeMessage(selectedSlot.label)
          },
          selectedSlot,
          "birthday_confirmed"
        );

        return {
          record: updated,
          replyMessage: buildBirthdayConfirmation(record, selectedSlot),
          logs: [
            {
              accion: "flow_step_matched",
              resultado: "birthday_waiting_slot",
              detalle: "El mensaje coincide con un slot ofrecido en el flujo de cumpleaños."
            },
            {
              accion: "slot_confirmed",
              resultado: "ok",
              detalle: `Slot confirmado: ${selectedSlot.label}.`
            },
            {
              accion: "conversation_closed",
              resultado: "calendar_creado",
              detalle: "Flujo de cumpleaños cerrado con cita confirmada."
            }
          ],
          calendarUpdated: true
        };
      }
    }
  }

  if (activeFlowType === "implantologia_recuperacion") {
    if (
      record.conversationState === "implant_followup_sent" &&
      hasAny(normalized, ["molestia", "molestias", "dolor", "me duele", "me molesta", "me ha dado problemas"])
    ) {
      return {
        record: {
          ...withInbound,
          conversationState: "implant_waiting_reason",
          lastBotMessageType: "implant_ask_reason",
          intentDetected: "molestia"
        },
        replyMessage: `Entiendo, ${record.nombre}.

En su momento parecía algo que convenía tratar, pero también sabemos que con los implantes muchas personas necesitan pensarlo, o simplemente no era el mejor momento.

¿Hubo algo en concreto que te hizo no seguir adelante en aquel momento?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "implant_followup_sent",
            detalle: "El mensaje coincide con la detección de molestia en implantología."
          },
          {
            accion: "flow_progressed",
            resultado: "molestia",
            detalle: "El paciente indica molestia en la zona del implante."
          }
        ],
        calendarUpdated: false
      };
    }

    if (
      record.conversationState === "implant_waiting_reason" &&
      hasAny(normalized, ["objecion", "duda", "precio", "dinero", "miedo", "lo fui dejando", "dejando", "tiempo"])
    ) {
      return {
        record: {
          ...withInbound,
          conversationState: "implant_waiting_acceptance",
          lastBotMessageType: "implant_recommend_review",
          intentDetected: "objecion"
        },
        replyMessage: `Gracias por contármelo, ${record.nombre}.

Con los implantes es muy habitual que en unos meses la situación cambie: el hueso puede variar, la molestia puede aumentar o incluso mejorar.

Por eso lo más recomendable es hacer una revisión rápida para ver cómo está la zona ahora y valorar si sigue siendo la misma opción o hay alternativas.

¿Te parece que agendemos una cita para verlo?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "implant_waiting_reason",
            detalle: "El mensaje coincide con la objeción del flujo de implantología."
          },
          {
            accion: "flow_progressed",
            resultado: "objecion",
            detalle: "El paciente comparte una objeción en implantología."
          }
        ],
        calendarUpdated: false
      };
    }

    if (
      record.conversationState === "implant_waiting_acceptance" &&
      hasAny(normalized, ["si", "sí", "vale", "ok", "de acuerdo", "quiero", "me va bien", "acepto", "agendemos", "cita"])
    ) {
      const slots = buildClinicReviewSlots();
      return {
        record: {
          ...withInbound,
          conversationState: "implant_waiting_slot",
          lastBotMessageType: "implant_slot_offer",
          intentDetected: "acepta_revision",
          proposedSlots: slots.map(serializeSlot)
        },
        replyMessage: `Perfecto, ${record.nombre}.

Te propongo dos opciones:
- ${slots[0].label}
- ${slots[1].label}

¿Cuál te viene mejor?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "implant_waiting_acceptance",
            detalle: "El mensaje coincide con la aceptación de revisión en implantología."
          },
          {
            accion: "flow_progressed",
            resultado: "acepta_revision",
            detalle: "El paciente acepta revisión de implantología."
          },
          {
            accion: "slot_offered",
            resultado: "ok",
            detalle: `Slots ofrecidos: ${slots.map((slot) => slot.label).join(" / ")}.`
          }
        ],
        calendarUpdated: false
      };
    }

    if (record.conversationState === "implant_waiting_slot") {
      const selectedSlot = resolveSelectedSlot(record, inboundMessage);
      if (selectedSlot) {
        const updated = await confirmSlot(
          {
            ...withInbound,
            intentDetected: normalizeMessage(selectedSlot.label)
          },
          selectedSlot,
          "implant_confirmed"
        );

        return {
          record: updated,
          replyMessage: buildImplantConfirmation(record, selectedSlot),
          logs: [
            {
              accion: "flow_step_matched",
              resultado: "implant_waiting_slot",
              detalle: "El mensaje coincide con un slot ofrecido en implantología."
            },
            {
              accion: "slot_confirmed",
              resultado: "ok",
              detalle: `Slot confirmado: ${selectedSlot.label}.`
            },
            {
              accion: "conversation_closed",
              resultado: "calendar_creado",
              detalle: "Flujo de implantología cerrado con cita confirmada."
            }
          ],
          calendarUpdated: true
        };
      }
    }
  }

  if (activeFlowType === "revision_ortodoncia") {
    const currentStep = record.conversationState || "revision_ortodoncia";

    if (
      record.conversationState === "ortho_review_sent" &&
      matchesRevisionChangeSignal(normalized)
    ) {
      console.info("[conversationFlowService] revision intent parsed", {
        recordId: record.id,
        step: currentStep,
        intent: "cambios"
      });
      console.info("[conversationFlowService] revision branch selected", {
        recordId: record.id,
        step: currentStep,
        branch: "ortho_waiting_adherence"
      });
      return {
        record: {
          ...withInbound,
          conversationState: "ortho_waiting_adherence",
          lastBotMessageType: "ortho_ask_adherence",
          intentDetected: "cambios"
        },
        replyMessage: `Gracias por contármelo, ${record.nombre}.

Esa revisión era importante para asegurarnos de que el movimiento de los dientes seguía como estaba previsto.

¿Has podido seguir usando los alineadores con normalidad estos meses?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "ortho_review_sent",
            detalle: "El mensaje coincide con la detección de cambios en ortodoncia."
          },
          {
            accion: "flow_progressed",
            resultado: "cambios",
            detalle: "El paciente indica cambios en ortodoncia."
          }
        ],
        calendarUpdated: false
      };
    }

    if (
      record.conversationState === "ortho_waiting_adherence" &&
      matchesRevisionAdherenceIssue(normalized)
    ) {
      console.info("[conversationFlowService] revision intent parsed", {
        recordId: record.id,
        step: currentStep,
        intent: "mala_adherencia"
      });
      console.info("[conversationFlowService] revision branch selected", {
        recordId: record.id,
        step: currentStep,
        branch: "ortho_waiting_acceptance"
      });
      return {
        record: {
          ...withInbound,
          conversationState: "ortho_waiting_acceptance",
          lastBotMessageType: "ortho_recommend_review",
          intentDetected: "mala_adherencia"
        },
        replyMessage: `Es totalmente normal, ${record.nombre}.

En ortodoncia, cuando pasa tiempo sin revisión, los dientes pueden moverse de forma distinta a lo planificado.

Para quedarnos tranquilos, lo ideal sería verte unos minutos y revisar cómo está todo.

¿Te parece que agendemos una cita para verlo?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "ortho_waiting_adherence",
            detalle: "El mensaje coincide con la detección de mala adherencia en ortodoncia."
          },
          {
            accion: "flow_progressed",
            resultado: "mala_adherencia",
            detalle: "El paciente indica mala adherencia en ortodoncia."
          }
        ],
        calendarUpdated: false
      };
    }

    if (
      record.conversationState === "ortho_waiting_acceptance" &&
      matchesRevisionAcceptance(normalized)
    ) {
      console.info("[conversationFlowService] revision intent parsed", {
        recordId: record.id,
        step: currentStep,
        intent: "acepta_revision"
      });
      console.info("[conversationFlowService] revision branch selected", {
        recordId: record.id,
        step: currentStep,
        branch: "ortho_waiting_slot"
      });
      const slots = buildClinicReviewSlots();
      return {
        record: {
          ...withInbound,
          conversationState: "ortho_waiting_slot",
          lastBotMessageType: "ortho_slot_offer",
          intentDetected: "acepta_revision",
          proposedSlots: slots.map(serializeSlot)
        },
        replyMessage: `Perfecto, ${record.nombre}.

Te propongo dos opciones:
- ${slots[0].label}
- ${slots[1].label}

¿Cuál te viene mejor?`,
        logs: [
          {
            accion: "flow_step_matched",
            resultado: "ortho_waiting_acceptance",
            detalle: "El mensaje coincide con la aceptación de revisión en ortodoncia."
          },
          {
            accion: "flow_progressed",
            resultado: "acepta_revision",
            detalle: "El paciente acepta revisión de ortodoncia."
          },
          {
            accion: "slot_offered",
            resultado: "ok",
            detalle: `Slots ofrecidos: ${slots.map((slot) => slot.label).join(" / ")}.`
          }
        ],
        calendarUpdated: false
      };
    }

    if (record.conversationState === "ortho_waiting_slot") {
      const selectedSlot = resolveSelectedSlot(record, inboundMessage);
      if (selectedSlot) {
        console.info("[conversationFlowService] revision intent parsed", {
          recordId: record.id,
          step: currentStep,
          intent: normalizeMessage(selectedSlot.label)
        });
        console.info("[conversationFlowService] revision branch selected", {
          recordId: record.id,
          step: currentStep,
          branch: "ortho_confirmed"
        });
        const updated = await confirmSlot(
          {
            ...withInbound,
            intentDetected: normalizeMessage(selectedSlot.label)
          },
          selectedSlot,
          "ortho_confirmed"
        );

        return {
          record: updated,
          replyMessage: buildOrthoConfirmation(record, selectedSlot),
          logs: [
            {
              accion: "flow_step_matched",
              resultado: "ortho_waiting_slot",
              detalle: "El mensaje coincide con un slot ofrecido en ortodoncia."
            },
            {
              accion: "slot_confirmed",
              resultado: "ok",
              detalle: `Slot confirmado: ${selectedSlot.label}.`
            },
            {
              accion: "conversation_closed",
              resultado: "calendar_creado",
              detalle: "Flujo de ortodoncia cerrado con cita confirmada."
            }
          ],
          calendarUpdated: true
        };
      }
    }

    console.info("[conversationFlowService] revision fallback used", {
      recordId: record.id,
      step: currentStep,
      inboundMessage,
      normalizedInbound: normalized
    });
  }

  return {
    record: withInbound,
    replyMessage: "Perfecto. Si te parece, responde con una de las opciones que te acabo de indicar y seguimos.",
    logs: [
      ...(activeFlowType === "revision_ortodoncia"
        ? [
            {
              accion: "revision_fallback_used",
              resultado: record.conversationState || activeFlowType,
              detalle: "El mensaje no encajó con el paso actual del flujo de revisión de ortodoncia."
            }
          ]
        : []),
      {
        accion: "flow_step_unmatched",
        resultado: record.conversationState || activeFlowType,
        detalle: "El mensaje entrante no encaja con el paso actual del flujo guiado."
      },
      {
        accion: "flow_progressed",
        resultado: "sin_match",
        detalle: "Mensaje recibido sin coincidencia clara en el flujo guiado."
      }
    ],
    calendarUpdated: false
  };
}
