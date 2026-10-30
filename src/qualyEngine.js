import { matchedTrackEvolution, normalizePredictedGaps } from "./qualySignals.js";

const OPENF1 = "/api/openf1";
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const YEARS = [2025, 2026];
const TRAINING_EVENTS = 10;
const REQUEST_GAP_MS = 2100;
const CACHE_TTL_MS = 30 * 60 * 1000;
const FEATURE_KEYS = [
  "qualyPaceGap",
  "theoreticalGap",
  "practicePosition",
  "shortRunConfidence",
  "longRunGap",
  "teammateDelta",
  "trackEvolutionExposure",
  "driverFormGap",
  "teamFormGap",
  "teamTrend",
  "trackFitGap",
  "driverFormPosition",
  "practiceCoverage",
  "qualyPriorStrength",
  "qualyPriorPosition",
  "qualyPriorMomentum",
  "latestQualyGap",
  "latestTheoreticalGap",
  "shortRunSpread",
  "topSpeedDeficit",
];

const RANK_FEATURE_KEYS = [
  "qualyPaceGap",
  "theoreticalGap",
  "practicePosition",
  "shortRunConfidence",
  "teammateDelta",
  "driverFormGap",
  "teamFormGap",
  "teamTrend",
  "trackFitGap",
  "driverFormPosition",
  "practiceCoverage",
  "qualyPriorStrength",
  "qualyPriorPosition",
  "qualyPriorMomentum",
  "latestQualyGap",
  "latestTheoreticalGap",
  "shortRunSpread",
  "topSpeedDeficit",
];

const TRACK_PROFILES = {
  "albert park": "balanced",
  shanghai: "balanced",
  suzuka: "high_speed",
  miami: "balanced",
  "gilles villeneuve": "power",
  monaco: "downforce",
  catalunya: "balanced",
  "red bull ring": "power",
  silverstone: "high_speed",
  "spa-francorchamps": "high_speed",
  hungaroring: "downforce",
  zandvoort: "downforce",
  monza: "power",
  baku: "power",
  "marina bay": "downforce",
  americas: "balanced",
  "hermanos rodriguez": "power",
  interlagos: "balanced",
  "las vegas": "power",
  losail: "high_speed",
  "yas marina": "balanced",
  jeddah: "high_speed",
  bahrain: "balanced",
  madring: "balanced",
  sepang: "balanced",
  portimao: "balanced",
  istanbul: "high_speed",
};

const PROFILE_LABELS = {
  power: "Alta velocidad / potencia",
  high_speed: "Curvas rápidas",
  downforce: "Alta carga",
  balanced: "Equilibrado",
};

const RESPONSE_CACHE = new Map();
const QUALY_HISTORY_CACHE = new Map();
const INFLIGHT = new Map();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function safeNumber(value, fallback = null) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    typeof value === "boolean"
  ) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function plausibleLapTime(value) {
  const parsed = safeNumber(value);
  return parsed !== null && parsed >= 35 && parsed <= 240;
}

function plausibleGap(value) {
  return Number.isFinite(value) && value >= 0 && value <= 6;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values, fallback = null) {
  const valid = (values || []).map((value) => safeNumber(value)).filter(Number.isFinite);
  if (!valid.length) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values, fallback = null) {
  const valid = (values || []).map((value) => safeNumber(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return fallback;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
}

function lastFinite(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const parsed = safeNumber(value[index]);
      if (plausibleLapTime(parsed)) return parsed;
    }
    return null;
  }
  return safeNumber(value);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function createQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  });
  return query.toString();
}

async function queuedFetch(url) {
  const task = requestQueue.then(async () => {
    const delay = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (delay) await wait(delay);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url);
      lastRequestAt = Date.now();

      if (response.status === 429 && attempt < 2) {
        const retryAfter = safeNumber(response.headers.get("Retry-After"));
        await wait(retryAfter ? Math.max(1000, retryAfter * 1000) : 900 * (attempt + 1));
        continue;
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(
            "OpenF1 está limitando temporalmente las consultas. GridPulse redujo el ritmo de peticiones; vuelve a generar la predicción en unos segundos."
          );
        }

        let detail = "";
        try {
          const payload = await response.json();
          detail = payload && payload.error ? payload.error : "";
        } catch {
          // Respuesta no JSON.
        }

        throw new Error(detail || "OpenF1 respondió " + response.status);
      }

      return response.json();
    }

    throw new Error("OpenF1 alcanzó temporalmente el límite de peticiones.");
  });

  requestQueue = task.catch(() => undefined);
  return task;
}

