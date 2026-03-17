"use client";

import type { LogEntry } from "@/types/demo";

type ActivityPanelProps = {
  logs: LogEntry[];
};

export function ActivityPanel({ logs }: ActivityPanelProps) {
  return (
    <div className="glass-card rounded-[28px] border border-white/60 p-6 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.32em] text-teal/70">Actividad</p>
          <h2 className="mt-2 text-2xl text-ink">Timeline en vivo</h2>
        </div>
        <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-ink/70">
          {logs.length} eventos
        </span>
      </div>

      <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
        {logs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-sand bg-white/60 p-4 text-sm text-ink/70">
            Aún no hay actividad. Sube un Excel o fuerza un cambio para empezar la demo.
          </div>
        ) : null}

        {logs.map((log) => (
          <article key={log.id} className="rounded-2xl border border-white/60 bg-white/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink">{log.accion}</p>
                <p className="mt-1 text-sm text-ink/70">{log.detalle || log.resultado}</p>
              </div>
              <span className="rounded-full bg-fog px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-teal">
                {log.resultado}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink/60">
              <span>{log.paciente || "sistema"}</span>
              <span>{log.telefono || "sin teléfono"}</span>
              <span>{log.correlationId}</span>
              <span>{new Date(log.timestamp).toLocaleString("es-ES")}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
