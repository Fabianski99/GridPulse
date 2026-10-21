/*
  Correcciones manuales de numeración para circuitos cuya geometría
  requiere semántica real de curvas y no solo máximos de curvatura.

  Los valores representan porcentaje de avance desde la línea de meta.
  Telemetría y Circuitos consumen esta misma fuente para mantener
  exactamente la misma numeración.
*/

export const CIRCUIT_CORNER_PROGRESS_OVERRIDES = Object.freeze({
  monza: Object.freeze([
    15.7, // T1  Variante del Rettifilo
    16.4, // T2  Variante del Rettifilo
    27.9, // T3  Curva Grande
    36.7, // T4  Variante della Roggia
    37.5, // T5  Variante della Roggia
    43.5, // T6  Lesmo 1
    49.2, // T7  Lesmo 2
    67.7, // T8  Variante Ascari
    69.9, // T9  Variante Ascari
    71.5, // T10 Variante Ascari
    91.1, // T11 Parabolica / Alboreto
  ]),
});