async function openF1(endpoint, params, optional) {
  const query = createQuery(params);
  const url =
    OPENF1 +
    "?endpoint=" +
    encodeURIComponent(endpoint) +
    (query ? "&" + query : "");
  const cached = RESPONSE_CACHE.get(url);

  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (INFLIGHT.has(url)) return INFLIGHT.get(url);

  const promise = queuedFetch(url)
    .then((data) => {
      RESPONSE_CACHE.set(url, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return data;
    })
    .catch((error) => {
      if (optional) return [];
      throw error;
    })
    .finally(() => INFLIGHT.delete(url));

  INFLIGHT.set(url, promise);
  return promise;
}


async function fetchSeasonQualifying(year) {
  const cacheKey = String(year);
  const cached = QUALY_HISTORY_CACHE.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const response = await fetch(
    JOLPICA + "/" + year + "/qualifying.json?limit=2000"
  );

  if (!response.ok) {
    throw new Error(
      "No fue posible recuperar el historial de clasificación de " + year + "."
    );
  }

  const payload = await response.json();
  const races =
    payload &&
    payload.MRData &&
    payload.MRData.RaceTable &&
    Array.isArray(payload.MRData.RaceTable.Races)
      ? payload.MRData.RaceTable.Races
      : [];

  QUALY_HISTORY_CACHE.set(cacheKey, {
    data: races,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return races;
}

async function loadQualifyingHistory() {
  const groups = [];

  for (const year of YEARS) {
    try {
      groups.push(...(await fetchSeasonQualifying(year)));
    } catch {
      // El predictor puede seguir funcionando sin este prior.
    }
  }

  return groups;
}

function raceStartTimestamp(race) {
  if (!race || !race.date) return null;

  const value =
    race.date +
    (race.time ? "T" + race.time : "T12:00:00Z");

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildQualyPriors(races, cutoffTimestamp, season = null) {
  const usable = (races || [])
    .map((race) => ({
      ...race,
      timestamp: raceStartTimestamp(race),
    }))
    .filter(
      (race) =>
        Number.isFinite(race.timestamp) &&
        race.timestamp < cutoffTimestamp &&
        (season == null || !Number.isFinite(Number(season)) ||
          Number(race.season) === Number(season)) &&
        Array.isArray(race.QualifyingResults)
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-14);

  const history = new Map();

  usable.forEach((race) => {
    const results = (race.QualifyingResults || [])
      .map((result) => ({
        code:
          result &&
          result.Driver &&
          result.Driver.code
            ? String(result.Driver.code).toUpperCase()
            : null,
        position: safeNumber(result && result.position),
        constructor:
          result &&
          result.Constructor &&
          (result.Constructor.constructorId || result.Constructor.name)
            ? String(
                result.Constructor.constructorId || result.Constructor.name
              )
            : null,
      }))
      .filter(
        (result) =>
          result.code &&
          Number.isFinite(result.position) &&
          result.position >= 1 &&
          result.position <= 30
      );

    const teamGroups = new Map();

    results.forEach((result) => {
      if (!result.constructor) return;
      if (!teamGroups.has(result.constructor)) {
        teamGroups.set(result.constructor, []);
      }
      teamGroups.get(result.constructor).push(result);
    });

    results.forEach((result) => {
      if (!history.has(result.code)) history.set(result.code, []);

      const teammate = result.constructor
        ? (teamGroups.get(result.constructor) || [])
            .filter((item) => item.code !== result.code)
            .sort(
              (a, b) =>
                Math.abs(a.position - result.position) -
                Math.abs(b.position - result.position)
            )[0]
        : null;

      history.get(result.code).push({
        position: result.position,
        teammateDelta: teammate
          ? teammate.position - result.position
          : null,
        timestamp: race.timestamp,
      });
    });
  });

  const priors = new Map();

  history.forEach((entries, code) => {
    const recent = entries.slice(-10);
    if (!recent.length) return;

    let weightSum = 0;
    let scoreSum = 0;
    let positionSum = 0;
    let poleWeight = 0;
    let frontRowWeight = 0;
    let q3Weight = 0;
    let teammateWeight = 0;
    let teammateWins = 0;
    let teammateDeltaSum = 0;

    recent.forEach((entry, index) => {
      const age = recent.length - 1 - index;
      const weight = Math.pow(0.78, age);
      const positionScore = clamp(
        1 - (entry.position - 1) / 19,
        0,
        1
      );

      const eventScore =
        positionScore * 0.72 +
        (entry.position <= 10 ? 0.1 : 0) +
        (entry.position <= 2 ? 0.1 : 0) +
        (entry.position === 1 ? 0.08 : 0);

      weightSum += weight;
      scoreSum += eventScore * weight;
      positionSum += entry.position * weight;

      if (entry.position === 1) poleWeight += weight;
      if (entry.position <= 2) frontRowWeight += weight;
      if (entry.position <= 10) q3Weight += weight;

      if (Number.isFinite(entry.teammateDelta)) {
        teammateWeight += weight;
        teammateDeltaSum += entry.teammateDelta * weight;
        if (entry.teammateDelta > 0) teammateWins += weight;
      }
    });

    const lastThree = recent.slice(-3);
    const previousThree = recent.slice(-6, -3);

    const scoreOf = (entry) => {
      const positionScore = clamp(
        1 - (entry.position - 1) / 19,
        0,
        1
      );

      return (
        positionScore * 0.72 +
        (entry.position <= 10 ? 0.1 : 0) +
        (entry.position <= 2 ? 0.1 : 0) +
        (entry.position === 1 ? 0.08 : 0)
      );
    };

    const momentum =
      previousThree.length >= 2
        ? average(lastThree.map(scoreOf), 0.5) -
          average(previousThree.map(scoreOf), 0.5)
        : 0;

    const rawStrength =
      weightSum > 0 ? scoreSum / weightSum : 0.5;

    const sampleConfidence = clamp(recent.length / 6, 0.35, 1);
    const teammateStrength =
      teammateWeight > 0
        ? clamp(
            0.5 +
              (teammateDeltaSum / teammateWeight) / 12 +
              (teammateWins / teammateWeight - 0.5) * 0.18,
            0,
            1
          )
        : 0.5;

    const strength = clamp(
      (
        rawStrength * 0.82 +
        teammateStrength * 0.1 +
        clamp(0.5 + momentum, 0, 1) * 0.08
      ) *
        sampleConfidence +
        0.5 * (1 - sampleConfidence),
      0,
      1
    );

    priors.set(code, {
      events: recent.length,
      strength,
      weightedPosition:
        weightSum > 0 ? positionSum / weightSum : null,
      poleRate: weightSum > 0 ? poleWeight / weightSum : 0,
      frontRowRate:
        weightSum > 0 ? frontRowWeight / weightSum : 0,
      q3Rate: weightSum > 0 ? q3Weight / weightSum : 0,
      teammateWinRate:
        teammateWeight > 0 ? teammateWins / teammateWeight : null,
      teammateDelta:
        teammateWeight > 0
          ? teammateDeltaSum / teammateWeight
          : null,
      momentum,
    });
  });

  return priors;
}

function attachQualyPriors(rows, priors) {
  return (rows || []).map((row) => {
    const code =
      row &&
      row.driver &&
      row.driver.name_acronym
        ? String(row.driver.name_acronym).toUpperCase()
        : null;

    const prior = code ? priors.get(code) || null : null;
    const fallbackPosition = Number.isFinite(row.driverFormPosition)
      ? row.driverFormPosition
      : 0.525;

    return {
      ...row,
      qualyPrior: prior,
      qualyPriorStrength:
        prior && Number.isFinite(prior.strength)
          ? prior.strength
          : 0.5,
      qualyPriorPosition:
        prior && Number.isFinite(prior.weightedPosition)
          ? clamp(prior.weightedPosition / 20, 0, 1.5)
          : fallbackPosition,
      qualyPriorMomentum:
        prior && Number.isFinite(prior.momentum)
          ? clamp(prior.momentum, -0.5, 0.5)
          : 0,
    };
  });
}

function calibrateWithQualyPrior(predictions) {
  const rows = predictions || [];
  const strengths = rows
    .map((row) => row.qualyPrior && row.qualyPrior.strength)
    .filter(Number.isFinite);

  if (!strengths.length) return rows;

  const bestStrength = Math.max(...strengths);
  const medianStrength = median(strengths, 0.5);

  return rows.map((row) => {
    const prior = row.qualyPrior;
    const strength =
      prior && Number.isFinite(prior.strength)
        ? prior.strength
        : medianStrength;

    const priorGap = clamp(
      (bestStrength - strength) * 1.35,
      0,
      1.4
    );

    const practiceConfidence = clamp(
      row.shortRunConfidence || 0.45,
      0.15,
      1
    );

    if (!prior || prior.events < 1) return row;

    const priorReliability =
      prior && Number.isFinite(prior.events)
        ? clamp(prior.events / 6, 0, 1)
        : 0;

    const historyWeight = priorReliability * clamp(
      0.16 +
        priorReliability * 0.08 +
        (1 - practiceConfidence) * 0.14,
      0.18,
      0.38
    );

    const calibrated =
      row.predictedGap * (1 - historyWeight) +
      priorGap * historyWeight;

    return {
      ...row,
      prePriorGap: row.predictedGap,
      qualyPriorGap: priorGap,
      qualyPriorWeight: historyWeight,
      predictedGap: clamp(calibrated, 0, 4.5),
    };
  });
}

function trackProfile(meeting) {
  const text = normalizeText([
    meeting && meeting.circuit_short_name,
    meeting && meeting.location,
    meeting && meeting.country_name,
  ].filter(Boolean).join(" "));

  const found = Object.entries(TRACK_PROFILES).find(([name]) =>
    text.includes(normalizeText(name))
  );

  return found ? found[1] : "balanced";
}


function practiceSessionWeight(name, index, total) {
  if (total <= 1) return 1;
  if (/Practice 3/i.test(name || "")) return 1;
  if (/Practice 2/i.test(name || "")) return 0.55;
  if (/Practice 1/i.test(name || "")) return 0.25;
  return 0.35 + (index / Math.max(1, total - 1)) * 0.55;
}

function circuitKey(meeting) {
  return normalizeText(
    (meeting && meeting.circuit_short_name) ||
      (meeting && meeting.location) ||
      (meeting && meeting.country_name) ||
      ""
  );
}

function groupMeetings(sessions) {
  const map = new Map();

  (sessions || []).forEach((session) => {
    const key = Number(session.meeting_key);
    if (!Number.isFinite(key)) return;

    if (!map.has(key)) {
      map.set(key, {
        meeting_key: key,
        year: Number(session.year),
        country_name: session.country_name,
        country_code: session.country_code,
        location: session.location,
        circuit_short_name: session.circuit_short_name,
        sessions: [],
      });
    }

    map.get(key).sessions.push(session);
  });

  return [...map.values()]
    .map((meeting) => {
      const sessionsSorted = [...meeting.sessions].sort(
        (a, b) => new Date(a.date_start) - new Date(b.date_start)
      );

      return {
        ...meeting,
        sessions: sessionsSorted,
        startDate: Math.min(
          ...sessionsSorted.map((item) => new Date(item.date_start).getTime())
        ),
      };
    })
    .sort((a, b) => a.startDate - b.startDate);
}

function qualifyingSession(meeting) {
  return (meeting && meeting.sessions || []).find(
    (session) =>
      session.session_name === "Qualifying" ||
      (session.session_type === "Qualifying" &&
        !/sprint/i.test(session.session_name || ""))
  );
}

function practicesBeforeQualy(meeting, target = false) {
  const qualifying = qualifyingSession(meeting);
  const qualifyingStart = qualifying
    ? new Date(qualifying.date_start).getTime()
    : Infinity;

  return (meeting && meeting.sessions || [])
    .filter(
      (session) =>
        session.session_type === "Practice" &&
        !session.is_cancelled &&
        new Date(session.date_end).getTime() < qualifyingStart &&
        (!target || new Date(session.date_end).getTime() <= Date.now())
    )
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
}

function cleanResults(rows) {
  return (rows || [])
    .filter((row) => !row.dns && !row.dsq)
    .map((row) => ({
      ...row,
      durationValue: lastFinite(row.duration),
      phaseCount: Array.isArray(row.duration)
        ? row.duration
            .map((value) => safeNumber(value))
            .filter(plausibleLapTime).length
        : plausibleLapTime(row.duration)
          ? 1
          : 0,
      positionValue: safeNumber(row.position),
      lapsValue: safeNumber(row.number_of_laps, 0),
    }))
    .filter(
      (row) =>
        plausibleLapTime(row.durationValue) &&
        Number.isFinite(row.positionValue) &&
        row.positionValue >= 1 &&
        row.positionValue <= 30
    );
}

function stintForLap(stints, driverNumber, lapNumber) {
  return (stints || []).find(
    (stint) =>
      Number(stint.driver_number) === Number(driverNumber) &&
      Number(lapNumber) >= Number(stint.lap_start) &&
      Number(lapNumber) <= Number(stint.lap_end)
  );
}

function compoundWeight(compound) {
  const value = String(compound || "").toUpperCase();
  if (value === "SOFT") return 1;
  if (value === "MEDIUM") return 0.7;
  if (value === "HARD") return 0.45;
  if (value === "INTERMEDIATE") return 0.32;
  if (value === "WET") return 0.2;
  return 0.5;
}

function estimateTrackEvolution(laps, session, stints = []) {
  return matchedTrackEvolution(laps, stints, session);
}

function analyzePracticeSession(session, laps, stints, drivers) {
  const driverInfo = new Map(
    (drivers || []).map((driver) => [Number(driver.driver_number), driver])
  );

  const sessionStart = new Date(session.date_start).getTime();
  const sessionEnd = new Date(session.date_end).getTime();
  const sessionDuration = Math.max(1, sessionEnd - sessionStart);
  const evolution = estimateTrackEvolution(laps, session, stints);

  const clean = (laps || [])
    .filter(
      (lap) =>
        !lap.is_pit_out_lap &&
        plausibleLapTime(lap.lap_duration) &&
        Number.isFinite(safeNumber(lap.driver_number)) &&
        Number.isFinite(safeNumber(lap.lap_number)) &&
        Number.isFinite(Date.parse(lap.date_start))
    )
    .map((lap) => {
      const driverNumber = Number(lap.driver_number);
      const lapNumber = Number(lap.lap_number);
      const stint = stintForLap(stints, driverNumber, lapNumber);
      const start = safeNumber(stint && stint.lap_start, lapNumber);
      const end = safeNumber(stint && stint.lap_end, lapNumber);
      const stintLength = Math.max(1, end - start + 1);
      const tyreAge =
        safeNumber(stint && stint.tyre_age_at_start, 0) +
        Math.max(0, lapNumber - start);
      const progress = clamp(
        (new Date(lap.date_start).getTime() - sessionStart) / sessionDuration,
        0,
        1
      );

      return {
        ...lap,
        driverNumber,
        lapNumber,
        lapDuration: Number(lap.lap_duration),
        stint,
        stintLength,
        tyreAge,
        compound: String(stint && stint.compound || "UNKNOWN").toUpperCase(),
        progress,
        adjustedDuration:
          Number(lap.lap_duration) - evolution * (1 - progress),
        speedTrap: safeNumber(lap.st_speed),
      };
    });

  if (!clean.length) {
    return {
      session,
      evolution,
      byDriver: new Map(),
      leaderQualy: null,
      leaderLongRun: null,
      wetLapShare: 0,
    };
  }

  const wetLaps = clean.filter(
    (lap) =>
      lap.compound === "INTERMEDIATE" ||
      lap.compound === "WET"
  ).length;
  const wetLapShare = wetLaps / clean.length;

  // A mixed session must not compare a wet lap with the dry field.
  const dryDrivers = new Set(clean.filter(lap => ["SOFT", "MEDIUM", "HARD"].includes(lap.compound)).map(lap => lap.driverNumber));
  const representativeLaps = dryDrivers.size >= Math.max(3, driverInfo.size / 2)
    ? clean.filter(lap => !["INTERMEDIATE", "WET"].includes(lap.compound))
    : clean;
  const grouped = new Map();

  representativeLaps.forEach((lap) => {
    if (!grouped.has(lap.driverNumber)) grouped.set(lap.driverNumber, []);
    grouped.get(lap.driverNumber).push(lap);
  });

  const raw = new Map();

  grouped.forEach((driverLaps, driverNumber) => {
    const ordered = [...driverLaps].sort((a, b) => a.lapNumber - b.lapNumber);
    const fastest = Math.min(...ordered.map((lap) => lap.adjustedDuration));

    const sectorPool = ordered.filter(
      (lap) =>
        lap.adjustedDuration <= fastest * 1.06 &&
        lap.tyreAge <= 5 &&
        ["SOFT", "MEDIUM", "UNKNOWN"].includes(lap.compound)
    );

    const sector1 = sectorPool
      .map((lap) => safeNumber(lap.duration_sector_1))
      .filter(value => Number.isFinite(value) && value > 0);
    const sector2 = sectorPool
      .map((lap) => safeNumber(lap.duration_sector_2))
      .filter(value => Number.isFinite(value) && value > 0);
    const sector3 = sectorPool
      .map((lap) => safeNumber(lap.duration_sector_3))
      .filter(value => Number.isFinite(value) && value > 0);

    const sectorSum =
      sector1.length && sector2.length && sector3.length
        ? Math.min(...sector1) + Math.min(...sector2) + Math.min(...sector3)
        : fastest;

    const theoreticalDuration = plausibleLapTime(sectorSum) && sectorSum >= fastest * 0.97
      ? Math.min(sectorSum, fastest) : fastest;

    let candidates = ordered.filter((lap) => {
      const shortRun = Boolean(lap.stint) && lap.stintLength <= 4;
      const suitableTyre =
        lap.compound === "SOFT" ||
        (lap.compound === "MEDIUM" && lap.tyreAge <= 2);

      return (
        Boolean(lap.stint) &&
        ["SOFT", "MEDIUM", "HARD"].includes(lap.compound) &&
        lap.adjustedDuration <= fastest * 1.018 &&
        lap.tyreAge <= 4 &&
        (shortRun || suitableTyre)
      );
    });

    const hasQualyRun = candidates.length > 0;
    if (!candidates.length) {
      candidates = [...ordered]
        .sort((a, b) => a.adjustedDuration - b.adjustedDuration)
        .slice(0, 2);
    }

    const qualyLap = [...candidates].sort((a, b) => {
      const scoreA =
        a.adjustedDuration +
        (1 - compoundWeight(a.compound)) * 0.35 +
        Math.max(0, a.tyreAge - 1) * 0.05 +
        Math.max(0, a.stintLength - 4) * 0.035;

      const scoreB =
        b.adjustedDuration +
        (1 - compoundWeight(b.compound)) * 0.35 +
        Math.max(0, b.tyreAge - 1) * 0.05 +
        Math.max(0, b.stintLength - 4) * 0.035;

      return scoreA - scoreB;
    })[0];

    const shortRunDurations = [...candidates]
      .map((lap) => lap.adjustedDuration)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
      .slice(0, 3);

    const shortRunSpread =
      shortRunDurations.length >= 2
        ? median(
            shortRunDurations,
            shortRunDurations[0]
          ) - shortRunDurations[0]
        : 0.35;

    const rawShortRunConfidence = qualyLap
      ? clamp(
          0.18 +
            compoundWeight(qualyLap.compound) * 0.42 +
            (qualyLap.tyreAge <= 1 ? 0.18 : qualyLap.tyreAge <= 3 ? 0.1 : 0) +
            (qualyLap.stintLength <= 4 ? 0.22 : 0.05),
          0.15,
          1
        )
      : 0.15;

    const shortRunConfidence = Math.min(rawShortRunConfidence,
      !qualyLap?.stint ? 0.25 : !hasQualyRun ? 0.35 :
      qualyLap.compound === "HARD" ? 0.5 : qualyLap.compound === "MEDIUM" ? 0.72 : 1);

    const longStintGroups = new Map();

    ordered.forEach((lap) => {
      if (!lap.stint || lap.stintLength < 5) return;
      const key = String(lap.stint.stint_number || lap.stint.lap_start || 0);
      if (!longStintGroups.has(key)) longStintGroups.set(key, []);
      longStintGroups.get(key).push(lap);
    });

    const longRunCandidates = [];

    longStintGroups.forEach((stintLaps) => {
      if (stintLaps.length < 4) return;

      const sorted = [...stintLaps].sort((a, b) => a.lapNumber - b.lapNumber);
      const middle = sorted.length > 5 ? sorted.slice(1, -1) : sorted;
      const med = median(middle.map((lap) => lap.lapDuration), null);
      if (!Number.isFinite(med)) return;

      const representative = middle
        .filter((lap) => lap.lapDuration <= med * 1.04)
        .map((lap) => lap.lapDuration);

      if (representative.length >= 3) {
        longRunCandidates.push(median(representative, med));
      }
    });

    raw.set(driverNumber, {
      driverNumber,
      driver: driverInfo.get(driverNumber),
      qualyDuration: qualyLap ? qualyLap.adjustedDuration : fastest,
      qualyRawDuration: qualyLap ? qualyLap.lapDuration : fastest,
      theoreticalDuration,
      selectedProgress: qualyLap ? qualyLap.progress : 0.5,
      selectedCompound: qualyLap ? qualyLap.compound : "UNKNOWN",
      selectedTyreAge: qualyLap ? qualyLap.tyreAge : null,
      selectedStintLength: qualyLap ? qualyLap.stintLength : null,
      shortRunConfidence,
      shortRunSpread: clamp(shortRunSpread, 0, 2),
      longRunDuration: longRunCandidates.length
        ? Math.min(...longRunCandidates)
        : null,
      cleanLaps: ordered.length,
      topSpeed: Math.max(
        ...ordered.map((lap) => lap.speedTrap || 0)
      ),
    });
  });

  const qualyValues = [...raw.values()]
    .map((item) => item.qualyDuration)
    .filter(plausibleLapTime);
  const rawQualyValues = [...raw.values()]
    .map((item) => item.qualyRawDuration)
    .filter(plausibleLapTime);
  const theoreticalValues = [...raw.values()]
    .map((item) => item.theoreticalDuration)
    .filter(plausibleLapTime);
  const longRunValues = [...raw.values()]
    .map((item) => item.longRunDuration)
    .filter(Number.isFinite);

  const leaderQualy = qualyValues.length ? Math.min(...qualyValues) : null;
  const leaderRawQualy = rawQualyValues.length
    ? Math.min(...rawQualyValues)
    : null;
  const leaderTheoretical = theoreticalValues.length
    ? Math.min(...theoreticalValues)
    : leaderQualy;
  const leaderLongRun = longRunValues.length ? Math.min(...longRunValues) : null;

  const byDriver = new Map();

  raw.forEach((item, driverNumber) => {
    byDriver.set(driverNumber, {
      ...item,
      qualyGap:
        Number.isFinite(leaderQualy) && Number.isFinite(item.qualyDuration)
          ? Math.max(0, item.qualyDuration - leaderQualy)
          : null,
      theoreticalGap:
        Number.isFinite(leaderTheoretical) &&
        Number.isFinite(item.theoreticalDuration)
          ? Math.max(0, item.theoreticalDuration - leaderTheoretical)
          : null,
      longRunGap:
        Number.isFinite(leaderLongRun) && Number.isFinite(item.longRunDuration)
          ? Math.max(0, item.longRunDuration - leaderLongRun)
          : null,
      trackEvolutionExposure:
        evolution * Math.max(0, 1 - item.selectedProgress),
      teammateDelta: 0,
    });
  });

  const teams = new Map();

  byDriver.forEach((item) => {
    const team = item.driver && item.driver.team_name;
    if (!team) return;
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(item);
  });

  teams.forEach((items) => {
    if (items.length < 2) return;

    items.forEach((item) => {
      const teammate = items
        .filter((other) => other.driverNumber !== item.driverNumber)
        .sort((a, b) => a.qualyGap - b.qualyGap)[0];

      if (teammate && Number.isFinite(teammate.qualyGap)) {
        item.teammateDelta = item.qualyGap - teammate.qualyGap;
      }
    });
  });

  return {
    session,
    evolution,
    byDriver,
    leaderQualy,
    leaderRawQualy,
    leaderTheoretical,
    leaderLongRun,
    wetLapShare,
  };
}

async function loadBundle(meeting, target) {
  const practices = practicesBeforeQualy(meeting, !!target);
  const qualifying = qualifyingSession(meeting);

  if (!practices.length || !qualifying) {
    throw new Error(
      target
        ? "Este GP todavía no tiene una práctica utilizable antes de clasificación."
        : "Fin de semana histórico incompleto."
    );
  }

  const latestPractice = practices[practices.length - 1];
  const drivers = await openF1(
    "drivers",
    { session_key: latestPractice.session_key },
    false
  );

  let meetingStints = [];

  try {
    meetingStints = await openF1(
      "stints",
      { meeting_key: meeting.meeting_key },
      false
    );
  } catch {
    meetingStints = [];
  }

  const analyses = [];

  for (const practice of practices) {
    const sessionKey = Number(practice.session_key);
    const laps = await openF1(
      "laps",
      { session_key: sessionKey },
      false
    );

    let stints = (meetingStints || []).filter(
      (stint) => Number(stint.session_key) === sessionKey
    );

    if (!stints.length) {
      stints = await openF1(
        "stints",
        { session_key: sessionKey },
        true
      );
    }

    const analysis = analyzePracticeSession(
      practice,
      laps,
      stints,
      drivers
    );

    if (analysis.byDriver.size > 0) {
      analyses.push(analysis);
    }
  }

  if (!analyses.length) {
    throw new Error(
      "No se encontraron vueltas de práctica utilizables para " +
        meeting.country_name +
        "."
    );
  }

  const qualifyingFinished =
    new Date(qualifying.date_end).getTime() <= Date.now();

  const qualifyingRows =
    qualifyingFinished || !target
      ? cleanResults(
          await openF1(
            "session_result",
            { session_key: qualifying.session_key },
            !!target
          )
        )
      : [];

  if (!target && qualifyingRows.length < 10) {
    throw new Error(
      "La clasificación histórica de " +
        meeting.country_name +
        " está incompleta."
    );
  }

  return {
    meeting,
    practices,
    practice: latestPractice,
    practiceAnalyses: analyses,
    qualifying,
    qualifyingRows,
    drivers,
    profile: trackProfile(meeting),
  };
}

async function loadPoleReference(meeting) {
  const practices = practicesBeforeQualy(meeting, false);
  const qualifying = qualifyingSession(meeting);

  if (!practices.length || !qualifying) return null;

  const latestPractice = practices[practices.length - 1];
  const sessionKey = Number(latestPractice.session_key);

  const [laps, stints, qualifyingRows] = await Promise.all([
    openF1("laps", { session_key: sessionKey }, false),
    openF1("stints", { session_key: sessionKey }, true),
    openF1(
      "session_result",
      { session_key: qualifying.session_key },
      false
    ).then(cleanResults),
  ]);

  if (qualifyingRows.length < 10) return null;

  const analysis = analyzePracticeSession(
    latestPractice,
    laps,
    stints,
    []
  );

  if (!analysis.byDriver.size) return null;

  return {
    meeting,
    practices: [latestPractice],
    practice: latestPractice,
    practiceAnalyses: [analysis],
    qualifying,
    qualifyingRows,
    drivers: [],
    profile: trackProfile(meeting),
  };
}

function practiceMetrics(bundle) {
  const available = bundle.practiceAnalyses || [];
  const dry = available.filter(analysis => (analysis.wetLapShare || 0) < 0.25);
  const analyses = dry.length ? dry : available;
  if (!analyses.length) return null;

  const totals = new Map();
  let totalWeight = 0;
  let evolutionWeighted = 0;

  analyses.forEach((analysis, index) => {
    const baseWeight = practiceSessionWeight(
      analysis.session.session_name,
      index,
      analyses.length
    );
    const wetPenalty = clamp(
      1 - (analysis.wetLapShare || 0) * 0.88,
      0.18,
      1
    );
    const weight = baseWeight * wetPenalty;

    totalWeight += weight;
    evolutionWeighted += analysis.evolution * weight;

    analysis.byDriver.forEach((item, driverNumber) => {
      if (!totals.has(driverNumber)) {
        totals.set(driverNumber, {
          weight: 0,
          qualyPaceGap: 0,
          theoreticalGap: 0,
          longRunGap: 0,
          longRunWeight: 0,
          shortRunConfidence: 0,
          shortRunSpread: 0,
          teammateDelta: 0,
          trackEvolutionExposure: 0,
          practiceLaps: 0,
          topSpeed: 0,
          latestRawDuration: null,
          latestQualyGap: null,
          latestTheoreticalGap: null,
          latestShortRunSpread: null,
          selectedCompound: "UNKNOWN",
          selectedTyreAge: null,
          driver: item.driver,
        });
      }

      const target = totals.get(driverNumber);

      target.weight += weight;
      target.qualyPaceGap += item.qualyGap * weight;
      target.theoreticalGap +=
        (Number.isFinite(item.theoreticalGap)
          ? item.theoreticalGap
          : item.qualyGap) * weight;
      target.shortRunConfidence += item.shortRunConfidence * weight;
      target.shortRunSpread +=
        (Number.isFinite(item.shortRunSpread)
          ? item.shortRunSpread
          : 0.35) * weight;
      target.teammateDelta += item.teammateDelta * weight;
      target.trackEvolutionExposure +=
        item.trackEvolutionExposure * weight;
      target.practiceLaps += item.cleanLaps * weight;
      target.topSpeed = Math.max(target.topSpeed, item.topSpeed || 0);

      if (Number.isFinite(item.longRunGap)) {
        target.longRunGap += item.longRunGap * weight;
        target.longRunWeight += weight;
      }

      if (index === analyses.length - 1) {
        target.latestRawDuration = item.qualyRawDuration;
        target.latestQualyGap = item.qualyGap;
        target.latestTheoreticalGap =
          item.theoreticalGap;
        target.latestShortRunSpread =
          item.shortRunSpread;
        target.selectedCompound = item.selectedCompound;
        target.selectedTyreAge = item.selectedTyreAge;
      }
    });
  });

  const rows = [];
  const fieldTopSpeed = Math.max(
    1,
    ...[...totals.values()]
      .map((item) => item.topSpeed)
      .filter(
        (value) =>
          Number.isFinite(value) && value > 0
      )
  );

  totals.forEach((item, driverNumber) => {
    const weight = Math.max(item.weight, 0.001);

    rows.push({
      driverNumber,
      driver: item.driver,
      qualyPaceGap: item.qualyPaceGap / weight,
      theoreticalGap: item.theoreticalGap / weight,
      longRunGap:
        item.longRunWeight > 0
          ? item.longRunGap / item.longRunWeight
          : null,
      shortRunConfidence:
        item.shortRunConfidence / weight,
      shortRunSpread:
        Number.isFinite(item.latestShortRunSpread)
          ? item.latestShortRunSpread
          : item.shortRunSpread / weight,
      latestQualyGap:
        Number.isFinite(item.latestQualyGap)
          ? item.latestQualyGap
          : item.qualyPaceGap / weight,
      latestTheoreticalGap:
        Number.isFinite(item.latestTheoreticalGap)
          ? item.latestTheoreticalGap
          : item.theoreticalGap / weight,
      topSpeedDeficit:
        item.topSpeed > 0
          ? clamp(
              (fieldTopSpeed - item.topSpeed) /
                fieldTopSpeed,
              0,
              0.2
            )
          : 0.04,
      teammateDelta: item.teammateDelta / weight,
      trackEvolutionExposure:
        item.trackEvolutionExposure / weight,
      practiceLaps: item.practiceLaps / weight,
      topSpeed: item.topSpeed,
      latestRawDuration: item.latestRawDuration,
      selectedCompound: item.selectedCompound,
      selectedTyreAge: item.selectedTyreAge,
      practiceCoverage: clamp(item.weight / Math.max(totalWeight, 0.001), 0, 1),
    });
  });

  // Keep the declared session roster, including drivers without a usable lap.
  // Their historical form can still be used, with explicit low practice quality.
  const neutralGap = median(rows.map(row => row.qualyPaceGap), 1);
  for (const driver of bundle.drivers || []) {
    const driverNumber = Number(driver.driver_number);
    if (rows.some(row => row.driverNumber === driverNumber)) continue;
    rows.push({driverNumber, driver, qualyPaceGap: neutralGap, theoreticalGap: neutralGap,
      latestQualyGap: neutralGap, latestTheoreticalGap: neutralGap, longRunGap: null,
      shortRunConfidence: 0.15, shortRunSpread: 0.6, topSpeedDeficit: 0.04,
      teammateDelta: 0, trackEvolutionExposure: 0, practiceLaps: 0, topSpeed: 0,
      latestRawDuration: null, selectedCompound: "UNKNOWN", selectedTyreAge: null,
      practiceCoverage: 0});
  }
  rows.sort((a, b) => a.qualyPaceGap - b.qualyPaceGap);

  rows.forEach((row, index) => {
    row.position = index + 1;
  });

  const referenceAnalysis =
    [...analyses]
      .reverse()
      .find(
        (analysis) =>
          (analysis.wetLapShare || 0) < 0.25 &&
          plausibleLapTime(analysis.leaderRawQualy)
      ) ||
    analyses[analyses.length - 1];

  const latestLeader = referenceAnalysis.leaderRawQualy;
  const latestTheoreticalLeader =
    referenceAnalysis.leaderTheoretical;
  const sessionNames = analyses.map(
    (analysis) => analysis.session.session_name
  );

  return {
    leader:
      Number.isFinite(latestLeader)
        ? latestLeader
        : Math.min(
            ...rows
              .map((row) => row.latestRawDuration)
              .filter(Number.isFinite)
          ),
    theoreticalLeader:
      plausibleLapTime(latestTheoreticalLeader)
        ? latestTheoreticalLeader
        : null,
    poleReferenceSession:
      referenceAnalysis.session &&
      referenceAnalysis.session.session_name
        ? referenceAnalysis.session.session_name
        : null,
    poleReferenceWetShare:
      referenceAnalysis.wetLapShare || 0,
    byDriver: new Map(rows.map((row) => [row.driverNumber, row])),
    rows,
    sessionNames,
    evolution:
      totalWeight > 0 ? evolutionWeighted / totalWeight : 0,
    shortRuns: rows.filter((row) => row.shortRunConfidence >= 0.62).length,
    longRuns: rows.filter((row) => Number.isFinite(row.longRunGap)).length,
  };
}

function robustWeightedMean(samples, fallback = null) {
  const valid = (samples || []).filter(
    (sample) =>
      Number.isFinite(sample && sample.value) &&
      Number.isFinite(sample && sample.weight) &&
      sample.weight > 0
  );

  if (!valid.length) return fallback;

  const center = median(
    valid.map((sample) => sample.value),
    fallback
  );
  const mad = median(
    valid.map((sample) => Math.abs(sample.value - center)),
    0
  );
  const tolerance = Math.max(0.45, mad * 3);

  let filtered = valid.filter(
    (sample) =>
      Math.abs(sample.value - center) <= tolerance
  );

  if (filtered.length < Math.min(3, valid.length)) {
    filtered = valid;
  }

  const totalWeight = filtered.reduce(
    (sum, sample) => sum + sample.weight,
    0
  );

  if (totalWeight <= 0) return center;

  return filtered.reduce(
    (sum, sample) => sum + sample.value * sample.weight,
    0
  ) / totalWeight;
}

function estimatePoleTime(
  targetBundle,
  targetPractice,
  historicalBundles,
  circuitReferenceBundle = null
) {
  const unique = new Map();

  (historicalBundles || []).forEach((bundle, index) => {
    if (!bundle || !bundle.meeting) return;
    unique.set(Number(bundle.meeting.meeting_key), {
      bundle,
      order: index,
      reference: false,
    });
  });

  if (
    circuitReferenceBundle &&
    circuitReferenceBundle.meeting
  ) {
    const key = Number(
      circuitReferenceBundle.meeting.meeting_key
    );
    const existing = unique.get(key);

    unique.set(key, {
      bundle: circuitReferenceBundle,
      order: existing ? existing.order : unique.size,
      reference: true,
    });
  }

  const entries = [...unique.values()];
  const rawSamples = [];
  const theoreticalSamples = [];
  let sameCircuitSamples = 0;

  entries.forEach((entry, index) => {
    if (entry.bundle.meeting.year !== targetBundle.meeting.year ||
        entry.bundle.meeting.startDate >= targetBundle.meeting.startDate) return;
    const practice = practiceMetrics(entry.bundle);
    const qualifying = qualifyingMetrics(entry.bundle);

    if (
      !practice ||
      !qualifying ||
      !plausibleLapTime(practice.leader) ||
      !plausibleLapTime(qualifying.poleDuration)
    ) {
      return;
    }

    const sameCircuit =
      circuitKey(entry.bundle.meeting) ===
      circuitKey(targetBundle.meeting);
    const sameProfile =
      entry.bundle.profile === targetBundle.profile;

    const recencyWeight =
      entries.length <= 1
        ? 1
        : 0.72 + (index / (entries.length - 1)) * 0.38;
    const circuitWeight = sameCircuit
      ? 2.8
      : sameProfile
        ? 1.35
        : 0.9;
    const dryWeight = clamp(
      1 - (practice.poleReferenceWetShare || 0) * 0.9,
      0.15,
      1
    );
    const weight =
      recencyWeight *
      circuitWeight *
      dryWeight *
      (entry.reference ? 1.15 : 1);

    const rawDelta =
      qualifying.poleDuration - practice.leader;

    if (rawDelta >= -5 && rawDelta <= 2.5) {
      rawSamples.push({
        value: rawDelta,
        weight,
      });

      if (sameCircuit) sameCircuitSamples += 1;
    }

    if (
      plausibleLapTime(practice.theoreticalLeader)
    ) {
      const theoreticalDelta =
        qualifying.poleDuration -
        practice.theoreticalLeader;

      if (
        theoreticalDelta >= -5 &&
        theoreticalDelta <= 2.5
      ) {
        theoreticalSamples.push({
          value: theoreticalDelta,
          weight,
        });
      }
    }
  });

  const rawDelta = robustWeightedMean(
    rawSamples,
    -0.75
  );
  const theoreticalDelta = robustWeightedMean(
    theoreticalSamples,
    rawDelta
  );

  const rawEstimate =
    targetPractice.leader + rawDelta;

  const theoreticalAvailable =
    plausibleLapTime(targetPractice.theoreticalLeader);
  const theoreticalEstimate = theoreticalAvailable
    ? targetPractice.theoreticalLeader +
      theoreticalDelta
    : rawEstimate;

  const theoreticalGain = theoreticalAvailable
    ? targetPractice.leader -
      targetPractice.theoreticalLeader
    : 0;
  const theoreticalWeight = theoreticalAvailable
    ? theoreticalGain >= 0 &&
      theoreticalGain <= 1.2
      ? 0.34
      : 0.18
    : 0;

  const estimatedPole =
    rawEstimate * (1 - theoreticalWeight) +
    theoreticalEstimate * theoreticalWeight;

  return {
    estimatedPole,
    rawDelta,
    theoreticalDelta,
    samples: rawSamples.length,
    sameCircuitSamples,
    theoreticalWeight,
  };
}

function validatePoleEstimator(bundles) {
  const errors = [];

  for (let index = 2; index < (bundles || []).length; index += 1) {
    const targetBundle = bundles[index];
    const practice = practiceMetrics(targetBundle);
    const actual = qualifyingMetrics(targetBundle);

    if (
      !practice ||
      !actual ||
      !plausibleLapTime(practice.leader)
    ) {
      continue;
    }

    const estimate = estimatePoleTime(
      targetBundle,
      practice,
      bundles.slice(0, index),
      null
    );

    if (plausibleLapTime(estimate.estimatedPole)) {
      errors.push(
        Math.abs(
          estimate.estimatedPole - actual.poleDuration
        )
      );
    }
  }

  return {
    mae: average(errors, null),
    samples: errors.length,
  };
}

function qualifyingMetrics(bundle) {
  const rows = bundle.qualifyingRows || [];
  const pole = rows.find(row => row.positionValue === 1);
  if (!pole || !plausibleLapTime(pole.durationValue)) return null;
  const phaseLeaders = [0, 1, 2].map(phase => {
    const times = rows.map(row => Array.isArray(row.duration) ? safeNumber(row.duration[phase]) : null).filter(plausibleLapTime);
    return times.length ? Math.min(...times) : null;
  });
  return {
    poleDuration: pole.durationValue,
    byDriver: new Map(rows.map(row => {
      const phases = Array.isArray(row.duration) ? row.duration : [];
      let phase = -1;
      phases.forEach((time, index) => { if (plausibleLapTime(time)) phase = index; });
      const leader = phaseLeaders[phase];
      const formGap = Number.isFinite(leader)
        ? Math.max(0, (Number(phases[phase]) / leader - 1) * pole.durationValue) : null;
      return [Number(row.driver_number), {
        gap: Math.max(0, row.durationValue - pole.durationValue),
        formGap,
        position: row.positionValue,
        phaseCount: row.phaseCount || 0,
        gapComparable: phase === 2 && plausibleLapTime(pole.duration?.[2]),
      }];
    })),
  };
}

function pushRecent(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  const values = map.get(key);
  values.push(value);
  if (values.length > 5) values.shift();
}

function recentAverage(map, key, fallback) {
  return average(map.get(key) || [], fallback);
}

function recentTrend(map, key) {
  const values = map.get(key) || [];
  if (values.length < 4) return 0;

  const recent = values.slice(-2);
  const previous = values.slice(-5, -2);

  if (!previous.length) return 0;

  // Negativo = el equipo está acercándose a la pole.
  return clamp(
    average(recent, 0) - average(previous, 0),
    -0.8,
    0.8
  );
}

function buildTraining(bundles, qualyHistory = []) {
  const driverGap = new Map();
  const driverPosition = new Map();
  const teamGap = new Map();
  const teamProfileGap = new Map();
  const globalGaps = [];
  const globalPositions = [];
  const rows = [];

  [...bundles].sort((a,b) => a.meeting.startDate - b.meeting.startDate).forEach((bundle, eventIndex) => {
    const practice = practiceMetrics(bundle);
    const qualifying = qualifyingMetrics(bundle);
    if (!practice || !qualifying) return;

    const drivers = new Map(
      bundle.drivers.map((driver) => [Number(driver.driver_number), driver])
    );

    const eventPriors = buildQualyPriors(
      qualyHistory,
      bundle.meeting.startDate,
      bundle.meeting.year
    );

    const globalGap = average(globalGaps, 0.85);
    const globalPosition = average(globalPositions, 10.5);
    const eventRows = [];

    practice.rows.forEach((p) => {
      const number = Number(p.driverNumber);
      const target = qualifying.byDriver.get(number);
      const driver = drivers.get(number) || p.driver;

      if (!p || !target || !driver || !driver.team_name) return;
      if (!Number.isFinite(p.qualyPaceGap)) return;

      const team = driver.team_name;
      const profileKey = team + "::" + bundle.profile;
      const teamFallback = recentAverage(teamGap, team, globalGap);

      eventRows.push({
        eventIndex,
        driverNumber: number,
        driver,
        team,
        qualyPaceGap: p.qualyPaceGap,
        theoreticalGap: Number.isFinite(p.theoreticalGap)
          ? p.theoreticalGap
          : p.qualyPaceGap,
        practicePosition: (p.position - 1) / Math.max(1, practice.rows.length - 1),
        shortRunConfidence: p.shortRunConfidence,
        latestQualyGap:
          Number.isFinite(p.latestQualyGap)
            ? p.latestQualyGap
            : p.qualyPaceGap,
        latestTheoreticalGap:
          Number.isFinite(p.latestTheoreticalGap)
            ? p.latestTheoreticalGap
            : p.theoreticalGap,
        shortRunSpread:
          Number.isFinite(p.shortRunSpread)
            ? p.shortRunSpread
            : 0.35,
        topSpeedDeficit:
          Number.isFinite(p.topSpeedDeficit)
            ? p.topSpeedDeficit
            : 0.04,
        longRunGap: Number.isFinite(p.longRunGap)
          ? p.longRunGap
          : teamFallback,
        teammateDelta: clamp(p.teammateDelta, -1.2, 1.2),
        trackEvolutionExposure: clamp(
          p.trackEvolutionExposure,
          -2.5,
          2.5
        ),
        driverFormGap: recentAverage(driverGap, number, globalGap),
        teamFormGap: teamFallback,
        teamTrend: recentTrend(teamGap, team),
        trackFitGap: recentAverage(
          teamProfileGap,
          profileKey,
          teamFallback
        ),
        driverFormPosition:
          recentAverage(driverPosition, number, globalPosition) / 20,
        practiceCoverage: p.practiceCoverage,
        practiceLaps: clamp(p.practiceLaps / 30, 0, 1.5),
        practicePositionRaw: p.position,
        topSpeed: p.topSpeed,
        selectedCompound: p.selectedCompound,
        selectedTyreAge: p.selectedTyreAge,
        targetGap: target.gap,
        targetFormGap: target.formGap,
        targetPosition: target.position,
        gapComparable: Boolean(
          target.gapComparable
        ),
      });
    });

    const enrichedEventRows = attachQualyPriors(
      eventRows,
      eventPriors
    );

    const calibratedBaseline = calibrateWithQualyPrior(
      enrichedEventRows.map((row) => ({
        ...row,
        predictedGap: baselineGap(row),
      }))
    );

    calibratedBaseline.forEach((row) => {
      rows.push({
        ...row,
        historicalBaseGap: row.predictedGap,
        // Include eliminated drivers using a same-phase pace target. Training
        // only on Q3 finishers makes the time model extrapolate the whole midfield.
        residualTarget: plausibleGap(row.targetFormGap)
          ? clamp(
              row.targetFormGap - row.predictedGap,
              -1.5,
              1.5
            )
          : null,
      });
    });

    const eventTeamGaps = new Map();
    qualifying.byDriver.forEach((target, number) => {
      const driver = drivers.get(number);
      if (!driver || !driver.team_name) return;

      pushRecent(driverPosition, number, target.position);
      globalPositions.push(target.position);
      if (!plausibleGap(target.formGap)) return;
      pushRecent(driverGap, number, target.formGap);
      if (!eventTeamGaps.has(driver.team_name)) eventTeamGaps.set(driver.team_name, []);
      eventTeamGaps.get(driver.team_name).push(target.formGap);
      globalGaps.push(target.formGap);
    });
    // One observation per team and GP, independent of result row ordering.
    eventTeamGaps.forEach((gaps, team) => {
      const gap = median(gaps);
      pushRecent(teamGap, team, gap);
      pushRecent(teamProfileGap, team + "::" + bundle.profile, gap);
    });
  });

  return {
    rows,
    state: {
      driverGap,
      driverPosition,
      teamGap,
      teamProfileGap,
      globalGap: average(globalGaps, 0.85),
      globalPosition: average(globalPositions, 10.5),
    },
  };
}

function makeTargetRows(bundle, state) {
  const practice = practiceMetrics(bundle);
  if (!practice) return [];

  const drivers = new Map(
    bundle.drivers.map((driver) => [Number(driver.driver_number), driver])
  );

  return practice.rows
    .map((p) => {
      const number = Number(p.driverNumber);
      const driver = drivers.get(number) || p.driver;
      if (!driver || !driver.team_name) return null;

      const team = driver.team_name;
      const profileKey = team + "::" + bundle.profile;
      const teamFallback = recentAverage(
        state.teamGap,
        team,
        state.globalGap
      );

      return {
        driverNumber: number,
        driver,
        team,
        qualyPaceGap: p.qualyPaceGap,
        theoreticalGap: Number.isFinite(p.theoreticalGap)
          ? p.theoreticalGap
          : p.qualyPaceGap,
        practicePosition: (p.position - 1) / Math.max(1, practice.rows.length - 1),
        practicePositionRaw: p.position,
        shortRunConfidence: p.shortRunConfidence,
        latestQualyGap:
          Number.isFinite(p.latestQualyGap)
            ? p.latestQualyGap
            : p.qualyPaceGap,
        latestTheoreticalGap:
          Number.isFinite(p.latestTheoreticalGap)
            ? p.latestTheoreticalGap
            : p.theoreticalGap,
        shortRunSpread:
          Number.isFinite(p.shortRunSpread)
            ? p.shortRunSpread
            : 0.35,
        topSpeedDeficit:
          Number.isFinite(p.topSpeedDeficit)
            ? p.topSpeedDeficit
            : 0.04,
        longRunGap: Number.isFinite(p.longRunGap)
          ? p.longRunGap
          : teamFallback,
        teammateDelta: clamp(p.teammateDelta, -1.2, 1.2),
        trackEvolutionExposure: clamp(
          p.trackEvolutionExposure,
          -2.5,
          2.5
        ),
        driverFormGap: recentAverage(
          state.driverGap,
          number,
          state.globalGap
        ),
        teamFormGap: teamFallback,
        teamTrend: recentTrend(state.teamGap, team),
        trackFitGap: recentAverage(
          state.teamProfileGap,
          profileKey,
          teamFallback
        ),
        driverFormPosition:
          recentAverage(
            state.driverPosition,
            number,
            state.globalPosition
          ) / 20,
        practiceCoverage: p.practiceCoverage,
        practiceLaps: clamp(p.practiceLaps / 30, 0, 1.5),
        topSpeed: p.topSpeed,
        selectedCompound: p.selectedCompound,
        selectedTyreAge: p.selectedTyreAge,
        practiceDuration: p.latestRawDuration,
      };
    })
    .filter(Boolean);
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;

    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(augmented[pivot][col]) < 1e-10) continue;

    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];

    const divisor = augmented[col][col];
    for (let index = col; index <= n; index += 1) {
      augmented[col][index] /= divisor;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];

      for (let index = col; index <= n; index += 1) {
        augmented[row][index] -= factor * augmented[col][index];
      }
    }
  }

  return augmented.map((row) => row[n] || 0);
}


