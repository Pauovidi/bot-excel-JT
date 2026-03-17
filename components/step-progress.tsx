"use client";

import clsx from "clsx";

import type { DemoState, StepKey } from "@/types/demo";

const stepLabels: Record<StepKey, string> = {
  excel_loaded: "Excel cargado",
  data_parsed: "Datos parseados",
  sheet_updated: "Google Sheet actualizado",
  trigger_detected: "Trigger detectado",
  whatsapp_sent: "WhatsApp enviado",
  response_received: "Respuesta recibida",
  calendar_updated: "Google Calendar actualizado"
};

const statusClasses = {
  idle: "border-sand/70 bg-white/60 text-ink/70",
  done: "border-mint bg-mint/25 text-teal",
  warning: "border-coral/40 bg-coral/10 text-coral",
  error: "border-red-300 bg-red-50 text-red-600"
} as const;

type StepProgressProps = {
  state: DemoState;
};

export function StepProgress({ state }: StepProgressProps) {
  return (
    <div className="glass-card rounded-[28px] border border-white/60 p-6 shadow-card">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.32em] text-teal/70">Estado visual</p>
          <h2 className="mt-2 text-2xl text-ink">Flujo de la demo</h2>
        </div>
        <p className="rounded-full border border-white/70 bg-white/80 px-4 py-2 text-xs text-ink/70">
          Auto-check cada 30s con la app abierta
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Object.entries(stepLabels).map(([key, label], index) => {
          const stepKey = key as StepKey;
          const status = state.steps[stepKey];
          return (
            <div
              key={stepKey}
              className={clsx(
                "relative overflow-hidden rounded-2xl border px-4 py-4 transition",
                statusClasses[status]
              )}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs uppercase tracking-[0.24em]">Paso {index + 1}</span>
                <span className="text-xs font-semibold uppercase">{status}</span>
              </div>
              <p className="text-sm font-semibold">{label}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
