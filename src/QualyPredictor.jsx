import { useEffect, useMemo, useState } from "react";
import "./QualyPredictor.css";

const OPENF1 = "https://api.openf1.org/v1";
const YEARS = [2025, 2026];
const TRAINING_EVENTS = 6;
const REQUEST_GAP_MS = 430;
const CACHE_TTL_MS = 30 * 60 * 1000;
const FEATURE_KEYS = [
  "practiceGap",
  "practicePosition",
  "practiceLaps",
  "driverFormGap",
  "teamFormGap",
  "trackFitGap",
  "driverFormPosition",
  "practiceQuality",
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

function practiceQuality(name) {
  if (/Practice 3/i.test(name || "")) return 1;
  if (/Practice 2/i.test(name || "")) return 0.82;
  return 0.62;
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
        startDate: Math.min(...sessionsSorted.map((item) => new Date(item.date_start).getTime())),
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

function practicesBeforeQualy(meeting) {
  const qualifying = qualifyingSession(meeting);
  const qualifyingStart = qualifying
    ? new Date(qualifying.date_start).getTime()
    : Infinity;

  return (meeting && meeting.sessions || [])
    .filter(
      (session) =>
        session.session_type === "Practice" &&
        !session.is_cancelled &&
        new Date(session.date_end).getTime() < qualifyingStart
    )
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
}

function choosePractice(meeting, target) {
  let sessions = practicesBeforeQualy(meeting);
  if (target) {
    sessions = sessions.filter(
      (session) => new Date(session.date_end).getTime() <= Date.now()
    );
  }
  return sessions[sessions.length - 1] || null;
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

async function loadBundle(meeting, target) {
  const practice = choosePractice(meeting, target);
  const qualifying = qualifyingSession(meeting);

  if (!practice || !qualifying) {
    throw new Error(
      target
        ? "Este GP todavía no tiene una práctica utilizable antes de clasificación."
        : "Fin de semana histórico incompleto."
    );
  }

  const qualifyingFinished =
    new Date(qualifying.date_end).getTime() <= Date.now();

  const [practiceRows, drivers, qualifyingRows] = await Promise.all([
    openF1("session_result", { session_key: practice.session_key }, false),
    openF1("drivers", { session_key: practice.session_key }, false),
    qualifyingFinished || !target
      ? openF1("session_result", { session_key: qualifying.session_key }, !!target)
      : Promise.resolve([]),
  ]);

  return {
    meeting,
    practice,
    qualifying,
    practiceRows: cleanResults(practiceRows),
    qualifyingRows: cleanResults(qualifyingRows),
    drivers,
    profile: trackProfile(meeting),
  };
}

function practiceMetrics(bundle) {
  if (!bundle.practiceRows.length) return null;
  const leader = Math.min(...bundle.practiceRows.map((row) => row.durationValue));

  return {
    leader,
    byDriver: new Map(
      bundle.practiceRows.map((row) => [
        Number(row.driver_number),
        {
          gap: Math.max(0, row.durationValue - leader),
          position: row.positionValue,
          laps: row.lapsValue,
          duration: row.durationValue,
        },
      ])
    ),
  };
}

function qualifyingMetrics(bundle) {
  if (!bundle.qualifyingRows.length) return null;

  const pole =
    bundle.qualifyingRows.find((row) => row.positionValue === 1) ||
    [...bundle.qualifyingRows].sort((a, b) => a.positionValue - b.positionValue)[0];

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

    bundle.practiceRows.forEach((row) => {
      const number = Number(row.driver_number);
      const p = practice.byDriver.get(number);
      const target = qualifying.byDriver.get(number);
      const driver = drivers.get(number);

      if (!p || !target || !driver || !driver.team_name) return;
      if (p.gap > 6 || target.gap > 5) return;

      const team = driver.team_name;
      const profileKey = team + "::" + bundle.profile;

      rows.push({
        eventIndex,
        driverNumber: number,
        driver,
        team,
        practiceGap: p.gap,
        practicePosition: (p.position - 1) / 21,
        practiceLaps: clamp(p.laps / 30, 0, 1.4),
        driverFormGap: recentAverage(driverGap, number, globalGap),
        teamFormGap: recentAverage(teamGap, team, globalGap),
        trackFitGap: recentAverage(
          teamProfileGap,
          profileKey,
          recentAverage(teamGap, team, globalGap)
        ),
        driverFormPosition:
          recentAverage(driverPosition, number, globalPosition) / 20,
        practiceQuality: practiceQuality(bundle.practice.session_name),
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

  return bundle.practiceRows
    .map((row) => {
      const number = Number(row.driver_number);
      const p = practice.byDriver.get(number);
      const driver = drivers.get(number);
      if (!p || !driver || !driver.team_name) return null;

      const team = driver.team_name;
      const profileKey = team + "::" + bundle.profile;

      return {
        driverNumber: number,
        driver,
        team,
        practiceGap: p.gap,
        practicePosition: (p.position - 1) / 21,
        practicePositionRaw: p.position,
        practiceLaps: clamp(p.laps / 30, 0, 1.4),
        practiceDuration: p.duration,
        driverFormGap: recentAverage(
          state.driverGap,
          number,
          state.globalGap
        ),
        teamFormGap: recentAverage(
          state.teamGap,
          team,
          state.globalGap
        ),
        trackFitGap: recentAverage(
          state.teamProfileGap,
          profileKey,
          recentAverage(state.teamGap, team, state.globalGap)
        ),
        driverFormPosition:
          recentAverage(
            state.driverPosition,
            number,
            state.globalPosition
          ) / 20,
        practiceQuality: practiceQuality(bundle.practice.session_name),
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

function temporalValidation(training) {
  const events = [...new Set(training.rows.map((row) => row.eventIndex))];
  const errors = [];

  events.slice(2).forEach((eventIndex) => {
    const train = training.rows.filter((row) => row.eventIndex < eventIndex);
    const test = training.rows.filter((row) => row.eventIndex === eventIndex);
    const model = fitRidge(train);

    if (!model) return;

    test.forEach((row) => {
      const prediction = Math.max(0, predictGap(model, row));
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
  const formMedian = median(
    predictions.map((row) => row.driverFormGap),
    0.8
  );

  if (item.practicePositionRaw <= 3) {
    factors.push({
      type: "positive",
      text: "Ritmo fuerte: P" + item.practicePositionRaw + " en " + practiceName + ".",
    });
  } else if (item.practicePositionRaw >= 12) {
    factors.push({
      type: "negative",
      text: "La mejor vuelta de práctica queda en P" + item.practicePositionRaw + ".",
    });
  }

  if (item.driverFormGap <= formMedian - 0.12) {
    factors.push({
      type: "positive",
      text: "La forma reciente del piloto favorece la predicción.",
    });
  } else if (item.driverFormGap >= formMedian + 0.18) {
    factors.push({
      type: "negative",
      text: "La forma reciente en clasificación penaliza la estimación.",
    });
  }

  if (item.trackFitGap <= item.teamFormGap - 0.08) {
    factors.push({
      type: "positive",
      text: "El equipo suele rendir mejor en pistas de perfil " + profileLabel.toLowerCase() + ".",
    });
  } else if (item.trackFitGap >= item.teamFormGap + 0.12) {
    factors.push({
      type: "negative",
      text: "Este tipo de pista no ha sido el mejor contexto reciente del equipo.",
    });
  }

  if (item.practiceLaps < 0.25) {
    factors.push({
      type: "warning",
      text: "Hay pocas vueltas representativas; la incertidumbre aumenta.",
    });
  }

  if (!factors.length) {
    factors.push({
      type: "neutral",
      text: "El resultado se apoya principalmente en ritmo de práctica y forma reciente.",
    });
  }

  return factors.slice(0, 3);
}

function buildPrediction(targetBundle, historicalBundles) {
  const training = buildTraining(historicalBundles);
  const model = fitRidge(training.rows);

  if (!model) {
    throw new Error("Todavía no hay suficientes observaciones para entrenar el prototipo.");
  }

  const validation = temporalValidation(training);
  const target = makeTargetRows(targetBundle, training.state);

  if (!target.length) {
    throw new Error("No hay suficientes pilotos con tiempos válidos de práctica.");
  }

  let predictions = target
    .map((row) => ({
      ...row,
      predictedGap: Math.max(0, predictGap(model, row)),
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
      return practice && qualifying
        ? qualifying.poleDuration / practice.leader
        : null;
    })
    .filter(Number.isFinite);

  const targetPractice = practiceMetrics(targetBundle);
  const estimatedPole =
    targetPractice.leader * median(ratios, 0.985);
  const sigma = Math.max(validation.mae || 0.22, 0.1);
  const probabilities = calculateProbabilities(
    predictions,
    sigma * 1.1,
    Number(targetBundle.meeting.meeting_key) * 97
  );

  const profileLabel =
    PROFILE_LABELS[targetBundle.profile] || PROFILE_LABELS.balanced;
  const practiceName = targetBundle.practice.session_name;

  predictions = predictions.map((row, index) => ({
    ...row,
    predictedPosition: index + 1,
    estimatedTime: estimatedPole + row.predictedGap,
    probabilities: probabilities.get(row.driverNumber),
    color: driverColor(row.driver, index),
  }));

  predictions = predictions.map((row) => ({
    ...row,
    factors: buildFactors(row, predictions, practiceName, profileLabel),
    scores: {
      practice: percentileScore(
        row.practiceGap,
        predictions.map((item) => item.practiceGap)
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

  const confidence = clamp(
    Math.round(
      88 -
        (validation.mae || 0.25) * 45 -
        Math.max(0, 4 - historicalBundles.length) * 8 -
        (practiceQuality(practiceName) < 0.8 ? 7 : 0)
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
        "Leyendo " + selectedMeeting.country_name + " y la última práctica disponible…"
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
            Una primera estimación de clasificación basada en ritmo de prácticas,
            forma reciente de piloto y equipo, y comportamiento en circuitos de perfil similar.
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
              <span>Práctica utilizada</span>
              <strong>{prediction.practiceName}</strong>
              <small>Última práctica previa a qualy</small>
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
              <strong>Gap y posición en práctica</strong>
              <strong>Volumen de vueltas</strong>
              <strong>Forma reciente del piloto</strong>
              <strong>Forma reciente del equipo</strong>
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