function baselineGap(row) {
  const confidence = clamp(row.shortRunConfidence || 0.4, 0.15, 1);
  const longRun = Number.isFinite(row.longRunGap)
    ? row.longRunGap
    : row.teamFormGap;
  const theoretical = Number.isFinite(row.theoreticalGap)
    ? row.theoreticalGap
    : row.qualyPaceGap;
  const teammateDelta = clamp(
    row.teammateDelta || 0,
    -0.9,
    0.9
  );

  const teammateSignal = clamp(
    row.teamFormGap + teammateDelta * 0.45,
    0,
    4.5
  );
  const trendSignal = clamp(
    row.teamFormGap + row.teamTrend,
    0,
    4.5
  );

  const coverage = clamp(row.practiceCoverage ?? 1, 0, 1);
  const practiceWeight = (0.05 + confidence * 0.25) * coverage;
  const theoreticalWeight = 0.12 * confidence * coverage;
  const teamWeight = 0.23;
  const driverWeight = 0.12;
  const trackWeight = 0.07;
  const longRunWeight = 0.04 * coverage;
  const teammateWeight = 0.07 * confidence * coverage;
  const trendWeight = 0.08;

  const total =
    practiceWeight +
    theoreticalWeight +
    teamWeight +
    driverWeight +
    trackWeight +
    longRunWeight +
    teammateWeight +
    trendWeight;

  return (
    row.qualyPaceGap * practiceWeight +
    theoretical * theoreticalWeight +
    row.teamFormGap * teamWeight +
    row.driverFormGap * driverWeight +
    row.trackFitGap * trackWeight +
    longRun * longRunWeight +
    teammateSignal * teammateWeight +
    trendSignal * trendWeight
  ) / total;
}

