"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActivityPanel } from "@/components/activity-panel";
import { RecordsTable } from "@/components/records-table";
import { StepProgress } from "@/components/step-progress";
import type { ActionType, DemoState } from "@/types/demo";

type ApiResult<T = unknown> = {
  ok: boolean;
  error?: string;
  code?: string;
} & T;

function buildEmptyState(): DemoState {
  return {
    version: 1,
    spreadsheetId: "",
    spreadsheetUrl: "",
    uploadedFilePath: "",
    importSummary: null,
    records: [],
    logs: [],
    steps: {
      excel_loaded: "idle",
      data_parsed: "idle",
      sheet_updated: "idle",
      trigger_detected: "idle",
      whatsapp_sent: "idle",
      response_received: "idle",
      calendar_updated: "idle"
    },
    lastUpdatedAt: new Date(0).toISOString()
  };
}

export function DemoDashboard() {
  const [state, setState] = useState<DemoState>(buildEmptyState);
  const [calendarUrl, setCalendarUrl] = useState("");
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activeOperation, setActiveOperation] = useState<
    "idle" | "upload" | "process" | "check" | "refresh" | "reset" | "save"
  >("idle");

  const totals = useMemo(
    () => ({
      total: state.records.length,
      pendientes: state.records.filter((record) => record.estadoWhatsapp === "pendiente").length,
      enviados: state.records.filter((record) => record.estadoWhatsapp === "enviado").length,
      calendar: state.records.filter((record) => record.calendarEventId).length
    }),
    [state.records]
  );
  const previewRecords = useMemo(() => state.records.slice(0, 5), [state.records]);

  const hasSpreadsheetUrl = Boolean(state.spreadsheetUrl?.trim());
  const hasCalendarUrl = Boolean(calendarUrl.trim());
  const hasUploadedExcel = Boolean(state.importSummary && (state.uploadedFilePath || state.records.length > 0));
  const hasPendingSelection = Boolean(selectedFile);
  const isBusy = activeOperation !== "idle";
  const canRebuildFromSheets = Boolean(state.spreadsheetId || hasSpreadsheetUrl);
  const fileTitle = hasPendingSelection
    ? "Archivo seleccionado"
    : hasUploadedExcel
      ? "Archivo cargado"
      : "Seleccionar archivo";
  const fileDescription = hasPendingSelection
    ? selectedFile?.name || ""
    : hasUploadedExcel
      ? state.importSummary?.fileName || "Excel cargado correctamente"
      : "Haz clic para elegir un Excel de pacientes";
  const defaultNotice = hasPendingSelection
    ? "Archivo seleccionado. Pulsa “Procesar Excel” para cargarlo."
    : hasUploadedExcel
      ? state.uploadedFilePath?.startsWith("reconstructed:")
        ? "Estado reconstruido desde Google Sheets. Ya puedes comprobar cambios o seguir la demo."
        : "Excel procesado correctamente. Ya puedes crear Sheets."
      : canRebuildFromSheets
        ? "No hay parseo en memoria. Usa “Simular refresco de estado” para reconstruir desde Google Sheets."
        : "Selecciona un Excel para continuar.";
  const notice = feedback ?? defaultNotice;

  const clearSelectedFileState = useCallback(() => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const data = await readApiResult<{ state: DemoState; calendarUrl?: string }>(response);
      const nextState = data?.state ?? buildEmptyState();
      setCalendarUrl(data?.calendarUrl ?? "");

      setState((current) => {
        if (current.lastUpdatedAt === nextState.lastUpdatedAt) {
          return current;
        }
        return nextState;
      });

      if (!response.ok || !data?.ok) {
        setFeedback(data?.error || "No se pudo cargar el estado guardado. Se ha usado un estado inicial vacío.");
      }
    } catch {
      setState(buildEmptyState());
      setFeedback("No se pudo cargar el estado guardado. Se ha usado un estado inicial vacío.");
    }
  }, []);

  async function readApiResult<T>(response: Response) {
    const rawText = await response.text();
    if (!rawText) {
      return null;
    }

    try {
      return JSON.parse(rawText) as ApiResult<T>;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!autoCheckEnabled || !state.spreadsheetId || isBusy) {
      return;
    }

    const triggerInterval = window.setInterval(() => {
      void fetch("/api/triggers/check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          spreadsheetId: state.spreadsheetId
        })
      }).then(() => loadState());
    }, 30000);

    return () => window.clearInterval(triggerInterval);
  }, [autoCheckEnabled, isBusy, state.spreadsheetId, loadState]);

  async function runAction<T extends { state?: DemoState } = { state?: DemoState }>(
    input: Promise<Response>,
    successMessage: string,
    onSuccess?: (payload: ApiResult<T>) => void,
    fallbackErrorMessage = "Ha ocurrido un error durante la operación.",
    operation: "upload" | "process" | "check" | "refresh" | "reset" | "save" = "save"
  ) {
    setActiveOperation(operation);
    try {
      const response = await input;
      const payload = await readApiResult<T>(response);
      if (!response.ok || !payload?.ok) {
        setFeedback(payload?.error || fallbackErrorMessage);
        setActiveOperation("idle");
        return;
      }

      if (payload.state) {
        setState(payload.state);
      } else {
        await loadState();
      }

      onSuccess?.(payload);
      setFeedback(successMessage);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Error inesperado.");
    } finally {
      setActiveOperation("idle");
    }
  }

  async function handleUpload() {
    if (!selectedFile) {
      setFeedback("Selecciona un Excel para continuar.");
      return;
    }

    const formData = new FormData();
    formData.append("file", selectedFile);
    await runAction<{ state?: DemoState }>(
      fetch("/api/upload", { method: "POST", body: formData }),
      "Excel procesado correctamente. Ya puedes crear Sheets.",
      () => {
        clearSelectedFileState();
      },
      "No se pudo subir el Excel. Revisa el archivo e inténtalo de nuevo.",
      "upload"
    );
  }

  async function handleProcess() {
    await runAction(
      fetch("/api/process", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          records: state.records,
          importSummary: state.importSummary,
          spreadsheetId: state.spreadsheetId || undefined
        })
      }),
      "Google Sheet creado o actualizado.",
      undefined,
      "No se pudo crear o actualizar Google Sheets. Revisa GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY y las APIs habilitadas.",
      "process"
    );
  }

  async function handleCheckChanges() {
    await runAction(
      fetch("/api/triggers/check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          spreadsheetId: state.spreadsheetId || undefined
        })
      }),
      "Comprobación de cambios completada.",
      undefined,
      "No se pudieron comprobar los cambios en Google Sheets.",
      "check"
    );
  }

  async function handleRefreshState() {
    await runAction(
      fetch("/api/state/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          spreadsheetId: state.spreadsheetId || undefined
        })
      }),
      "Estado refrescado desde Google Sheets.",
      undefined,
      "No se pudo refrescar el estado desde Google Sheets.",
      "refresh"
    );
  }

  async function handleResetDemo() {
    await runAction<{ state: DemoState }>(
      fetch("/api/state/reset", { method: "POST" }),
      "Demo reiniciada. Ya puedes cargar un Excel nuevo.",
      (payload) => {
        setState(payload.state ?? buildEmptyState());
        clearSelectedFileState();
        setFeedback(null);
      },
      "No se pudo reiniciar la demo.",
      "reset"
    );
  }

  async function handleSaveRecord(
    id: string,
    payload: { tipoAccion: ActionType; fechaAccion: string; horaCita: string }
  ) {
    await runAction(
      fetch(`/api/records/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...payload,
          spreadsheetId: state.spreadsheetId || undefined
        })
      }),
      "Fila actualizada. Ya puedes forzar la demo desde la tabla.",
      undefined,
      "No se pudo actualizar la fila.",
      "save"
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-screen-2xl flex-col gap-8 overflow-x-hidden px-4 py-6 sm:px-6 xl:px-8">
      <section className="overflow-hidden rounded-[36px] border border-white/70 bg-hero-mesh p-8 shadow-card">
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div>
            <p className="text-xs uppercase tracking-[0.4em] text-teal/80">Demo full-stack</p>
            <h1 className="mt-4 max-w-3xl text-4xl leading-tight text-ink sm:text-5xl">
              Clínica Dental Juan Margarit: Excel, Google Sheets, WhatsApp y Calendar en un solo flujo.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-ink/75">
              Sube un Excel, agrupa por tratamiento, sincroniza con Google Sheets, detecta cambios y dispara un
              mensaje real de WhatsApp que acaba en una cita real de Google Calendar.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-white transition hover:bg-teal disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedFile || isBusy}
                onClick={handleUpload}
              >
                {activeOperation === "upload" ? "Procesando Excel..." : "Procesar Excel"}
              </button>
              <button
                className="rounded-full border border-ink/15 bg-white/75 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasUploadedExcel || hasPendingSelection || isBusy}
                onClick={handleProcess}
              >
                {activeOperation === "process" ? "Creando Sheets..." : "Crear Sheets"}
              </button>
              <button
                className="rounded-full border border-ink/15 bg-white/75 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasSpreadsheetUrl || isBusy}
                onClick={() => {
                  if (!state.spreadsheetUrl?.trim()) {
                    return;
                  }
                  window.open(state.spreadsheetUrl, "_blank", "noopener,noreferrer");
                }}
              >
                Abrir Google Sheet
              </button>
              <button
                className="rounded-full border border-ink/15 bg-white/75 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasCalendarUrl || isBusy}
                onClick={() => {
                  if (!calendarUrl.trim()) {
                    return;
                  }
                  window.open(calendarUrl, "_blank", "noopener,noreferrer");
                }}
              >
                Abrir Google Calendar
              </button>
              <button
                className="rounded-full border border-coral/30 bg-coral/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.22em] text-coral transition hover:border-coral hover:bg-coral hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isBusy}
                onClick={handleResetDemo}
              >
                {activeOperation === "reset" ? "Reiniciando..." : "Reset demo"}
              </button>
            </div>
          </div>

          <div className="glass-card rounded-[28px] border border-white/70 p-6">
            <p className="text-xs uppercase tracking-[0.32em] text-teal/70">Subida</p>
            <h2 className="mt-2 text-2xl text-ink">Carga tu Excel</h2>
            <p className="mt-2 text-sm leading-6 text-ink/70">
              Se asume una sola hoja. La columna exacta requerida es &quot;Tratamiento realizado&quot;.
            </p>
            <label className="mt-6 flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-[24px] border border-dashed border-teal/35 bg-white/65 p-6 text-center transition hover:border-teal">
              <input
                ref={fileInputRef}
                className="hidden"
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setSelectedFile(nextFile);
                  setFeedback(null);
                }}
              />
              <span className="text-sm font-semibold uppercase tracking-[0.24em] text-teal">
                {fileTitle}
              </span>
              <span className="mt-3 text-sm text-ink/70">
                {fileDescription}
              </span>
            </label>
            <div className="mt-5 rounded-2xl border border-white/70 bg-white/80 p-4 text-sm text-ink/75">
              {notice}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="glass-card rounded-[24px] border border-white/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-[0.24em] text-teal/70">Registros</p>
          <p className="mt-3 text-3xl font-semibold text-ink">{totals.total}</p>
        </article>
        <article className="glass-card rounded-[24px] border border-white/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-[0.24em] text-teal/70">Pendientes</p>
          <p className="mt-3 text-3xl font-semibold text-ink">{totals.pendientes}</p>
        </article>
        <article className="glass-card rounded-[24px] border border-white/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-[0.24em] text-teal/70">WhatsApps enviados</p>
          <p className="mt-3 text-3xl font-semibold text-ink">{totals.enviados}</p>
        </article>
        <article className="glass-card rounded-[24px] border border-white/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-[0.24em] text-teal/70">Eventos Calendar</p>
          <p className="mt-3 text-3xl font-semibold text-ink">{totals.calendar}</p>
        </article>
      </section>

      <StepProgress state={state} autoCheckEnabled={autoCheckEnabled} />

      <section className="grid items-start gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className="min-w-0 space-y-8">
          <div className="glass-card rounded-[28px] border border-white/60 p-6 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-teal/70">Parseo</p>
                <h2 className="mt-2 text-2xl text-ink">Resultado del Excel</h2>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-full border border-ink/15 bg-white/75 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isBusy}
                  onClick={() => {
                    setAutoCheckEnabled((current) => !current);
                    setFeedback(
                      autoCheckEnabled
                        ? "Auto-check desactivado. La demo queda en modo manual."
                        : "Auto-check activado. Se comprobarán cambios cada 30s."
                    );
                  }}
                >
                  Auto-check {autoCheckEnabled ? "ON" : "OFF"}
                </button>
                <button
                  className="rounded-full border border-ink/15 bg-white/75 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!state.spreadsheetId || isBusy}
                  onClick={handleCheckChanges}
                >
                  {activeOperation === "check" ? "Comprobando..." : "Comprobar cambios"}
                </button>
                <button
                  className="rounded-full border border-ink/15 bg-white/75 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-ink transition hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isBusy}
                  onClick={handleRefreshState}
                >
                  {activeOperation === "refresh" ? "Refrescando..." : "Simular refresco de estado"}
                </button>
              </div>
            </div>

            {state.importSummary ? (
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-white/70 bg-white/80 p-5">
                  <p className="text-xs uppercase tracking-[0.24em] text-teal/70">Archivo</p>
                  <p className="mt-2 text-lg font-semibold text-ink">{state.importSummary.fileName}</p>
                  <p className="mt-2 text-sm text-ink/70">
                    {state.importSummary.totalRows} filas, {state.importSummary.totalGroups} tratamientos,{" "}
                    {state.importSummary.validationErrors} filas con error de validación.
                  </p>
                </div>
                <div className="rounded-2xl border border-white/70 bg-white/80 p-5">
                  <p className="text-xs uppercase tracking-[0.24em] text-teal/70">Pestañas previstas</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {Object.entries(state.importSummary.groupCounts).map(([group, count]) => (
                      <span
                        key={group}
                        className="rounded-full border border-mint bg-mint/20 px-3 py-1 text-xs font-semibold text-teal"
                      >
                        {group} · {count}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-dashed border-sand bg-white/70 p-5 text-sm text-ink/70">
                {canRebuildFromSheets
                  ? "Aún no hay parseo disponible en memoria. Puedes reconstruir el estado desde Google Sheets con “Simular refresco de estado” o volver a subir el Excel."
                  : "Aún no hay parseo disponible. Puedes usar tu Excel real o el archivo de ejemplo incluido en el workspace."}
              </div>
            )}
          </div>

          <RecordsTable records={previewRecords} totalRecords={state.records.length} onSave={handleSaveRecord} />
        </div>

        <div className="min-w-0">
          <ActivityPanel logs={state.logs} />
        </div>
      </section>
    </main>
  );
}
