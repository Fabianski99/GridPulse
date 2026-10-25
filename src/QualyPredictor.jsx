import { useEffect, useMemo, useState } from "react";
import "./QualyPredictor.css";

const OPENF1 = "https://api.openf1.org/v1";
const YEARS = [2025, 2026];
const TRAINING_EVENTS = 5;
const REQUEST_GAP_MS = 430;
const CACHE_TTL_MS = 30 * 60 * 1000;
const FEATURE_KEYS = [
  "qualyPaceGap",
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
const INFLIGHT = new Map();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function safeNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values, fallback = null) {
  const valid = (values || []).map(Number).filter(Number.isFinite);
  if (!valid.length) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values, fallback = null) {
  const valid = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
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
      if (parsed !== null) return parsed;
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
        throw new Error("OpenF1 respondió " + response.status);
      }

      return response.json();
    }

    throw new Error("OpenF1 alcanzó temporalmente el límite de peticiones.");
  });

  requestQueue = task.catch(() => undefined);
  return task;
}

async function openF1(endpoint, params, optional) {
  const url = OPENF1 + "/" + endpoint + "?" + createQuery(params);
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
  if (/Practice 2/i.test(name || "")) return 0.72;
  if (/Practice 1/i.test(name || "")) return 0.48;
  return 0.45 + (index / Math.max(1, total - 1)) * 0.45;
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
      positionValue: safeNumber(row.position),
      lapsValue: safeNumber(row.number_of_laps, 0),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.durationValue) &&
        Number.isFinite(row.positionValue)
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

function estimateTrackEvolution(laps, session) {
  const sessionStart = new Date(session.date_start).getTime();
  const sessionEnd = new Date(session.date_end).getTime();
  const duration = Math.max(1, sessionEnd - sessionStart);

  const clean = (laps || [])
    .filter(
      (lap) =>
        !lap.is_pit_out_lap &&
        Number.isFinite(safeNumber(lap.lap_duration)) &&
        Number.isFinite(new Date(lap.date_start).getTime())
    )
    .map((lap) => ({
      time: Number(lap.lap_duration),
      progress: clamp(
        (new Date(lap.date_start).getTime() - sessionStart) / duration,
        0,
        1
      ),
    }));

  if (clean.length < 18) return 0;

  const best = Math.min(...clean.map((lap) => lap.time));
  const representative = clean.filter((lap) => lap.time <= best * 1.08);

  const early = representative
    .filter((lap) => lap.progress <= 0.38)
    .map((lap) => lap.time)
    .sort((a, b) => a - b)
    .slice(0, 8);

  const late = representative
    .filter((lap) => lap.progress >= 0.62)
    .map((lap) => lap.time)
    .sort((a, b) => a - b)
    .slice(0, 8);

  if (early.length < 3 || late.length < 3) return 0;

  return clamp(median(early, 0) - median(late, 0), -2.5, 2.5);
}