function fitRidge(rows, lambda = 1.1, targetKey = "residualTarget") {
  const validRows = (rows || []).filter(
    (row) =>
      Number.isFinite(row[targetKey]) &&
      FEATURE_KEYS.every((key) => Number.isFinite(row[key]))
  );

  if (validRows.length < 12) return null;

  const means = {};
  const scales = {};

  FEATURE_KEYS.forEach((key) => {
    means[key] = average(validRows.map((row) => row[key]), 0);
    const variance = average(
      validRows.map((row) => Math.pow(row[key] - means[key], 2)),
      0
    );
    scales[key] = Math.sqrt(variance) || 1;
  });

  const width = FEATURE_KEYS.length + 1;
  const xtx = Array.from({ length: width }, () =>
    Array.from({ length: width }, () => 0)
  );
  const xty = Array.from({ length: width }, () => 0);

  validRows.forEach((row) => {
    const vector = [
      1,
      ...FEATURE_KEYS.map(
        (key) => (row[key] - means[key]) / scales[key]
      ),
    ];

    vector.forEach((a, rowIndex) => {
      xty[rowIndex] += a * row[targetKey];

      vector.forEach((b, columnIndex) => {
        xtx[rowIndex][columnIndex] += a * b;
      });
    });
  });

  for (let index = 1; index < width; index += 1) {
    xtx[index][index] += lambda;
  }

  return {
    type: "ridge",
    coefficients: solveLinearSystem(xtx, xty),
    means,
    scales,
    sampleCount: validRows.length,
  };
}

