export const COLUMN_ALIASES = {
  nombre: ["Nombre y apellidos"],
  fecha_nacimiento: ["Fecha de nacimiento"],
  telefono: ["Teléfono móvil"],
  tratamiento_realizado: ["Tratamiento realizado"],
  fecha_tratamiento: ["Fecha del tratamiento"],
  cantidad_pagada: ["Cantidad pagada (€)"],
  casilla_presupuesto: ["Casilla de presupuesto"]
} as const;

export const REQUIRED_CANONICAL_FIELDS = ["nombre", "telefono", "tratamiento_realizado"] as const;
