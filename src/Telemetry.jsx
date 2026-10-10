import { useEffect, useMemo, useRef, useState } from "react";
import "./Telemetry.css";

const OPENF1 = "https://api.openf1.org/v1";
const YEAR = 2026;
const LIVE_REFRESH_MS = 10000;
const MAX_PACE_DRIVERS = 8;
const CAR_DATA_CACHE = new Map();
const PACE_DATA_CACHE = new Map();

/*
  OpenF1 free tier: evitamos ráfagas de peticiones y reutilizamos
  solicitudes idénticas. Esto es especialmente importante al cargar
  vueltas + stints + car_data casi al mismo tiempo.
*/
const OPENF1_INFLIGHT = new Map();
const OPENF1_RESPONSE_CACHE = new Map();
const OPENF1_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENF1_HISTORICAL_GAP_MS = 380;
const OPENF1_LIVE_GAP_MS = 190;
const OPENF1_MAX_RETRIES = 3;

let openF1Queue = Promise.resolve();
let lastOpenF1RequestAt = 0;

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

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function cacheableOpenF1Endpoint(endpoint, live) {
  if (live) return false;

  return [
    "meetings",
    "sessions",
    "drivers",
    "laps",
    "stints",
  ].includes(endpoint);
}

function retryDelayFromResponse(response, attempt) {
  const retryAfter = response?.headers?.get?.("Retry-After");

  if (retryAfter) {
    const numeric = Number(retryAfter);

    if (Number.isFinite(numeric)) {
      return Math.max(500, numeric * 1000);
    }

    const date = new Date(retryAfter).getTime();
    const delay = date - Date.now();

    if (Number.isFinite(delay) && delay > 0) {
      return delay;
    }
  }

  return Math.min(4000, 850 * 2 ** attempt);
}

