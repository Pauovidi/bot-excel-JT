"use client";

import { useEffect, useState, useTransition } from "react";
import clsx from "clsx";

import { ACTION_OPTIONS } from "@/lib/constants";
import type { ActionType, DemoRecord } from "@/types/demo";

type RecordsTableProps = {
  records: DemoRecord[];
  totalRecords: number;
  onSave: (id: string, payload: { tipoAccion: ActionType; fechaAccion: string; horaCita: string }) => Promise<void>;
};

type DraftMap = Record<
  string,
  {
    tipoAccion: ActionType;
    fechaAccion: string;
    horaCita: string;
  }
>;

const badgeStyles: Record<DemoRecord["estadoWhatsapp"], string> = {
  pendiente: "bg-white text-ink/75 border-sand/80",
  enviado: "bg-mint/20 text-teal border-mint",
  respondido: "bg-fog text-teal border-fog",
  rechazo: "bg-sand text-ink/75 border-sand/80",
  error: "bg-red-50 text-red-600 border-red-200",
  calendar_creado: "bg-teal text-white border-teal",
  pendiente_reprogramacion: "bg-coral/15 text-coral border-coral/40"
};

export function RecordsTable({ records, totalRecords, onSave }: RecordsTableProps) {
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [savingId, startTransition] = useTransition();

  useEffect(() => {
    setDrafts(
      Object.fromEntries(
        records.map((record) => [
          record.id,
          {
            tipoAccion: record.tipoAccion,
            fechaAccion: record.fechaAccion,
            horaCita: record.horaCita
          }
        ])
      )
    );
  }, [records]);

  return (
    <div className="glass-card min-w-0 overflow-hidden rounded-[28px] border border-white/60 p-6 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.32em] text-teal/70">Registros</p>
          <h2 className="mt-2 text-2xl text-ink">Tabla editable para la demo</h2>
          <p className="mt-2 text-sm text-ink/70">Mostrando {records.length} de {totalRecords} registros.</p>
        </div>
        <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-ink/70">
          {totalRecords} filas totales
        </span>
      </div>

      <div className="max-w-full overflow-x-auto">
        <table className="min-w-[920px] text-sm xl:min-w-full">
          <thead>
            <tr className="border-b border-sand/70 text-left text-xs uppercase tracking-[0.24em] text-ink/65">
              <th className="pb-3 pr-4">Nombre</th>
              <th className="pb-3 pr-4">Teléfono</th>
              <th className="pb-3 pr-4">Tratamiento</th>
              <th className="pb-3 pr-4">Tipo acción</th>
              <th className="pb-3 pr-4">Fecha acción</th>
              <th className="pb-3 pr-4">Hora cita</th>
              <th className="pb-3 pr-4">Estado WhatsApp</th>
              <th className="pb-3 pr-4">Acción</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const draft = drafts[record.id] ?? {
                tipoAccion: record.tipoAccion,
                fechaAccion: record.fechaAccion,
                horaCita: record.horaCita
              };

              return (
                <tr key={record.id} className="border-b border-white/60 align-top">
                  <td className="min-w-[220px] py-4 pr-4">
                    <div className="font-semibold text-ink">{record.nombre || "Sin nombre"}</div>
                    {record.validationErrors.length > 0 ? (
                      <div className="mt-1 text-xs text-red-600">{record.validationErrors.join(" ")}</div>
                    ) : null}
                  </td>
                  <td className="min-w-[130px] py-4 pr-4 text-ink/80">{record.telefono || "-"}</td>
                  <td className="min-w-[170px] py-4 pr-4 text-ink/80">{record.tratamientoRealizado || "-"}</td>
                  <td className="min-w-[160px] py-4 pr-4">
                    <select
                      className="w-full rounded-xl border border-sand bg-white/80 px-3 py-2 outline-none transition focus:border-teal"
                      value={draft.tipoAccion}
                      onChange={(event) => {
                        const value = event.target.value as ActionType;
                        setDrafts((current) => ({
                          ...current,
                          [record.id]: {
                            ...draft,
                            tipoAccion: value
                          }
                        }));
                      }}
                    >
                      {ACTION_OPTIONS.map((action) => (
                        <option key={action} value={action}>
                          {action}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="min-w-[150px] py-4 pr-4">
                    <input
                      type="date"
                      className="w-full rounded-xl border border-sand bg-white/80 px-3 py-2 outline-none transition focus:border-teal"
                      value={draft.fechaAccion}
                      onChange={(event) => {
                        setDrafts((current) => ({
                          ...current,
                          [record.id]: {
                            ...draft,
                            fechaAccion: event.target.value
                          }
                        }));
                      }}
                    />
                  </td>
                  <td className="min-w-[130px] py-4 pr-4">
                    <input
                      type="time"
                      className="w-full rounded-xl border border-sand bg-white/80 px-3 py-2 outline-none transition focus:border-teal"
                      value={draft.horaCita}
                      onChange={(event) => {
                        setDrafts((current) => ({
                          ...current,
                          [record.id]: {
                            ...draft,
                            horaCita: event.target.value
                          }
                        }));
                      }}
                    />
                  </td>
                  <td className="min-w-[170px] py-4 pr-4">
                    <span
                      className={clsx(
                        "inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em]",
                        badgeStyles[record.estadoWhatsapp]
                      )}
                    >
                      {record.estadoWhatsapp}
                    </span>
                  </td>
                  <td className="min-w-[120px] py-4 pr-4">
                    <button
                      className="rounded-full bg-teal px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-white transition hover:bg-ink disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={savingId}
                      onClick={() => {
                        startTransition(async () => {
                          await onSave(record.id, draft);
                        });
                      }}
                    >
                      Guardar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
