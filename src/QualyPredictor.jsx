import { useEffect, useMemo, useState } from "react";
import "./QualyPredictor.css";

import { YEARS, TRAINING_EVENTS, PROFILE_LABELS, clamp, openF1, loadQualifyingHistory, buildQualyPriors, trackProfile, groupMeetings, qualifyingSession, practicesBeforeQualy, loadBundle, formatLap } from "./qualyEngine.js";

function ScoreBar({ label, value }) {
  return (
    <div className="qualy-score-row">
      <span>{label}</span>
      <i><b style={{ width: clamp(value, 0, 100) + "%" }} /></i>
      <strong>{Math.round(value)}</strong>
    </div>
  );
}

export default function QualyPredictor() {
  const [meetings, setMeetings] = useState([]);
  const [meetingKey, setMeetingKey] = useState("");
  const [loadingBase, setLoadingBase] = useState(true);
  const [loadingPrediction, setLoadingPrediction] = useState(false);
  const [progress, setProgress] = useState("");
  const [prediction, setPrediction] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadMeetings() {
      try {
        setLoadingBase(true);
        const allSessions = [];

        for (const year of YEARS) {
          const rows = await openF1("sessions", { year }, false);
          allSessions.push(...rows);
        }

        if (cancelled) return;

        const grouped = groupMeetings(allSessions);
        const current = grouped.filter((meeting) => meeting.year === 2026);
        const started = current.filter(
          (meeting) => meeting.startDate <= Date.now()
        );
        const defaultMeeting =
          started[started.length - 1] || current[current.length - 1];

        setMeetings(grouped);
        setMeetingKey(defaultMeeting ? String(defaultMeeting.meeting_key) : "");
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoadingBase(false);
      }
    }

    loadMeetings();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectableMeetings = useMemo(
    () => meetings.filter((meeting) => meeting.year === 2026),
    [meetings]
  );

  const selectedMeeting = useMemo(
    () =>
      meetings.find(
        (meeting) => String(meeting.meeting_key) === String(meetingKey)
      ) || null,
    [meetings, meetingKey]
  );

  async function runPrediction() {
    if (!selectedMeeting) return;

    try {
      setLoadingPrediction(true);
      setPrediction(null);
      setSelectedDriver(null);
      setError("");

      const previous = meetings
        .filter(
          (meeting) =>
            meeting.year === selectedMeeting.year &&
            meeting.startDate < selectedMeeting.startDate &&
            qualifyingSession(meeting) &&
            practicesBeforeQualy(meeting, false).length > 0
        )
        .slice(-TRAINING_EVENTS);

      if (previous.length < 3) {
        throw new Error(
          "El prototipo necesita al menos tres GP anteriores con prácticas y clasificación."
        );
      }

      const historicalBundles = [];
      const historicalFailures = [];

      for (let index = 0; index < previous.length; index += 1) {
        const meeting = previous[index];
        setProgress(
          "Aprendiendo de " +
            meeting.country_name +
            " · " +
            (index + 1) +
            "/" +
            previous.length
        );

        try {
          historicalBundles.push(await loadBundle(meeting, false));
        } catch (historyError) {
          historicalFailures.push({
            country: meeting.country_name,
            reason:
              historyError instanceof Error
                ? historyError.message
                : "Error de datos",
          });
        }
      }

      if (historicalBundles.length < 3) {
        const details = historicalFailures
          .slice(0, 3)
          .map(
            (item) =>
              item.country + ": " + item.reason
          )
          .join(" · ");

        throw new Error(
          "No se pudieron recuperar suficientes GP históricos completos." +
            (details ? " " + details : "")
        );
      }

      setProgress(
        "Leyendo " + selectedMeeting.country_name + ": prácticas, stints y vueltas representativas…"
      );

      const targetBundle = await loadBundle(selectedMeeting, true);

      setProgress("Leyendo la forma reciente de clasificación…");

      const qualyHistory = await loadQualifyingHistory();
      const qualyPriors = buildQualyPriors(
        qualyHistory,
        selectedMeeting.startDate,
        selectedMeeting.year
      );

      setProgress("Validando tiempos y Pairwise Ranker…");

      const args = [
        targetBundle,
        historicalBundles,
        qualyPriors,
        qualyHistory,
        null
      ];
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./qualyWorker.js', import.meta.url), {type:'module'});
        worker.onmessage = ({data}) => {
          worker.terminate();
          if (data.error) reject(new Error(data.error));
          else resolve(data.result);
        };
        worker.onerror = () => {
          worker.terminate();
          reject(new Error('No se pudo completar el cálculo del predictor.'));
        };
        worker.postMessage(args);
      });
      setPrediction(result);
      setSelectedDriver(result.predictions[0] && result.predictions[0].driverNumber);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingPrediction(false);
    }
  }

  const selected = prediction && prediction.predictions.find(
    (row) => Number(row.driverNumber) === Number(selectedDriver)
  );

  return (
    <main className="qualy-page">
      <section className="qualy-hero">
        <div>
          <span className="qualy-eyebrow">MODELO EXPERIMENTAL · 2026</span>
          <h1>Qualy Predictor</h1>
          <p>
            Predicción de clasificación que separa short runs y long runs,
            corrige parte de la evolución de pista y combina la práctica con
            la forma reciente del piloto, del coche y del equipo.
          </p>
        </div>

        <div className="qualy-model-chip">
          <span>Modelo</span>
          <strong>Selección automática</strong>
          <small>Baseline · Ridge · Gradient Boosting · Ensemble · Pairwise Ranker</small>
        </div>
      </section>

      <section className="qualy-control-card">
        <label>
          <span>Gran Premio</span>
          <select
            value={meetingKey}
            disabled={loadingBase || loadingPrediction}
            onChange={(event) => {
              setMeetingKey(event.target.value);
              setPrediction(null);
              setSelectedDriver(null);
              setError("");
            }}
          >
            {selectableMeetings.map((meeting) => (
              <option key={meeting.meeting_key} value={meeting.meeting_key}>
                {meeting.country_name} · {meeting.circuit_short_name}
              </option>
            ))}
          </select>
        </label>

        <div className="qualy-control-context">
          <span>Perfil estimado</span>
          <strong>{selectedMeeting ? PROFILE_LABELS[trackProfile(selectedMeeting)] : "—"}</strong>
          <small>{selectedMeeting ? selectedMeeting.circuit_short_name : "Sin GP seleccionado"}</small>
        </div>

        <button
          type="button"
          className="qualy-run"
          disabled={loadingBase || loadingPrediction || !selectedMeeting}
          onClick={runPrediction}
        >
          {loadingPrediction ? "Calculando…" : "Generar predicción"}
        </button>
      </section>

      {loadingPrediction && (
        <section className="qualy-loading">
          <div className="qualy-loading-ring" />
          <div>
            <strong>Entrenando prototipo</strong>
            <span>{progress}</span>
          </div>
        </section>
      )}

      {error && <div className="qualy-error">{error}</div>}

      {!loadingPrediction && !prediction && !error && (
        <section className="qualy-empty">
          <span>PRIMER PROTOTIPO</span>
          <h2>Entrena con los GP anteriores y comprueba si se acerca a la qualy real.</h2>
          <p>
            Si eliges un fin de semana cuya clasificación ya terminó, GridPulse
            también mostrará un backtest para medir cuánto se acercó el modelo.
          </p>
        </section>
      )}

      {prediction && (
        <>
          <section className="qualy-status-grid">
            <article>
              <span>Prácticas analizadas</span>
              <strong>{prediction.practiceName}</strong>
              <small>{prediction.practiceSessions.length} sesiones previas a qualy</small>
            </article>

            <article>
              <span>Entrenamiento</span>
              <strong>{prediction.trainingRows}</strong>
              <small>
                {prediction.trainingEvents} GP 2026 · {prediction.modelActive
                  ? prediction.modelSamples + " muestras · " + prediction.selectedModelLabel
                  : "baseline histórico elegido"}
              </small>
            </article>

            <article>
              <span>Error temporal</span>
              <strong>
                {prediction.validation.mae !== null
                  ? "±" + prediction.validation.mae.toFixed(3) + " s"
                  : prediction.modelActive
                    ? "Sin validar"
                    : "Baseline"}
              </strong>
              <small>
                {prediction.validation.samples} observaciones · ranking ±
                {prediction.rankValidation.positionMae !== null
                  ? prediction.rankValidation.positionMae.toFixed(2)
                  : prediction.validation.positionMae !== null
                    ? prediction.validation.positionMae.toFixed(2)
                    : "—"} pos. · Top 3{" "}
                {prediction.rankValidation.top3Rate !== null
                  ? Math.round(prediction.rankValidation.top3Rate * 100)
                  : prediction.validation.top3Rate !== null
                    ? Math.round(prediction.validation.top3Rate * 100)
                    : 0}% · pole ±
                {prediction.poleValidation.mae !== null
                  ? prediction.poleValidation.mae.toFixed(3)
                  : "—"} s
              </small>
            </article>

            <article>
              <span>Índice de evidencia</span>
              <strong>{prediction.confidence}%</strong>
              <i><b style={{ width: prediction.confidence + "%" }} /></i>
              <small>No es una probabilidad de acierto · {prediction.validation.events} GP de prueba fuera de selección</small>
            </article>
          </section>

          <section className="qualy-data-quality">
            <article>
              <span>Short runs detectados</span>
              <strong>{prediction.shortRuns}</strong>
              <small>Vueltas rápidas con stint corto / neumático adecuado</small>
            </article>

            <article>
              <span>Long runs detectados</span>
              <strong>{prediction.longRuns}</strong>
              <small>Tandas de 5+ vueltas usadas como señal secundaria del coche</small>
            </article>

            <article>
              <span>Evolución de pista</span>
              <strong>
                {prediction.trackEvolution >= 0 ? "+" : ""}
                {prediction.trackEvolution.toFixed(3)} s
              </strong>
              <small>
                Mejora estimada del asfalto durante las prácticas analizadas
              </small>
            </article>

            <article>
              <span>Lectura del modelo</span>
              <strong>{prediction.selectedModelLabel}</strong>
              <small>
                Elegido por validación temporal · {prediction.qualyPriorCoverage} pilotos con prior de qualy
                {prediction.rankerActive
                  ? (prediction.rankValidation.mode === "recent_form" ? " · Forma reciente " : " · Pairwise ") +
                    Math.round(prediction.rankerWeight * 100) +
                    "%" + (prediction.rankerPairs ? " · " + prediction.rankerPairs + " pares" : "")
                  : ""}
              </small>
            </article>
          </section>

          {prediction.backtest && (
            <section className="qualy-backtest">
              <div>
                <span>BACKTEST DISPONIBLE</span>
                <h2>Predicción vs qualy real</h2>
              </div>

              <div className="qualy-backtest-metrics">
                <div>
                  <span>Error medio</span>
                  <strong>{prediction.backtest.positionMae.toFixed(2)} pos.</strong>
                </div>
                <div>
                  <span>Top 3 acertados</span>
                  <strong>{prediction.backtest.top3Hits}/3</strong>
                </div>
                <div>
                  <span>Error pole</span>
                  <strong>
                    {prediction.backtest.poleTimeError.toFixed(3)} s
                  </strong>
                </div>
              </div>
            </section>
          )}

          <section className="qualy-main-grid">
            <div className="qualy-ranking-card">
              <div className="qualy-section-head">
                <div>
                  <span>RESULTADO ESTIMADO</span>
                  <h2>Clasificación proyectada</h2>
                </div>
                <div>
                  <span>Pole estimada</span>
                  <strong>{formatLap(prediction.estimatedPole)}</strong>
                </div>
              </div>

              <div className={"qualy-ranking-head " + (prediction.backtest ? "with-real" : "")}>
                <span>Pos</span>
                <span>Piloto</span>
                <span>Tiempo</span>
                <span>Pole</span>
                <span>Q3</span>
                {prediction.backtest && <span>Real</span>}
              </div>

              <div className="qualy-ranking">
                {prediction.predictions.map((item) => {
                  const actualPosition =
                    prediction.backtest &&
                    prediction.backtest.positions.get(item.driverNumber);

                  return (
                    <button
                      type="button"
                      key={item.driverNumber}
                      className={
                        Number(selectedDriver) === Number(item.driverNumber)
                          ? "active"
                          : ""
                      }
                      onClick={() => setSelectedDriver(item.driverNumber)}
                      style={{ "--driver-color": item.color }}
                    >
                      <b className="qualy-pos">{item.predictedPosition}</b>

                      <span className="qualy-driver">
                        <i />
                        <span>
                          <strong>{item.driver.name_acronym || item.driverNumber}</strong>
                          <small>{item.driver.team_name}</small>
                        </span>
                      </span>

                      <span className="qualy-time">
                        <strong>{formatLap(item.estimatedTime)}</strong>
                        <small>
                          {item.predictedPosition === 1
                            ? "Pole"
                            : "+" + item.predictedGap.toFixed(3) + " s"}
                        </small>
                      </span>

                      <strong className="qualy-prob">
                        {item.probabilities.pole.toFixed(0)}%
                      </strong>

                      <strong className="qualy-prob">
                        {item.probabilities.q3.toFixed(0)}%
                      </strong>

                      {prediction.backtest && (
                        <span
                          className={
                            "qualy-actual " +
                            (actualPosition === item.predictedPosition ? "exact" : "")
                          }
                        >
                          P{actualPosition || "—"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {selected && (
              <aside
                className="qualy-driver-card"
                style={{ "--driver-color": selected.color }}
              >
                <div className="qualy-driver-card-head">
                  <div>
                    <span>ANÁLISIS DEL MODELO</span>
                    <h2>{selected.driver.name_acronym || selected.driverNumber}</h2>
                    <p>{selected.driver.team_name}</p>
                  </div>
                  <div>
                    <strong>P{selected.predictedPosition}</strong>
                    <span>+{selected.predictedGap.toFixed(3)} s</span>
                  </div>
                </div>

                <div className="qualy-prob-grid">
                  <div><span>Pole</span><strong>{selected.probabilities.pole.toFixed(0)}%</strong></div>
                  <div><span>1ª fila</span><strong>{selected.probabilities.frontRow.toFixed(0)}%</strong></div>
                  <div><span>Top 3</span><strong>{selected.probabilities.top3.toFixed(0)}%</strong></div>
                  <div><span>Q3</span><strong>{selected.probabilities.q3.toFixed(0)}%</strong></div>
                </div>

                <div className="qualy-score-card">
                  <span>EVALUACIÓN</span>
                  <ScoreBar label="Prácticas" value={selected.scores.practice} />
                  <ScoreBar label="Piloto" value={selected.scores.driver} />
                  <ScoreBar label="Auto / equipo" value={selected.scores.car} />
                  <ScoreBar label="Encaje con pista" value={selected.scores.track} />
                </div>

                <div className="qualy-factors">
                  <span>¿POR QUÉ ESTA POSICIÓN?</span>
                  {selected.factors.map((factor, index) => (
                    <div key={index} className={factor.type}>
                      <i />
                      <p>{factor.text}</p>
                    </div>
                  ))}
                </div>

                <div className="qualy-detail-foot">
                  <span>Perfil del circuito</span>
                  <strong>{prediction.profileLabel}</strong>
                </div>
              </aside>
            )}
          </section>

          <section className="qualy-method-card">
            <div>
              <span>MÉTODO</span>
              <h2>El modelo predice gap a pole, no una posición fija.</h2>
              <p>
                GridPulse separa ahora dos tareas: el modelo de tiempos estima
                los gaps y un Pairwise Ranker aprende qué piloto debe quedar
                delante de otro. Su peso se activa únicamente si mejora la
                validación temporal; la pole se estima aparte mediante el delta
                entre práctica y clasificación.
              </p>
            </div>

            <div className="qualy-method-features">
              <span>Variables actuales</span>
              <strong>Short runs de vuelta rápida</strong>
              <strong>Vuelta teórica por mejores sectores</strong>
              <strong>Delta práctica → qualy calibrado con GP 2026</strong>
              <strong>Mayor peso de FP3 y penalización de sesiones mojadas</strong>
              <strong>Long runs separados del ritmo de qualy</strong>
              <strong>Compuesto, edad de neumático y stint</strong>
              <strong>Evolución de pista durante la práctica</strong>
              <strong>Forma y tendencia reciente del coche</strong>
              <strong>Comparación con el compañero</strong>
              <strong>Historial reciente de pole / primera fila / Q3</strong>
              <strong>Forma de qualy ponderada por recencia</strong>
              <strong>Pairwise Ranker con foco extra en Top 3</strong>
              <strong>FP3, consistencia y velocidad relativa del coche</strong>
              <strong>Encaje con circuitos similares</strong>
            </div>
          </section>

          <p className="qualy-disclaimer">
            Modelo experimental. Cambios de setup, combustible, neumáticos,
            tráfico, clima y evolución de pista pueden alterar de forma
            importante la clasificación real. Los porcentajes de pole y Q3 son
            simulaciones orientativas, no probabilidades calibradas. El índice
            de evidencia resume datos y errores históricos; no mide la
            probabilidad de acertar toda la parrilla.
          </p>
        </>
      )}
    </main>
  );
}
