import { createHash } from "node:crypto";

import type { DemoRecord } from "@/types/demo";

export function buildTriggerHash(record: DemoRecord) {
  return createHash("sha1")
    .update(
      [
        record.nombre ?? "",
        record.telefono ?? "",
        record.tratamientoRealizado ?? "",
        record.tipoAccion ?? "",
        record.fechaAccion ?? "",
        record.horaCita ?? "",
      ].join("|")
    )
    .digest("hex");
}

export function buildTriggerReopenHash(record: DemoRecord) {
  return createHash("sha1")
    .update(
      [
        record.tipoAccion ?? "",
        record.fechaAccion ?? "",
        record.horaCita ?? ""
      ].join("|")
    )
    .digest("hex");
}