function predictRidge(model, row) {
  if (!model) return 0;

  const vector = [
    1,
    ...FEATURE_KEYS.map(
      (key) => (row[key] - model.means[key]) / model.scales[key]
    ),
  ];

  return vector.reduce(
    (sum, value, index) =>
      sum + value * model.coefficients[index],
    0
  );
}

function regressionLeafValue(rows, targetKey) {
  return average(rows.map((row) => row[targetKey]), 0);
}

function bestTreeSplit(rows, targetKey, minLeaf = 8) {
  let best = null;

  FEATURE_KEYS.forEach((feature) => {
    const values = rows
      .map((row) => row[feature])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    if (values.length < minLeaf * 2) return;

    const thresholds = [];
    const quantiles = [0.2, 0.35, 0.5, 0.65, 0.8];

    quantiles.forEach((q) => {
      const index = Math.floor((values.length - 1) * q);
      const threshold = values[index];
      if (
        Number.isFinite(threshold) &&
        !thresholds.some((value) => Math.abs(value - threshold) < 1e-9)
      ) {
        thresholds.push(threshold);
      }
    });

    thresholds.forEach((threshold) => {
      const left = rows.filter((row) => row[feature] <= threshold);
      const right = rows.filter((row) => row[feature] > threshold);

      if (left.length < minLeaf || right.length < minLeaf) return;

      const leftMean = regressionLeafValue(left, targetKey);
      const rightMean = regressionLeafValue(right, targetKey);

      const loss =
        left.reduce(
          (sum, row) => sum + Math.pow(row[targetKey] - leftMean, 2),
          0
        ) +
        right.reduce(
          (sum, row) => sum + Math.pow(row[targetKey] - rightMean, 2),
          0
        );

      if (!best || loss < best.loss) {
        best = {
          feature,
          threshold,
          loss,
          left,
          right,
        };
      }
    });
  });

  return best;
}

function fitRegressionTree(rows, targetKey, depth = 0, maxDepth = 2) {
  if (!rows.length) {
    return { leaf: true, value: 0 };
  }

  if (depth >= maxDepth || rows.length < 16) {
    return {
      leaf: true,
      value: regressionLeafValue(rows, targetKey),
    };
  }

  const split = bestTreeSplit(rows, targetKey);

  if (!split) {
    return {
      leaf: true,
      value: regressionLeafValue(rows, targetKey),
    };
  }

  return {
    leaf: false,
    feature: split.feature,
    threshold: split.threshold,
    left: fitRegressionTree(
      split.left,
      targetKey,
      depth + 1,
      maxDepth
    ),
    right: fitRegressionTree(
      split.right,
      targetKey,
      depth + 1,
      maxDepth
    ),
  };
}

function predictTree(tree, row) {
  if (!tree) return 0;
  if (tree.leaf) return tree.value;

  return row[tree.feature] <= tree.threshold
    ? predictTree(tree.left, row)
    : predictTree(tree.right, row);
}

function fitGradientBoosting(rows, options = {}) {
  const validRows = (rows || []).filter(
    (row) =>
      Number.isFinite(row.residualTarget) &&
      FEATURE_KEYS.every((key) => Number.isFinite(row[key]))
  );

  if (validRows.length < 28) return null;

  const estimators = options.estimators || 36;
  const learningRate = options.learningRate || 0.055;
  const maxDepth = options.maxDepth || 2;

  const initial = average(
    validRows.map((row) => row.residualTarget),
    0
  );

  const working = validRows.map((row) => ({
    ...row,
    __prediction: initial,
    __residual: row.residualTarget - initial,
  }));

  const trees = [];

  for (let iteration = 0; iteration < estimators; iteration += 1) {
    const residualRows = working.map((row) => ({
      ...row,
      __boostTarget: row.__residual,
    }));

    const tree = fitRegressionTree(
      residualRows,
      "__boostTarget",
      0,
      maxDepth
    );

    trees.push(tree);

    working.forEach((row) => {
      const update = predictTree(tree, row) * learningRate;
      row.__prediction += update;
      row.__residual = row.residualTarget - row.__prediction;
    });
  }

  return {
    type: "gradient_boosting",
    initial,
    trees,
    learningRate,
    sampleCount: validRows.length,
  };
}

