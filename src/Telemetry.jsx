import { useEffect, useMemo, useRef, useState } from "react";
import "./Telemetry.css";

const OPENF1 = "https://api.openf1.org/v1";
const YEAR = 2026;
const LIVE_REFRESH_MS = 10000;
const MAX_PACE_DRIVERS = 8;
const CAR_DATA_CACHE = new Map();

const FALLBACK_COLORS = [
  "#00f5d4",
  "#ff5f56",
  "#a06bff",
  "#ff9f43",
  "#39a6ff",
  "#ff4fbd",
  "#f3d34a",
  "#72ff4d",
];

const SESSION_ORDER = {
  "Practice 1": 1,
  "Practice 2": 2,
  "Practice 3": 3,
  "Sprint Qualifying": 4,
  Sprint: 5,
  Qualifying: 6,
  Race: 7,
};

function createQuery(params = {}) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;

    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, String(item)));
      return;
    }

    query.append(key, String(value));
  });

  return query;
}

async function openF1(endpoint, params = {}, { live = false } = {}) {
  const query = createQuery(params);

  let url;

  if (live) {
    const proxyQuery = new URLSearchParams(query);
    proxyQuery.set("endpoint", endpoint);
    url = `/api/openf1?${proxyQuery.toString()}`;
  } else {
    url = `${OPENF1}/${endpoint}?${query.toString()}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    let detail = "";

    try {
      const payload = await response.json();
      detail = payload?.error || payload?.detail || "";
    } catch {
      detail = await response.text();
    }

    throw new Error(detail || `OpenF1 respondió ${response.status}`);
  }

  return response.json();
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatLapTime(seconds) {
  const value = safeNumber(seconds);
  if (value === null) return "—";

  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;

  return `${minutes}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function formatDelta(seconds) {
  const value = safeNumber(seconds);
  if (value === null) return "—";
  if (Math.abs(value) < 0.0005) return "0.000";
  return `${value > 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatSessionDate(date) {
  if (!date) return "";

  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function meetingLabel(meeting) {
  return `${meeting.country_name} · ${meeting.circuit_short_name}`;
}

function driverColor(driver, index = 0) {
  if (driver?.team_colour) {
    const value = String(driver.team_colour).replace("#", "");
    if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value}`;
  }

  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function driverLabel(driver) {
  if (!driver) return "Piloto";
  return `${driver.name_acronym || driver.driver_number} · ${driver.full_name || driver.broadcast_name}`;
}

function median(values) {
  const valid = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!valid.length) return null;

  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
}

function fastestLapForDriver(laps, driverNumber) {
  return laps
    .filter(
      (lap) =>
        Number(lap.driver_number) === Number(driverNumber) &&
        Number.isFinite(Number(lap.lap_duration)) &&
        !lap.is_pit_out_lap
    )
    .sort((a, b) => Number(a.lap_duration) - Number(b.lap_duration))[0];
}

function endOfLap(lap) {
  const start = new Date(lap.date_start).getTime();
  const duration = Number(lap.lap_duration) * 1000;
  return new Date(start + duration + 800).toISOString();
}

function startOfLapWithMargin(lap, marginMs = 5000) {
  const start = new Date(lap.date_start).getTime();
  return new Date(start - marginMs).toISOString();
}

function endOfLapWithMargin(lap, marginMs = 5000) {
  const start = new Date(lap.date_start).getTime();
  const duration = Number(lap.lap_duration) * 1000;
  return new Date(start + duration + marginMs).toISOString();
}

function rowsInsideLap(rows, lap, marginMs = 2500) {
  if (!Array.isArray(rows) || !lap?.date_start) return [];

  const start = new Date(lap.date_start).getTime() - marginMs;
  const end =
    new Date(lap.date_start).getTime() +
    Number(lap.lap_duration) * 1000 +
    marginMs;

  return rows.filter((row) => {
    const timestamp = new Date(row.date).getTime();
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

async function fetchCarDataForLap(sessionKey, driverNumber, lap, liveMode) {
  const narrowParams = {
    session_key: sessionKey,
    driver_number: driverNumber,
    "date>=": startOfLapWithMargin(lap),
    "date<=": endOfLapWithMargin(lap),
  };

  try {
    const narrow = await openF1(
      "car_data",
      narrowParams,
      { live: liveMode }
    );

    if (Array.isArray(narrow) && narrow.length >= 10) {
      return narrow;
    }
  } catch (error) {
    const message = String(error?.message || error);

    if (!/no results found|404|not found/i.test(message)) {
      console.warn(
        `Consulta acotada de car_data falló para #${driverNumber}:`,
        error
      );
    }
  }

  // Respaldo: algunos históricos de OpenF1 no responden bien a la
  // combinación de filtros por fecha. En ese caso descargamos solo la
  // telemetría del piloto en la sesión y recortamos la vuelta localmente.
  const cacheKey = `${sessionKey}-${driverNumber}`;
  let fullSession = !liveMode ? CAR_DATA_CACHE.get(cacheKey) : null;

  if (!fullSession) {
    fullSession = await openF1(
      "car_data",
      {
        session_key: sessionKey,
        driver_number: driverNumber,
      },
      { live: liveMode }
    );

    if (!liveMode && Array.isArray(fullSession)) {
      CAR_DATA_CACHE.set(cacheKey, fullSession);
    }
  }

  const sliced = rowsInsideLap(fullSession, lap);

  if (sliced.length < 10) {
    throw new Error(
      `OpenF1 no devolvió telemetría suficiente para la vuelta de ${driverNumber}.`
    );
  }

  return sliced;
}

function prepareTelemetry(rows, lap) {
  if (!rows?.length || !lap?.date_start) return [];

  const start = new Date(lap.date_start).getTime();

  const clean = rows
    .map((row) => ({
      ...row,
      timestamp: new Date(row.date).getTime(),
      speed: safeNumber(row.speed),
      throttle: safeNumber(row.throttle),
      brake: safeNumber(row.brake),
      rpm: safeNumber(row.rpm),
      n_gear: safeNumber(row.n_gear),
      drs: safeNumber(row.drs),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.timestamp) &&
        row.timestamp >= start - 500 &&
        row.timestamp <= start + Number(lap.lap_duration) * 1000 + 1000
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (clean.length < 2) return [];

  let distance = 0;
  let previous = clean[0];

  const enriched = clean.map((row, index) => {
    if (index > 0) {
      const dt = Math.min(Math.max((row.timestamp - previous.timestamp) / 1000, 0), 1.5);
      const previousSpeed = Number(previous.speed) || Number(row.speed) || 0;
      const currentSpeed = Number(row.speed) || previousSpeed;
      const averageMs = ((previousSpeed + currentSpeed) / 2) / 3.6;
      distance += averageMs * dt;
    }

    previous = row;

    return {
      ...row,
      elapsed: Math.max((row.timestamp - start) / 1000, 0),
      distance,
    };
  });

  const totalDistance = enriched[enriched.length - 1]?.distance || 1;

  const normalized = enriched.map((row) => ({
    ...row,
    progress: Math.max(0, Math.min(100, (row.distance / totalDistance) * 100)),
  }));

  if (normalized.length <= 420) return normalized;

  const step = Math.ceil(normalized.length / 420);
  return normalized.filter((_, index) => index % step === 0 || index === normalized.length - 1);
}

function interpolateAtProgress(points, progress, key) {
  if (!points?.length) return null;

  if (progress <= points[0].progress) return safeNumber(points[0][key]);
  if (progress >= points[points.length - 1].progress) {
    return safeNumber(points[points.length - 1][key]);
  }

  let low = 0;
  let high = points.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = points[middle].progress;

    if (value < progress) low = middle + 1;
    else high = middle - 1;
  }

  const right = points[Math.min(low, points.length - 1)];
  const left = points[Math.max(0, low - 1)];

  if (!right || !left) return null;

  const leftValue = safeNumber(left[key]);
  const rightValue = safeNumber(right[key]);

  if (leftValue === null || rightValue === null) return leftValue ?? rightValue;

  const span = right.progress - left.progress;
  if (!span) return leftValue;

  const ratio = (progress - left.progress) / span;
  return leftValue + (rightValue - leftValue) * ratio;
}

function buildDeltaSeries(aPoints, bPoints) {
  const values = [];

  for (let progress = 0; progress <= 100; progress += 1) {
    const aElapsed = interpolateAtProgress(aPoints, progress, "elapsed");
    const bElapsed = interpolateAtProgress(bPoints, progress, "elapsed");

    if (aElapsed === null || bElapsed === null) continue;

    values.push({
      progress,
      delta: bElapsed - aElapsed,
    });
  }

  return values;
}

function sessionIsLive(session) {
  if (!session?.date_start || !session?.date_end) return false;

  const now = Date.now();
  const start = new Date(session.date_start).getTime() - 30 * 60 * 1000;
  const end = new Date(session.date_end).getTime() + 30 * 60 * 1000;

  return now >= start && now <= end;
}

function sessionSort(a, b) {
  const orderA = SESSION_ORDER[a.session_name] ?? 99;
  const orderB = SESSION_ORDER[b.session_name] ?? 99;

  if (orderA !== orderB) return orderA - orderB;
  return new Date(a.date_start) - new Date(b.date_start);
}

function getCompoundForLap(stints, driverNumber, lapNumber) {
  const stint = stints.find(
    (item) =>
      Number(item.driver_number) === Number(driverNumber) &&
      Number(item.lap_start) <= Number(lapNumber) &&
      (item.lap_end == null || Number(item.lap_end) >= Number(lapNumber))
  );

  if (!stint) return null;

  const tyreAge =
    Number(stint.tyre_age_at_start || 0) +
    Math.max(0, Number(lapNumber) - Number(stint.lap_start));

  return {
    compound: stint.compound,
    tyreAge,
    stintNumber: stint.stint_number,
  };
}

function buildRacePace(laps, stints, selectedDrivers, filterSlow) {
  const selected = new Set(selectedDrivers.map(Number));
  const byDriver = new Map();

  laps.forEach((lap) => {
    const driverNumber = Number(lap.driver_number);
    const duration = Number(lap.lap_duration);
    const lapNumber = Number(lap.lap_number);

    if (!selected.has(driverNumber)) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (!Number.isFinite(lapNumber) || lapNumber <= 1) return;
    if (lap.is_pit_out_lap) return;

    if (!byDriver.has(driverNumber)) byDriver.set(driverNumber, []);
    byDriver.get(driverNumber).push({ ...lap, lap_duration: duration, lap_number: lapNumber });
  });

  const result = [];

  byDriver.forEach((driverLaps, driverNumber) => {
    const med = median(driverLaps.map((lap) => lap.lap_duration));
    const filtered = driverLaps.filter((lap) => {
      if (!filterSlow || med === null) return true;
      return lap.lap_duration <= med + 7;
    });

    filtered.forEach((lap) => {
      const tyre = getCompoundForLap(stints, driverNumber, lap.lap_number);
      result.push({
        driverNumber,
        lapNumber: lap.lap_number,
        lapTime: lap.lap_duration,
        compound: tyre?.compound || "—",
        tyreAge: tyre?.tyreAge ?? null,
        stintNumber: tyre?.stintNumber ?? null,
      });
    });
  });

  return result;
}

function medianAbsoluteDeviation(values) {
  const med = median(values);
  if (med === null) return null;
  return median(values.map((value) => Math.abs(Number(value) - med)));
}

function regressionSlope(points) {
  if (!points || points.length < 4) return null;

  const xs = points.map((point) => Number(point.lapNumber));
  const ys = points.map((point) => Number(point.lapTime));
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;

  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }

  return denominator > 0 ? numerator / denominator : null;
}

function weightedStintSlope(points) {
  const byStint = new Map();

  points.forEach((point) => {
    const key = point.stintNumber ?? `unknown-${point.compound}`;
    if (!byStint.has(key)) byStint.set(key, []);
    byStint.get(key).push(point);
  });

  const slopes = [];

  byStint.forEach((stintPoints) => {
    const ordered = [...stintPoints].sort((a, b) => a.lapNumber - b.lapNumber);
    const slope = regressionSlope(ordered);

    if (slope !== null) {
      slopes.push({
        slope,
        weight: ordered.length,
      });
    }
  });

  if (!slopes.length) return null;

  const totalWeight = slopes.reduce((sum, item) => sum + item.weight, 0);
  return slopes.reduce((sum, item) => sum + item.slope * item.weight, 0) / totalWeight;
}

function mostCommonCompound(points) {
  const counts = new Map();

  points.forEach((point) => {
    const compound = point.compound && point.compound !== "—" ? point.compound : null;
    if (!compound) return;
    counts.set(compound, (counts.get(compound) || 0) + 1);
  });

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
}

function buildPaceAnalysis(points, drivers) {
  if (!points.length || !drivers.length) return null;

  const stats = drivers
    .map((driver, index) => {
      const own = points
        .filter((point) => Number(point.driverNumber) === Number(driver.driver_number))
        .sort((a, b) => a.lapNumber - b.lapNumber);

      if (!own.length) return null;

      const times = own.map((point) => point.lapTime);
      const med = median(times);
      const best = Math.min(...times);
      const mad = medianAbsoluteDeviation(times);
      const trend = weightedStintSlope(own);

      return {
        driver,
        index,
        points: own,
        median: med,
        best,
        mad,
        trend,
        compound: mostCommonCompound(own),
        laps: own.length,
      };
    })
    .filter(Boolean);

  if (!stats.length) return null;

  const byMedian = [...stats].sort((a, b) => a.median - b.median);
  const byBest = [...stats].sort((a, b) => a.best - b.best);
  const withConsistency = stats.filter((item) => item.mad !== null);
  const byConsistency = [...withConsistency].sort((a, b) => a.mad - b.mad);

  const reference = byMedian[0];
  const bestLap = byBest[0];
  const consistent = byConsistency[0] || null;

  const enriched = stats
    .map((item) => ({
      ...item,
      gapToReference: item.median - reference.median,
    }))
    .sort((a, b) => a.median - b.median);

  const runnerUp = enriched[1] || null;
  const trendCandidates = enriched.filter((item) => item.trend !== null);
  const strongestPositiveTrend = [...trendCandidates].sort((a, b) => b.trend - a.trend)[0] || null;

  const narrative = [];

  narrative.push(
    `${reference.driver.name_acronym} marca el ritmo de referencia con una mediana de ${formatLapTime(reference.median)}.`
  );

  if (runnerUp) {
    narrative.push(
      `${runnerUp.driver.name_acronym} queda a ${runnerUp.gapToReference.toFixed(3)} s/vuelta en ritmo mediano.`
    );
  }

  if (bestLap.driver.driver_number !== reference.driver.driver_number) {
    narrative.push(
      `${bestLap.driver.name_acronym} tiene la mejor vuelta aislada (${formatLapTime(bestLap.best)}), aunque no lidera la mediana.`
    );
  } else {
    narrative.push(
      `${bestLap.driver.name_acronym} también firma la mejor vuelta filtrada: ${formatLapTime(bestLap.best)}.`
    );
  }

  if (consistent) {
    narrative.push(
      `${consistent.driver.name_acronym} es el más consistente de la selección, con una dispersión robusta de ±${consistent.mad.toFixed(3)} s alrededor de su mediana.`
    );
  }

  if (strongestPositiveTrend && strongestPositiveTrend.trend > 0.015) {
    narrative.push(
      `${strongestPositiveTrend.driver.name_acronym} muestra la mayor tendencia a perder tiempo dentro de sus stints: +${strongestPositiveTrend.trend.toFixed(3)} s por vuelta. Esto puede reflejar degradación, combustible, tráfico o evolución de pista; no se atribuye a una sola causa.`
    );
  }

  return {
    reference,
    bestLap,
    consistent,
    stats: enriched,
    narrative,
  };
}

function SelectField({ label, value, onChange, children, disabled = false }) {
  return (
    <label className="telemetry-field">
      <span>{label}</span>
      <select value={value} onChange={onChange} disabled={disabled}>
        {children}
      </select>
    </label>
  );
}

function MetricCard({ label, value, sub, accent }) {
  return (
    <div className="telemetry-metric" style={{ "--metric-accent": accent || "#00f5d4" }}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function LineChart({
  title,
  unit,
  series,
  valueKey,
  formatter = (value) => value?.toFixed?.(1) ?? "—",
  zeroLine = false,
  deltaContext = null,
}) {
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(false);

  const width = 1000;
  const height = 250;
  const pad = { left: 64, right: 22, top: 24, bottom: 38 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;

  const values = series.flatMap((item) =>
    item.points.map((point) => safeNumber(point[valueKey])).filter((value) => value !== null)
  );

  if (!values.length) {
    return (
      <div className="telemetry-chart-card">
        <div className="telemetry-chart-title"><h3>{title}</h3></div>
        <div className="telemetry-chart-empty">Sin datos suficientes.</div>
      </div>
    );
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (zeroLine) {
    const absolute = Math.max(Math.abs(min), Math.abs(max), 0.05);
    min = -absolute;
    max = absolute;
  } else if (min === max) {
    min -= 1;
    max += 1;
  } else {
    const margin = (max - min) * 0.08;
    min -= margin;
    max += margin;
  }

  const x = (progress) => pad.left + (Number(progress) / 100) * innerWidth;
  const y = (value) => pad.top + ((max - Number(value)) / (max - min)) * innerHeight;

  const gridValues = Array.from({ length: 5 }, (_, index) => max - ((max - min) * index) / 4);

  function buildHover(progress, pointerY = null) {
    const clampedProgress = Math.max(0, Math.min(100, progress));

    const samples = series
      .map((item) => {
        const value = interpolateAtProgress(item.points, clampedProgress, valueKey);
        return value === null
          ? null
          : {
              label: item.label,
              color: item.color,
              value,
              chartY: y(value),
            };
      })
      .filter(Boolean);

    let activeLabel = samples[0]?.label || null;

    if (pointerY !== null && samples.length) {
      activeLabel = [...samples].sort(
        (a, b) => Math.abs(a.chartY - pointerY) - Math.abs(b.chartY - pointerY)
      )[0]?.label;
    }

    let accumulatedDelta = null;
    let localDeltaChange = null;

    if (deltaContext?.points?.length) {
      accumulatedDelta = interpolateAtProgress(deltaContext.points, clampedProgress, "delta");

      const window = 1.5;
      const before = interpolateAtProgress(
        deltaContext.points,
        Math.max(0, clampedProgress - window),
        "delta"
      );
      const after = interpolateAtProgress(
        deltaContext.points,
        Math.min(100, clampedProgress + window),
        "delta"
      );

      if (before !== null && after !== null) {
        localDeltaChange = after - before;
      }
    }

    return {
      progress: clampedProgress,
      samples,
      activeLabel,
      accumulatedDelta,
      localDeltaChange,
    };
  }

  function handlePointerMove(event) {
    if (pinned) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = ((event.clientX - rect.left) / rect.width) * width;
    const pointerY = ((event.clientY - rect.top) / rect.height) * height;
    const chartX = Math.max(pad.left, Math.min(width - pad.right, pointerX));
    const progress = ((chartX - pad.left) / innerWidth) * 100;

    setHover(buildHover(progress, pointerY));
  }

  function handlePointerLeave() {
    if (!pinned) setHover(null);
  }

  function handlePointerDown(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = ((event.clientX - rect.left) / rect.width) * width;
    const pointerY = ((event.clientY - rect.top) / rect.height) * height;
    const chartX = Math.max(pad.left, Math.min(width - pad.right, pointerX));
    const progress = ((chartX - pad.left) / innerWidth) * 100;

    setHover(buildHover(progress, pointerY));
    setPinned((current) => !current);
  }

  function accumulatedText() {
    const value = hover?.accumulatedDelta;
    if (value === null || value === undefined || !deltaContext) return null;

    if (Math.abs(value) < 0.001) {
      return "Delta acumulado: prácticamente igualados";
    }

    const leader = value > 0 ? deltaContext.driverA : deltaContext.driverB;
    return `Delta acumulado: ${leader} +${Math.abs(value).toFixed(3)} s`;
  }

  function localGainText() {
    const change = hover?.localDeltaChange;
    if (change === null || change === undefined || !deltaContext) return null;

    if (Math.abs(change) < 0.003) {
      return "Tramo local: sin ganancia significativa";
    }

    // delta = B - A. Si aumenta, A gana tiempo; si disminuye, B gana tiempo.
    const gainingDriver = change > 0 ? deltaContext.driverA : deltaContext.driverB;
    return `${gainingDriver} gana ~${Math.abs(change).toFixed(3)} s en este tramo`;
  }

  const activeSample = hover?.samples?.find((sample) => sample.label === hover.activeLabel);
  const comparisonSample = hover?.samples?.find((sample) => sample.label !== hover.activeLabel);
  const activeDifference =
    activeSample && comparisonSample ? activeSample.value - comparisonSample.value : null;

  return (
    <div className="telemetry-chart-card">
      <div className="telemetry-chart-title">
        <div>
          <span>Telemetría</span>
          <h3>{title}</h3>
        </div>
        <div className="telemetry-chart-legend">
          {series.map((item) => (
            <span key={item.label} className={hover?.activeLabel === item.label ? "active" : ""}>
              <i style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </div>

      <div className="telemetry-chart-plot">
        <svg
          className="telemetry-line-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={title}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onPointerDown={handlePointerDown}
        >
          {gridValues.map((value, index) => (
            <g key={index}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(value)}
                y2={y(value)}
                className="telemetry-grid-line"
              />
              <text x={pad.left - 12} y={y(value) + 4} className="telemetry-axis-text" textAnchor="end">
                {formatter(value)}
              </text>
            </g>
          ))}

          {[0, 25, 50, 75, 100].map((progress) => (
            <g key={progress}>
              <line
                x1={x(progress)}
                x2={x(progress)}
                y1={pad.top}
                y2={height - pad.bottom}
                className="telemetry-grid-line vertical"
              />
              <text x={x(progress)} y={height - 12} className="telemetry-axis-text" textAnchor="middle">
                {progress}%
              </text>
            </g>
          ))}

          {zeroLine && min < 0 && max > 0 && (
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(0)}
              y2={y(0)}
              className="telemetry-zero-line"
            />
          )}

          {series.map((item) => {
            const valid = item.points.filter((point) => safeNumber(point[valueKey]) !== null);
            const polyline = valid.map((point) => `${x(point.progress)},${y(point[valueKey])}`).join(" ");

            return (
              <polyline
                key={item.label}
                points={polyline}
                fill="none"
                stroke={item.color}
                strokeWidth={hover?.activeLabel === item.label ? "4.5" : "3.2"}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`telemetry-series-line ${
                  hover && hover.activeLabel !== item.label ? "dimmed" : ""
                }`}
              />
            );
          })}

          {hover && (
            <>
              <line
                x1={x(hover.progress)}
                x2={x(hover.progress)}
                y1={pad.top}
                y2={height - pad.bottom}
                className="telemetry-hover-line"
              />

              {hover.samples.map((sample) => (
                <g key={sample.label}>
                  <circle
                    cx={x(hover.progress)}
                    cy={y(sample.value)}
                    r={sample.label === hover.activeLabel ? 6.5 : 5}
                    fill={sample.color}
                    className="telemetry-hover-dot"
                  />
                  <circle
                    cx={x(hover.progress)}
                    cy={y(sample.value)}
                    r={sample.label === hover.activeLabel ? 10 : 8}
                    fill="none"
                    stroke={sample.color}
                    className="telemetry-hover-ring"
                  />
                </g>
              ))}
            </>
          )}

          <text x={16} y={18} className="telemetry-unit-text">{unit}</text>
        </svg>

        {hover && (
          <>
            <div
              className="telemetry-cursor-badge"
              style={{
                left: `${(x(hover.progress) / width) * 100}%`,
              }}
            >
              {hover.progress.toFixed(1)}%
            </div>

            <div
              className={`telemetry-hover-tooltip ${
                pinned ? "pinned" : ""
              } ${
                hover.progress >= 50 ? "dock-left" : "dock-right"
              }`}
            >
              <div className="telemetry-hover-tooltip-head">
                <strong>{hover.progress.toFixed(1)}% de la vuelta</strong>
                <span>{pinned ? "Fijado" : "Mover cursor"}</span>
              </div>

              <div className="telemetry-hover-values">
                {hover.samples.map((sample) => (
                  <div
                    key={sample.label}
                    className={sample.label === hover.activeLabel ? "active" : ""}
                  >
                    <span>
                      <i style={{ background: sample.color }} />
                      {sample.label}
                    </span>
                    <strong>{formatter(sample.value)}</strong>
                  </div>
                ))}
              </div>

              {activeDifference !== null && !zeroLine && (
                <div className="telemetry-hover-comparison">
                  {hover.activeLabel}: {activeDifference >= 0 ? "+" : ""}
                  {valueKey === "speed"
                    ? `${activeDifference.toFixed(0)} km/h`
                    : `${activeDifference.toFixed(0)} pp`} vs {comparisonSample?.label}
                </div>
              )}

              {accumulatedText() && (
                <div className="telemetry-hover-delta">{accumulatedText()}</div>
              )}

              {localGainText() && (
                <div className="telemetry-hover-local">{localGainText()}</div>
              )}

              <small>
                {pinned
                  ? "Pulsa de nuevo sobre el gráfico para liberar el punto."
                  : "Haz clic para fijar este punto."}
              </small>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RacePaceChart({ points, drivers }) {
  const width = 1000;
  const height = 510;
  const pad = { left: 72, right: 24, top: 22, bottom: 48 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;

  if (!points.length) {
    return <div className="telemetry-chart-empty large">No hay vueltas válidas para mostrar.</div>;
  }

  const minLap = Math.min(...points.map((point) => point.lapNumber));
  const maxLap = Math.max(...points.map((point) => point.lapNumber));
  let minTime = Math.min(...points.map((point) => point.lapTime));
  let maxTime = Math.max(...points.map((point) => point.lapTime));

  const margin = Math.max((maxTime - minTime) * 0.08, 0.7);
  minTime -= margin;
  maxTime += margin;

  const x = (lap) =>
    pad.left + ((Number(lap) - minLap) / Math.max(maxLap - minLap, 1)) * innerWidth;
  const y = (time) => pad.top + ((Number(time) - minTime) / Math.max(maxTime - minTime, 0.1)) * innerHeight;

  const yGrid = Array.from({ length: 6 }, (_, index) => minTime + ((maxTime - minTime) * index) / 5);
  const driverMap = new Map(drivers.map((driver, index) => [Number(driver.driver_number), { driver, index }]));

  return (
    <div className="pace-chart-card">
      <div className="telemetry-chart-title">
        <div>
          <span>Ritmo de carrera</span>
          <h3>Dispersión de tiempos por vuelta</h3>
        </div>
        <div className="telemetry-chart-legend multi">
          {drivers.map((driver, index) => (
            <span key={driver.driver_number}>
              <i style={{ background: driverColor(driver, index) }} />
              {driver.name_acronym}
            </span>
          ))}
        </div>
      </div>

      <svg className="telemetry-pace-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Ritmo de carrera por vuelta">
        {yGrid.map((value, index) => (
          <g key={index}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(value)}
              y2={y(value)}
              className="telemetry-grid-line"
            />
            <text x={pad.left - 12} y={y(value) + 4} className="telemetry-axis-text" textAnchor="end">
              {formatLapTime(value)}
            </text>
          </g>
        ))}

        {Array.from({ length: 7 }, (_, index) => {
          const lap = Math.round(minLap + ((maxLap - minLap) * index) / 6);
          return (
            <g key={`${lap}-${index}`}>
              <line
                x1={x(lap)}
                x2={x(lap)}
                y1={pad.top}
                y2={height - pad.bottom}
                className="telemetry-grid-line vertical"
              />
              <text x={x(lap)} y={height - 15} className="telemetry-axis-text" textAnchor="middle">
                V{lap}
              </text>
            </g>
          );
        })}

        {points.map((point, index) => {
          const meta = driverMap.get(Number(point.driverNumber));
          const driver = meta?.driver;
          const color = driverColor(driver, meta?.index || 0);

          return (
            <circle
              key={`${point.driverNumber}-${point.lapNumber}-${index}`}
              cx={x(point.lapNumber)}
              cy={y(point.lapTime)}
              r="5.2"
              fill={color}
              fillOpacity="0.82"
              stroke="#050608"
              strokeWidth="1.8"
            >
              <title>
                {`${driver?.name_acronym || point.driverNumber} · Vuelta ${point.lapNumber} · ${formatLapTime(point.lapTime)} · ${point.compound}${point.tyreAge !== null ? ` · neumático ${point.tyreAge}v` : ""}`}
              </title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function PaceAnalysis({ analysis }) {
  if (!analysis) return null;

  const { reference, bestLap, consistent, stats, narrative } = analysis;

  return (
    <section className="pace-analysis">
      <div className="pace-analysis-heading">
        <div>
          <span>Lectura de carrera</span>
          <h3>¿Qué está mostrando el ritmo?</h3>
        </div>
        <small>Comparación basada en las vueltas filtradas que aparecen en el gráfico.</small>
      </div>

      <div className="pace-insight-grid">
        <article className="pace-insight-card">
          <span>Ritmo de referencia</span>
          <strong>{reference.driver.name_acronym}</strong>
          <b>{formatLapTime(reference.median)}</b>
          <small>Mediana de ritmo</small>
        </article>

        <article className="pace-insight-card">
          <span>Mejor vuelta filtrada</span>
          <strong>{bestLap.driver.name_acronym}</strong>
          <b>{formatLapTime(bestLap.best)}</b>
          <small>Vuelta individual más rápida</small>
        </article>

        <article className="pace-insight-card">
          <span>Mayor consistencia</span>
          <strong>{consistent?.driver.name_acronym || "—"}</strong>
          <b>{consistent?.mad !== null && consistent?.mad !== undefined ? `±${consistent.mad.toFixed(3)} s` : "—"}</b>
          <small>Desviación mediana absoluta</small>
        </article>
      </div>

      <div className="pace-analysis-body">
        <div className="pace-narrative">
          <h4>Resumen automático</h4>
          {narrative.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </div>

        <div className="pace-analysis-table-wrap">
          <table className="pace-analysis-table">
            <thead>
              <tr>
                <th>Piloto</th>
                <th>Mediana</th>
                <th>Gap</th>
                <th>Mejor</th>
                <th>Consistencia</th>
                <th>Tendencia/stint</th>
                <th>Compuesto</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((item) => (
                <tr key={item.driver.driver_number}>
                  <td>
                    <span
                      className="pace-table-dot"
                      style={{ background: driverColor(item.driver, item.index) }}
                    />
                    <strong>{item.driver.name_acronym}</strong>
                  </td>
                  <td>{formatLapTime(item.median)}</td>
                  <td>{item.gapToReference <= 0.0005 ? "REF" : `+${item.gapToReference.toFixed(3)} s`}</td>
                  <td>{formatLapTime(item.best)}</td>
                  <td>{item.mad !== null ? `±${item.mad.toFixed(3)} s` : "—"}</td>
                  <td>
                    {item.trend === null
                      ? "—"
                      : `${item.trend >= 0 ? "+" : ""}${item.trend.toFixed(3)} s/v`}
                  </td>
                  <td>{item.compound}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pace-analysis-note">
        La tendencia por stint es una lectura estadística del tiempo por vuelta. Puede verse afectada por combustible, tráfico, banderas y evolución de pista, por lo que no equivale por sí sola a degradación pura del neumático.
      </div>
    </section>
  );
}

export default function Telemetry() {
  const [mode, setMode] = useState("lap");
  const [meetings, setMeetings] = useState([]);
  const [meetingKey, setMeetingKey] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionKey, setSessionKey] = useState("");
  const [drivers, setDrivers] = useState([]);

  const [driverA, setDriverA] = useState("");
  const [driverB, setDriverB] = useState("");
  const [paceDrivers, setPaceDrivers] = useState([]);
  const [filterSlow, setFilterSlow] = useState(true);

  const [comparison, setComparison] = useState(null);
  const [pacePoints, setPacePoints] = useState([]);

  const [loadingContext, setLoadingContext] = useState(true);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [error, setError] = useState("");

  const [liveMode, setLiveMode] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const analysisRef = useRef(null);

  const selectedMeeting = useMemo(
    () => meetings.find((meeting) => String(meeting.meeting_key) === String(meetingKey)),
    [meetings, meetingKey]
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => String(session.session_key) === String(sessionKey)),
    [sessions, sessionKey]
  );

  const driverMap = useMemo(
    () => new Map(drivers.map((driver) => [Number(driver.driver_number), driver])),
    [drivers]
  );

  useEffect(() => {
    async function loadMeetings() {
      try {
        setLoadingContext(true);
        const data = await openF1("meetings", { year: YEAR });
        const ordered = [...data].sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
        setMeetings(ordered);

        const now = Date.now();
        const completed = ordered.filter((meeting) => new Date(meeting.date_end).getTime() < now);
        const defaultMeeting = completed[completed.length - 1] || ordered[0];

        if (defaultMeeting) setMeetingKey(String(defaultMeeting.meeting_key));
      } catch (err) {
        setError(`No se pudieron cargar los Grandes Premios: ${err.message}`);
      } finally {
        setLoadingContext(false);
      }
    }

    loadMeetings();
  }, []);

  useEffect(() => {
    if (!meetingKey || liveMode) return;

    async function loadSessions() {
      try {
        setLoadingContext(true);
        setError("");
        setComparison(null);
        setPacePoints([]);

        const data = await openF1("sessions", { meeting_key: meetingKey });
        const ordered = [...data].sort(sessionSort);
        setSessions(ordered);

        const preferred =
          ordered.find((session) => session.session_name === (mode === "pace" ? "Race" : "Qualifying")) ||
          ordered.find((session) => session.session_name === "Race") ||
          ordered[ordered.length - 1];

        setSessionKey(preferred ? String(preferred.session_key) : "");
      } catch (err) {
        setError(`No se pudieron cargar las sesiones: ${err.message}`);
      } finally {
        setLoadingContext(false);
      }
    }

    loadSessions();
  }, [meetingKey, liveMode, mode]);

  useEffect(() => {
    if (!sessionKey) {
      setDrivers([]);
      return;
    }

    async function loadDrivers() {
      try {
        setLoadingContext(true);
        setError("");

        const data = await openF1(
          "drivers",
          { session_key: sessionKey },
          { live: liveMode }
        );

        const unique = [...new Map(data.map((driver) => [driver.driver_number, driver])).values()]
          .sort((a, b) => Number(a.driver_number) - Number(b.driver_number));

        setDrivers(unique);

        if (unique.length) {
          setDriverA((current) =>
            unique.some((driver) => String(driver.driver_number) === String(current))
              ? current
              : String(unique[0].driver_number)
          );

          setDriverB((current) => {
            if (unique.some((driver) => String(driver.driver_number) === String(current))) return current;
            return String(unique[1]?.driver_number ?? unique[0].driver_number);
          });

          setPaceDrivers((current) => {
            const stillValid = current.filter((number) =>
              unique.some((driver) => Number(driver.driver_number) === Number(number))
            );

            if (stillValid.length) return stillValid;
            return unique.slice(0, Math.min(4, unique.length)).map((driver) => Number(driver.driver_number));
          });
        }
      } catch (err) {
        setDrivers([]);
        setError(
          liveMode
            ? `No se pudieron cargar los pilotos LIVE: ${err.message}`
            : `No se pudieron cargar los pilotos de esta sesión: ${err.message}`
        );
      } finally {
        setLoadingContext(false);
      }
    }

    loadDrivers();
  }, [sessionKey, liveMode]);

  async function runLapComparison({ silent = false } = {}) {
    if (!sessionKey || !driverA || !driverB) return;
    if (String(driverA) === String(driverB)) {
      setError("Selecciona dos pilotos distintos para comparar.");
      return;
    }

    try {
      if (!silent) setLoadingAnalysis(true);
      setError("");

      const laps = await openF1(
        "laps",
        { session_key: sessionKey },
        { live: liveMode }
      );

      const lapA = fastestLapForDriver(laps, driverA);
      const lapB = fastestLapForDriver(laps, driverB);

      if (!lapA || !lapB) {
        throw new Error("Aún no hay una vuelta rápida válida para ambos pilotos en esta sesión.");
      }

      const [carA, carB] = await Promise.all([
        fetchCarDataForLap(sessionKey, driverA, lapA, liveMode),
        fetchCarDataForLap(sessionKey, driverB, lapB, liveMode),
      ]);

      const pointsA = prepareTelemetry(carA, lapA);
      const pointsB = prepareTelemetry(carB, lapB);

      if (pointsA.length < 10 || pointsB.length < 10) {
        throw new Error("OpenF1 no devolvió suficiente telemetría para una de las vueltas.");
      }

      setComparison({
        lapA,
        lapB,
        pointsA,
        pointsB,
        delta: buildDeltaSeries(pointsA, pointsB),
      });
      setLastUpdated(new Date());
    } catch (err) {
      if (!silent) setComparison(null);
      setError(`No se pudo generar la comparación: ${err.message}`);
    } finally {
      if (!silent) setLoadingAnalysis(false);
    }
  }

  async function runRacePace({ silent = false } = {}) {
    if (!sessionKey || !paceDrivers.length) return;

    try {
      if (!silent) setLoadingAnalysis(true);
      setError("");

      const [laps, stints] = await Promise.all([
        openF1("laps", { session_key: sessionKey }, { live: liveMode }),
        openF1("stints", { session_key: sessionKey }, { live: liveMode }).catch(() => []),
      ]);

      const points = buildRacePace(laps, stints, paceDrivers, filterSlow);
      setPacePoints(points);
      setLastUpdated(new Date());
    } catch (err) {
      if (!silent) setPacePoints([]);
      setError(`No se pudo generar el ritmo de carrera: ${err.message}`);
    } finally {
      if (!silent) setLoadingAnalysis(false);
    }
  }

  async function activateLive() {
    try {
      setLoadingContext(true);
      setError("");

      const latestSessions = await openF1(
        "sessions",
        { session_key: "latest" },
        { live: true }
      );

      const current = latestSessions[latestSessions.length - 1];

      if (!current || !sessionIsLive(current)) {
        throw new Error(
          "No hay una sesión de F1 dentro de la ventana LIVE en este momento. El modo LIVE funciona desde 30 minutos antes hasta 30 minutos después de cada sesión."
        );
      }

      const meeting = meetings.find(
        (item) => Number(item.meeting_key) === Number(current.meeting_key)
      );

      setLiveMode(true);
      setAutoRefresh(true);
      setSessions([current]);
      setSessionKey(String(current.session_key));
      if (meeting) setMeetingKey(String(meeting.meeting_key));
      setComparison(null);
      setPacePoints([]);
    } catch (err) {
      setLiveMode(false);
      setAutoRefresh(false);
      setError(
        `No se pudo iniciar LIVE: ${err.message}. Para datos en tiempo real OpenF1 requiere una suscripción con acceso LIVE y credenciales configuradas en Vercel.`
      );
    } finally {
      setLoadingContext(false);
    }
  }

  function deactivateLive() {
    setLiveMode(false);
    setAutoRefresh(false);
    setComparison(null);
    setPacePoints([]);

    if (meetingKey) {
      setMeetingKey((current) => String(current));
    }
  }

  function togglePaceDriver(driverNumber) {
    const numeric = Number(driverNumber);

    setPaceDrivers((current) => {
      if (current.includes(numeric)) {
        return current.filter((item) => item !== numeric);
      }

      if (current.length >= MAX_PACE_DRIVERS) return current;
      return [...current, numeric];
    });
  }

  analysisRef.current = () => {
    if (mode === "lap") return runLapComparison({ silent: true });
    return runRacePace({ silent: true });
  };

  useEffect(() => {
    if (!liveMode || !autoRefresh) return undefined;

    const interval = window.setInterval(() => {
      analysisRef.current?.();
    }, LIVE_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [liveMode, autoRefresh, mode, sessionKey, driverA, driverB, filterSlow, paceDrivers.join(",")]);

  const driverAInfo = driverMap.get(Number(driverA));
  const driverBInfo = driverMap.get(Number(driverB));
  const paceDriverInfo = paceDrivers.map((number) => driverMap.get(Number(number))).filter(Boolean);

  const paceAnalysis = useMemo(
    () => buildPaceAnalysis(pacePoints, paceDriverInfo),
    [pacePoints, paceDriverInfo]
  );

  const difference = comparison
    ? Number(comparison.lapB.lap_duration) - Number(comparison.lapA.lap_duration)
    : null;

  return (
    <main className="page telemetry-page">
      <section className="telemetry-hero">
        <div>
          <div className="eyebrow">GridPulse Telemetry</div>
          <h1>
            La vuelta y el ritmo,
            <br />
            explicados con datos.
          </h1>
          <p>
            Compara las vueltas rápidas de dos pilotos o analiza el ritmo de carrera de hasta ocho competidores. Los datos históricos de 2026 llegan desde OpenF1 y el modo LIVE está preparado para las sesiones en curso.
          </p>
        </div>

        <div className={`telemetry-live-box ${liveMode ? "active" : ""}`}>
          <span className="telemetry-live-dot" />
          <div>
            <strong>{liveMode ? "LIVE conectado" : "LIVE preparado"}</strong>
            <small>{liveMode ? "Actualización cada 10 s" : "OpenF1 · requiere acceso LIVE"}</small>
          </div>
          {liveMode ? (
            <button onClick={deactivateLive}>Salir</button>
          ) : (
            <button onClick={activateLive}>Conectar</button>
          )}
        </div>
      </section>

      <section className="telemetry-workspace">
        <div className="telemetry-tabs">
          <button
            className={mode === "lap" ? "active" : ""}
            onClick={() => {
              setMode("lap");
              setError("");
            }}
          >
            <span>01</span>
            Vuelta rápida 1v1
          </button>
          <button
            className={mode === "pace" ? "active" : ""}
            onClick={() => {
              setMode("pace");
              setError("");
            }}
          >
            <span>02</span>
            Ritmo de carrera
          </button>
        </div>

        <div className="telemetry-control-panel">
          <SelectField
            label="Gran Premio"
            value={meetingKey}
            disabled={liveMode || loadingContext}
            onChange={(event) => {
              setMeetingKey(event.target.value);
              setComparison(null);
              setPacePoints([]);
            }}
          >
            {meetings.map((meeting) => (
              <option key={meeting.meeting_key} value={meeting.meeting_key}>
                {meetingLabel(meeting)}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Sesión"
            value={sessionKey}
            disabled={liveMode || loadingContext || !sessions.length}
            onChange={(event) => {
              setSessionKey(event.target.value);
              setComparison(null);
              setPacePoints([]);
            }}
          >
            {sessions.map((session) => (
              <option key={session.session_key} value={session.session_key}>
                {session.session_name} · {formatSessionDate(session.date_start)}
              </option>
            ))}
          </SelectField>

          <div className="telemetry-context-summary">
            <span>{selectedMeeting?.country_name || "Temporada 2026"}</span>
            <strong>{selectedSession?.session_name || "Selecciona una sesión"}</strong>
            <small>{selectedSession ? formatSessionDate(selectedSession.date_start) : ""}</small>
          </div>
        </div>

        {error && <div className="telemetry-error">{error}</div>}

        {mode === "lap" ? (
          <section className="telemetry-lap-mode">
            <div className="telemetry-driver-picker two">
              <SelectField
                label="Piloto A"
                value={driverA}
                disabled={!drivers.length}
                onChange={(event) => setDriverA(event.target.value)}
              >
                {drivers.map((driver) => (
                  <option key={driver.driver_number} value={driver.driver_number}>
                    {driverLabel(driver)}
                  </option>
                ))}
              </SelectField>

              <div className="telemetry-vs">VS</div>

              <SelectField
                label="Piloto B"
                value={driverB}
                disabled={!drivers.length}
                onChange={(event) => setDriverB(event.target.value)}
              >
                {drivers.map((driver) => (
                  <option key={driver.driver_number} value={driver.driver_number}>
                    {driverLabel(driver)}
                  </option>
                ))}
              </SelectField>

              <button className="telemetry-primary-button" onClick={() => runLapComparison()} disabled={loadingAnalysis || !driverA || !driverB}>
                {loadingAnalysis ? "Analizando…" : "Comparar vueltas"}
              </button>
            </div>

            {comparison && (
              <>
                <div className="telemetry-metrics-grid three">
                  <MetricCard
                    label={driverAInfo?.name_acronym || "Piloto A"}
                    value={formatLapTime(comparison.lapA.lap_duration)}
                    sub={`Vuelta ${comparison.lapA.lap_number} · ${driverAInfo?.team_name || ""}`}
                    accent={driverColor(driverAInfo, 0)}
                  />
                  <MetricCard
                    label="Diferencia"
                    value={formatDelta(Math.abs(difference))}
                    sub={
                      difference === 0
                        ? "Mismo tiempo"
                        : difference > 0
                        ? `${driverAInfo?.name_acronym || "A"} fue más rápido`
                        : `${driverBInfo?.name_acronym || "B"} fue más rápido`
                    }
                    accent="#f3f4f6"
                  />
                  <MetricCard
                    label={driverBInfo?.name_acronym || "Piloto B"}
                    value={formatLapTime(comparison.lapB.lap_duration)}
                    sub={`Vuelta ${comparison.lapB.lap_number} · ${driverBInfo?.team_name || ""}`}
                    accent={driverColor(driverBInfo, 1)}
                  />
                </div>

                <LineChart
                  title={`Delta · ${driverBInfo?.name_acronym || "B"} vs ${driverAInfo?.name_acronym || "A"}`}
                  unit="seg"
                  zeroLine
                  valueKey="delta"
                  deltaContext={{
                    points: comparison.delta,
                    driverA: driverAInfo?.name_acronym || "A",
                    driverB: driverBInfo?.name_acronym || "B",
                  }}
                  formatter={(value) => formatDelta(value)}
                  series={[
                    {
                      label: `${driverBInfo?.name_acronym || "B"} − ${driverAInfo?.name_acronym || "A"}`,
                      color: "#f3f4f6",
                      points: comparison.delta,
                    },
                  ]}
                />

                <LineChart
                  title="Velocidad"
                  unit="km/h"
                  valueKey="speed"
                  deltaContext={{
                    points: comparison.delta,
                    driverA: driverAInfo?.name_acronym || "A",
                    driverB: driverBInfo?.name_acronym || "B",
                  }}
                  formatter={(value) => Math.round(value)}
                  series={[
                    {
                      label: driverAInfo?.name_acronym || "A",
                      color: driverColor(driverAInfo, 0),
                      points: comparison.pointsA,
                    },
                    {
                      label: driverBInfo?.name_acronym || "B",
                      color: driverColor(driverBInfo, 1),
                      points: comparison.pointsB,
                    },
                  ]}
                />

                <LineChart
                  title="Acelerador"
                  unit="%"
                  valueKey="throttle"
                  deltaContext={{
                    points: comparison.delta,
                    driverA: driverAInfo?.name_acronym || "A",
                    driverB: driverBInfo?.name_acronym || "B",
                  }}
                  formatter={(value) => `${Math.round(value)}%`}
                  series={[
                    {
                      label: driverAInfo?.name_acronym || "A",
                      color: driverColor(driverAInfo, 0),
                      points: comparison.pointsA,
                    },
                    {
                      label: driverBInfo?.name_acronym || "B",
                      color: driverColor(driverBInfo, 1),
                      points: comparison.pointsB,
                    },
                  ]}
                />

                <LineChart
                  title="Freno"
                  unit="%"
                  valueKey="brake"
                  deltaContext={{
                    points: comparison.delta,
                    driverA: driverAInfo?.name_acronym || "A",
                    driverB: driverBInfo?.name_acronym || "B",
                  }}
                  formatter={(value) => `${Math.round(value)}%`}
                  series={[
                    {
                      label: driverAInfo?.name_acronym || "A",
                      color: driverColor(driverAInfo, 0),
                      points: comparison.pointsA,
                    },
                    {
                      label: driverBInfo?.name_acronym || "B",
                      color: driverColor(driverBInfo, 1),
                      points: comparison.pointsB,
                    },
                  ]}
                />
              </>
            )}
          </section>
        ) : (
          <section className="telemetry-pace-mode">
            <div className="pace-picker-head">
              <div>
                <span className="eyebrow">Comparación múltiple</span>
                <h2>Elige hasta 8 pilotos</h2>
                <p>Las vueltas lentas por tráfico, Safety Car o boxes pueden ocultarse para visualizar mejor la degradación y el ritmo real.</p>
              </div>

              <div className="pace-actions">
                <label className="telemetry-switch">
                  <input
                    type="checkbox"
                    checked={filterSlow}
                    onChange={(event) => setFilterSlow(event.target.checked)}
                  />
                  <span />
                  Filtrar vueltas lentas
                </label>

                <button
                  className="telemetry-primary-button"
                  onClick={() => runRacePace()}
                  disabled={loadingAnalysis || !paceDrivers.length}
                >
                  {loadingAnalysis ? "Analizando…" : "Analizar ritmo"}
                </button>
              </div>
            </div>

            <div className="pace-driver-grid">
              {drivers.map((driver, index) => {
                const selected = paceDrivers.includes(Number(driver.driver_number));
                const disabled = !selected && paceDrivers.length >= MAX_PACE_DRIVERS;

                return (
                  <button
                    key={driver.driver_number}
                    className={`pace-driver-chip ${selected ? "selected" : ""}`}
                    style={{ "--driver-color": driverColor(driver, index) }}
                    disabled={disabled}
                    onClick={() => togglePaceDriver(driver.driver_number)}
                  >
                    <span className="pace-driver-number">{driver.driver_number}</span>
                    <span>
                      <strong>{driver.name_acronym}</strong>
                      <small>{driver.team_name}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="pace-selection-count">
              {paceDrivers.length} / {MAX_PACE_DRIVERS} pilotos seleccionados
            </div>

            {pacePoints.length > 0 && (
              <>
                <RacePaceChart points={pacePoints} drivers={paceDriverInfo} />

                <div className="pace-summary-grid">
                  {paceDriverInfo.map((driver, index) => {
                    const own = pacePoints.filter(
                      (point) => Number(point.driverNumber) === Number(driver.driver_number)
                    );
                    const med = median(own.map((point) => point.lapTime));
                    const best = own.length ? Math.min(...own.map((point) => point.lapTime)) : null;

                    return (
                      <MetricCard
                        key={driver.driver_number}
                        label={driver.name_acronym}
                        value={formatLapTime(med)}
                        sub={`Mediana · mejor ${formatLapTime(best)}`}
                        accent={driverColor(driver, index)}
                      />
                    );
                  })}
                </div>

                <PaceAnalysis analysis={paceAnalysis} />
              </>
            )}
          </section>
        )}

        {liveMode && (
          <div className="telemetry-live-footer">
            <span className="telemetry-live-dot" />
            LIVE · actualización automática cada {LIVE_REFRESH_MS / 1000} s
            {lastUpdated && ` · última actualización ${lastUpdated.toLocaleTimeString("es-CL")}`}
            <button onClick={() => setAutoRefresh((current) => !current)}>
              {autoRefresh ? "Pausar" : "Reanudar"}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
