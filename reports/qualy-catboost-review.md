# Predictor gratuito: CatBoost y lectura de prácticas

Revisión del 31 de octubre de 2026, comparada con la versión publicada `9cfe638`.

## Resultado medido

Se recuperaron 18 fines de semana de 2026. Tres sirven para construir la forma
inicial; quedan 15 GP con variables y resultados, y 11 predicciones cronológicas
para evaluar CatBoost, comenzando con cuatro GP de entrenamiento.

| Métrica de los 11 GP | Versión publicada | Nuevo sistema con selección temporal |
| --- | ---: | ---: |
| Error medio de posición, promedio por GP | 2,118 | 2,097 |
| Pilotos acertados del Top 3 | 14/33 | 15/33 |

La mejora agregada es pequeña. No equivale a un 80 % de fiabilidad.
Austin baja de 1,455 a 1,182 posiciones de error; el Top 3 pasa de 1/3 a 2/3
y se acierta el poleman. Singapur empeora de 2,000 a 2,762 posiciones, por lo
que no se afirma una mejora en todos los circuitos.

CatBoost por sí solo obtiene 2,017 posiciones de error y 14/33 en Top 3 en esas
pruebas, pero esa cifra **no** representa el sistema desplegado en todos los GP:
el selector conserva el modelo anterior cuando todavía no dispone de evidencia
previa suficiente. No se eligió retrospectivamente la mejor opción para cada GP.

Resultados completos: `qualy-catboost-2026.json`.

## Cambios

- Las salidas de boxes y las interrupciones separan las tandas reales, incluso
  cuando se reutiliza el mismo juego de neumáticos. Se apartan las vueltas de
  entrada detectables; las tandas largas se agrupan por salida, no por juego.
- Las vueltas eliminadas se identifican por coche y vuelta en el mensaje de
  dirección de carrera. Se respeta una reinstauración posterior disponible al
  finalizar la práctica. No se confunde el campo `lap_number` de control de
  carrera con el número de la vuelta eliminada de una práctica.
- CatBoost recibe temperatura de pista y aire, humedad, viento y lluvia de las
  prácticas, con indicadores de datos ausentes. No se presupone que ese sea el
  clima de la futura clasificación ni se utiliza su meteorología real.
- Se incorpora Sprint Qualifying solo si terminó antes de la qualy principal
  y está disponible en el acceso público. La carrera Sprint no se incorpora
  todavía: su orden mezcla ritmo de carrera, tráfico e incidentes.
- CatBoost YetiRank ordena pilotos. El motor existente sigue estimando pole y
  diferencias de tiempo. La mezcla usa 0 %, 50 % o 100 % de ranking CatBoost.
- Se entrenan modelos pequeños de 220 árboles, profundidad 4, semilla 42,
  únicamente con GP anteriores de 2026. El peso se decide con predicciones
  históricas anteriores al objetivo; requiere tres evaluaciones y una mejora
  mínima del criterio, sin empeorar el error de posición de esa validación.
- Las métricas mostradas proceden de las predicciones que el selector habría
  emitido en cada fecha, separadas de las métricas con las que elige el peso.
- Cada modelo guardado declara hasta qué GP fue entrenado. Una consulta histórica
  nunca puede escoger un modelo que ya haya aprendido su resultado. Los modelos
  de otra temporada, incompatibles o con más de 60 días de antigüedad se descartan.
- El navegador evalúa los árboles exportados en JSON, dentro del worker. No
  requiere Python, CatBoost, GPU ni servidor de entrenamiento en producción.

## Costos y actualización

No se crearon cuentas, suscripciones, servicios de nube ni tareas pagadas.
El predictor pide `public_only=1`: el proxy omite la autenticación de OpenF1,
incluso si existen credenciales configuradas para otras funciones de la web.
Se espera al menos 30 minutos después del cierre de las sesiones para su acceso
histórico gratuito. Los límites y disponibilidad del proveedor siguen aplicando.

El modelo entrenado es un archivo estático de menos de 1 MB. Se mantienen los
límites y condiciones del alojamiento existente; no se promete tráfico ilimitado.
El entrenamiento consume recursos del equipo local. El modelo CatBoost **no se
reentrena automáticamente en la nube**: hay que regenerarlo y publicar el archivo
después de nuevos GP. La interfaz muestra la fecha hasta la que fue entrenado.
El modelo de respaldo continúa aprendiendo de los históricos cargados por la web.

## Reproducir y actualizar localmente

En Windows, desde la raíz del proyecto:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements-qualy.txt
npm run qualy:collect -- 2026
npm run qualy:dataset -- 2026
.\.venv\Scripts\python.exe scripts/train-qualy.py 2026
npm test
npm run qualy:verify -- 2026
npm run build
```

Publicar después los cambios verificados de `public/models/`, el informe y las
pruebas de paridad. No publicar `.venv/` ni `.qualy-cache/` (ambos ignorados por Git).
La descarga usa los endpoints públicos de OpenF1 con caché y espera entre consultas.

La comparación conserva la parrilla predicha completa, incluso para pilotos sin
tiempo/DNS en el resultado final: no los elimina usando información futura. Solo
se omiten sus etiquetas desconocidas al ajustar y medir errores. Se verificaron
los cinco GP más recientes de extremo a extremo en JavaScript contra la evaluación
de Python, además de comprobar que los árboles exportados reproducen los scores
de CatBoost con precisión numérica.

Esto sigue siendo una evaluación retrospectiva de desarrollo. Faltan validación
prospectiva y calibración empírica de las probabilidades; los porcentajes de pole
y Q3 continúan siendo orientativos.

Referencias: [CatBoostRanker](https://catboost.ai/docs/en/concepts/python-reference_catboostranker),
[exportación JSON](https://catboost.ai/docs/en/concepts/python-reference_catboost_save_model),
[OpenF1](https://openf1.org/docs/).