function analyzePracticeSession(session, laps, stints, drivers) {
  const driverInfo = new Map(
    (drivers || []).map((driver) => [Number(driver.driver_number), driver])
  );

  const sessionStart = new Date(session.date_start).getTime();
  const sessionEnd = new Date(session.date_end).getTime();
  const sessionDuration = Math.max(1, sessionEnd - sessionStart);
  const evolution = estimateTrackEvolution(laps, session);

  const clean = (laps || [])
    .filter(
      (lap) =>
        !lap.is_pit_out_lap &&
        Number.isFinite(safeNumber(lap.lap_duration)) &&
        Number.isFinite(safeNumber(lap.driver_number)) &&
        Number.isFinite(safeNumber(lap.lap_number))
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
    };
  }

  const grouped = new Map();

  clean.forEach((lap) => {
    if (!grouped.has(lap.driverNumber)) grouped.set(lap.driverNumber, []);
    grouped.get(lap.driverNumber).push(lap);
  });

  const raw = new Map();

  grouped.forEach((driverLaps, driverNumber) => {
    const ordered = [...driverLaps].sort((a, b) => a.lapNumber - b.lapNumber);
    const fastest = Math.min(...ordered.map((lap) => lap.adjustedDuration));

    let candidates = ordered.filter((lap) => {
      const shortRun = lap.stintLength <= 4;
      const suitableTyre =
        lap.compound === "SOFT" ||
        (lap.compound === "MEDIUM" && lap.tyreAge <= 2);

      return (
        lap.adjustedDuration <= fastest * 1.018 &&
        lap.tyreAge <= 4 &&
        (shortRun || suitableTyre)
      );
    });

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

    const shortRunConfidence = qualyLap
      ? clamp(
          0.18 +
            compoundWeight(qualyLap.compound) * 0.42 +
            (qualyLap.tyreAge <= 1 ? 0.18 : qualyLap.tyreAge <= 3 ? 0.1 : 0) +
            (qualyLap.stintLength <= 4 ? 0.22 : 0.05),
          0.15,
          1
        )
      : 0.15;

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
      selectedProgress: qualyLap ? qualyLap.progress : 0.5,
      selectedCompound: qualyLap ? qualyLap.compound : "UNKNOWN",
      selectedTyreAge: qualyLap ? qualyLap.tyreAge : null,
      selectedStintLength: qualyLap ? qualyLap.stintLength : null,
      shortRunConfidence,
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
    .filter(Number.isFinite);
  const longRunValues = [...raw.values()]
    .map((item) => item.longRunDuration)
    .filter(Number.isFinite);

  const leaderQualy = qualyValues.length ? Math.min(...qualyValues) : null;
  const leaderLongRun = longRunValues.length ? Math.min(...longRunValues) : null;

  const byDriver = new Map();

  raw.forEach((item, driverNumber) => {
    byDriver.set(driverNumber, {
      ...item,
      qualyGap:
        Number.isFinite(leaderQualy) && Number.isFinite(item.qualyDuration)
          ? Math.max(0, item.qualyDuration - leaderQualy)
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
    leaderLongRun,
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

  const analyses = [];

  for (const practice of practices) {
    const [laps, stints] = await Promise.all([
      openF1("laps", { session_key: practice.session_key }, false),
      openF1("stints", { session_key: practice.session_key }, false),
    ]);

    analyses.push(
      analyzePracticeSession(practice, laps, stints, drivers)
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

function practiceMetrics(bundle) {
  const analyses = bundle.practiceAnalyses || [];
  if (!analyses.length) return null;

  const totals = new Map();
  let totalWeight = 0;
  let evolutionWeighted = 0;

  analyses.forEach((analysis, index) => {
    const weight = practiceSessionWeight(
      analysis.session.session_name,
      index,
      analyses.length
    );

    totalWeight += weight;
    evolutionWeighted += analysis.evolution * weight;

    analysis.byDriver.forEach((item, driverNumber) => {
      if (!totals.has(driverNumber)) {
        totals.set(driverNumber, {
          weight: 0,
          qualyPaceGap: 0,
          longRunGap: 0,
          longRunWeight: 0,
          shortRunConfidence: 0,
          teammateDelta: 0,
          trackEvolutionExposure: 0,
          practiceLaps: 0,
          topSpeed: 0,
          latestRawDuration: null,
          selectedCompound: "UNKNOWN",
          selectedTyreAge: null,
          driver: item.driver,
        });
      }

      const target = totals.get(driverNumber);

      target.weight += weight;
      target.qualyPaceGap += item.qualyGap * weight;
      target.shortRunConfidence += item.shortRunConfidence * weight;
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
        target.selectedCompound = item.selectedCompound;
        target.selectedTyreAge = item.selectedTyreAge;
      }
    });
  });

  const rows = [];

  totals.forEach((item, driverNumber) => {
    const weight = Math.max(item.weight, 0.001);

    rows.push({
      driverNumber,
      driver: item.driver,
      qualyPaceGap: item.qualyPaceGap / weight,
      longRunGap:
        item.longRunWeight > 0
          ? item.longRunGap / item.longRunWeight
          : null,
      shortRunConfidence: item.shortRunConfidence / weight,
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

  rows.sort((a, b) => a.qualyPaceGap - b.qualyPaceGap);

  rows.forEach((row, index) => {
    row.position = index + 1;
  });

  const latestLeader = analyses[analyses.length - 1].leaderQualy;
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
    byDriver: new Map(rows.map((row) => [row.driverNumber, row])),
    rows,
    sessionNames,
    evolution:
      totalWeight > 0 ? evolutionWeighted / totalWeight : 0,
    shortRuns: rows.filter((row) => row.shortRunConfidence >= 0.62).length,
    longRuns: rows.filter((row) => Number.isFinite(row.longRunGap)).length,
  };
}

function qualifyingMetrics(bundle) {
  if (!bundle.qualifyingRows.length) return null;

  const pole =
    bundle.qualifyingRows.find((row) => row.positionValue === 1) ||
    [...bundle.qualifyingRows].sort(
      (a, b) => a.positionValue - b.positionValue
    )[0];

  if (!pole || !Number.isFinite(pole.durationValue)) return null;

  return {
    poleDuration: pole.durationValue,
    byDriver: new Map(
      bundle.qualifyingRows.map((row) => [
        Number(row.driver_number),
        {
          gap: Math.max(0, row.durationValue - pole.durationValue),
          position: row.positionValue,
        },
      ])
    ),
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

function buildTraining(bundles) {
  const driverGap = new Map();
  const driverPosition = new Map();
  const teamGap = new Map();
  const teamProfileGap = new Map();
  const globalGaps = [];
  const globalPositions = [];
  const rows = [];

  bundles.forEach((bundle, eventIndex) => {
    const practice = practiceMetrics(bundle);
    const qualifying = qualifyingMetrics(bundle);
    if (!practice || !qualifying) return;

    const drivers = new Map(
      bundle.drivers.map((driver) => [Number(driver.driver_number), driver])
    );

    const globalGap = average(globalGaps, 0.85);
    const globalPosition = average(globalPositions, 10.5);

    practice.rows.forEach((p) => {
      const number = Number(p.driverNumber);
      const target = qualifying.byDriver.get(number);
      const driver = drivers.get(number) || p.driver;

      if (!p || !target || !driver || !driver.team_name) return;
      if (p.qualyPaceGap > 5 || target.gap > 5) return;

      const team = driver.team_name;
      const profileKey = team + "::" + bundle.profile;
      const teamFallback = recentAverage(teamGap, team, globalGap);

      rows.push({
        eventIndex,
        driverNumber: number,
        driver,
        team,
        qualyPaceGap: p.qualyPaceGap,
        practicePosition: (p.position - 1) / 21,
        shortRunConfidence: p.shortRunConfidence,
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
        targetPosition: target.position,
      });
    });

    qualifying.byDriver.forEach((target, number) => {
      const driver = drivers.get(number);
      if (!driver || !driver.team_name) return;

      pushRecent(driverGap, number, target.gap);
      pushRecent(driverPosition, number, target.position);
      pushRecent(teamGap, driver.team_name, target.gap);
      pushRecent(
        teamProfileGap,
        driver.team_name + "::" + bundle.profile,
        target.gap
      );

      globalGaps.push(target.gap);
      globalPositions.push(target.position);
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
        practicePosition: (p.position - 1) / 21,
        practicePositionRaw: p.position,
        shortRunConfidence: p.shortRunConfidence,
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

function fitRidge(rows, lambda = 0.85) {
  if (rows.length < FEATURE_KEYS.length + 4) return null;

  const means = {};
  const scales = {};

  FEATURE_KEYS.forEach((key) => {
    means[key] = average(rows.map((row) => row[key]), 0);
    const variance = average(
      rows.map((row) => Math.pow(row[key] - means[key], 2)),
      0
    );
    scales[key] = Math.sqrt(variance) || 1;
  });

  const width = FEATURE_KEYS.length + 1;
  const xtx = Array.from({ length: width }, () =>
    Array.from({ length: width }, () => 0)
  );
  const xty = Array.from({ length: width }, () => 0);

  rows.forEach((row) => {
    const vector = [
      1,
      ...FEATURE_KEYS.map(
        (key) => (row[key] - means[key]) / scales[key]
      ),
    ];

    vector.forEach((a, rowIndex) => {
      xty[rowIndex] += a * row.targetGap;

      vector.forEach((b, columnIndex) => {
        xtx[rowIndex][columnIndex] += a * b;
      });
    });
  });

  for (let index = 1; index < width; index += 1) {
    xtx[index][index] += lambda;
  }

  return {
    coefficients: solveLinearSystem(xtx, xty),
    means,
    scales,
    sampleCount: rows.length,
  };
}


function predictGap(model, row) {
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

function baselineGap(row) {
  const confidence = clamp(row.shortRunConfidence || 0.4, 0.15, 1);
  const longRun = Number.isFinite(row.longRunGap)
    ? row.longRunGap
    : row.teamFormGap;
  const teammatePenalty = clamp(row.teammateDelta || 0, -0.8, 0.8);

  const practiceWeight = 0.24 + confidence * 0.14;
  const teamWeight = 0.28;
  const driverWeight = 0.12;
  const trackWeight = 0.1;
  const longRunWeight = 0.06;
  const teammateWeight = 0.08;
  const evolutionWeight = 0.08;
  const total =
    practiceWeight +
    teamWeight +
    driverWeight +
    trackWeight +
    longRunWeight +
    teammateWeight +
    evolutionWeight;

  return Math.max(
    0,
    (
      row.qualyPaceGap * practiceWeight +
      row.teamFormGap * teamWeight +
      row.driverFormGap * driverWeight +
      row.trackFitGap * trackWeight +
      longRun * longRunWeight +
      Math.max(0, teammatePenalty) * teammateWeight +
      Math.max(0, row.teamFormGap + row.teamTrend) * evolutionWeight
    ) / total
  );
}

function blendedPrediction(model, row) {
  const baseline = baselineGap(row);
  const mlRaw = predictGap(model, row);

  const mlClipped = clamp(
    mlRaw,
    Math.max(0, baseline - 0.45),
    baseline + 0.45
  );

  const confidence = clamp(row.shortRunConfidence || 0.4, 0.15, 1);
  const mlWeight = 0.34 + confidence * 0.16;

  return Math.max(
    0,
    baseline * (1 - mlWeight) + mlClipped * mlWeight
  );
}

function temporalValidation(training) {
  const events = [...new Set(training.rows.map((row) => row.eventIndex))];
  const errors = [];

  events.slice(2).forEach((eventIndex) => {
    const train = training.rows.filter((row) => row.eventIndex < eventIndex);
    const test = training.rows.filter((row) => row.eventIndex === eventIndex);
    const model = fitRidge(train);

    if (!model) return;

    test.forEach((row) => {
      const prediction = blendedPrediction(model, row);
      errors.push(Math.abs(prediction - row.targetGap));
    });
  });

  return {
    mae: average(errors, null),
    samples: errors.length,
  };
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
  const simulations = 450;

  for (let run = 0; run < simulations; run += 1) {
    const order = predictions
      .map((item) => ({
        driverNumber: item.driverNumber,
        score: item.predictedGap + gaussian(random) * sigma,
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

function buildPrediction(targetBundle, historicalBundles) {
  const training = buildTraining(historicalBundles);
  const model = fitRidge(training.rows);

  if (!model) {
    throw new Error(
      "Todavía no hay suficientes observaciones para entrenar el prototipo."
    );
  }

  const validation = temporalValidation(training);
  const target = makeTargetRows(targetBundle, training.state);

  if (!target.length) {
    throw new Error(
      "No hay suficientes pilotos con vueltas representativas de práctica."
    );
  }

  let predictions = target
    .map((row) => ({
      ...row,
      modelGap: predictGap(model, row),
      baselineGap: baselineGap(row),
      predictedGap: blendedPrediction(model, row),
    }))
    .filter((row) => Number.isFinite(row.predictedGap));

  const minimum = Math.min(...predictions.map((row) => row.predictedGap));

  predictions = predictions
    .map((row) => ({
      ...row,
      predictedGap: Math.max(0, row.predictedGap - minimum),
    }))
    .sort((a, b) => a.predictedGap - b.predictedGap);

  const ratios = historicalBundles
    .map((bundle) => {
      const practice = practiceMetrics(bundle);
      const qualifying = qualifyingMetrics(bundle);
      return practice && qualifying && Number.isFinite(practice.leader)
        ? qualifying.poleDuration / practice.leader
        : null;
    })
    .filter(Number.isFinite);

  const targetPractice = practiceMetrics(targetBundle);
  const estimatedPole =
    targetPractice && Number.isFinite(targetPractice.leader)
      ? targetPractice.leader * median(ratios, 0.985)
      : null;

  const sigma = Math.max(validation.mae || 0.24, 0.12);
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
      driver: percentileScore(
        row.driverFormGap,
        predictions.map((item) => item.driverFormGap)
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

  const confidence = clamp(
    Math.round(
      82 -
        (validation.mae || 0.28) * 38 -
        Math.max(0, 4 - historicalBundles.length) * 7 +
        averageConfidence * 10
    ),
    35,
    88
  );

  return {
    predictions,
    validation,
    backtest,
    confidence,
    estimatedPole,
    practiceName,
    profileLabel,
    trainingEvents: historicalBundles.length,
    trainingRows: training.rows.length,
    shortRuns: targetPractice ? targetPractice.shortRuns : 0,
    longRuns: targetPractice ? targetPractice.longRuns : 0,
    trackEvolution: targetPractice ? targetPractice.evolution : 0,
    practiceSessions:
      targetPractice && targetPractice.sessionNames
        ? targetPractice.sessionNames
        : [],
  };
}

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
            meeting.startDate < selectedMeeting.startDate &&
            qualifyingSession(meeting) &&
            choosePractice(meeting, false)
        )
        .slice(-TRAINING_EVENTS);

      if (previous.length < 3) {
        throw new Error(
          "El prototipo necesita al menos tres GP anteriores con prácticas y clasificación."
        );
      }

      const historicalBundles = [];

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
        } catch {
          // Saltamos fines de semana históricos incompletos.
        }
      }

      if (historicalBundles.length < 3) {
        throw new Error(
          "No se pudieron recuperar suficientes GP históricos completos."
        );
      }

      setProgress(
        "Leyendo " + selectedMeeting.country_name + ": prácticas, stints y vueltas representativas…"
      );

      const targetBundle = await loadBundle(selectedMeeting, true);

      setProgress("Entrenando Ridge Regression y simulando 450 escenarios…");

      const result = buildPrediction(targetBundle, historicalBundles);
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
          <strong>Ridge Regression</strong>
          <small>Validación temporal · Monte Carlo</small>
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
              <small>{prediction.trainingEvents} GP anteriores</small>
            </article>

            <article>
              <span>Error temporal</span>
              <strong>
                {prediction.validation.mae !== null
                  ? "±" + prediction.validation.mae.toFixed(3) + " s"
                  : "Sin validar"}
              </strong>
              <small>{prediction.validation.samples} observaciones de prueba</small>
            </article>

            <article>
              <span>Confianza del modelo</span>
              <strong>{prediction.confidence}%</strong>
              <i><b style={{ width: prediction.confidence + "%" }} /></i>
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
              <strong>Short run + forma</strong>
              <small>La práctica ya no se interpreta como una tabla de tiempos bruta</small>
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
                Ridge Regression estima el gap esperado de cada piloto. Después
                se ordenan los tiempos y 450 simulaciones alrededor del error
                histórico generan las probabilidades.
              </p>
            </div>

            <div className="qualy-method-features">
              <span>Variables actuales</span>
              <strong>Short runs de vuelta rápida</strong>
              <strong>Long runs separados del ritmo de qualy</strong>
              <strong>Compuesto, edad de neumático y stint</strong>
              <strong>Evolución de pista durante la práctica</strong>
              <strong>Forma y tendencia reciente del coche</strong>
              <strong>Comparación con el compañero</strong>
              <strong>Encaje con circuitos similares</strong>
            </div>
          </section>

          <p className="qualy-disclaimer">
            Modelo experimental. Cambios de setup, combustible, neumáticos,
            tráfico, clima y evolución de pista pueden alterar de forma
            importante la clasificación real.
          </p>
        </>
      )}
    </main>
  );
}
