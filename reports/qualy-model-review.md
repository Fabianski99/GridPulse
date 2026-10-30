# Revisión del predictor de qualy

## Qué cambia

El motor queda separado de React en `src/qualyEngine.js`, con cálculo en un
Web Worker para que la validación no bloquee la interfaz.

- Los agregados ya no convierten datos ausentes en cero. Los tiempos de fase
  nulos, vacíos o imposibles tampoco cuentan como una fase disputada.
- Sin stint conocido, una vuelta no se trata como una simulación fiable de qualy.
  El peso de prácticas y compañero se reduce con la calidad y cobertura disponibles.
  Los pilotos sin vuelta utilizable permanecen en la predicción usando su historial.
- La evolución de pista solo se estima con observaciones del mismo piloto,
  compuesto y grupo de edad del neumático, con soporte de tres pilotos. Se reduce
  hacia cero porque la carga de combustible sigue siendo desconocida.
- En sesiones mixtas se separan las vueltas con neumático de lluvia cuando hay
  suficiente campo en seco. Si existen prácticas secas, no se mezclan sus gaps
  con los de prácticas mojadas. Esto **no** es un pronóstico meteorológico de qualy.
- La forma histórica usa el déficit respecto del mejor tiempo de la misma fase,
  escalado a la duración de la pole. Cada equipo aporta una observación por GP,
  independiente del orden de sus pilotos en la respuesta de la API.
- Los regresores incluyen a los eliminados en Q1/Q2 con ese objetivo de fase
  comparable; ya no extrapolan toda la zona media desde una muestra de Q3.
  El error de segundos mostrado se sigue evaluando con tiempos comparables de Q3.
- El ranking puede combinar tiempos con Pairwise o con forma reciente. Se elige
  con carreras anteriores; la alternativa de forma solo sustituye a Pairwise si
  mejora su criterio de selección por al menos 0,025.
- La validación y la predicción recentran los gaps de la misma manera. Todos los
  candidatos se prueban en los mismos eventos; si no se pueden ajustar, usan el
  baseline. La evaluación exterior elige modelo y ranking únicamente con GP
  anteriores al que evalúa, separando selección y medición de resultados.
- La simulación usa 3.000 muestras reproducibles y más dispersión para pilotos
  con prácticas poco fiables. El MAE se convierte a escala gaussiana antes de
  simular. Son probabilidades orientativas, todavía sin calibración empírica.
- «Confianza» pasa a «Índice de evidencia»: el porcentaje anterior era una mezcla
  de métricas, no una probabilidad de acertar. Con menos de tres GP de evaluación
  exterior se limita a 50. No se fuerza ningún objetivo de 80 %.

## Verificación reproducible

```sh
npm ci
npm test
npm run build
npm run benchmark:qualy -- 2026
```

El benchmark compara con el commit `2af6a430924550d208ea1e988dc7b9036a9aadd1`.
Descarga los últimos quince fines de semana completos de la temporada indicada
y predice los últimos cinco con los diez GP anteriores a cada uno. Ambos motores
reciben las mismas respuestas de OpenF1/Jolpica. El resultado real del objetivo
solo se utiliza al medir el error, no como entrada de predicción.

Los datos brutos quedan en `.qualy-cache/` (ignorado por Git). Los resultados de
esta revisión están en `qualy-benchmark-2026.json`. El script requiere acceso a
las APIs, conserva el límite público de consultas y falla visiblemente si falta
una respuesta. Una ejecución posterior puede evaluar otros GP si avanzó la temporada.

Las pruebas cubren datos ausentes, fases de clasificación, falta de stints,
compuestos y evolución de pista, cobertura de pilotos, agregación por equipo,
prior sin historial, normalización de gaps, exclusión del futuro, invariantes
de probabilidad y transporte del resultado por el worker.

## Límites

Comparación obtenida el 30 de octubre de 2026 (media por GP; menor es mejor):

| Métrica, cinco GP | Anterior | Revisado |
| --- | ---: | ---: |
| Error medio de posición | 2,571 | 2,532 |
| Error de tiempo de pole | 0,275 s | 0,264 s |
| Pilotos del Top 3 acertados | 5/15 | 5/15 |

En Austin el error de posición baja de 1,818 a 1,455; el error de pole queda
prácticamente igual (0,360 s). En Singapur mejora el tiempo de pole de 0,320 a
0,199 s, pero empeora el ranking de 1,905 a 2,000 y el Top 3 pasa de 2/3 a 1/3.
España mejora en ambas métricas; Azerbaiyán y Baréin empeoran el error de posición
y de pole (Azerbaiyán sí mejora el Top 3). La mejora agregada es modesta, no un
salto demostrado de precisión.

Estos cinco GP son una comparación de desarrollo, no una prueba independiente
que demuestre precisión futura. No se asegura mejora en cada circuito. El error
de ranking, aciertos Top 3 y error de pole deben leerse por separado.

El combustible, modos de motor, tráfico, vueltas eliminadas y cambios de setup
no se observan de forma completa. Las condiciones se aproximan por los compuestos
de práctica; no se incorpora una previsión meteorológica de clasificación.
La incertidumbre es especialmente alta en Sprint, lluvia y cambios de condiciones.

Referencia del proveedor: https://openf1.org/ (datos históricos, stints, vueltas
y límites públicos de consultas).
