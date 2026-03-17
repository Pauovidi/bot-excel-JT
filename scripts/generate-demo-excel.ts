import { mkdir } from "node:fs/promises";
import path from "node:path";

import * as XLSX from "xlsx";

const demoRows = [
  ["Nombre y apellidos", "Fecha de nacimiento", "Teléfono móvil", "Tratamiento realizado", "Fecha del tratamiento", "Cantidad pagada (€)", "Casilla de presupuesto"],
  ["Lucía Hernández", "02/07/1965", "614104287", "Limpieza dental", "21/04/2026", 61, ""],
  ["Carlos Martín", "27/03/1956", "672748869", "Presupuesto pendiente", "22/04/2026", 79, "Pendiente"],
  ["Ana Rodríguez", "09/03/1964", "699953545", "Implante dental", "24/04/2026", 65, ""],
  ["Javier López", "17/08/1989", "618160427", "Limpieza dental", "25/04/2026", 70, ""]
];

async function main() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(demoRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Clientes Clínica Dental");

  const outputDir = path.join(process.cwd(), "data");
  const outputPath = path.join(outputDir, "demo-clinica-dental.xlsx");
  await mkdir(outputDir, { recursive: true });
  XLSX.writeFile(workbook, outputPath);
  console.log(`Excel demo generado en ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
