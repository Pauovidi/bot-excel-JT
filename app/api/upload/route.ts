import path from "node:path";

import { NextResponse } from "next/server";

import { readState, saveUpload, updateState } from "@/lib/stateStore";
import { parseExcelBuffer } from "@/services/excelService";
import { logActivity } from "@/services/loggerService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        ok: false,
        error: "No se ha recibido ningún archivo Excel."
      },
      { status: 400 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const safeFileName = `${Date.now()}-${file.name.replace(/\s+/g, "-")}`;
  const uploadPath = await saveUpload(buffer, safeFileName);
  const { records, summary } = parseExcelBuffer(buffer, file.name);

  await updateState((state) => {
    state.importSummary = summary;
    state.records = records;
    state.uploadedFilePath = uploadPath;
    state.steps.excel_loaded = "done";
    state.steps.data_parsed = "done";
  });

  await logActivity({
    correlationId: safeFileName.slice(0, 8),
    paciente: "lote_excel",
    telefono: "",
    accion: "excel_uploaded",
    resultado: "ok",
    detalle: `${summary.totalRows} filas parseadas desde ${path.basename(file.name)}`
  });

  for (const record of records.filter((item) => item.validationErrors.length > 0)) {
    await logActivity({
      correlationId: record.id.slice(0, 8),
      paciente: record.nombre || `fila_${record.sourceRowNumber}`,
      telefono: record.telefono,
      accion: "validation_error",
      resultado: "error",
      detalle: `Fila ${record.sourceRowNumber}: ${record.validationErrors.join(" ")}`
    });
  }

  const nextState = await readState();

  return NextResponse.json({
    ok: true,
    summary,
    records,
    state: nextState
  });
}