function predictGradientBoosting(model, row) {
  if (!model) return 0;

  return model.trees.reduce(
    (prediction, tree) =>
      prediction + predictTree(tree, row) * model.learningRate,
    model.initial
  );
}

function residualPrediction(model, row) {
  if (!model) return 0;

  if (model.type === "gradient_boosting") {
    return predictGradientBoosting(model, row);
  }

  return predictRidge(model, row);
}

function applyResidualModel(baseGap, model, row) {
  const correction = clamp(
    residualPrediction(model, row),
    -0.55,
    0.55
  );

  // Los residuales pueden ser negativos antes de recentrar el campo.
  // Recortarlos aquí era la causa de varios líderes con exactamente el mismo tiempo.
  return clamp(baseGap + correction, -0.9, 4.5);
}

function rankMetrics(rows) {
  if (!rows.length) {
    return {
      positionMae: null,
      ndcg: null,
      top3Hits: 0,
      top3Possible: 0,
    };
  }

  const predicted = [...rows]
    .sort((a, b) => a.predictedGap - b.predictedGap)
    .map((row, index) => ({
      ...row,
      predictedPosition: index + 1,
    }));

  const positionMae = average(
    predicted.map((row) =>
      Math.abs(row.predictedPosition - row.targetPosition)
    ),
    null
  );

  const fieldSize = Math.max(rows.length, ...rows.map(row => row.targetPosition));
  const relevance = (position) =>
    Math.max(0, fieldSize + 1 - Number(position || fieldSize + 1));

  const dcg = predicted.reduce(
    (sum, row, index) =>
      sum +
      relevance(row.targetPosition) /
        Math.log2(index + 2),
    0
  );

  const ideal = [...predicted]
    .sort((a, b) => a.targetPosition - b.targetPosition)
    .reduce(
      (sum, row, index) =>
        sum +
        relevance(row.targetPosition) /
          Math.log2(index + 2),
      0
    );

  const predictedTop3 = predicted.slice(0, 3);
  const top3Hits = predictedTop3.filter(
    (row) => row.targetPosition <= 3
  ).length;

  return {
    positionMae,
    ndcg: ideal > 0 ? dcg / ideal : null,
    top3Hits,
    top3Possible: Math.min(3, predicted.length),
  };
}

function blendModelGaps(baseGap, row, ridge, gradient) {
  const parts = [{ value: baseGap, weight: 0.38 }];

  if (ridge) {
    parts.push({
      value: applyResidualModel(baseGap, ridge, row),
      weight: 0.34,
    });
  }

  if (gradient) {
    parts.push({
      value: applyResidualModel(baseGap, gradient, row),
      weight: 0.28,
    });
  }

  const totalWeight = parts.reduce(
    (sum, part) => sum + part.weight,
    0
  );

  return parts.reduce(
    (sum, part) => sum + part.value * part.weight,
    0
  ) / Math.max(totalWeight, 0.001);
}

function fitPairwiseRanker(rows, options = {}) {
  const validRows = (rows || []).filter(
    (row) =>
      Number.isFinite(row.eventIndex) &&
      Number.isFinite(row.targetPosition) &&
      RANK_FEATURE_KEYS.every((key) =>
        Number.isFinite(row[key])
      )
  );

  if (validRows.length < 30) return null;

  const means = {};
  const scales = {};

  RANK_FEATURE_KEYS.forEach((key) => {
    means[key] = average(
      validRows.map((row) => row[key]),
      0
    );
    const variance = average(
      validRows.map((row) =>
        Math.pow(row[key] - means[key], 2)
      ),
      0
    );
    scales[key] = Math.sqrt(variance) || 1;
  });

  const groups = new Map();

  validRows.forEach((row) => {
    if (!groups.has(row.eventIndex)) {
      groups.set(row.eventIndex, []);
    }
    groups.get(row.eventIndex).push(row);
  });

  const vectorOf = (row) =>
    RANK_FEATURE_KEYS.map(
      (key) => (row[key] - means[key]) / scales[key]
    );

  const pairs = [];

  groups.forEach((eventRows) => {
    for (let i = 0; i < eventRows.length; i += 1) {
      for (let j = i + 1; j < eventRows.length; j += 1) {
        const first = eventRows[i];
        const second = eventRows[j];

        if (first.targetPosition === second.targetPosition) {
          continue;
        }

        const better =
          first.targetPosition < second.targetPosition
            ? first
            : second;
        const worse = better === first ? second : first;

        const betterVector = vectorOf(better);
        const worseVector = vectorOf(worse);
        const diff = betterVector.map(
          (value, index) => value - worseVector[index]
        );

        const bestPosition = Math.min(
          better.targetPosition,
          worse.targetPosition
        );
        const positionDistance = Math.abs(
          better.targetPosition - worse.targetPosition
        );

        const topWeight =
          bestPosition <= 3
            ? 2.8
            : bestPosition <= 10
              ? 1.45
              : 0.85;
        const distanceWeight = clamp(
          0.65 + positionDistance / 8,
          0.65,
          1.65
        );

        pairs.push({
          diff,
          weight: topWeight * distanceWeight,
        });
      }
    }
  });

  if (pairs.length < 120) return null;

  const epochs = options.epochs || 240;
  const baseLearningRate =
    options.learningRate || 0.085;
  const l2 = options.l2 || 0.028;
  const weights = Array.from(
    { length: RANK_FEATURE_KEYS.length },
    () => 0
  );
  const totalPairWeight = pairs.reduce(
    (sum, pair) => sum + pair.weight,
    0
  );

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array.from(
      { length: weights.length },
      () => 0
    );

    pairs.forEach((pair) => {
      const score = pair.diff.reduce(
        (sum, value, index) =>
          sum + value * weights[index],
        0
      );
      const probability =
        1 / (1 + Math.exp(-clamp(score, -18, 18)));
      const factor =
        (probability - 1) * pair.weight;

      pair.diff.forEach((value, index) => {
        gradient[index] += factor * value;
      });
    });

    const learningRate =
      baseLearningRate / (1 + epoch * 0.012);

    weights.forEach((weight, index) => {
      const normalizedGradient =
        gradient[index] /
          Math.max(totalPairWeight, 0.001) +
        l2 * weight;
      weights[index] -=
        learningRate * normalizedGradient;
    });
  }

  return {
    type: "pairwise_ranker",
    weights,
    means,
    scales,
    pairCount: pairs.length,
    sampleCount: validRows.length,
  };
}

function predictPairwiseScore(model, row) {
  if (model?.type === "recent_form") {
    return -(row.qualyPriorPosition * 0.7 + row.driverFormPosition * 0.3);
  }
  if (!model) return 0;

  return RANK_FEATURE_KEYS.reduce(
    (sum, key, index) =>
      sum +
      ((row[key] - model.means[key]) /
        model.scales[key]) *
        model.weights[index],
    0
  );
}

function predictedGapForModel(
  type,
  row,
  ridge,
  gradient
) {
  if (type === "ridge" && ridge) {
    return applyResidualModel(
      row.historicalBaseGap,
      ridge,
      row
    );
  }

  if (type === "gradient_boosting" && gradient) {
    return applyResidualModel(
      row.historicalBaseGap,
      gradient,
      row
    );
  }

  if (type === "ensemble" && (ridge || gradient)) {
    return blendModelGaps(
      row.historicalBaseGap,
      row,
      ridge,
      gradient
    );
  }

  return row.historicalBaseGap;
}

function rankIndexMap(rows, scoreGetter, descending = false) {
  const sorted = [...rows].sort((a, b) => {
    const aScore = scoreGetter(a);
    const bScore = scoreGetter(b);

    if (aScore === bScore) {
      return a.driverNumber - b.driverNumber;
    }

    return descending
      ? bScore - aScore
      : aScore - bScore;
  });

  return new Map(
    sorted.map((row, index) => [
      row.driverNumber,
      index,
    ])
  );
}

function fuseRankingRows(
  rows,
  pairwiseModel,
  pairwiseWeight
) {
  if (
    !pairwiseModel ||
    pairwiseWeight <= 0 ||
    rows.length < 2
  ) {
    return rows.map((row) => ({
      ...row,
      rankFusionScore: null,
      pairwiseScore: null,
    }));
  }

  const denominator = Math.max(1, rows.length - 1);
  const gapRanks = rankIndexMap(
    rows,
    (row) => row.predictedGap,
    false
  );
  const pairRanks = rankIndexMap(
    rows,
    (row) => predictPairwiseScore(pairwiseModel, row),
    true
  );

  return rows.map((row) => {
    const gapRank =
      (gapRanks.get(row.driverNumber) || 0) /
      denominator;
    const pairRank =
      (pairRanks.get(row.driverNumber) || 0) /
      denominator;

    return {
      ...row,
      pairwiseScore:
        predictPairwiseScore(pairwiseModel, row),
      rankFusionScore:
        gapRank * (1 - pairwiseWeight) +
        pairRank * pairwiseWeight,
    };
  });
}

function rankingValidation(training, mode = "pairwise") {
  const events = [
    ...new Set(
      training.rows.map((row) => row.eventIndex)
    ),
  ];
  const weights = [0, 0.25, 0.5, 0.75, 1];
  const buckets = new Map(
    weights.map((weight) => [
      weight,
      {
        positionErrors: [],
        ndcg: [],
        top3Hits: 0,
        top3Possible: 0,
        events: 0,
        pairCounts: [],
      },
    ])
  );

  events.slice(2).forEach((eventIndex) => {
    const trainRows = training.rows.filter(
      (row) => row.eventIndex < eventIndex
    );
    const testRows = training.rows.filter(
      (row) => row.eventIndex === eventIndex
    );

    const localValidation = temporalValidation({
      rows: trainRows,
    });
    const ridge = fitRidge(trainRows);
    const gradient = fitGradientBoosting(trainRows);
    const pairwise = mode === "recent_form" ? {type: mode} : fitPairwiseRanker(trainRows);

    const baseRows = testRows.map((row) => ({
      ...row,
      predictedGap: predictedGapForModel(
        localValidation.winner,
        row,
        ridge,
        gradient
      ),
    }));

    weights.forEach((weight) => {
      const bucket = buckets.get(weight);
      const fused = fuseRankingRows(
        baseRows,
        pairwise,
        weight
      )
        .sort((a, b) => {
          if (
            weight > 0 &&
            Number.isFinite(a.rankFusionScore) &&
            Number.isFinite(b.rankFusionScore)
          ) {
            return (
              a.rankFusionScore -
                b.rankFusionScore ||
              a.predictedGap - b.predictedGap
            );
          }

          return a.predictedGap - b.predictedGap;
        })
        .map((row, index) => ({
          ...row,
          predictedGap: index,
        }));

      const metrics = rankMetrics(fused);

      if (Number.isFinite(metrics.positionMae)) {
        bucket.positionErrors.push(
          metrics.positionMae
        );
      }
      if (Number.isFinite(metrics.ndcg)) {
        bucket.ndcg.push(metrics.ndcg);
      }

      bucket.top3Hits += metrics.top3Hits;
      bucket.top3Possible += metrics.top3Possible;
      bucket.events += 1;

      if (pairwise) {
        bucket.pairCounts.push(pairwise.pairCount);
      }
    });
  });

  const candidates = [...buckets.entries()]
    .map(([weight, bucket]) => {
      const positionMae = average(
        bucket.positionErrors,
        null
      );
      const ndcg = average(bucket.ndcg, null);
      const top3Rate =
        bucket.top3Possible > 0
          ? bucket.top3Hits / bucket.top3Possible
          : null;

      const selectionScore =
        Number.isFinite(positionMae) &&
        Number.isFinite(ndcg) &&
        Number.isFinite(top3Rate)
          ? positionMae * 0.58 +
            (1 - ndcg) * 3.1 +
            (1 - top3Rate) * 0.9
          : null;

      return {
        weight,
        positionMae,
        ndcg,
        top3Rate,
        events: bucket.events,
        pairCount: Math.round(
          average(bucket.pairCounts, 0)
        ),
        selectionScore,
      };
    })
    .filter((item) =>
      Number.isFinite(item.selectionScore)
    )
    .sort(
      (a, b) =>
        a.selectionScore - b.selectionScore
    );

  const baseline =
    candidates.find((item) => item.weight === 0) ||
    null;
  const best = candidates[0] || baseline;
  const improvement =
    baseline && best
      ? baseline.selectionScore -
        best.selectionScore
      : 0;
  const active =
    best &&
    best.weight > 0 &&
    improvement >= 0.025;

  return {
    mode,
    selectionScore: active ? best.selectionScore : baseline?.selectionScore ?? Infinity,
    active: Boolean(active),
    weight: active ? best.weight : 0,
    positionMae:
      active && Number.isFinite(best.positionMae)
        ? best.positionMae
        : baseline && Number.isFinite(baseline.positionMae)
          ? baseline.positionMae
          : null,
    ndcg:
      active && Number.isFinite(best.ndcg)
        ? best.ndcg
        : baseline && Number.isFinite(baseline.ndcg)
          ? baseline.ndcg
          : null,
    top3Rate:
      active && Number.isFinite(best.top3Rate)
        ? best.top3Rate
        : baseline && Number.isFinite(baseline.top3Rate)
          ? baseline.top3Rate
          : null,
    pairCount:
      active ? best.pairCount : 0,
    improvement,
    candidates,
  };
}