function scheduleOpenF1Request(task, live = false) {
  const minGap = live ? OPENF1_LIVE_GAP_MS : OPENF1_HISTORICAL_GAP_MS;

  const run = async () => {
    const elapsed = Date.now() - lastOpenF1RequestAt;
    const remaining = Math.max(0, minGap - elapsed);

    if (remaining > 0) {
      await wait(remaining);
    }

    lastOpenF1RequestAt = Date.now();
    return task();
  };

  const scheduled = openF1Queue.then(run, run);

  // La cola no debe quedar rota si una petición falla.
  openF1Queue = scheduled.catch(() => undefined);

  return scheduled;
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

  const requestKey = `${live ? "live" : "history"}:${url}`;
  const canCache = cacheableOpenF1Endpoint(endpoint, live);

  if (canCache) {
    const cached = OPENF1_RESPONSE_CACHE.get(requestKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  const inflight = OPENF1_INFLIGHT.get(requestKey);
  if (inflight) return inflight;

  const requestPromise = scheduleOpenF1Request(async () => {
    let lastError = null;

    for (let attempt = 0; attempt < OPENF1_MAX_RETRIES; attempt += 1) {
      const response = await fetch(url);

      if (response.status === 429) {
        const delay = retryDelayFromResponse(response, attempt);

        if (attempt < OPENF1_MAX_RETRIES - 1) {
          await wait(delay);
          lastOpenF1RequestAt = Date.now();
          continue;
        }

        throw new Error(
          "OpenF1 alcanzó temporalmente el límite de peticiones. Espera unos segundos y vuelve a comparar."
        );
      }

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

      const data = await response.json();

      if (canCache) {
        OPENF1_RESPONSE_CACHE.set(requestKey, {
          data,
          expiresAt: Date.now() + OPENF1_CACHE_TTL_MS,
        });
      }

      return data;
    }

    throw lastError || new Error("No fue posible consultar OpenF1.");
  }, live);

  OPENF1_INFLIGHT.set(requestKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    OPENF1_INFLIGHT.delete(requestKey);
  }
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


function normalizeHexColor(color) {
  const value = String(color || "").replace("#", "");
  return /^[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function mixHexColor(colorA, colorB = "#ffffff", amount = 0.38) {
  const a = normalizeHexColor(colorA);
  const b = normalizeHexColor(colorB);

  if (!a || !b) return colorA;

  const ratio = Math.max(0, Math.min(1, Number(amount)));
  const channels = [0, 2, 4].map((offset) => {
    const from = parseInt(a.slice(offset, offset + 2), 16);
    const to = parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * ratio)
      .toString(16)
      .padStart(2, "0");
  });

  return `#${channels.join("")}`;
}

function sameTeam(driverA, driverB) {
  const teamA = String(driverA?.team_name || "").trim().toLowerCase();
  const teamB = String(driverB?.team_name || "").trim().toLowerCase();

  return Boolean(teamA && teamB && teamA === teamB);
}

/*
  En tarjetas/selectores mantenemos el color oficial del equipo.
  Solo en los gráficos 1v1 diferenciamos a compañeros de equipo:
  A = color oficial sólido, B = variante más clara y discontinua.
*/
function comparisonChartStyle(driver, otherDriver, slot = "A", fallbackIndex = 0) {
  const baseColor = driverColor(driver, fallbackIndex);

  if (!sameTeam(driver, otherDriver)) {
    return {
      color: baseColor,
      dash: null,
    };
  }

  if (slot === "B") {
    return {
      color: mixHexColor(baseColor, "#ffffff", 0.42),
      dash: "10 7",
    };
  }

  return {
    color: baseColor,
    dash: null,
  };
}

const TEAM_PRIORITY = [
  "Ferrari",
  "Mercedes",
  "Red Bull Racing",
  "McLaren",
];

function teamOrder(driver) {
  const team = String(driver?.team_name || "Sin equipo");
  const priority = TEAM_PRIORITY.indexOf(team);

  return {
    team,
    priority: priority === -1 ? TEAM_PRIORITY.length : priority,
  };
}

function compareDriversByTeam(a, b) {
  const teamA = teamOrder(a);
  const teamB = teamOrder(b);

  if (teamA.priority !== teamB.priority) {
    return teamA.priority - teamB.priority;
  }

  if (teamA.priority >= TEAM_PRIORITY.length) {
    const teamCompare = teamA.team.localeCompare(teamB.team, "es", {
      sensitivity: "base",
    });

    if (teamCompare !== 0) return teamCompare;
  }

  const nameA = String(
    a?.name_acronym || a?.broadcast_name || a?.driver_number || ""
  );
  const nameB = String(
    b?.name_acronym || b?.broadcast_name || b?.driver_number || ""
  );

  return nameA.localeCompare(nameB, "es", { sensitivity: "base" });
}

/*
  Las tarjetas siempre conservan exactamente el color del equipo.
  Si hay compañeros de escudería, se distinguen SOLO en el gráfico
  mediante la forma del marcador.
*/
function paceDriverColor(driver, visibleDrivers = [], fallbackIndex = 0) {
  return driverColor(driver, fallbackIndex);
}

function paceDriverMarker(driver, visibleDrivers = []) {
  const team = String(driver?.team_name || "");
  if (!team) return "circle";

  const teammates = visibleDrivers.filter(
    (item) => String(item?.team_name || "") === team
  );

  if (teammates.length <= 1) return "circle";

  const teammateIndex = teammates.findIndex(
    (item) => Number(item.driver_number) === Number(driver?.driver_number)
  );

  const markers = ["circle", "diamond", "square", "triangle"];
  return markers[Math.max(0, teammateIndex) % markers.length];
}

function normalizeCompound(compound) {
  return String(compound || "—").toUpperCase();
}

function compoundColor(compound) {
  const key = normalizeCompound(compound);
  const colors = {
    SOFT: "#ff3b4f",
    MEDIUM: "#ffd43b",
    HARD: "#f1f3f5",
    INTERMEDIATE: "#43d17a",
    WET: "#4f8cff",
  };

  return colors[key] || "#8792a2";
}

function driverStints(stints, driverNumber) {
  const seen = new Set();

  return stints
    .filter((stint) => Number(stint.driver_number) === Number(driverNumber))
    .filter((stint) => {
      const number = Number(stint.stint_number);
      if (!Number.isFinite(number) || seen.has(number)) return false;
      seen.add(number);
      return true;
    })
    .sort((a, b) => Number(a.stint_number) - Number(b.stint_number));
}

function stintLabel(stint) {
  const number = Number(stint?.stint_number);
  const start =
    stint?.lap_start === null || stint?.lap_start === undefined
      ? null
      : Number(stint.lap_start);
  const end =
    stint?.lap_end === null || stint?.lap_end === undefined
      ? null
      : Number(stint.lap_end);
  const compound = normalizeCompound(stint?.compound);
  const laps = Number.isFinite(start)
    ? `V${start}${Number.isFinite(end) ? `–V${end}` : "+"}`
    : "vueltas sin rango";

  return `Stint ${Number.isFinite(number) ? number : "—"} · ${compound} · ${laps}`;
}

async function fetchPaceData(sessionKey, liveMode) {
  const cacheKey = String(sessionKey);

  if (!liveMode && PACE_DATA_CACHE.has(cacheKey)) {
    return PACE_DATA_CACHE.get(cacheKey);
  }

  const [laps, stints] = await Promise.all([
    openF1("laps", { session_key: sessionKey }, { live: liveMode }),
    openF1("stints", { session_key: sessionKey }, { live: liveMode }).catch(() => []),
  ]);

  const payload = {
    laps: Array.isArray(laps) ? laps : [],
    stints: Array.isArray(stints) ? stints : [],
  };

  if (!liveMode) PACE_DATA_CACHE.set(cacheKey, payload);
  return payload;
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

function isTelemetryLap(lap) {
  const duration = Number(lap?.lap_duration);
  const start = new Date(lap?.date_start || "").getTime();

  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(start) &&
    !lap?.is_pit_out_lap
  );
}

function timedLapsForDriver(laps, driverNumber) {
  return (Array.isArray(laps) ? laps : [])
    .filter(
      (lap) =>
        Number(lap.driver_number) === Number(driverNumber) &&
        isTelemetryLap(lap)
    )
    .sort((a, b) => Number(a.lap_number) - Number(b.lap_number));
}

function fastestLapForDriver(laps, driverNumber) {
  return [...timedLapsForDriver(laps, driverNumber)].sort(
    (a, b) => Number(a.lap_duration) - Number(b.lap_duration)
  )[0];
}

function lapOptionData(lap, stints, driverNumber) {
  const tyre = getCompoundForLap(stints, driverNumber, lap?.lap_number);

  return {
    lap,
    compound: normalizeCompound(tyre?.compound),
    stintNumber: tyre?.stintNumber ?? null,
    tyreAge: tyre?.tyreAge ?? null,
  };
}

function lapOptionLabel(item) {
  if (!item?.lap) return "Selecciona una vuelta";

  return `V${item.lap.lap_number} · ${formatLapTime(item.lap.lap_duration)} · ${item.compound}`;
}

function lapOptionMeta(item) {
  const bits = [];

  if (item?.stintNumber !== null && item?.stintNumber !== undefined) {
    bits.push(`Stint ${item.stintNumber}`);
  }

  if (item?.tyreAge !== null && item?.tyreAge !== undefined) {
    bits.push(`neumático ${item.tyreAge} v`);
  }

  return bits.join(" · ");
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

function lapTimeWindow(lap, allLaps = [], driverNumber, marginMs = 6500) {
  const start = new Date(lap?.date_start || "").getTime();
  const duration = Number(lap?.lap_duration) * 1000;

  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  const ownLaps = timedLapsForDriver(allLaps, driverNumber);
  const currentIndex = ownLaps.findIndex(
    (item) => Number(item.lap_number) === Number(lap.lap_number)
  );

  const nextStart =
    currentIndex >= 0 && ownLaps[currentIndex + 1]?.date_start
      ? new Date(ownLaps[currentIndex + 1].date_start).getTime()
      : null;

  const nominalEnd = start + duration;
  const safeNextEnd =
    Number.isFinite(nextStart) && nextStart > start
      ? nextStart + 1500
      : nominalEnd + marginMs;

  return {
    start,
    end: Math.max(nominalEnd + 2500, safeNextEnd),
    queryStart: start - marginMs,
    queryEnd: Math.max(nominalEnd + marginMs, safeNextEnd),
  };
}

function rowsInsideLap(rows, lap, allLaps = [], driverNumber, marginMs = 6500) {
  if (!Array.isArray(rows) || !lap?.date_start) return [];

  const window = lapTimeWindow(lap, allLaps, driverNumber, marginMs);
  if (!window) return [];

  return rows.filter((row) => {
    const timestamp = new Date(row.date).getTime();
    return (
      Number.isFinite(timestamp) &&
      timestamp >= window.queryStart &&
      timestamp <= window.queryEnd
    );
  });
}

async function fetchCarDataForLap(
  sessionKey,
  driverNumber,
  lap,
  liveMode,
  allLaps = []
) {
  const window = lapTimeWindow(lap, allLaps, driverNumber);

  if (!window) {
    throw new Error(`La vuelta V${lap?.lap_number || "—"} no tiene un rango temporal válido.`);
  }

  const narrowParams = {
    session_key: sessionKey,
    driver_number: driverNumber,
    "date>=": new Date(window.queryStart).toISOString(),
    "date<=": new Date(window.queryEnd).toISOString(),
  };

  try {
    const narrow = await openF1(
      "car_data",
      narrowParams,
      { live: liveMode }
    );

    if (Array.isArray(narrow) && narrow.length >= 18) {
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

  // Respaldo histórico: descargamos una sola vez la telemetría completa
  // del piloto para esa sesión y después recortamos localmente cada vuelta.
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

  const sliced = rowsInsideLap(fullSession, lap, allLaps, driverNumber);

  if (sliced.length < 18) {
    throw new Error(
      `OpenF1 no devolvió telemetría suficiente para ${driverNumber} en la vuelta ${lap.lap_number}. Prueba otra vuelta del selector.`
    );
  }

  return sliced;
}

function prepareTelemetry(rows, lap) {
  if (!rows?.length || !lap?.date_start) return [];

  const start = new Date(lap.date_start).getTime();
  const durationMs = Number(lap.lap_duration) * 1000;

  if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }

  const mapped = rows
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
    .filter((row) => Number.isFinite(row.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  let clean = mapped.filter(
    (row) =>
      row.timestamp >= start - 2500 &&
      row.timestamp <= start + durationMs + 3500
  );

  // date_start es aproximado en OpenF1. Si la ventana normal queda corta,
  // ampliamos únicamente como respaldo en lugar de descartar la vuelta.
  if (clean.length < 10) {
    clean = mapped.filter(
      (row) =>
        row.timestamp >= start - 10000 &&
        row.timestamp <= start + durationMs + 10000
    );
  }

  if (clean.length < 2) return [];

  let distance = 0;
  let previous = clean[0];
  const telemetryStart = clean[0].timestamp;

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
      elapsed: Math.max((row.timestamp - telemetryStart) / 1000, 0),
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
  return normalized.filter(
    (_, index) => index % step === 0 || index === normalized.length - 1
  );
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

function buildRacePace(
  laps,
  stints,
  selectedDrivers,
  filterSlow,
  stintSelection = {}
) {
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

    const tyre = getCompoundForLap(stints, driverNumber, lapNumber);
    const wantedStint = String(stintSelection[driverNumber] ?? "all");

    if (
      wantedStint !== "all" &&
      String(tyre?.stintNumber ?? "") !== wantedStint
    ) {
      return;
    }

    if (!byDriver.has(driverNumber)) byDriver.set(driverNumber, []);

    byDriver.get(driverNumber).push({
      ...lap,
      lap_duration: duration,
      lap_number: lapNumber,
      compound: normalizeCompound(tyre?.compound),
      tyreAge: tyre?.tyreAge ?? null,
      stintNumber: tyre?.stintNumber ?? null,
    });
  });

  const result = [];

  byDriver.forEach((driverLaps, driverNumber) => {
    const med = median(driverLaps.map((lap) => lap.lap_duration));
    const filtered = driverLaps.filter((lap) => {
      if (!filterSlow || med === null) return true;
      return lap.lap_duration <= med + 7;
    });

    filtered.forEach((lap) => {
      result.push({
        driverNumber,
        lapNumber: lap.lap_number,
        lapTime: lap.lap_duration,
        compound: lap.compound || "—",
        tyreAge: lap.tyreAge,
        stintNumber: lap.stintNumber,
      });
    });
  });

  return result.sort((a, b) => {
    if (a.lapNumber !== b.lapNumber) return a.lapNumber - b.lapNumber;
    return a.driverNumber - b.driverNumber;
  });
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

function TelemetrySelect({
  label,
  value,
  options,
  placeholder,
  onChange,
  disabled = false,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const selected = options.find(
    (option) => String(option.value) === String(value)
  );

  useEffect(() => {
    function handlePointerDown(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      ref={rootRef}
      className={`telemetry-field telemetry-custom-select ${className} ${open ? "open" : ""}`}
    >
      {label ? <span>{label}</span> : null}

      <button
        type="button"
        className={`telemetry-select-trigger ${!value ? "placeholder" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="telemetry-select-current">
          {selected?.color ? (
            <i
              className="telemetry-select-color"
              style={{ "--select-color": selected.color }}
              aria-hidden="true"
            />
          ) : null}

          {selected?.badge ? (
            <b className="telemetry-select-badge">{selected.badge}</b>
          ) : null}

          <span className="telemetry-select-current-copy">
            <strong>{selected?.label || placeholder}</strong>
            {selected?.meta ? <small>{selected.meta}</small> : null}
          </span>
        </span>

        <i className="telemetry-select-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="telemetry-select-menu" role="listbox">
          {options.length ? (
            options.map((option) => {
              const active = String(option.value) === String(value);

              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  key={option.value}
                  className={active ? "active" : ""}
                  onClick={() => {
                    onChange(String(option.value));
                    setOpen(false);
                  }}
                >
                  <span className="telemetry-select-option-main">
                    {option.color ? (
                      <i
                        className="telemetry-select-color"
                        style={{ "--select-color": option.color }}
                        aria-hidden="true"
                      />
                    ) : null}

                    {option.badge ? (
                      <b className="telemetry-select-badge">{option.badge}</b>
                    ) : null}

                    <span className="telemetry-select-option-copy">
                      <strong>{option.label}</strong>
                      {option.meta ? <small>{option.meta}</small> : null}
                    </span>
                  </span>

                  {active ? <em>Seleccionado</em> : null}
                </button>
              );
            })
          ) : (
            <div className="telemetry-select-empty">Sin opciones disponibles</div>
          )}
        </div>
      )}
    </div>
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
              dash: item.dash || null,
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
              <i
                className={item.dash ? "dashed" : ""}
                style={{
                  background: item.color,
                  width: item.dash ? 16 : 8,
                  height: item.dash ? 3 : 8,
                  borderRadius: item.dash ? 999 : "50%",
                }}
              />
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
                strokeDasharray={item.dash || undefined}
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
  const [hoverPoint, setHoverPoint] = useState(null);

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

  // En este gráfico los tiempos más rápidos se muestran más abajo.
  const y = (time) =>
    pad.top + ((maxTime - Number(time)) / Math.max(maxTime - minTime, 0.1)) * innerHeight;

  const yGrid = Array.from(
    { length: 6 },
    (_, index) => maxTime - ((maxTime - minTime) * index) / 5
  );

  const driverMap = new Map(
    drivers.map((driver, index) => [
      Number(driver.driver_number),
      {
        driver,
        index,
        color: paceDriverColor(driver, drivers, index),
        marker: paceDriverMarker(driver, drivers),
      },
    ])
  );

  const hoverKey = hoverPoint
    ? `${hoverPoint.driverNumber}-${hoverPoint.lapNumber}`
    : null;

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
              <i
                className={`pace-legend-marker ${paceDriverMarker(driver, drivers)}`}
                style={{ "--marker-color": paceDriverColor(driver, drivers, index) }}
              />
              {driver.name_acronym}
            </span>
          ))}
        </div>
      </div>

      <div className="pace-chart-plot">
        <svg
          className="telemetry-pace-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Ritmo de carrera por vuelta"
        >
          {yGrid.map((value, index) => (
            <g key={index}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(value)}
                y2={y(value)}
                className="telemetry-grid-line"
              />
              <text
                x={pad.left - 12}
                y={y(value) + 4}
                className="telemetry-axis-text"
                textAnchor="end"
              >
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
                <text
                  x={x(lap)}
                  y={height - 15}
                  className="telemetry-axis-text"
                  textAnchor="middle"
                >
                  V{lap}
                </text>
              </g>
            );
          })}

          {points.map((point, index) => {
            const meta = driverMap.get(Number(point.driverNumber));
            const driver = meta?.driver;
            const color = meta?.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
            const marker = meta?.marker || "circle";
            const key = `${point.driverNumber}-${point.lapNumber}`;
            const active = hoverKey === key;
            const cx = x(point.lapNumber);
            const cy = y(point.lapTime);
            const size = active ? 7.2 : 5.6;

            const hoverData = {
              ...point,
              driver,
              color,
              marker,
              chartX: cx,
              chartY: cy,
            };

            const common = {
              fill: color,
              fillOpacity: active ? 1 : 0.88,
              stroke: active ? "#ffffff" : "#050608",
              strokeWidth: active ? 2.4 : 1.8,
              className: "pace-chart-point-shape",
              pointerEvents: "none",
            };

            return (
              <g
                key={`${key}-${index}`}
                className="pace-chart-point"
                onPointerEnter={() => setHoverPoint(hoverData)}
                onPointerMove={() => setHoverPoint(hoverData)}
                onPointerLeave={() => setHoverPoint(null)}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r="11"
                  fill="transparent"
                  className="pace-chart-hit-area"
                />

                {marker === "diamond" ? (
                  <rect
                    x={cx - size}
                    y={cy - size}
                    width={size * 2}
                    height={size * 2}
                    rx="1.5"
                    transform={`rotate(45 ${cx} ${cy})`}
                    {...common}
                  />
                ) : marker === "square" ? (
                  <rect
                    x={cx - size}
                    y={cy - size}
                    width={size * 2}
                    height={size * 2}
                    rx="2"
                    {...common}
                  />
                ) : marker === "triangle" ? (
                  <polygon
                    points={`${cx},${cy - size * 1.25} ${cx - size * 1.15},${cy + size} ${cx + size * 1.15},${cy + size}`}
                    {...common}
                  />
                ) : (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={size}
                    {...common}
                  />
                )}
              </g>
            );
          })}
        </svg>

        {hoverPoint && (
          <div
            className={`pace-point-tooltip ${
              hoverPoint.chartX > width / 2 ? "dock-left" : "dock-right"
            }`}
            style={{ "--pace-point-color": hoverPoint.color }}
          >
            <div className="pace-point-tooltip-head">
              <span className="pace-point-driver">
                <i className={`pace-tooltip-marker ${hoverPoint.marker || "circle"}`} />
                <strong>{hoverPoint.driver?.name_acronym || hoverPoint.driverNumber}</strong>
              </span>
              <small>{hoverPoint.driver?.team_name || ""}</small>
            </div>

            <div className="pace-point-time">{formatLapTime(hoverPoint.lapTime)}</div>

            <div className="pace-point-details">
              <div>
                <span>Vuelta</span>
                <strong>{hoverPoint.lapNumber}</strong>
              </div>
              <div>
                <span>Stint</span>
                <strong>{hoverPoint.stintNumber ?? "—"}</strong>
              </div>
              <div>
                <span>Compuesto</span>
                <strong
                  className="pace-compound-pill"
                  style={{ "--compound-color": compoundColor(hoverPoint.compound) }}
                >
                  {normalizeCompound(hoverPoint.compound)}
                </strong>
              </div>
              <div>
                <span>Edad neumático</span>
                <strong>
                  {hoverPoint.tyreAge !== null && hoverPoint.tyreAge !== undefined
                    ? `${hoverPoint.tyreAge} v`
                    : "—"}
                </strong>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PaceAnalysis({ analysis, drivers = [] }) {
  if (!analysis) return null;

  const { reference, bestLap, consistent, stats, narrative } = analysis;

  return (
    <section className="pace-analysis">
      <div className="pace-analysis-heading">
        <div>
          <span>Lectura de ritmo</span>
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
                      style={{ background: paceDriverColor(item.driver, drivers, item.index) }}
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
  const [paceStints, setPaceStints] = useState([]);
  const [paceStintSelection, setPaceStintSelection] = useState({});
  const [loadingStints, setLoadingStints] = useState(false);

  const [lapLaps, setLapLaps] = useState([]);
  const [lapStints, setLapStints] = useState([]);
  const [lapASelection, setLapASelection] = useState("");
  const [lapBSelection, setLapBSelection] = useState("");
  const [loadingLapChoices, setLoadingLapChoices] = useState(false);

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

        // La página comienza sin GP seleccionado.
        // Así el usuario decide qué fin de semana quiere analizar.
        setMeetingKey("");
        setSessions([]);
        setSessionKey("");
      } catch (err) {
        setError(`No se pudieron cargar los Grandes Premios: ${err.message}`);
      } finally {
        setLoadingContext(false);
      }
    }

    loadMeetings();
  }, []);

  useEffect(() => {
    if (!meetingKey || liveMode) {
      if (!liveMode) {
        setSessions([]);
        setSessionKey("");
      }
      return;
    }

    async function loadSessions() {
      try {
        setLoadingContext(true);
        setError("");
        setComparison(null);
        setPacePoints([]);

        const data = await openF1("sessions", { meeting_key: meetingKey });
        const ordered = [...data].sort(sessionSort);
        setSessions(ordered);

        // Igual que con el GP, no elegimos una sesión automáticamente.
        setSessionKey("");
      } catch (err) {
        setError(`No se pudieron cargar las sesiones: ${err.message}`);
      } finally {
        setLoadingContext(false);
      }
    }

    loadSessions();
  }, [meetingKey, liveMode]);

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
          .sort(compareDriversByTeam);

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

  useEffect(() => {
    setComparison(null);
    setLapASelection("");
    setLapBSelection("");

    if (!sessionKey || mode !== "lap") {
      setLapLaps([]);
      setLapStints([]);
      setLoadingLapChoices(false);
      return undefined;
    }

    let cancelled = false;

    async function loadLapChoices() {
      try {
        setLoadingLapChoices(true);
        setError("");

        const { laps, stints } = await fetchPaceData(sessionKey, liveMode);

        if (!cancelled) {
          setLapLaps(laps);
          setLapStints(stints);
        }
      } catch (err) {
        if (!cancelled) {
          setLapLaps([]);
          setLapStints([]);
          setError(`No se pudieron cargar las vueltas de la sesión: ${err.message}`);
        }
      } finally {
        if (!cancelled) setLoadingLapChoices(false);
      }
    }

    loadLapChoices();

    return () => {
      cancelled = true;
    };
  }, [sessionKey, liveMode, mode]);

  useEffect(() => {
    setPacePoints([]);
    setPaceStintSelection({});

    if (!sessionKey || mode !== "pace") {
      setPaceStints([]);
      setLoadingStints(false);
      return undefined;
    }

    let cancelled = false;

    async function loadPaceStints() {
      try {
        setLoadingStints(true);

        const cached = !liveMode ? PACE_DATA_CACHE.get(String(sessionKey)) : null;
        const data = cached?.stints || await openF1(
          "stints",
          { session_key: sessionKey },
          { live: liveMode }
        ).catch(() => []);

        if (!cancelled) {
          setPaceStints(Array.isArray(data) ? data : []);
        }
      } finally {
        if (!cancelled) setLoadingStints(false);
      }
    }

    loadPaceStints();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, liveMode, mode]);

  async function runLapComparison({ silent = false } = {}) {
    if (!sessionKey || !driverA || !driverB) return;

    if (String(driverA) === String(driverB)) {
      setError("Selecciona dos pilotos distintos para comparar.");
      return;
    }

    if (!lapASelection || !lapBSelection) {
      setError("Selecciona una vuelta válida para cada piloto.");
      return;
    }

    try {
      if (!silent) setLoadingAnalysis(true);
      setError("");

      let laps = lapLaps;
      let stints = lapStints;

      // En LIVE actualizamos la lista justo antes de comparar.
      if (liveMode || !laps.length) {
        const latest = await fetchPaceData(sessionKey, liveMode);
        laps = latest.laps;
        stints = latest.stints;
        setLapLaps(laps);
        setLapStints(stints);
      }

      const lapA = timedLapsForDriver(laps, driverA).find(
        (lap) => String(lap.lap_number) === String(lapASelection)
      );
      const lapB = timedLapsForDriver(laps, driverB).find(
        (lap) => String(lap.lap_number) === String(lapBSelection)
      );

      if (!lapA || !lapB) {
        throw new Error(
          "Una de las vueltas seleccionadas ya no está disponible. Vuelve a elegirla en el filtro."
        );
      }

      const [carA, carB] = await Promise.all([
        fetchCarDataForLap(sessionKey, driverA, lapA, liveMode, laps),
        fetchCarDataForLap(sessionKey, driverB, lapB, liveMode, laps),
      ]);

      const pointsA = prepareTelemetry(carA, lapA);
      const pointsB = prepareTelemetry(carB, lapB);

      if (pointsA.length < 10 || pointsB.length < 10) {
        throw new Error(
          "OpenF1 no devolvió suficiente telemetría para una de las vueltas. Prueba otra vuelta del selector."
        );
      }

      setComparison({
        lapA,
        lapB,
        lapAInfo: lapOptionData(lapA, stints, driverA),
        lapBInfo: lapOptionData(lapB, stints, driverB),
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

      const { laps, stints } = await fetchPaceData(sessionKey, liveMode);
      setPaceStints(stints);

      const points = buildRacePace(
        laps,
        stints,
        paceDrivers,
        filterSlow,
        paceStintSelection
      );

      if (!points.length) {
        throw new Error(
          "No hay vueltas válidas para la combinación de pilotos y stints seleccionada."
        );
      }

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
      setPaceStints([]);
      setPaceStintSelection({});
      setLapLaps([]);
      setLapStints([]);
      setLapASelection("");
      setLapBSelection("");
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
    setPaceStints([]);
    setPaceStintSelection({});
    setLapLaps([]);
    setLapStints([]);
    setLapASelection("");
    setLapBSelection("");

    if (meetingKey) {
      setMeetingKey((current) => String(current));
    }
  }

  function togglePaceDriver(driverNumber) {
    const numeric = Number(driverNumber);
    const selected = paceDrivers.includes(numeric);

    if (!selected && paceDrivers.length >= MAX_PACE_DRIVERS) return;

    setPacePoints([]);

    if (selected) {
      setPaceDrivers((current) => current.filter((item) => item !== numeric));
      setPaceStintSelection((selection) => {
        const next = { ...selection };
        delete next[numeric];
        return next;
      });
      return;
    }

    setPaceDrivers((current) => [...current, numeric]);
    setPaceStintSelection((selection) => ({
      ...selection,
      [numeric]: selection[numeric] ?? "all",
    }));
  }

  function updatePaceStint(driverNumber, value) {
    const numeric = Number(driverNumber);
    setPaceStintSelection((current) => ({
      ...current,
      [numeric]: value,
    }));
    setPacePoints([]);
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
  }, [
    liveMode,
    autoRefresh,
    mode,
    sessionKey,
    driverA,
    driverB,
    lapASelection,
    lapBSelection,
    filterSlow,
    paceDrivers.join(","),
    paceStintSelection,
  ]);

  const driverAInfo = driverMap.get(Number(driverA));
  const driverBInfo = driverMap.get(Number(driverB));

  const driverAChartStyle = comparisonChartStyle(
    driverAInfo,
    driverBInfo,
    "A",
    0
  );

  const driverBChartStyle = comparisonChartStyle(
    driverBInfo,
    driverAInfo,
    "B",
    1
  );

  const lapChoicesA = useMemo(
    () =>
      timedLapsForDriver(lapLaps, driverA).map((lap) =>
        lapOptionData(lap, lapStints, driverA)
      ),
    [lapLaps, lapStints, driverA]
  );

  const lapChoicesB = useMemo(
    () =>
      timedLapsForDriver(lapLaps, driverB).map((lap) =>
        lapOptionData(lap, lapStints, driverB)
      ),
    [lapLaps, lapStints, driverB]
  );

  const paceDriverInfo = drivers.filter((driver) =>
    paceDrivers.includes(Number(driver.driver_number))
  );

  useEffect(() => {
    if (!driverA || !lapChoicesA.length) {
      setLapASelection("");
      return;
    }

    setLapASelection((current) => {
      if (
        lapChoicesA.some(
          (item) => String(item.lap.lap_number) === String(current)
        )
      ) {
        return current;
      }

      const fastest = [...lapChoicesA].sort(
        (a, b) => Number(a.lap.lap_duration) - Number(b.lap.lap_duration)
      )[0];

      return fastest ? String(fastest.lap.lap_number) : "";
    });
  }, [driverA, lapChoicesA]);

  useEffect(() => {
    if (!driverB || !lapChoicesB.length) {
      setLapBSelection("");
      return;
    }

    setLapBSelection((current) => {
      if (
        lapChoicesB.some(
          (item) => String(item.lap.lap_number) === String(current)
        )
      ) {
        return current;
      }

      const fastest = [...lapChoicesB].sort(
        (a, b) => Number(a.lap.lap_duration) - Number(b.lap.lap_duration)
      )[0];

      return fastest ? String(fastest.lap.lap_number) : "";
    });
  }, [driverB, lapChoicesB]);

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
          <TelemetrySelect
            label="Gran Premio"
            value={meetingKey}
            placeholder="Selecciona un Gran Premio"
            disabled={liveMode || loadingContext}
            options={meetings.map((meeting) => ({
              value: meeting.meeting_key,
              label: meetingLabel(meeting),
            }))}
            onChange={(nextMeetingKey) => {
              setMeetingKey(nextMeetingKey);
              setSessionKey("");
              setSessions([]);
              setDrivers([]);
              setDriverA("");
              setDriverB("");
              setPaceDrivers([]);
              setComparison(null);
              setPacePoints([]);
              setPaceStints([]);
              setPaceStintSelection({});
              setLapLaps([]);
              setLapStints([]);
              setLapASelection("");
              setLapBSelection("");
            }}
          />

          <TelemetrySelect
            label="Sesión"
            value={sessionKey}
            placeholder="Selecciona una sesión"
            disabled={liveMode || loadingContext || !meetingKey || !sessions.length}
            options={sessions.map((session) => ({
              value: session.session_key,
              label: `${session.session_name} · ${formatSessionDate(session.date_start)}`,
            }))}
            onChange={(nextSessionKey) => {
              setSessionKey(nextSessionKey);
              setComparison(null);
              setPacePoints([]);
              setPaceStintSelection({});
              setLapLaps([]);
              setLapStints([]);
              setLapASelection("");
              setLapBSelection("");
            }}
          />

          <div className="telemetry-context-summary">
            <span>{selectedMeeting?.country_name || "Temporada 2026"}</span>
            <strong>{selectedSession?.session_name || "Selecciona una sesión"}</strong>
            <small>{selectedSession ? formatSessionDate(selectedSession.date_start) : ""}</small>
          </div>
        </div>

        {error && <div className="telemetry-error">{error}</div>}

        {mode === "lap" ? (
          <section className="telemetry-lap-mode">
            <div className="telemetry-driver-picker two telemetry-driver-picker-rich">
              <TelemetrySelect
                label="Piloto A"
                value={driverA}
                placeholder="Selecciona piloto A"
                disabled={!drivers.length}
                className="telemetry-driver-select"
                options={drivers.map((driver, index) => ({
                  value: driver.driver_number,
                  label: driver.full_name || driver.broadcast_name || driverLabel(driver),
                  meta: driver.team_name || "Sin equipo",
                  badge: driver.name_acronym || driver.driver_number,
                  color: driverColor(driver, index),
                }))}
                onChange={(value) => {
                  setDriverA(value);
                  setLapASelection("");
                  setComparison(null);
                }}
              />

              <div className="telemetry-vs">VS</div>

              <TelemetrySelect
                label="Piloto B"
                value={driverB}
                placeholder="Selecciona piloto B"
                disabled={!drivers.length}
                className="telemetry-driver-select"
                options={drivers.map((driver, index) => ({
                  value: driver.driver_number,
                  label: driver.full_name || driver.broadcast_name || driverLabel(driver),
                  meta: driver.team_name || "Sin equipo",
                  badge: driver.name_acronym || driver.driver_number,
                  color: driverColor(driver, index),
                }))}
                onChange={(value) => {
                  setDriverB(value);
                  setLapBSelection("");
                  setComparison(null);
                }}
              />

              <button
                className="telemetry-primary-button"
                onClick={() => runLapComparison()}
                disabled={
                  loadingAnalysis ||
                  loadingLapChoices ||
                  !driverA ||
                  !driverB ||
                  !lapASelection ||
                  !lapBSelection
                }
              >
                {loadingAnalysis ? "Analizando…" : "Comparar vueltas"}
              </button>
            </div>

            {drivers.length > 0 && sessionKey && (
              <section className="lap-filter-panel">
                <div className="lap-filter-head">
                  <div>
                    <span>Filtro por vuelta</span>
                    <h3>Elige la vuelta exacta de cada piloto</h3>
                  </div>

                  <small>
                    {loadingLapChoices
                      ? "Cargando vueltas y compuestos…"
                      : "Por defecto se selecciona la vuelta cronometrada más rápida con fecha válida."}
                  </small>
                </div>

                <div className="lap-filter-grid">
                  {[{
                    key: "A",
                    driver: driverAInfo,
                    choices: lapChoicesA,
                    value: lapASelection,
                    onChange: (value) => {
                      setLapASelection(value);
                      setComparison(null);
                    },
                  }, {
                    key: "B",
                    driver: driverBInfo,
                    choices: lapChoicesB,
                    value: lapBSelection,
                    onChange: (value) => {
                      setLapBSelection(value);
                      setComparison(null);
                    },
                  }].map((item, index) => {
                    const color = driverColor(item.driver, index);
                    const selectedLap = item.choices.find(
                      (choice) => String(choice.lap.lap_number) === String(item.value)
                    );

                    return (
                      <div
                        key={item.key}
                        className="lap-filter-card"
                        style={{ "--driver-color": color }}
                      >
                        <div className="lap-filter-driver">
                          <i />
                          <div>
                            <span>Piloto {item.key}</span>
                            <strong>{item.driver?.name_acronym || "—"}</strong>
                            <small>{item.driver?.team_name || "Selecciona un piloto"}</small>
                          </div>
                        </div>

                        <TelemetrySelect
                          label="Vuelta"
                          value={item.value}
                          placeholder={
                            loadingLapChoices
                              ? "Cargando vueltas…"
                              : "Selecciona una vuelta"
                          }
                          disabled={loadingLapChoices || !item.driver || !item.choices.length}
                          className="telemetry-lap-select"
                          options={item.choices.map((choice) => ({
                            value: choice.lap.lap_number,
                            label: lapOptionLabel(choice),
                            meta: lapOptionMeta(choice),
                            badge: `V${choice.lap.lap_number}`,
                            color: compoundColor(choice.compound),
                          }))}
                          onChange={item.onChange}
                        />

                        {selectedLap ? (
                          <div className="lap-filter-summary">
                            <span
                              className="lap-compound-pill"
                              style={{ "--compound-color": compoundColor(selectedLap.compound) }}
                            >
                              {selectedLap.compound}
                            </span>
                            <strong>{formatLapTime(selectedLap.lap.lap_duration)}</strong>
                            <small>
                              Vuelta {selectedLap.lap.lap_number}
                              {selectedLap.stintNumber ? ` · Stint ${selectedLap.stintNumber}` : ""}
                              {selectedLap.tyreAge !== null ? ` · ${selectedLap.tyreAge} vueltas de neumático` : ""}
                            </small>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {comparison && (
              <>
                <div className="telemetry-metrics-grid three">
                  <MetricCard
                    label={driverAInfo?.name_acronym || "Piloto A"}
                    value={formatLapTime(comparison.lapA.lap_duration)}
                    sub={`Vuelta ${comparison.lapA.lap_number} · ${comparison.lapAInfo?.compound || "—"} · ${driverAInfo?.team_name || ""}`}
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
                    sub={`Vuelta ${comparison.lapB.lap_number} · ${comparison.lapBInfo?.compound || "—"} · ${driverBInfo?.team_name || ""}`}
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
                      color: driverAChartStyle.color,
                      dash: driverAChartStyle.dash,
                      points: comparison.pointsA,
                    },
                    {
                      label: driverBInfo?.name_acronym || "B",
                      color: driverBChartStyle.color,
                      dash: driverBChartStyle.dash,
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
                      color: driverAChartStyle.color,
                      dash: driverAChartStyle.dash,
                      points: comparison.pointsA,
                    },
                    {
                      label: driverBInfo?.name_acronym || "B",
                      color: driverBChartStyle.color,
                      dash: driverBChartStyle.dash,
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
                      color: driverAChartStyle.color,
                      dash: driverAChartStyle.dash,
                      points: comparison.pointsA,
                    },
                    {
                      label: driverBInfo?.name_acronym || "B",
                      color: driverBChartStyle.color,
                      dash: driverBChartStyle.dash,
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
                    onChange={(event) => {
                      setFilterSlow(event.target.checked);
                      setPacePoints([]);
                    }}
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
                const color = driverColor(driver, index);

                return (
                  <button
                    key={driver.driver_number}
                    className={`pace-driver-chip ${selected ? "selected" : ""}`}
                    style={{ "--driver-color": color }}
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

            {paceDriverInfo.length > 0 && (
              <section className="pace-stint-panel">
                <div className="pace-stint-head">
                  <div>
                    <span>Filtro por stint</span>
                    <h3>Elige qué tramo comparar de cada piloto</h3>
                  </div>
                  <small>
                    {loadingStints
                      ? "Cargando compuestos y stints…"
                      : paceStints.length
                      ? "Puedes comparar stints distintos entre pilotos."
                      : "Esta sesión no devuelve información de stints; se usarán todas las vueltas."}
                  </small>
                </div>

                <div className="pace-stint-grid">
                  {paceDriverInfo.map((driver, index) => {
                    const number = Number(driver.driver_number);
                    const stints = driverStints(paceStints, number);
                    const selectedStint = String(paceStintSelection[number] ?? "all");
                    const color = driverColor(driver, index);

                    return (
                      <div
                        key={driver.driver_number}
                        className="pace-stint-card"
                        style={{ "--driver-color": color }}
                      >
                        <div className="pace-stint-driver">
                          <i />
                          <div>
                            <strong>{driver.name_acronym}</strong>
                            <small>{driver.team_name}</small>
                          </div>
                        </div>

                        <TelemetrySelect
                          label=""
                          value={selectedStint}
                          placeholder="Selecciona un stint"
                          disabled={!stints.length}
                          className="pace-stint-select"
                          options={[
                            {
                              value: "all",
                              label: "Todos los stints",
                              meta: stints.length
                                ? `${stints.length} stints disponibles`
                                : "Sin información de stints",
                            },
                            ...stints.map((stint) => ({
                              value: String(stint.stint_number),
                              label: stintLabel(stint),
                              meta:
                                stint.tyre_age_at_start !== null &&
                                stint.tyre_age_at_start !== undefined
                                  ? `Neumático inicia con ${stint.tyre_age_at_start} vueltas`
                                  : "",
                              badge: `S${stint.stint_number}`,
                              color: compoundColor(stint.compound),
                            })),
                          ]}
                          onChange={(value) =>
                            updatePaceStint(driver.driver_number, value)
                          }
                        />

                        {selectedStint !== "all" && stints.length > 0 && (() => {
                          const active = stints.find(
                            (stint) => String(stint.stint_number) === selectedStint
                          );
                          return active ? (
                            <span
                              className="pace-stint-compound"
                              style={{ "--compound-color": compoundColor(active.compound) }}
                            >
                              {normalizeCompound(active.compound)}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

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
                        sub={`Mediana · mejor ${formatLapTime(best)} · ${
                          String(paceStintSelection[driver.driver_number] ?? "all") === "all"
                            ? "todos los stints"
                            : `stint ${paceStintSelection[driver.driver_number]}`
                        }`}
                        accent={paceDriverColor(driver, paceDriverInfo, index)}
                      />
                    );
                  })}
                </div>

                <PaceAnalysis analysis={paceAnalysis} drivers={paceDriverInfo} />
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