function selectRanking(training) {
  const pairwise = rankingValidation(training);
  const form = rankingValidation(training, "recent_form");
  return form.active && form.selectionScore < pairwise.selectionScore - 0.025 ? form : pairwise;
}

function fitSelectedRanker(training, selection) {
  if (!selection.active) return null;
  return selection.mode === "recent_form"
    ? {type: "recent_form", pairCount: 0} : fitPairwiseRanker(training.rows);
}

function temporalValidation(training) {
  const events = [...new Set(training.rows.map((row) => row.eventIndex))];
  const buckets = {
    baseline: { gapErrors: [], positionErrors: [], ndcg: [], top3Hits: 0, top3Possible: 0, events: 0 },
    ridge: { gapErrors: [], positionErrors: [], ndcg: [], top3Hits: 0, top3Possible: 0, events: 0 },
    gradient_boosting: { gapErrors: [], positionErrors: [], ndcg: [], top3Hits: 0, top3Possible: 0, events: 0 },
    ensemble: { gapErrors: [], positionErrors: [], ndcg: [], top3Hits: 0, top3Possible: 0, events: 0 },
  };

  function record(type, rows) {
    if (!rows.length) return;
    const bucket = buckets[type];

    rows.forEach((row) => {
      if (row.gapComparable) {
        bucket.gapErrors.push(
          Math.abs(row.predictedGap - row.targetGap)
        );
      }
    });

    const rank = rankMetrics(rows);
    if (Number.isFinite(rank.positionMae)) {
      bucket.positionErrors.push(rank.positionMae);
    }
    if (Number.isFinite(rank.ndcg)) {
      bucket.ndcg.push(rank.ndcg);
    }
    bucket.top3Hits += rank.top3Hits;
    bucket.top3Possible += rank.top3Possible;
    bucket.events += 1;
  }

  events.slice(2).forEach((eventIndex) => {
    const train = training.rows.filter((row) => row.eventIndex < eventIndex);
    const test = training.rows.filter((row) => row.eventIndex === eventIndex);

    const ridge = fitRidge(train);
    const gradient = fitGradientBoosting(train);

    for (const type of Object.keys(buckets)) {
      record(type, normalizePredictedGaps(test.map(row => ({
        ...row, predictedGap: predictedGapForModel(type, row, ridge, gradient),
      }))));
    }
  });

  const baselineSamples = buckets.baseline.gapErrors.length;

  const metrics = Object.fromEntries(
    Object.entries(buckets).map(([type, bucket]) => {
      const mae = average(bucket.gapErrors, null);
      const positionMae = average(bucket.positionErrors, null);
      const ndcg = average(bucket.ndcg, null);
      const top3Rate =
        bucket.top3Possible > 0
          ? bucket.top3Hits / bucket.top3Possible
          : null;
      const coverage =
        baselineSamples > 0
          ? bucket.gapErrors.length / baselineSamples
          : 0;

      const selectionScore =
        Number.isFinite(mae) &&
        Number.isFinite(positionMae) &&
        Number.isFinite(ndcg)
          ? mae +
            positionMae * 0.075 +
            (1 - ndcg) * 1.2 +
            (Number.isFinite(top3Rate)
              ? (1 - top3Rate) * 0.12
              : 0.12) +
            Math.max(0, 0.85 - coverage) * 0.35
          : null;

      return [
        type,
        {
          mae,
          positionMae,
          ndcg,
          top3Rate,
          samples: bucket.gapErrors.length,
          events: bucket.events,
          selectionScore,
        },
      ];
    })
  );

  const candidates = Object.entries(metrics)
    .filter(([, metric]) => Number.isFinite(metric.selectionScore))
    .sort((a, b) => a[1].selectionScore - b[1].selectionScore);

  const winner = candidates.length ? candidates[0][0] : "baseline";
  const winnerMetric = metrics[winner];

  return {
    mae:
      winnerMetric && Number.isFinite(winnerMetric.mae)
        ? winnerMetric.mae
        : null,
    positionMae:
      winnerMetric && Number.isFinite(winnerMetric.positionMae)
        ? winnerMetric.positionMae
        : null,
    ndcg:
      winnerMetric && Number.isFinite(winnerMetric.ndcg)
        ? winnerMetric.ndcg
        : null,
    top3Rate:
      winnerMetric && Number.isFinite(winnerMetric.top3Rate)
        ? winnerMetric.top3Rate
        : null,
    samples: winnerMetric ? winnerMetric.samples : 0,
    winner,
    metrics,
  };
}

function modelLabel(type) {
  if (type === "ensemble") {
    return "Ensemble híbrido";
  }

  if (type === "gradient_boosting") {
    return "Gradient Boosting residual";
  }

  if (type === "ridge") {
    return "Ridge residual";
  }

  return "Baseline histórico";
}

function seededRandom(seed) {
  let value = seed >>> 0;

  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(1e-9, random());
  const v = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function calculateProbabilities(predictions, sigma, seed) {
  const counts = new Map(
    predictions.map((item) => [
      item.driverNumber,
      { pole: 0, frontRow: 0, top3: 0, q3: 0 },
    ])
  );

  const random = seededRandom(seed);
  const simulations = 3000;

  for (let run = 0; run < simulations; run += 1) {
    const order = predictions
      .map((item) => ({
        driverNumber: item.driverNumber,
        score: item.predictedGap + gaussian(random) * sigma *
          (1 + (1 - (item.shortRunConfidence ?? 0.4)) * 0.7 +
            (1 - (item.practiceCoverage ?? 1)) * 0.5),
      }))
      .sort((a, b) => a.score - b.score);

    order.forEach((item, index) => {
      const result = counts.get(item.driverNumber);
      const position = index + 1;
      if (position === 1) result.pole += 1;
      if (position <= 2) result.frontRow += 1;
      if (position <= 3) result.top3 += 1;
      if (position <= 10) result.q3 += 1;
    });
  }

  return new Map(
    [...counts.entries()].map(([number, values]) => [
      number,
      {
        pole: (values.pole / simulations) * 100,
        frontRow: (values.frontRow / simulations) * 100,
        top3: (values.top3 / simulations) * 100,
        q3: (values.q3 / simulations) * 100,
      },
    ])
  );
}

function driverColor(driver, index) {
  const raw = String(driver && driver.team_colour || "").replace("#", "");
  if (/^[0-9a-f]{6}$/i.test(raw)) return "#" + raw;

  const fallback = [
    "#00f5d4",
    "#ff3157",
    "#4d93ff",
    "#ff9f43",
    "#a06bff",
    "#56d364",
    "#f3d34a",
    "#ff4fbd",
  ];

  return fallback[index % fallback.length];
}

function formatLap(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes + ":" + remainder.toFixed(3).padStart(6, "0");
}

function percentileScore(value, values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return 50;
  const better = valid.filter((item) => item >= value).length;
  return Math.round((better / valid.length) * 100);
}


function buildFactors(item, predictions, practiceName, profileLabel) {
  const factors = [];
  const teamMedian = median(
    predictions.map((row) => row.teamFormGap),
    0.8
  );

  if (item.shortRunConfidence >= 0.72) {
    factors.push({
      type: "positive",
      text:
        "Short run de qualy bien identificado" +
        (item.selectedCompound && item.selectedCompound !== "UNKNOWN"
          ? " con " + item.selectedCompound
          : "") +
        ".",
    });
  } else if (item.shortRunConfidence < 0.45) {
    factors.push({
      type: "warning",
      text:
        "No hay una simulación de qualy clara; la práctica pesa menos en la predicción.",
    });
  }

  if (item.qualyPaceGap <= 0.25) {
    factors.push({
      type: "positive",
      text:
        "Ritmo corregido de short run a +" +
        item.qualyPaceGap.toFixed(3) +
        " s del mejor.",
    });
  } else if (item.qualyPaceGap >= 1.0) {
    factors.push({
      type: "negative",
      text:
        "El ritmo de short run queda a +" +
        item.qualyPaceGap.toFixed(3) +
        " s del mejor.",
    });
  }

  if (
    item.qualyPrior &&
    item.qualyPrior.events >= 3
  ) {
    if (item.qualyPrior.poleRate >= 0.22) {
      factors.push({
        type: "positive",
        text:
          "Forma reciente de qualy muy fuerte: pole en " +
          Math.round(item.qualyPrior.poleRate * 100) +
          "% ponderado de las últimas clasificaciones.",
      });
    } else if (item.qualyPrior.frontRowRate >= 0.42) {
      factors.push({
        type: "positive",
        text:
          "Alta frecuencia reciente de primera fila en clasificación.",
      });
    } else if (
      item.qualyPrior.weightedPosition !== null &&
      item.qualyPrior.weightedPosition >= 11
    ) {
      factors.push({
        type: "negative",
        text:
          "El historial reciente de qualy todavía está fuera de la zona delantera.",
      });
    }
  }

  if (item.teamFormGap <= teamMedian - 0.15) {
    factors.push({
      type: "positive",
      text:
        "El coche/equipo llega con una forma reciente de clasificación fuerte.",
    });
  } else if (item.teamFormGap >= teamMedian + 0.2) {
    factors.push({
      type: "negative",
      text:
        "La forma reciente del coche/equipo limita una subida artificial por una sola práctica.",
    });
  }

  if (item.teamTrend <= -0.12) {
    factors.push({
      type: "positive",
      text:
        "El coche/equipo viene mejorando en clasificación durante los últimos GP.",
    });
  } else if (item.teamTrend >= 0.15) {
    factors.push({
      type: "negative",
      text:
        "La tendencia reciente del coche/equipo es peor que su media de las últimas carreras.",
    });
  }

  if (item.teammateDelta <= -0.12) {
    factors.push({
      type: "positive",
      text:
        "Está siendo claramente más rápido que su compañero en los short runs.",
    });
  } else if (item.teammateDelta >= 0.18) {
    factors.push({
      type: "negative",
      text:
        "Su compañero está mostrando mejor ritmo de vuelta rápida.",
    });
  }

  if (
    Number.isFinite(item.longRunGap) &&
    item.longRunGap <= 0.35 &&
    factors.length < 3
  ) {
    factors.push({
      type: "positive",
      text:
        "El ritmo de tandas largas también confirma una base competitiva del coche.",
    });
  }

  if (
    Math.abs(item.trackEvolutionExposure) >= 0.12 &&
    factors.length < 3
  ) {
    factors.push({
      type: "neutral",
      text:
        "GridPulse corrigió aproximadamente " +
        Math.abs(item.trackEvolutionExposure).toFixed(2) +
        " s por evolución de pista en su vuelta representativa.",
    });
  }

  if (item.trackFitGap <= item.teamFormGap - 0.08 && factors.length < 3) {
    factors.push({
      type: "positive",
      text:
        "El equipo suele rendir mejor en pistas de perfil " +
        profileLabel.toLowerCase() +
        ".",
    });
  }

  if (!factors.length) {
    factors.push({
      type: "neutral",
      text:
        "La estimación combina short runs, forma del coche, compañero y ritmo reciente.",
    });
  }

  return factors.slice(0, 3);
}

// Outer walk-forward test: choose BOTH models on earlier events only.
// Model-selection scores are not an unbiased estimate of future accuracy.
function validatePipeline(training) {
  const events = [...new Set(training.rows.map(row => row.eventIndex))].sort((a,b) => a-b);
  const errors = [], positions = [], ndcgs = [], folds = [];
  let top3Hits = 0, top3Possible = 0;
  for (const eventIndex of events.slice(3)) {
    const past = {rows: training.rows.filter(row => row.eventIndex < eventIndex)};
    const test = training.rows.filter(row => row.eventIndex === eventIndex);
    const selection = temporalValidation(past);
    const ranking = selectRanking(past);
    const ridge = fitRidge(past.rows);
    const gradient = fitGradientBoosting(past.rows);
    const pairwise = fitSelectedRanker(past, ranking);
    const base = normalizePredictedGaps(test.map(row => ({...row,
      predictedGap: predictedGapForModel(selection.winner, row, ridge, gradient)})));
    const slots = base.map(row => row.predictedGap).sort((a,b) => a-b);
    const final = fuseRankingRows(base, pairwise, ranking.weight)
      .sort((a,b) => ranking.active
        ? a.rankFusionScore - b.rankFusionScore || a.predictedGap - b.predictedGap
        : a.predictedGap - b.predictedGap)
      .map((row,index) => ({...row, predictedGap: slots[index]}));
    const rank = rankMetrics(final);
    const gapErrors = final.filter(row => row.gapComparable).map(row => Math.abs(row.predictedGap-row.targetGap));
    errors.push(...gapErrors);
    positions.push(rank.positionMae);
    ndcgs.push(rank.ndcg);
    top3Hits += rank.top3Hits;
    top3Possible += rank.top3Possible;
    folds.push({eventIndex, model: selection.winner, rankWeight: ranking.weight,
      positionMae: rank.positionMae, mae: average(gapErrors), top3Hits: rank.top3Hits});
  }
  return {mae: average(errors), positionMae: average(positions), ndcg: average(ndcgs),
    top3Rate: top3Possible ? top3Hits/top3Possible : null, samples: errors.length,
    events: folds.length, folds};
}

function buildPrediction(
  targetBundle,
  historicalBundles,
  qualyPriors = new Map(),
  qualyHistory = [],
  circuitReferenceBundle = null
) {
  historicalBundles = historicalBundles.filter(bundle =>
    bundle.meeting.year === targetBundle.meeting.year &&
    bundle.meeting.startDate < targetBundle.meeting.startDate
  ).sort((a,b) => a.meeting.startDate - b.meeting.startDate);
  const training = buildTraining(
    historicalBundles,
    qualyHistory
  );

  const validation = temporalValidation(training);
  const rankValidation = selectRanking(training);
  const heldOut = validatePipeline(training);
  Object.assign(validation, heldOut);
  Object.assign(rankValidation, {
    positionMae: heldOut.positionMae, ndcg: heldOut.ndcg, top3Rate: heldOut.top3Rate,
  });

  const ridgeModel = fitRidge(training.rows);
  const gradientModel = fitGradientBoosting(training.rows);
  const pairwiseModel = fitSelectedRanker(training, rankValidation);

  const selectedModel =
    validation.winner === "gradient_boosting"
      ? gradientModel
      : validation.winner === "ridge"
        ? ridgeModel
        : null;
  const ensembleSelected = validation.winner === "ensemble";
  const modelActive = ensembleSelected || Boolean(selectedModel);

  const target = attachQualyPriors(
    makeTargetRows(targetBundle, training.state),
    qualyPriors
  );

  if (!target.length) {
    throw new Error(
      "No hay suficientes pilotos con vueltas representativas de práctica."
    );
  }

  let predictions = calibrateWithQualyPrior(
    target.map((row) => ({
      ...row,
      baselineGap: baselineGap(row),
      predictedGap: baselineGap(row),
    }))
  );

  predictions = predictions
    .map((row) => {
      const modelGap = ensembleSelected
        ? blendModelGaps(
            row.predictedGap,
            row,
            ridgeModel,
            gradientModel
          )
        : selectedModel
          ? applyResidualModel(
              row.predictedGap,
              selectedModel,
              row
            )
          : row.predictedGap;

      return {
        ...row,
        preModelGap: row.predictedGap,
        residualCorrection: modelGap - row.predictedGap,
        predictedGap: modelGap,
      };
    })
    .filter((row) => Number.isFinite(row.predictedGap));

  predictions = normalizePredictedGaps(predictions);

  const gapSlots = predictions
    .map((row) => row.predictedGap)
    .sort((a, b) => a - b);

  predictions = fuseRankingRows(
    predictions,
    pairwiseModel,
    rankValidation.weight
  ).sort((a, b) => {
    if (
      rankValidation.active &&
      Number.isFinite(a.rankFusionScore) &&
      Number.isFinite(b.rankFusionScore)
    ) {
      return (
        a.rankFusionScore -
          b.rankFusionScore ||
        a.predictedGap - b.predictedGap ||
        a.qualyPaceGap - b.qualyPaceGap
      );
    }

    return (
      a.predictedGap - b.predictedGap ||
      a.qualyPaceGap - b.qualyPaceGap ||
      a.qualyPriorPosition - b.qualyPriorPosition
    );
  });

  // El ranker cambia el orden, pero conserva la distribución de gaps
  // aprendida por el modelo de tiempos.
  predictions = predictions.map((row, index) => ({
    ...row,
    preRankGap: row.predictedGap,
    predictedGap: gapSlots[index],
  }));

  // Solo separa empates exactos al milisegundo; no cambia el orden aprendido.
  let previousGap = -1;
  predictions = predictions.map((row, index) => {
    let gap = row.predictedGap;

    if (index > 0 && gap - previousGap < 0.001) {
      gap = previousGap + 0.001;
    }

    previousGap = gap;
    return {
      ...row,
      predictedGap: clamp(gap, 0, 4.5),
    };
  });

  const targetPractice = practiceMetrics(targetBundle);

  if (
    !targetPractice ||
    !plausibleLapTime(targetPractice.leader)
  ) {
    throw new Error(
      "GridPulse descartó los tiempos de práctica porque no encontró una vuelta base físicamente válida para estimar la pole."
    );
  }

  const poleEstimate = estimatePoleTime(
    targetBundle,
    targetPractice,
    historicalBundles,
    circuitReferenceBundle
  );
  const estimatedPole = poleEstimate.estimatedPole;
  const poleValidation = validatePoleEstimator(
    historicalBundles
  );

  if (!plausibleLapTime(estimatedPole)) {
    throw new Error(
      "La pole estimada quedó fuera de un rango de tiempo razonable. La predicción fue cancelada para no mostrar datos corruptos."
    );
  }

  const sigma = Math.max((validation.mae ?? 0.5) * Math.sqrt(Math.PI / 2), 0.18);
  const probabilities = calculateProbabilities(
    predictions,
    sigma * 1.08,
    Number(targetBundle.meeting.meeting_key) * 97
  );

  const profileLabel =
    PROFILE_LABELS[targetBundle.profile] || PROFILE_LABELS.balanced;

  const practiceName =
    targetPractice && targetPractice.sessionNames.length
      ? targetPractice.sessionNames.join(" + ")
      : targetBundle.practice.session_name;

  predictions = predictions.map((row, index) => ({
    ...row,
    predictedPosition: index + 1,
    estimatedTime: Number.isFinite(estimatedPole)
      ? estimatedPole + row.predictedGap
      : null,
    probabilities: probabilities.get(row.driverNumber),
    color: driverColor(row.driver, index),
  }));

  predictions = predictions.map((row) => ({
    ...row,
    factors: buildFactors(
      row,
      predictions,
      practiceName,
      profileLabel
    ),
    scores: {
      practice: percentileScore(
        row.qualyPaceGap,
        predictions.map((item) => item.qualyPaceGap)
      ),
      driver: Math.round(
        (
          percentileScore(
            row.driverFormGap,
            predictions.map((item) => item.driverFormGap)
          ) *
            0.55 +
          (row.qualyPrior && Number.isFinite(row.qualyPrior.strength)
            ? row.qualyPrior.strength * 100
            : 50) *
            0.45
        )
      ),
      car: percentileScore(
        row.teamFormGap,
        predictions.map((item) => item.teamFormGap)
      ),
      track: percentileScore(
        row.trackFitGap,
        predictions.map((item) => item.trackFitGap)
      ),
    },
  }));

  const actual = qualifyingMetrics(targetBundle);
  let backtest = null;

  if (actual) {
    const compared = predictions
      .map((row) => {
        const real = actual.byDriver.get(row.driverNumber);
        return real
          ? {
              predicted: row.predictedPosition,
              actual: real.position,
            }
          : null;
      })
      .filter(Boolean);

    if (compared.length) {
      const predictedTop3 = compared.filter((row) => row.predicted <= 3);

      backtest = {
        positionMae: average(
          compared.map((row) => Math.abs(row.predicted - row.actual)),
          null
        ),
        poleTimeError: Math.abs(
          estimatedPole - actual.poleDuration
        ),
        actualPole: actual.poleDuration,
        top3Hits: predictedTop3.filter((row) => row.actual <= 3).length,
        positions: new Map(
          [...actual.byDriver.entries()].map(([number, row]) => [
            number,
            row.position,
          ])
        ),
      };
    }
  }

  const averageConfidence = average(
    predictions.map((row) => row.shortRunConfidence),
    0.45
  );

  const priorCoverage = predictions.filter(
    (row) => row.qualyPrior && row.qualyPrior.events >= 3
  ).length;
  const priorCoverageRatio =
    predictions.length > 0
      ? priorCoverage / predictions.length
      : 0;

  const gapConfidence = clamp(
    1 - (validation.mae ?? 0.85) / 1.4,
    0,
    1
  );
  const effectivePositionMae =
    rankValidation.positionMae ??
    validation.positionMae;
  const effectiveNdcg =
    rankValidation.ndcg ??
    validation.ndcg;
  const effectiveTop3Rate =
    rankValidation.top3Rate ??
    validation.top3Rate;

  const rankingConfidence = clamp(
    1 - (effectivePositionMae ?? 4.5) / 6,
    0,
    1
  );
  const ndcgConfidence = clamp(
    effectiveNdcg ?? 0.72,
    0,
    1
  );
  const top3Confidence = clamp(
    effectiveTop3Rate ?? 0.35,
    0,
    1
  );
  const poleConfidence = clamp(
    1 - (poleValidation.mae ?? 0.7) / 1.1,
    0,
    1
  );
  const dataConfidence = clamp(
    (historicalBundles.length / TRAINING_EVENTS) * 0.5 +
      averageConfidence * 0.3 +
      priorCoverageRatio * 0.2,
    0,
    1
  );

  const confidence = clamp(
    Math.round(
      (
        rankingConfidence * 0.28 +
        ndcgConfidence * 0.22 +
        gapConfidence * 0.18 +
        top3Confidence * 0.14 +
        poleConfidence * 0.1 +
        dataConfidence * 0.08
      ) * 100
    ),
    0,
    heldOut.events < 3 ? 50 : 92
  );

  return {
    predictions,
    validation,
    rankValidation,
    backtest,
    confidence,
    estimatedPole,
    poleEstimate,
    poleValidation,
    practiceName,
    profileLabel,
    trainingEvents: historicalBundles.length,
    trainingRows: training.rows.length,
    modelActive,
    modelSamples: ensembleSelected
      ? Math.max(
          ridgeModel ? ridgeModel.sampleCount : 0,
          gradientModel ? gradientModel.sampleCount : 0
        )
      : selectedModel
        ? selectedModel.sampleCount
        : training.rows.length,
    selectedModel: validation.winner,
    selectedModelLabel:
      modelLabel(validation.winner) +
      (rankValidation.active
        ? rankValidation.mode === "recent_form" ? " + Forma reciente" : " + Pairwise"
        : ""),
    modelMetrics: validation.metrics,
    rankerActive: rankValidation.active,
    rankerWeight: rankValidation.weight,
    rankerPairs:
      pairwiseModel ? pairwiseModel.pairCount : 0,
    qualyPriorCoverage: priorCoverage,
    shortRuns: targetPractice ? targetPractice.shortRuns : 0,
    longRuns: targetPractice ? targetPractice.longRuns : 0,
    trackEvolution: targetPractice ? targetPractice.evolution : 0,
    practiceSessions:
      targetPractice && targetPractice.sessionNames
        ? targetPractice.sessionNames
        : [],
  };
}


export { PROFILE_LABELS, TRAINING_EVENTS, YEARS, analyzePracticeSession, average, baselineGap, buildPrediction, buildQualyPriors, buildTraining, calculateProbabilities, calibrateWithQualyPrior, clamp, cleanResults, estimateTrackEvolution, fitGradientBoosting, fitRidge, formatLap, groupMeetings, loadBundle, loadQualifyingHistory, makeTargetRows, median, openF1, practiceMetrics, practicesBeforeQualy, predictedGapForModel, qualifyingMetrics, qualifyingSession, rankMetrics, rankingValidation, safeNumber, temporalValidation, trackProfile };
