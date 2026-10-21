import { useEffect, useMemo, useRef, useState } from "react";
import { CIRCUIT_TRACKS } from "./CircuitTracks";
import { CIRCUIT_CORNER_PROGRESS_OVERRIDES } from "./CircuitCornerOverrides";
import "./LapReplay.css";

const SECTORS = ["s1", "s2", "s3"];
const TRAIL_HEAD_GAP = 10;

const CIRCUIT_CORNER_COUNTS = Object.freeze({
  albert_park: 14,
  shanghai: 16,
  suzuka: 18,
  miami: 19,
  villeneuve: 14,
  monaco: 19,
  catalunya: 14,
  red_bull_ring: 10,
  silverstone: 18,
  spa: 19,
  hungaroring: 14,
  zandvoort: 14,
  monza: 11,
  madring: 22,
  baku: 20,
  sepang: 15,
  marina_bay: 19,
  americas: 20,
  rodriguez: 17,
  interlagos: 15,
  vegas: 17,
  losail: 16,
  yas_marina: 16,
  portimao: 15,
  istanbul: 14,
});

const CIRCUIT_ALIASES = [
  ["bahrain", ["sakhir", "bahrain"]],
  ["albert_park", ["melbourne", "australia", "albert park"]],
  ["shanghai", ["shanghai", "china"]],
  ["suzuka", ["suzuka", "japan"]],
  ["jeddah", ["jeddah", "saudi arabia"]],
  ["miami", ["miami"]],
  ["villeneuve", ["montreal", "montréal", "canada", "gilles villeneuve"]],
  ["monaco", ["monaco", "monte carlo"]],
  ["catalunya", ["barcelona", "catalunya", "catalonia"]],
  ["red_bull_ring", ["spielberg", "austria", "red bull ring"]],
  ["silverstone", ["silverstone", "great britain", "united kingdom", "british"]],
  ["spa", ["spa-francorchamps", "spa", "belgium"]],
  ["hungaroring", ["hungaroring", "budapest", "hungary"]],
  ["zandvoort", ["zandvoort", "netherlands", "dutch"]],
  ["monza", ["monza", "italy", "italian"]],
  ["madring", ["madrid", "madring"]],
  ["baku", ["baku", "azerbaijan"]],
  ["sepang", ["sepang", "kuala lumpur", "malaysia"]],
  ["marina_bay", ["singapore", "marina bay"]],
  ["americas", ["austin", "circuit of the americas", "united states"]],
  ["rodriguez", ["mexico city", "mexico", "hermanos rodriguez"]],
  ["interlagos", ["sao paulo", "são paulo", "interlagos", "brazil"]],
  ["vegas", ["las vegas", "vegas"]],
  ["losail", ["lusail", "losail", "qatar"]],
  ["yas_marina", ["abu dhabi", "yas marina", "united arab emirates"]],
];

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveCircuitId(meeting) {
  const haystack = normalize(
    [
      meeting?.meeting_name,
      meeting?.meeting_official_name,
      meeting?.circuit_short_name,
      meeting?.location,
      meeting?.country_name,
    ]
      .filter(Boolean)
      .join(" ")
  );

  for (const [id, aliases] of CIRCUIT_ALIASES) {
    if (aliases.some((alias) => haystack.includes(normalize(alias)))) {
      return id;
    }
  }

  return null;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatReplayClock(seconds) {
  const value = Math.max(0, number(seconds));
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function formatSigned(seconds) {
  const value = number(seconds);
  if (Math.abs(value) < 0.0005) return "0.000 s";
  return `${value > 0 ? "+" : ""}${value.toFixed(3)} s`;
}

function formatSectorTime(seconds) {
  const value = number(seconds, NaN);

  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }

  if (value >= 60) {
    const minutes = Math.floor(value / 60);
    const remainder = value - minutes * 60;
    return `${minutes}:${remainder.toFixed(3).padStart(6, "0")}`;
  }

  return `${value.toFixed(3)} s`;
}

function getSectorComparisons(lapA, lapB, codeA, codeB, colorA, colorB) {
  return [1, 2, 3].map((sectorNumber) => {
    const key = `duration_sector_${sectorNumber}`;

    const timeA = number(lapA?.[key], NaN);
    const timeB = number(lapB?.[key], NaN);

    const validA = Number.isFinite(timeA) && timeA > 0;
    const validB = Number.isFinite(timeB) && timeB > 0;

    if (!validA && !validB) {
      return {
        sector: `S${sectorNumber}`,
        winner: "—",
        winnerTime: NaN,
        gap: NaN,
        color: "#7f8b9c",
        available: false,
      };
    }

    if (validA && (!validB || timeA <= timeB)) {
      return {
        sector: `S${sectorNumber}`,
        winner: codeA,
        winnerTime: timeA,
        gap: validB ? timeB - timeA : NaN,
        color: colorA,
        available: true,
      };
    }

    return {
      sector: `S${sectorNumber}`,
      winner: codeB,
      winnerTime: timeB,
      gap: validA ? timeA - timeB : NaN,
      color: colorB,
      available: true,
    };
  });
}

function buildReplaySeries(points, lap) {
  if (!Array.isArray(points) || points.length < 2) return [];

  const officialDuration = number(lap?.lap_duration);
  const lapStart = new Date(lap?.date_start || "").getTime();
  const lapEnd =
    Number.isFinite(lapStart) && officialDuration > 0
      ? lapStart + officialDuration * 1000
      : null;

  let rows = points
    .filter((point) => Number.isFinite(number(point?.timestamp, NaN)))
    .sort((a, b) => number(a.timestamp) - number(b.timestamp));

  if (lapEnd) {
    const exactRows = rows.filter(
      (point) =>
        number(point.timestamp) >= lapStart - 350 &&
        number(point.timestamp) <= lapEnd + 650
    );

    if (exactRows.length >= 6) rows = exactRows;
  }

  if (rows.length < 2) return [];

  const first = rows[0];
  const last = rows[rows.length - 1];
  const firstDistance = number(first.distance);
  const lastDistance = number(last.distance);
  const distanceSpan = lastDistance - firstDistance;

  const firstTime = number(first.timestamp);
  const lastTime = number(last.timestamp);
  const rawTimeSpan = Math.max(1, lastTime - firstTime);

  return rows.map((point, index) => {
    const rawProgress =
      distanceSpan > 0
        ? ((number(point.distance) - firstDistance) / distanceSpan) * 100
        : (index / Math.max(1, rows.length - 1)) * 100;

    const rawElapsed = (number(point.timestamp) - firstTime) / 1000;
    const elapsed =
      officialDuration > 0
        ? (rawElapsed / (rawTimeSpan / 1000)) * officialDuration
        : rawElapsed;

    return {
      ...point,
      progress: clamp(rawProgress, 0, 100),
      replayElapsed: Math.max(0, elapsed),
    };
  });
}

function interpolateByKey(points, key, target, valueKey) {
  if (!points?.length) return null;

  if (target <= number(points[0][key])) {
    return number(points[0][valueKey], null);
  }

  const final = points[points.length - 1];
  if (target >= number(final[key])) {
    return number(final[valueKey], null);
  }

  let low = 0;
  let high = points.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = number(points[middle][key]);

    if (value < target) low = middle + 1;
    else high = middle - 1;
  }

  const right = points[Math.min(low, points.length - 1)];
  const left = points[Math.max(0, low - 1)];

  if (!left || !right) return null;

  const leftKey = number(left[key]);
  const rightKey = number(right[key]);
  const leftValue = number(left[valueKey], null);
  const rightValue = number(right[valueKey], null);

  if (leftValue === null || rightValue === null) {
    return leftValue ?? rightValue;
  }

  const span = rightKey - leftKey;
  if (!span) return leftValue;

  const ratio = (target - leftKey) / span;
  return leftValue + (rightValue - leftValue) * ratio;
}

function progressAtTime(points, elapsed) {
  if (!points?.length) return 0;

  const finalElapsed = number(points[points.length - 1]?.replayElapsed);

  if (elapsed <= 0) return 0;
  if (elapsed >= finalElapsed) return 100;

  return clamp(
    interpolateByKey(points, "replayElapsed", elapsed, "progress") ?? 0,
    0,
    100
  );
}

function valueAtProgress(points, progress, key) {
  return interpolateByKey(points, "progress", progress, key);
}

function buildReplayDelta(pointsA, pointsB) {
  const result = [];

  for (let progress = 0; progress <= 100; progress += 0.5) {
    const a = interpolateByKey(pointsA, "progress", progress, "replayElapsed");
    const b = interpolateByKey(pointsB, "progress", progress, "replayElapsed");

    if (a === null || b === null) continue;

    result.push({
      progress,
      delta: b - a,
    });
  }

  return result;
}

function deltaAtProgress(delta, progress) {
  return interpolateByKey(delta, "progress", progress, "delta") ?? 0;
}

function driverCode(driver, fallback) {
  return driver?.name_acronym || driver?.driver_number || fallback;
}

function driverName(driver, fallback) {
  return driver?.full_name || driver?.broadcast_name || fallback;
}

function drivingState(speed, throttle, brake) {
  if (number(brake) >= 25) return "Frenando";
  if (number(throttle) >= 92) return "Acelerador a fondo";
  if (number(throttle) >= 45) return "Acelerando";
  if (number(speed) > 0) return "Coasting";
  return "—";
}

function sectorForProgress(progress, geometry) {
  if (!geometry?.total) return "—";

  const target = (clamp(progress, 0, 100) / 100) * geometry.total;
  let cursor = 0;

  for (let index = 0; index < SECTORS.length; index += 1) {
    const sector = SECTORS[index];
    const length = geometry.lengths[sector] || 0;

    if (target <= cursor + length || index === SECTORS.length - 1) {
      return `S${index + 1}`;
    }

    cursor += length;
  }

  return "S3";
}

function completionForSector(progress, sector, geometry) {
  if (!geometry?.total) return 0;

  const target = (clamp(progress, 0, 100) / 100) * geometry.total;
  let cursor = 0;

  for (const name of SECTORS) {
    const length = geometry.lengths[name] || 0;
    const start = cursor;
    const end = cursor + length;

    if (name === sector) {
      if (target <= start) return 0;
      if (target >= end) return 100;

      const localProgress = clamp(target - start, 0, length);
      const gap = Math.min(TRAIL_HEAD_GAP, Math.max(0, localProgress - 0.01));
      const visible = Math.max(0, localProgress - gap);

      return clamp((visible / Math.max(1, length)) * 100, 0, 100);
    }

    cursor += length;
  }

  return 0;
}

function pointAtProgress(progress, geometry, refs, laneOffset = 0) {
  if (!geometry?.total) return null;

  const target = (clamp(progress, 0, 100) / 100) * geometry.total;
  let cursor = 0;

  for (let index = 0; index < SECTORS.length; index += 1) {
    const sector = SECTORS[index];
    const path = refs.current[sector];
    const length = geometry.lengths[sector] || 0;

    if (!path || !length) {
      cursor += length;
      continue;
    }

    if (target <= cursor + length || index === SECTORS.length - 1) {
      const local = clamp(target - cursor, 0, length);
      const before = path.getPointAtLength(Math.max(0, local - 4));
      const after = path.getPointAtLength(Math.min(length, local + 4));
      const point = path.getPointAtLength(local);

      const dx = after.x - before.x;
      const dy = after.y - before.y;
      const norm = Math.hypot(dx, dy) || 1;

      const nx = -dy / norm;
      const ny = dx / norm;

      return {
        x: point.x + nx * laneOffset,
        y: point.y + ny * laneOffset,
      };
    }

    cursor += length;
  }

  return null;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function samplesInRange(points, start, end) {
  const selected = (points || []).filter(
    (point) => point.progress >= start && point.progress <= end
  );

  if (selected.length >= 2) return selected;

  const middle = (start + end) / 2;
  return [start, middle, end].map((progress) => ({
    progress,
    speed: valueAtProgress(points, progress, "speed") ?? 0,
    throttle: valueAtProgress(points, progress, "throttle") ?? 0,
    brake: valueAtProgress(points, progress, "brake") ?? 0,
  }));
}

function rangeStats(points, start, end) {
  const rows = samplesInRange(points, start, end);
  const speeds = rows.map((row) => number(row.speed, NaN));
  const throttles = rows.map((row) => number(row.throttle, NaN));
  const brakes = rows.map((row) => number(row.brake, NaN));
  const validSpeeds = speeds.filter(Number.isFinite);

  return {
    avgSpeed: average(speeds),
    minSpeed: validSpeeds.length ? Math.min(...validSpeeds) : 0,
    maxSpeed: validSpeeds.length ? Math.max(...validSpeeds) : 0,
    avgThrottle: average(throttles),
    avgBrake: average(brakes),
  };
}

function angleDeltaDegrees(a, b) {
  let delta = Math.abs(a - b);
  while (delta > Math.PI) delta = Math.abs(delta - Math.PI * 2);
  return (delta * 180) / Math.PI;
}

function curvatureAroundProgress(progress, geometry, refs) {
  const span = 1.35;
  const p1 = pointAtProgress(clamp(progress - span, 0, 100), geometry, refs, 0);
  const p2 = pointAtProgress(progress, geometry, refs, 0);
  const p3 = pointAtProgress(clamp(progress + span, 0, 100), geometry, refs, 0);

  if (!p1 || !p2 || !p3) return 0;

  const incoming = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const outgoing = Math.atan2(p3.y - p2.y, p3.x - p2.x);
  return angleDeltaDegrees(incoming, outgoing);
}

function classifySegment(start, end, statsA, statsB, geometry, refs) {
  const midpoint = (start + end) / 2;
  const curvature = curvatureAroundProgress(midpoint, geometry, refs);
  const avgSpeed = (statsA.avgSpeed + statsB.avgSpeed) / 2;
  const minSpeed = Math.min(statsA.minSpeed || 999, statsB.minSpeed || 999);
  const throttle = Math.max(statsA.avgThrottle, statsB.avgThrottle);
  const brake = Math.max(statsA.avgBrake, statsB.avgBrake);

  if (curvature < 8 && throttle >= 82 && avgSpeed >= 190 && brake < 12) {
    return "Recta";
  }

  if (minSpeed <= 155 || (avgSpeed < 175 && curvature >= 10)) {
    return "Curva lenta";
  }

  if (avgSpeed >= 205 || (minSpeed >= 175 && curvature >= 8)) {
    return "Curva rápida";
  }

  return "Curva media";
}

function firstBrakeProgress(points, start, end) {
  const row = samplesInRange(points, start, end).find(
    (point) => number(point.brake) >= 25
  );
  return row?.progress ?? null;
}

function fullThrottleReturn(points, start, end) {
  const midpoint = (start + end) / 2;
  const row = samplesInRange(points, midpoint, end).find(
    (point) => number(point.throttle) >= 92 && number(point.brake) < 10
  );
  return row?.progress ?? null;
}

function describeZone(segment, winnerKey, codeA, codeB) {
  const winnerStats = winnerKey === "A" ? segment.statsA : segment.statsB;
  const rivalStats = winnerKey === "A" ? segment.statsB : segment.statsA;
  const winnerCode = winnerKey === "A" ? codeA : codeB;
  const winnerSeries = winnerKey === "A" ? segment.seriesA : segment.seriesB;
  const rivalSeries = winnerKey === "A" ? segment.seriesB : segment.seriesA;

  if (segment.type === "Recta") {
    const speedGain = winnerStats.maxSpeed - rivalStats.maxSpeed;
    if (speedGain >= 1.5) {
      return `${winnerCode} tiene +${speedGain.toFixed(0)} km/h de velocidad punta`;
    }

    const avgGain = winnerStats.avgSpeed - rivalStats.avgSpeed;
    if (avgGain >= 1.5) {
      return `${winnerCode} mantiene +${avgGain.toFixed(0)} km/h de media`;
    }

    return `${winnerCode} recorre la recta con menos pérdida`;
  }

  const brakeWinner = firstBrakeProgress(
    winnerSeries,
    segment.start,
    segment.end
  );
  const brakeRival = firstBrakeProgress(
    rivalSeries,
    segment.start,
    segment.end
  );

  if (
    brakeWinner !== null &&
    brakeRival !== null &&
    brakeWinner - brakeRival >= 0.18
  ) {
    return `${winnerCode} frena más tarde`;
  }

  const throttleWinner = fullThrottleReturn(
    winnerSeries,
    segment.start,
    segment.end
  );
  const throttleRival = fullThrottleReturn(
    rivalSeries,
    segment.start,
    segment.end
  );

  if (
    throttleWinner !== null &&
    throttleRival !== null &&
    throttleRival - throttleWinner >= 0.18
  ) {
    return `${winnerCode} vuelve al 100% de acelerador antes`;
  }

  const speedGain = winnerStats.avgSpeed - rivalStats.avgSpeed;
  if (speedGain >= 1.5) {
    return `${winnerCode} mantiene +${speedGain.toFixed(0)} km/h de media`;
  }

  return `${winnerCode} completa este tramo de forma más eficiente`;
}

function buildCornerProgress(circuitId, geometry, refs) {
  const desired = CIRCUIT_CORNER_COUNTS[circuitId] || 0;
  if (!desired || !geometry?.total) return [];

  const manualProgresses =
    CIRCUIT_CORNER_PROGRESS_OVERRIDES?.[circuitId] || null;

  if (manualProgresses?.length) {
    return manualProgresses.map((progress, index) => {
      const point = pointAtProgress(progress, geometry, refs, 0);

      return {
        number: index + 1,
        letter: "",
        x: point?.x ?? null,
        y: point?.y ?? null,
        progress,
        pathDistance: 0,
        derivedFromGeometry: false,
        manualReference: true,
      };
    });
  }

  /*
    Fuente de verdad: conteo real de curvas del circuito.
    La posición se deriva directamente de la geometría SVG usando el mismo
    criterio que la vista Circuitos, evitando depender de anotaciones
    aproximadas o con cantidades incorrectas.
  */
  const sampleCount = Math.max(900, desired * 55);
  const samples = new Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = (index / sampleCount) * 100;
    samples[index] = {
      progress,
      point: pointAtProgress(progress, geometry, refs, 0),
    };
  }

  const curvature = new Float32Array(sampleCount);
  const look = Math.max(4, Math.round(sampleCount / 360));

  function normalizedAngleDelta(value) {
    let angle = value;

    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;

    return angle;
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const before = samples[
      (index - look + sampleCount) % sampleCount
    ]?.point;
    const current = samples[index]?.point;
    const after = samples[
      (index + look) % sampleCount
    ]?.point;

    if (!before || !current || !after) continue;

    const angleBefore = Math.atan2(
      current.y - before.y,
      current.x - before.x
    );
    const angleAfter = Math.atan2(
      after.y - current.y,
      after.x - current.x
    );

    curvature[index] = Math.abs(
      normalizedAngleDelta(angleAfter - angleBefore)
    );
  }

  const candidates = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const previous =
      curvature[(index - 1 + sampleCount) % sampleCount];
    const current = curvature[index];
    const next = curvature[(index + 1) % sampleCount];

    if (current >= previous && current >= next) {
      candidates.push({
        index,
        score: current,
        progress: (index / sampleCount) * 100,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  function circularDistance(a, b) {
    const direct = Math.abs(a - b);
    return Math.min(direct, 100 - direct);
  }

  const selected = [];
  const separations = [2.6, 2.1, 1.7, 1.3, 0.9, 0.6, 0.3];

  for (const separation of separations) {
    for (const candidate of candidates) {
      if (selected.some((item) => item.index === candidate.index)) {
        continue;
      }

      const clear = selected.every(
        (item) =>
          circularDistance(item.progress, candidate.progress) >= separation
      );

      if (clear) selected.push(candidate);
      if (selected.length >= desired) break;
    }

    if (selected.length >= desired) break;
  }

  if (selected.length < desired) {
    for (const candidate of candidates) {
      if (selected.length >= desired) break;

      if (selected.some((item) => item.index === candidate.index)) {
        continue;
      }

      selected.push(candidate);
    }
  }

  if (selected.length < desired) {
    for (let index = 0; index < desired; index += 1) {
      if (selected.length >= desired) break;

      const progress = ((index + 0.5) / desired) * 100;

      if (
        selected.some(
          (item) => circularDistance(item.progress, progress) < 0.2
        )
      ) {
        continue;
      }

      selected.push({
        index: Math.floor((progress / 100) * sampleCount) % sampleCount,
        score: 0,
        progress,
      });
    }
  }

  selected.sort((a, b) => a.progress - b.progress);

  return selected.slice(0, desired).map((item, index) => {
    const point = pointAtProgress(item.progress, geometry, refs, 0);

    return {
      number: index + 1,
      letter: "",
      x: point?.x ?? null,
      y: point?.y ?? null,
      progress: item.progress,
      pathDistance: 0,
      derivedFromGeometry: true,
    };
  });
}

function buildStraightZones({
  replayDelta,
  seriesA,
  seriesB,
  geometry,
  refs,
  codeA,
  codeB,
  colorA,
  colorB,
}) {
  if (!geometry?.total || !seriesA.length || !seriesB.length) return [];

  const pieces = [];

  for (let start = 0; start < 100; start += 1.5) {
    const end = Math.min(100, start + 1.5);
    const segment = makeSegment(
      start,
      end,
      replayDelta,
      seriesA,
      seriesB,
      geometry,
      refs
    );

    if (segment.type === "Recta") {
      pieces.push(segment);
    }
  }

  if (!pieces.length) return [];

  const merged = [];

  for (const piece of pieces) {
    const current = merged[merged.length - 1];

    if (current && piece.start - current.end <= 0.2) {
      current.end = piece.end;
      continue;
    }

    merged.push({
      start: piece.start,
      end: piece.end,
    });
  }

  return merged
    .filter((zone) => zone.end - zone.start >= 3)
    .map((zone, index) => {
      const statsA = rangeStats(seriesA, zone.start, zone.end);
      const statsB = rangeStats(seriesB, zone.start, zone.end);
      const deltaStart = deltaAtProgress(replayDelta, zone.start);
      const deltaEnd = deltaAtProgress(replayDelta, zone.end);
      const gainA = deltaEnd - deltaStart;
      const timeGain = Math.abs(gainA);
      const winnerKey = timeGain < 0.003 ? null : gainA > 0 ? "A" : "B";
      const winnerCode =
        winnerKey === "A"
          ? codeA
          : winnerKey === "B"
            ? codeB
            : "Parejos";
      const color =
        winnerKey === "A"
          ? colorA
          : winnerKey === "B"
            ? colorB
            : "#7f8b9c";
      const midpoint = (zone.start + zone.end) / 2;

      return {
        id: `R${index + 1}`,
        label: `R${index + 1}`,
        start: zone.start,
        end: zone.end,
        midpoint,
        marker: pointAtProgress(midpoint, geometry, refs, 0),
        path: buildZonePath(zone.start, zone.end, geometry, refs),
        winnerKey,
        winnerCode,
        color,
        timeGain,
        maxSpeedA: statsA.maxSpeed,
        maxSpeedB: statsB.maxSpeed,
      };
    });
}

function zoneLocationLabel(segment, cornerProgress) {
  const nearby = (cornerProgress || [])
    .filter(
      (corner) =>
        Number.isFinite(corner.progress) &&
        corner.progress >= segment.start - 1.1 &&
        corner.progress <= segment.end + 1.1
    )
    .sort((a, b) => a.number - b.number);

  if (nearby.length === 1) {
    return `Curva ${nearby[0].number}${nearby[0].letter || ""}`;
  }

  if (nearby.length >= 2) {
    const first = nearby[0];
    const last = nearby[nearby.length - 1];
    return `Curvas ${first.number}${first.letter || ""}–${last.number}${last.letter || ""}`;
  }

  if (segment.type === "Recta") return "Recta";

  return `${segment.type} · ${Math.round(segment.start)}–${Math.round(
    segment.end
  )}%`;
}

function makeSegment(start, end, replayDelta, seriesA, seriesB, geometry, refs) {
  const statsA = rangeStats(seriesA, start, end);
  const statsB = rangeStats(seriesB, start, end);
  const deltaStart = deltaAtProgress(replayDelta, start);
  const deltaEnd = deltaAtProgress(replayDelta, end);

  return {
    start,
    end,
    midpoint: (start + end) / 2,
    gainA: deltaEnd - deltaStart,
    statsA,
    statsB,
    seriesA,
    seriesB,
    type: classifySegment(start, end, statsA, statsB, geometry, refs),
  };
}

function categoryAdvantage(segments, type, codeA, codeB) {
  const matching = segments.filter((segment) => segment.type === type);
  const gainA = matching.reduce((sum, segment) => sum + segment.gainA, 0);

  if (!matching.length || Math.abs(gainA) < 0.002) {
    return { winner: "Muy parejos", gain: 0, type };
  }

  return {
    winner: gainA > 0 ? codeA : codeB,
    gain: Math.abs(gainA),
    type,
  };
}

function maxSpeedSummary(seriesA, seriesB, codeA, codeB) {
  const maxA = Math.max(...seriesA.map((point) => number(point.speed)), 0);
  const maxB = Math.max(...seriesB.map((point) => number(point.speed)), 0);

  return maxA >= maxB
    ? { winner: codeA, speed: maxA, rivalSpeed: maxB, diff: maxA - maxB }
    : { winner: codeB, speed: maxB, rivalSpeed: maxA, diff: maxB - maxA };
}

function buildZonePath(start, end, geometry, refs) {
  if (!geometry?.total) return "";

  const span = Math.max(0.25, end - start);
  const samples = Math.max(8, Math.ceil(span * 4));
  const points = [];

  for (let index = 0; index <= samples; index += 1) {
    const progress = start + (span * index) / samples;
    const point = pointAtProgress(progress, geometry, refs, 0);
    if (point) points.push(point);
  }

  if (points.length < 2) return "";

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function buildLapAnalysis({
  replayDelta,
  seriesA,
  seriesB,
  geometry,
  refs,
  circuitId,
  lapA,
  lapB,
  codeA,
  codeB,
}) {
  if (!geometry?.total || !seriesA.length || !seriesB.length) return null;

  const durationA = number(lapA?.lap_duration, Infinity);
  const durationB = number(lapB?.lap_duration, Infinity);
  const winnerKey = durationA <= durationB ? "A" : "B";
  const winnerCode = winnerKey === "A" ? codeA : codeB;
  const rivalCode = winnerKey === "A" ? codeB : codeA;
  const lapGap = Math.abs(durationA - durationB);

  const baseSegments = [];
  for (let start = 0; start < 100; start += 2.5) {
    baseSegments.push(
      makeSegment(
        start,
        Math.min(100, start + 2.5),
        replayDelta,
        seriesA,
        seriesB,
        geometry,
        refs
      )
    );
  }

  const candidates = [];
  for (let start = 0; start <= 96.5; start += 1.5) {
    const segment = makeSegment(
      start,
      Math.min(100, start + 3.5),
      replayDelta,
      seriesA,
      seriesB,
      geometry,
      refs
    );

    segment.winnerGain = winnerKey === "A" ? segment.gainA : -segment.gainA;
    if (segment.winnerGain > 0.004) candidates.push(segment);
  }

  candidates.sort((a, b) => b.winnerGain - a.winnerGain);

  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some(
      (current) =>
        Math.min(current.end, candidate.end) -
          Math.max(current.start, candidate.start) >
        0.8
    );

    if (!overlaps) selected.push(candidate);
    if (selected.length >= 5) break;
  }

  const cornerProgress = buildCornerProgress(circuitId, geometry, refs);

  const topZones = selected.map((segment, index) => ({
    ...segment,
    rank: index + 1,
    label: zoneLocationLabel(segment, cornerProgress),
    reason: describeZone(segment, winnerKey, codeA, codeB),
    path: buildZonePath(segment.start, segment.end, geometry, refs),
    marker: pointAtProgress(segment.midpoint, geometry, refs, 0),
  }));

  return {
    winnerKey,
    winnerCode,
    rivalCode,
    lapGap,
    topZones,
    maxSpeed: maxSpeedSummary(seriesA, seriesB, codeA, codeB),
    slow: categoryAdvantage(baseSegments, "Curva lenta", codeA, codeB),
    fast: categoryAdvantage(baseSegments, "Curva rápida", codeA, codeB),
    straight: categoryAdvantage(baseSegments, "Recta", codeA, codeB),
  };
}


function seriesLapDistance(points) {
  if (!points?.length) return 0;

  const first = number(points[0]?.distance, 0);
  const last = number(points[points.length - 1]?.distance, 0);

  return Math.max(0, last - first);
}

function progressGapMeters(progressA, progressB, lapDistance) {
  if (
    !Number.isFinite(progressA) ||
    !Number.isFinite(progressB) ||
    !Number.isFinite(lapDistance) ||
    lapDistance <= 0
  ) {
    return 0;
  }

  return (Math.abs(progressA - progressB) / 100) * lapDistance;
}

function firstProgressMatching(points, start, end, predicate) {
  const rows = (points || [])
    .filter(
      (point) =>
        Number.isFinite(point.progress) &&
        point.progress >= start &&
        point.progress <= end
    )
    .sort((a, b) => a.progress - b.progress);

  const row = rows.find(predicate);
  return row?.progress ?? null;
}

function findCornerApexProgress(seriesA, seriesB, start, end, center) {
  const searchStart = Math.max(start, center - 1.7);
  const searchEnd = Math.min(end, center + 1.9);

  let bestProgress = clamp(center, searchStart, searchEnd);
  let bestSpeed = Infinity;

  for (let progress = searchStart; progress <= searchEnd; progress += 0.12) {
    const speedA = valueAtProgress(seriesA, progress, "speed");
    const speedB = valueAtProgress(seriesB, progress, "speed");

    const valid = [speedA, speedB].filter(Number.isFinite);
    if (!valid.length) continue;

    const combined = average(valid);

    if (combined < bestSpeed) {
      bestSpeed = combined;
      bestProgress = progress;
    }
  }

  return clamp(bestProgress, start, end);
}

function compareCornerEvent(
  type,
  progressA,
  progressB,
  lapDistance,
  codeA,
  codeB
) {
  if (!Number.isFinite(progressA) || !Number.isFinite(progressB)) {
    return {
      winnerKey: null,
      meters: 0,
      text: "Sin datos suficientes para comparar",
    };
  }

  const meters = progressGapMeters(progressA, progressB, lapDistance);

  if (meters < 2) {
    return {
      winnerKey: null,
      meters,
      text:
        type === "brake"
          ? "Punto de frenada prácticamente idéntico"
          : "Vuelta al 100% de gas prácticamente idéntica",
    };
  }

  const winnerKey =
    type === "brake"
      ? progressA > progressB
        ? "A"
        : "B"
      : progressA < progressB
        ? "A"
        : "B";

  const winnerCode = winnerKey === "A" ? codeA : codeB;

  return {
    winnerKey,
    meters,
    text:
      type === "brake"
        ? `${winnerCode} frena ~${Math.round(meters)} m más tarde`
        : `${winnerCode} vuelve al 100% ~${Math.round(meters)} m antes`,
  };
}

function explainCorner(corner, codeA, codeB) {
  if (!corner?.winnerKey || corner.timeGain < 0.003) {
    return "Los dos pilotos pasan esta curva con una diferencia mínima; aquí no se decide una parte importante de la vuelta.";
  }

  const winnerCode = corner.winnerKey === "A" ? codeA : codeB;
  const winnerEntry =
    corner.winnerKey === "A" ? corner.entrySpeedA : corner.entrySpeedB;
  const rivalEntry =
    corner.winnerKey === "A" ? corner.entrySpeedB : corner.entrySpeedA;
  const winnerApex =
    corner.winnerKey === "A" ? corner.apexSpeedA : corner.apexSpeedB;
  const rivalApex =
    corner.winnerKey === "A" ? corner.apexSpeedB : corner.apexSpeedA;
  const winnerExit =
    corner.winnerKey === "A" ? corner.exitSpeedA : corner.exitSpeedB;
  const rivalExit =
    corner.winnerKey === "A" ? corner.exitSpeedB : corner.exitSpeedA;

  const entryDelta = winnerEntry - rivalEntry;
  const apexDelta = winnerApex - rivalApex;
  const exitDelta = winnerExit - rivalExit;

  if (
    entryDelta <= -2 &&
    exitDelta >= 2 &&
    corner.throttleComparison.winnerKey === corner.winnerKey
  ) {
    return `${winnerCode} sacrifica algo de velocidad en la entrada, pero vuelve al gas antes y sale +${Math.round(
      exitDelta
    )} km/h más rápido. La ganancia está en la tracción.`;
  }

  if (
    corner.brakeComparison.winnerKey === corner.winnerKey &&
    corner.brakeComparison.meters >= 3 &&
    apexDelta >= -2
  ) {
    return `${winnerCode} construye la diferencia en la frenada: retrasa el punto ~${Math.round(
      corner.brakeComparison.meters
    )} m sin perder demasiado en el punto lento.`;
  }

  if (
    corner.throttleComparison.winnerKey === corner.winnerKey &&
    corner.throttleComparison.meters >= 3 &&
    exitDelta >= 1.5
  ) {
    return `${winnerCode} gana sobre todo en la salida: vuelve al 100% ~${Math.round(
      corner.throttleComparison.meters
    )} m antes y sale +${Math.round(exitDelta)} km/h más rápido.`;
  }

  if (apexDelta >= 2) {
    return `${winnerCode} mantiene +${Math.round(
      apexDelta
    )} km/h en el punto de mínima velocidad y arrastra esa ventaja hacia la salida.`;
  }

  if (exitDelta >= 2) {
    return `${winnerCode} consigue una salida más fuerte, con +${Math.round(
      exitDelta
    )} km/h al abandonar la curva.`;
  }

  if (entryDelta >= 2) {
    return `${winnerCode} llega a la curva +${Math.round(
      entryDelta
    )} km/h más rápido y conserva suficiente velocidad durante el giro.`;
  }

  return `${winnerCode} suma ${corner.timeGain.toFixed(
    3
  )} s mediante una ejecución más consistente entre entrada, punto lento y salida.`;
}

function buildCornerExplorer({
  circuitId,
  geometry,
  refs,
  replayDelta,
  seriesA,
  seriesB,
  lapA,
  lapB,
  codeA,
  codeB,
  colorA,
  colorB,
}) {
  if (!geometry?.total || !seriesA.length || !seriesB.length) return null;

  const mappedCorners = buildCornerProgress(circuitId, geometry, refs)
    .filter((corner) => Number.isFinite(corner.progress))
    .sort((a, b) => a.progress - b.progress);

  if (!mappedCorners.length) return null;

  const lapDistance = average([
    seriesLapDistance(seriesA),
    seriesLapDistance(seriesB),
  ]);

  const durationA = number(lapA?.lap_duration, Infinity);
  const durationB = number(lapB?.lap_duration, Infinity);
  const lapWinnerKey = durationA <= durationB ? "A" : "B";

  const corners = mappedCorners.map((corner, index) => {
    const previousProgress =
      index > 0
        ? mappedCorners[index - 1].progress
        : mappedCorners[mappedCorners.length - 1].progress - 100;

    const nextProgress =
      index < mappedCorners.length - 1
        ? mappedCorners[index + 1].progress
        : mappedCorners[0].progress + 100;

    const leftGap = Math.max(0.8, corner.progress - previousProgress);
    const rightGap = Math.max(0.8, nextProgress - corner.progress);

    const start = clamp(
      corner.progress - clamp(leftGap * 0.42, 0.8, 3.0),
      0,
      100
    );
    const end = clamp(
      corner.progress + clamp(rightGap * 0.42, 0.9, 3.4),
      0,
      100
    );

    const apexProgress = findCornerApexProgress(
      seriesA,
      seriesB,
      start,
      end,
      corner.progress
    );

    const entryProgress = clamp(
      apexProgress - clamp((apexProgress - start) * 0.72, 0.55, 1.35),
      start,
      apexProgress
    );

    const exitProgress = clamp(
      apexProgress + clamp((end - apexProgress) * 0.72, 0.65, 1.5),
      apexProgress,
      end
    );

    const statsA = rangeStats(seriesA, start, end);
    const statsB = rangeStats(seriesB, start, end);
    const detectedType = classifySegment(
      start,
      end,
      statsA,
      statsB,
      geometry,
      refs
    );
    const cornerMinSpeed = Math.min(
      statsA.minSpeed || 999,
      statsB.minSpeed || 999
    );
    const type =
      detectedType === "Recta"
        ? cornerMinSpeed >= 185
          ? "Curva rápida"
          : "Curva media"
        : detectedType;

    const deltaStart = deltaAtProgress(replayDelta, start);
    const deltaEnd = deltaAtProgress(replayDelta, end);
    const gainA = deltaEnd - deltaStart;
    const timeGain = Math.abs(gainA);

    const winnerKey = timeGain < 0.003 ? null : gainA > 0 ? "A" : "B";
    const winnerCode =
      winnerKey === "A" ? codeA : winnerKey === "B" ? codeB : "Parejos";
    const color =
      winnerKey === "A"
        ? colorA
        : winnerKey === "B"
          ? colorB
          : "#7f8b9c";

    const brakeA = firstProgressMatching(
      seriesA,
      start,
      Math.min(end, apexProgress + 0.25),
      (point) => number(point.brake) >= 25
    );
    const brakeB = firstProgressMatching(
      seriesB,
      start,
      Math.min(end, apexProgress + 0.25),
      (point) => number(point.brake) >= 25
    );

    const throttleA = firstProgressMatching(
      seriesA,
      apexProgress,
      end,
      (point) => number(point.throttle) >= 92 && number(point.brake) < 10
    );
    const throttleB = firstProgressMatching(
      seriesB,
      apexProgress,
      end,
      (point) => number(point.throttle) >= 92 && number(point.brake) < 10
    );

    const brakeComparison = compareCornerEvent(
      "brake",
      brakeA,
      brakeB,
      lapDistance,
      codeA,
      codeB
    );

    const throttleComparison = compareCornerEvent(
      "throttle",
      throttleA,
      throttleB,
      lapDistance,
      codeA,
      codeB
    );

    const analyzed = {
      id: `${corner.number}${corner.letter || ""}`,
      number: corner.number,
      letter: corner.letter || "",
      progress: corner.progress,
      start,
      end,
      apexProgress,
      entryProgress,
      exitProgress,
      marker: pointAtProgress(corner.progress, geometry, refs, 0),
      path: buildZonePath(start, end, geometry, refs),
      type,
      gainA,
      timeGain,
      winnerKey,
      winnerCode,
      color,
      entrySpeedA: valueAtProgress(seriesA, entryProgress, "speed") ?? 0,
      entrySpeedB: valueAtProgress(seriesB, entryProgress, "speed") ?? 0,
      apexSpeedA: valueAtProgress(seriesA, apexProgress, "speed") ?? 0,
      apexSpeedB: valueAtProgress(seriesB, apexProgress, "speed") ?? 0,
      exitSpeedA: valueAtProgress(seriesA, exitProgress, "speed") ?? 0,
      exitSpeedB: valueAtProgress(seriesB, exitProgress, "speed") ?? 0,
      brakeA,
      brakeB,
      throttleA,
      throttleB,
      brakeComparison,
      throttleComparison,
    };

    analyzed.explanation = explainCorner(analyzed, codeA, codeB);
    return analyzed;
  });

  const numberedCorners = [...corners].sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return a.letter.localeCompare(b.letter);
  });

  const decisiveCorners = corners
    .filter(
      (corner) =>
        corner.winnerKey === lapWinnerKey &&
        corner.timeGain >= 0.003
    )
    .sort((a, b) => b.timeGain - a.timeGain)
    .slice(0, 5)
    .map((corner, index) => ({
      ...corner,
      decisiveRank: index + 1,
    }));

  const straightZones = buildStraightZones({
    replayDelta,
    seriesA,
    seriesB,
    geometry,
    refs,
    codeA,
    codeB,
    colorA,
    colorB,
  });

  return {
    corners: numberedCorners,
    decisiveCorners,
    straightZones,
    lapDistance,
    lapWinnerKey,
  };
}

function cornerEventPoints(
  corner,
  eventType,
  codeA,
  codeB,
  colorA,
  colorB
) {
  if (!corner) return [];

  const base = [
    {
      key: "A",
      code: codeA,
      color: colorA,
      laneOffset: 15,
      labelOffsetY: -30,
    },
    {
      key: "B",
      code: codeB,
      color: colorB,
      laneOffset: -15,
      labelOffsetY: 30,
    },
  ];

  if (eventType === "apex") {
    return base.map((item) => ({
      ...item,
      progress: corner.apexProgress,
      shape: "diamond",
      eventLabel: "Punto lento",
    }));
  }

  const fieldA = eventType === "brake" ? corner.brakeA : corner.throttleA;
  const fieldB = eventType === "brake" ? corner.brakeB : corner.throttleB;

  return base
    .map((item) => ({
      ...item,
      progress: item.key === "A" ? fieldA : fieldB,
      shape: eventType === "brake" ? "square" : "chevron",
      eventLabel: eventType === "brake" ? "Frenada" : "Gas 100%",
    }))
    .filter((item) => Number.isFinite(item.progress));
}

export default function LapReplay({
  meeting,
  comparison,
  driverA,
  driverB,
  styleA,
  styleB,
}) {
  const circuitId = useMemo(() => resolveCircuitId(meeting), [meeting]);
  const track = circuitId ? CIRCUIT_TRACKS?.[circuitId] : null;

  const pathRefs = useRef({});
  const trailARefs = useRef({});
  const trailBRefs = useRef({});
  const markerARef = useRef(null);
  const markerBRef = useRef(null);

  const rafRef = useRef(null);
  const lastFrameRef = useRef(null);
  const elapsedRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  const [geometry, setGeometry] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [showTrails, setShowTrails] = useState(true);
  const [showKeyZones, setShowKeyZones] = useState(false);
  const [keyZoneCount, setKeyZoneCount] = useState(5);
  const [cornerExplorerOpen, setCornerExplorerOpen] = useState(false);
  const [selectedCornerId, setSelectedCornerId] = useState(null);
  const [cornerEvent, setCornerEvent] = useState("brake");
  const [cornerTouring, setCornerTouring] = useState(false);
  const [cornerTourIndex, setCornerTourIndex] = useState(0);
  const [frame, setFrame] = useState({
    elapsed: 0,
    progressA: 0,
    progressB: 0,
    speedA: 0,
    speedB: 0,
    throttleA: 0,
    throttleB: 0,
    brakeA: 0,
    brakeB: 0,
    delta: 0,
    gain: 0,
  });

  const seriesA = useMemo(
    () => buildReplaySeries(comparison?.pointsA, comparison?.lapA),
    [comparison]
  );

  const seriesB = useMemo(
    () => buildReplaySeries(comparison?.pointsB, comparison?.lapB),
    [comparison]
  );

  const replayDelta = useMemo(
    () => buildReplayDelta(seriesA, seriesB),
    [seriesA, seriesB]
  );

  const durationA = number(comparison?.lapA?.lap_duration);
  const durationB = number(comparison?.lapB?.lap_duration);
  const totalDuration = Math.max(durationA, durationB, 1);

  const sameTeam =
    Boolean(driverA?.team_name) &&
    Boolean(driverB?.team_name) &&
    String(driverA.team_name).toLowerCase() ===
      String(driverB.team_name).toLowerCase();

  const colorA = styleA?.color || "#00f5d4";
  const colorB = styleB?.color || "#a06bff";
  const codeA = driverCode(driverA, "A");
  const codeB = driverCode(driverB, "B");

  const lapAnalysis = useMemo(
    () =>
      buildLapAnalysis({
        replayDelta,
        seriesA,
        seriesB,
        geometry,
        refs: pathRefs,
        circuitId,
        lapA: comparison?.lapA,
        lapB: comparison?.lapB,
        codeA,
        codeB,
      }),
    [
      replayDelta,
      seriesA,
      seriesB,
      geometry,
      circuitId,
      comparison,
      codeA,
      codeB,
    ]
  );

  const cornerExplorer = useMemo(
    () =>
      buildCornerExplorer({
        circuitId,
        geometry,
        refs: pathRefs,
        replayDelta,
        seriesA,
        seriesB,
        lapA: comparison?.lapA,
        lapB: comparison?.lapB,
        codeA,
        codeB,
        colorA,
        colorB,
      }),
    [
      circuitId,
      geometry,
      replayDelta,
      seriesA,
      seriesB,
      comparison,
      codeA,
      codeB,
      colorA,
      colorB,
    ]
  );

  const selectedCorner = useMemo(() => {
    if (!cornerExplorer?.corners?.length) return null;

    return (
      cornerExplorer.corners.find(
        (corner) => corner.id === selectedCornerId
      ) ||
      cornerExplorer.decisiveCorners?.[0] ||
      cornerExplorer.corners[0]
    );
  }, [cornerExplorer, selectedCornerId]);

  useEffect(() => {
    setPlaying(false);
    setShowKeyZones(false);
    setCornerExplorerOpen(false);
    setSelectedCornerId(null);
    setCornerEvent("brake");
    setCornerTouring(false);
    setCornerTourIndex(0);
    elapsedRef.current = 0;
    lastFrameRef.current = null;
    setFrame((current) => ({
      ...current,
      elapsed: 0,
    }));
  }, [comparison, circuitId]);

  useEffect(() => {
    if (!track?.sectors) {
      setGeometry(null);
      return undefined;
    }

    let cancelled = false;

    const measure = () => {
      const lengths = {};

      for (const sector of SECTORS) {
        const path = pathRefs.current[sector];
        lengths[sector] = path?.getTotalLength?.() || 0;
      }

      const total = SECTORS.reduce(
        (sum, sector) => sum + (lengths[sector] || 0),
        0
      );

      if (!cancelled && total > 0) {
        setGeometry({ lengths, total });
      }
    };

    const id = window.requestAnimationFrame(measure);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, [track, circuitId]);

  function applyVisualFrame(elapsed, forceUi = false) {
    if (!geometry || !seriesA.length || !seriesB.length) return;

    const progressA = progressAtTime(seriesA, elapsed);
    const progressB = progressAtTime(seriesB, elapsed);

    const pointA = pointAtProgress(progressA, geometry, pathRefs, 4.5);
    const pointB = pointAtProgress(progressB, geometry, pathRefs, -4.5);

    if (pointA && markerARef.current) {
      markerARef.current.setAttribute(
        "transform",
        `translate(${pointA.x} ${pointA.y})`
      );
    }

    if (pointB && markerBRef.current) {
      markerBRef.current.setAttribute(
        "transform",
        `translate(${pointB.x} ${pointB.y})`
      );
    }

    for (const sector of SECTORS) {
      const aCompletion = showTrails
        ? completionForSector(progressA, sector, geometry)
        : 0;

      const bCompletion = showTrails
        ? completionForSector(progressB, sector, geometry)
        : 0;

      const aPath = trailARefs.current[sector];
      const bPath = trailBRefs.current[sector];

      if (aPath) {
        aPath.style.strokeDasharray = `${aCompletion} 100`;
      }

      if (bPath) {
        bPath.style.strokeDasharray = `${bCompletion} 100`;
      }
    }

    const referenceProgress = clamp(
      (progressA + progressB) / 2,
      0,
      100
    );

    const delta = deltaAtProgress(replayDelta, referenceProgress);
    const previousDelta = deltaAtProgress(
      replayDelta,
      Math.max(0, referenceProgress - 3)
    );
    const gain = delta - previousDelta;

    const now = performance.now();

    if (forceUi || now - lastUiUpdateRef.current > 80) {
      lastUiUpdateRef.current = now;

      setFrame({
        elapsed,
        progressA,
        progressB,
        speedA: valueAtProgress(seriesA, progressA, "speed") ?? 0,
        speedB: valueAtProgress(seriesB, progressB, "speed") ?? 0,
        throttleA: valueAtProgress(seriesA, progressA, "throttle") ?? 0,
        throttleB: valueAtProgress(seriesB, progressB, "throttle") ?? 0,
        brakeA: valueAtProgress(seriesA, progressA, "brake") ?? 0,
        brakeB: valueAtProgress(seriesB, progressB, "brake") ?? 0,
        delta,
        gain,
      });
    }
  }

  useEffect(() => {
    applyVisualFrame(elapsedRef.current, true);
  }, [geometry, seriesA, seriesB, showTrails]);

  useEffect(() => {
    if (
      !cornerTouring ||
      !cornerExplorerOpen ||
      !cornerExplorer?.decisiveCorners?.length
    ) {
      return undefined;
    }

    const corners = cornerExplorer.decisiveCorners;
    const current = corners[Math.min(cornerTourIndex, corners.length - 1)];

    if (current) focusCorner(current);

    const timer = window.setTimeout(() => {
      if (cornerTourIndex >= corners.length - 1) {
        setCornerTouring(false);
      } else {
        setCornerTourIndex((index) => index + 1);
      }
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [
    cornerTouring,
    cornerTourIndex,
    cornerExplorerOpen,
    cornerExplorer,
  ]);

  useEffect(() => {
    if (!playing) {
      lastFrameRef.current = null;
      return undefined;
    }

    const tick = (timestamp) => {
      if (lastFrameRef.current === null) {
        lastFrameRef.current = timestamp;
      }

      const dt = Math.max(0, timestamp - lastFrameRef.current) / 1000;
      lastFrameRef.current = timestamp;

      elapsedRef.current = Math.min(
        totalDuration,
        elapsedRef.current + dt * rate
      );

      applyVisualFrame(elapsedRef.current);

      if (elapsedRef.current >= totalDuration) {
        setPlaying(false);
        applyVisualFrame(totalDuration, true);
        return;
      }

      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
      lastFrameRef.current = null;
    };
  }, [playing, rate, totalDuration, geometry, seriesA, seriesB, showTrails]);

  function seek(next) {
    const value = clamp(number(next), 0, totalDuration);
    elapsedRef.current = value;
    lastFrameRef.current = null;
    applyVisualFrame(value, true);
  }

  function restart() {
    setPlaying(false);
    seek(0);
  }

  function togglePlay() {
    if (elapsedRef.current >= totalDuration - 0.05) {
      seek(0);
    }

    setPlaying((current) => !current);
  }

  function focusCorner(corner) {
    if (!corner) return;

    setPlaying(false);
    setSelectedCornerId(corner.id);

    const focusSeries =
      corner.winnerKey === "B"
        ? seriesB
        : corner.winnerKey === "A"
          ? seriesA
          : lapAnalysis?.winnerKey === "B"
            ? seriesB
            : seriesA;

    const targetElapsed = interpolateByKey(
      focusSeries,
      "progress",
      corner.apexProgress,
      "replayElapsed"
    );

    if (Number.isFinite(targetElapsed)) {
      seek(targetElapsed);
    }
  }

  function toggleCornerExplorer() {
    const next = !cornerExplorerOpen;

    setCornerExplorerOpen(next);
    setCornerTouring(false);
    setCornerTourIndex(0);

    if (next) {
      setShowKeyZones(false);
      const firstCorner =
        cornerExplorer?.decisiveCorners?.[0] ||
        cornerExplorer?.corners?.[0];

      if (firstCorner) focusCorner(firstCorner);
    }
  }

  function toggleKeyZones() {
    const next = !showKeyZones;
    setShowKeyZones(next);

    if (next) {
      setCornerExplorerOpen(false);
      setCornerTouring(false);
    }
  }

  function toggleCornerTour() {
    if (cornerTouring) {
      setCornerTouring(false);
      return;
    }

    if (!cornerExplorer?.decisiveCorners?.length) return;

    setShowKeyZones(false);
    setCornerExplorerOpen(true);
    setCornerTourIndex(0);
    setCornerTouring(true);
  }

  if (!comparison) return null;

  if (
    !track ||
    track?.type !== "segmented" ||
    !track?.viewBox ||
    !SECTORS.every((sector) => track?.sectors?.[sector])
  ) {
    return (
      <section className="lap-replay lap-replay--unavailable">
        <div className="lap-replay-head">
          <div>
            <span>Replay 1v1</span>
            <h2>Reproducción de la vuelta</h2>
          </div>
        </div>

        <p>
          El trazado animado todavía no está disponible para este circuito.
          Los gráficos de telemetría siguen funcionando normalmente.
        </p>
      </section>
    );
  }

  const sectorComparisons = getSectorComparisons(
    comparison?.lapA,
    comparison?.lapB,
    codeA,
    codeB,
    colorA,
    colorB
  );

  const referenceProgress = (frame.progressA + frame.progressB) / 2;
  const sector = sectorForProgress(referenceProgress, geometry);

  let leaderText = "Igualados";
  if (Math.abs(frame.delta) >= 0.005) {
    leaderText =
      frame.delta > 0
        ? `${codeA} llega antes a este punto`
        : `${codeB} llega antes a este punto`;
  }

  let gainText = "Diferencia estable";
  let gainDriver = null;

  if (Math.abs(frame.gain) >= 0.008) {
    gainDriver = frame.gain > 0 ? codeA : codeB;
    gainText = `${gainDriver} gana ${Math.abs(frame.gain).toFixed(3)} s en el último tramo`;
  }

  return (
    <section
      className="lap-replay"
      style={{
        "--replay-a": colorA,
        "--replay-b": colorB,
      }}
    >
      <div className="lap-replay-head">
        <div>
          <span>Replay 1v1</span>
          <h2>La vuelta, sobre el circuito</h2>
          <p>
            Ambos pilotos parten juntos. El reloj es compartido: si un punto
            se separa, esa diferencia se está creando realmente en ese tramo.
          </p>
        </div>

        <div className="lap-replay-head-status">
          <strong>{sector}</strong>
          <span>{Math.round(referenceProgress)}% de la vuelta</span>
        </div>
      </div>

      <div className="lap-replay-layout">
        <div className="lap-replay-map-shell">
          <div className="lap-replay-map-top">
            <div className="lap-replay-legend">
              <span>
                <i style={{ background: colorA }} />
                {codeA} · {driverA?.team_name || "Piloto A"}
              </span>

              <span>
                <i
                  className={sameTeam ? "is-ring" : ""}
                  style={{
                    background: sameTeam ? "transparent" : colorB,
                    borderColor: colorB,
                  }}
                />
                {codeB} · {driverB?.team_name || "Piloto B"}
              </span>
            </div>

            <div className="lap-replay-map-actions">
              <button
                type="button"
                className={`lap-replay-corner-toggle ${cornerExplorerOpen ? "active" : ""}`}
                onClick={toggleCornerExplorer}
                disabled={!cornerExplorer?.corners?.length}
              >
                Explorar curvas
              </button>

              {cornerExplorerOpen && cornerExplorer?.decisiveCorners?.length > 0 && (
                <button
                  type="button"
                  className={`lap-replay-corner-tour ${cornerTouring ? "active" : ""}`}
                  onClick={toggleCornerTour}
                >
                  {cornerTouring
                    ? `Recorriendo ${Math.min(
                        cornerTourIndex + 1,
                        cornerExplorer.decisiveCorners.length
                      )}/${cornerExplorer.decisiveCorners.length}`
                    : "Recorrer diferencias"}
                </button>
              )}

              <button
                type="button"
                className={`lap-replay-key-zones-toggle ${showKeyZones ? "active" : ""}`}
                onClick={toggleKeyZones}
              >
                ¿Dónde se ganó la vuelta?
              </button>

              {showKeyZones && (
                <div className="lap-replay-zone-count">
                  {[3, 5].map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={keyZoneCount === value ? "active" : ""}
                      onClick={() => setKeyZoneCount(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                className={`lap-replay-trail-toggle ${showTrails ? "active" : ""}`}
                onClick={() => setShowTrails((current) => !current)}
              >
                Estela {showTrails ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <svg
            className="lap-replay-map"
            viewBox={track.viewBox}
            role="img"
            aria-label={`Replay de ${driverName(driverA, codeA)} y ${driverName(
              driverB,
              codeB
            )}`}
          >
            <defs>
              <filter id="lap-replay-glow-a" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="7" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <filter id="lap-replay-glow-b" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="7" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <g className="lap-replay-track-base">
              {SECTORS.map((sectorName, index) => (
                <path
                  key={`base-${sectorName}`}
                  ref={(node) => {
                    pathRefs.current[sectorName] = node;
                  }}
                  className={`lap-replay-sector lap-replay-sector--${index + 1}`}
                  d={track.sectors[sectorName]}
                  pathLength="100"
                />
              ))}
            </g>

            {cornerExplorerOpen && cornerExplorer?.corners?.length > 0 && (
              <g className="lap-replay-corner-explorer-layer">
                {cornerExplorer.corners.map((corner) => {
                  const selected = selectedCorner?.id === corner.id;

                  return (
                    <g
                      key={`corner-segment-${corner.id}`}
                      className={`lap-replay-corner-segment-group ${
                        selected ? "selected" : ""
                      }`}
                      style={{ "--corner-color": corner.color }}
                    >
                      {corner.path && (
                        <>
                          <path
                            className="lap-replay-corner-segment"
                            d={corner.path}
                          />
                          <path
                            className="lap-replay-corner-hit"
                            d={corner.path}
                            onClick={() => {
                              setCornerTouring(false);
                              focusCorner(corner);
                            }}
                          />
                        </>
                      )}

                      {corner.marker && (
                        <g
                          className="lap-replay-corner-node"
                          transform={`translate(${corner.marker.x} ${corner.marker.y})`}
                          role="button"
                          tabIndex={0}
                          aria-label={`Analizar curva ${corner.number}${corner.letter || ""}`}
                          onClick={() => {
                            setCornerTouring(false);
                            focusCorner(corner);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setCornerTouring(false);
                              focusCorner(corner);
                            }
                          }}
                        >
                          <circle r={selected ? 15 : 11} />
                          <text
                            x="0"
                            y="1"
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            {corner.number}{corner.letter || ""}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            )}

            {cornerExplorerOpen && cornerExplorer?.straightZones?.length > 0 && (
              <g className="lap-replay-straight-zones">
                {cornerExplorer.straightZones.map((straight) => (
                  <g
                    key={straight.id}
                    className="lap-replay-straight-zone"
                    style={{ "--straight-color": straight.color }}
                  >
                    {straight.path && (
                      <path
                        className="lap-replay-straight-line"
                        d={straight.path}
                      />
                    )}

                    {straight.marker && (
                      <g
                        className="lap-replay-straight-marker"
                        transform={`translate(${straight.marker.x} ${straight.marker.y})`}
                      >
                        <rect x="-20" y="-10" width="40" height="20" rx="7" />
                        <text
                          x="0"
                          y="1"
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          {straight.label}
                        </text>
                      </g>
                    )}
                  </g>
                ))}
              </g>
            )}

            {showKeyZones && lapAnalysis?.topZones?.length > 0 && (
              <g
                className="lap-replay-key-zones"
                style={{
                  "--zone-color":
                    lapAnalysis.winnerKey === "A" ? colorA : colorB,
                }}
              >
                {lapAnalysis.topZones.slice(0, keyZoneCount).map((zone) => (
                  <g key={`key-zone-${zone.rank}`}>
                    {zone.path && (
                      <>
                        <path
                          className="lap-replay-key-zone-glow"
                          d={zone.path}
                        />
                        <path
                          className="lap-replay-key-zone-line"
                          d={zone.path}
                        />
                      </>
                    )}

                    {zone.marker && (
                      <g
                        className="lap-replay-key-zone-marker"
                        transform={`translate(${zone.marker.x} ${zone.marker.y})`}
                      >
                        <circle r="15" />
                        <text
                          x="0"
                          y="1"
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          {zone.rank}
                        </text>
                      </g>
                    )}
                  </g>
                ))}
              </g>
            )}

            <g className="lap-replay-trails">
              {SECTORS.map((sectorName) => (
                <path
                  key={`trail-a-${sectorName}`}
                  ref={(node) => {
                    trailARefs.current[sectorName] = node;
                  }}
                  className="lap-replay-trail lap-replay-trail--a"
                  d={track.sectors[sectorName]}
                  pathLength="100"
                />
              ))}

              {SECTORS.map((sectorName) => (
                <path
                  key={`trail-b-${sectorName}`}
                  ref={(node) => {
                    trailBRefs.current[sectorName] = node;
                  }}
                  className={`lap-replay-trail lap-replay-trail--b ${
                    sameTeam ? "same-team" : ""
                  }`}
                  d={track.sectors[sectorName]}
                  pathLength="100"
                />
              ))}
            </g>

            {cornerExplorerOpen && selectedCorner && (
              <g className="lap-replay-corner-events">
                {cornerEventPoints(
                  selectedCorner,
                  cornerEvent,
                  codeA,
                  codeB,
                  colorA,
                  colorB
                ).map((eventPoint) => {
                  const point = pointAtProgress(
                    eventPoint.progress,
                    geometry,
                    pathRefs,
                    eventPoint.laneOffset
                  );

                  if (!point) return null;

                  return (
                    <g
                      key={`corner-event-${cornerEvent}-${eventPoint.key}`}
                      className={`lap-replay-corner-event-marker is-${eventPoint.shape}`}
                      style={{ "--event-color": eventPoint.color }}
                      transform={`translate(${point.x} ${point.y})`}
                    >
                      <circle className="lap-replay-corner-event-pulse" r="18" />

                      {eventPoint.shape === "square" && (
                        <rect
                          className="lap-replay-corner-event-shape"
                          x="-9"
                          y="-9"
                          width="18"
                          height="18"
                          rx="4"
                        />
                      )}

                      {eventPoint.shape === "diamond" && (
                        <rect
                          className="lap-replay-corner-event-shape"
                          x="-8"
                          y="-8"
                          width="16"
                          height="16"
                          rx="3"
                          transform="rotate(45)"
                        />
                      )}

                      {eventPoint.shape === "chevron" && (
                        <path
                          className="lap-replay-corner-event-shape"
                          d="M -10 -8 L 0 0 L -10 8 M 0 -8 L 10 0 L 0 8"
                        />
                      )}

                      <line
                        className="lap-replay-corner-event-connector"
                        x1="0"
                        y1={eventPoint.labelOffsetY > 0 ? 9 : -9}
                        x2="0"
                        y2={eventPoint.labelOffsetY > 0 ? 18 : -18}
                      />

                      <g
                        className="lap-replay-corner-event-label"
                        transform={`translate(0 ${eventPoint.labelOffsetY})`}
                      >
                        <rect x="-28" y="-12" width="56" height="24" rx="12" />
                        <text
                          x="0"
                          y="1"
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          {eventPoint.code}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </g>
            )}

            <g
              ref={markerARef}
              className={`lap-replay-marker lap-replay-marker--a ${cornerExplorerOpen ? "is-analysis-hidden" : ""}`}
            >
              <circle className="lap-replay-marker-glow" r="16" />
              <circle className="lap-replay-marker-dot" r="9" />
              <g className="lap-replay-marker-label" transform="translate(0 -34)">
                <rect x="-27" y="-13" width="54" height="26" rx="13" />
                <text x="0" y="1" textAnchor="middle" dominantBaseline="middle">
                  {codeA}
                </text>
              </g>
            </g>

            <g
              ref={markerBRef}
              className={`lap-replay-marker lap-replay-marker--b ${cornerExplorerOpen ? "is-analysis-hidden" : ""}`}
            >
              <circle className="lap-replay-marker-glow" r="16" />
              <circle className="lap-replay-marker-dot" r="9" />
              <g className="lap-replay-marker-label" transform="translate(0 34)">
                <rect x="-27" y="-13" width="54" height="26" rx="13" />
                <text x="0" y="1" textAnchor="middle" dominantBaseline="middle">
                  {codeB}
                </text>
              </g>
            </g>
          </svg>

          <div className="lap-replay-sector-key">
            <span><i className="s1" />S1</span>
            <span><i className="s2" />S2</span>
            <span><i className="s3" />S3</span>
          </div>

          {cornerExplorerOpen && (
            <>
              <div className="lap-replay-event-mode">
                <span>Analizando</span>
                <strong>
                  {cornerEvent === "brake"
                    ? "Frenada"
                    : cornerEvent === "apex"
                      ? "Punto lento"
                      : "Gas 100%"}
                </strong>
              </div>

              <div className="lap-replay-corner-legend">
              <span><i style={{ background: colorA }} />{codeA} gana tiempo</span>
              <span><i style={{ background: colorB }} />{codeB} gana tiempo</span>
              <span><i className="neutral" />Diferencia mínima</span>
              <span className="straight-key"><b>R#</b> Recta detectada</span>
              <small>Los círculos numerados son curvas reales del circuito; las etiquetas R# identifican rectas de alta velocidad.</small>
              </div>
            </>
          )}
        </div>

        <aside className="lap-replay-live-panel">
          <div className="lap-replay-delta-card">
            <span>Delta acumulado</span>
            <strong>{formatSigned(frame.delta)}</strong>
            <p>{leaderText}</p>
          </div>

          <div className={`lap-replay-gain-card ${gainDriver ? "active" : ""}`}>
            <span>Último 3% del trazado</span>
            <strong>{gainText}</strong>
          </div>

          {cornerExplorerOpen && selectedCorner && (
            <div
              className="lap-replay-corner-inspector"
              style={{ "--corner-driver": selectedCorner.color }}
            >
              <div className="lap-replay-corner-inspector-head">
                <div>
                  <span>Interactive Corner Explorer</span>
                  <h3>
                    Curva {selectedCorner.number}{selectedCorner.letter || ""}
                    <small>{selectedCorner.type}</small>
                  </h3>
                </div>

                <div className="lap-replay-corner-gain">
                  <strong>{selectedCorner.winnerCode}</strong>
                  <span>
                    {selectedCorner.winnerKey
                      ? `+${selectedCorner.timeGain.toFixed(3)} s`
                      : "≈ 0.000 s"}
                  </span>
                </div>
              </div>

              <p className="lap-replay-corner-explanation">
                {selectedCorner.explanation}
              </p>

              <div className="lap-replay-corner-speed-table">
                <div className="head">
                  <span>Velocidad</span>
                  <strong style={{ color: colorA }}>{codeA}</strong>
                  <strong style={{ color: colorB }}>{codeB}</strong>
                </div>

                {[
                  ["Entrada", selectedCorner.entrySpeedA, selectedCorner.entrySpeedB],
                  ["Punto lento", selectedCorner.apexSpeedA, selectedCorner.apexSpeedB],
                  ["Salida", selectedCorner.exitSpeedA, selectedCorner.exitSpeedB],
                ].map(([label, speedA, speedB]) => (
                  <div className="row" key={label}>
                    <span>{label}</span>
                    <b>{Math.round(speedA)} km/h</b>
                    <b>{Math.round(speedB)} km/h</b>
                  </div>
                ))}
              </div>

              <div className="lap-replay-corner-events-summary">
                <div>
                  <span>Frenada</span>
                  <strong>{selectedCorner.brakeComparison.text}</strong>
                </div>
                <div>
                  <span>Gas 100%</span>
                  <strong>{selectedCorner.throttleComparison.text}</strong>
                </div>
              </div>

              <div className="lap-replay-corner-event-switcher">
                <span>Mostrar sobre el mapa</span>
                <div>
                  {[
                    ["brake", "Frenada"],
                    ["apex", "Punto lento"],
                    ["throttle", "Gas 100%"],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={cornerEvent === value ? "active" : ""}
                      onClick={() => setCornerEvent(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <small className="lap-replay-corner-note">
                “Punto lento” usa la zona de mínima velocidad de la telemetría como aproximación práctica al ápice.
              </small>
            </div>
          )}

          <div className="lap-replay-sector-times">
            <div className="lap-replay-sector-times-head">
              <span>Mejores sectores</span>
              <strong>Vuelta seleccionada</strong>
            </div>

            <div className="lap-replay-sector-times-grid">
              {sectorComparisons.map((item) => (
                <div
                  key={item.sector}
                  className="lap-replay-sector-time"
                  style={{ "--sector-winner": item.color }}
                >
                  <div className="lap-replay-sector-time-label">
                    <span>{item.sector}</span>
                    <i />
                  </div>

                  <strong>{item.winner}</strong>
                  <b>{formatSectorTime(item.winnerTime)}</b>

                  <small>
                    {item.available && Number.isFinite(item.gap)
                      ? `${item.gap.toFixed(3)} s más rápido`
                      : item.available
                        ? "Sin comparación del rival"
                        : "Sin dato de sector"}
                  </small>
                </div>
              ))}
            </div>
          </div>

          {lapAnalysis && (
            <div className="lap-replay-reading">
              <div className="lap-replay-reading-head">
                <span>Lectura rápida</span>
                <strong>
                  {lapAnalysis.winnerCode} · {lapAnalysis.lapGap.toFixed(3)} s
                </strong>
              </div>

              <div className="lap-replay-reading-grid">
                <div>
                  <span>Velocidad máxima</span>
                  <strong>
                    {lapAnalysis.maxSpeed.winner} · {Math.round(lapAnalysis.maxSpeed.speed)} km/h
                  </strong>
                  <small>
                    +{lapAnalysis.maxSpeed.diff.toFixed(0)} km/h vs rival
                  </small>
                </div>

                <div>
                  <span>Curvas lentas</span>
                  <strong>{lapAnalysis.slow.winner}</strong>
                  <small>
                    {lapAnalysis.slow.gain > 0
                      ? `${lapAnalysis.slow.gain.toFixed(3)} s de ventaja acumulada`
                      : "Diferencia mínima"}
                  </small>
                </div>

                <div>
                  <span>Curvas rápidas</span>
                  <strong>{lapAnalysis.fast.winner}</strong>
                  <small>
                    {lapAnalysis.fast.gain > 0
                      ? `${lapAnalysis.fast.gain.toFixed(3)} s de ventaja acumulada`
                      : "Diferencia mínima"}
                  </small>
                </div>

                <div>
                  <span>Rectas</span>
                  <strong>{lapAnalysis.straight.winner}</strong>
                  <small>
                    {lapAnalysis.straight.gain > 0
                      ? `${lapAnalysis.straight.gain.toFixed(3)} s de ventaja acumulada`
                      : "Diferencia mínima"}
                  </small>
                </div>
              </div>
            </div>
          )}

          {[{
            key: "A",
            code: codeA,
            name: driverName(driverA, codeA),
            team: driverA?.team_name,
            color: colorA,
            speed: frame.speedA,
            throttle: frame.throttleA,
            brake: frame.brakeA,
            progress: frame.progressA,
          }, {
            key: "B",
            code: codeB,
            name: driverName(driverB, codeB),
            team: driverB?.team_name,
            color: colorB,
            speed: frame.speedB,
            throttle: frame.throttleB,
            brake: frame.brakeB,
            progress: frame.progressB,
          }].map((item) => (
            <div
              key={item.key}
              className="lap-replay-driver-live"
              style={{ "--driver-live": item.color }}
            >
              <div className="lap-replay-driver-live-head">
                <i />
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.team || item.name}</span>
                </div>
                <b>{Math.round(item.speed)} <small>km/h</small></b>
              </div>

              <div className="lap-replay-driver-bars">
                <div>
                  <span>Acelerador</span>
                  <strong>{Math.round(item.throttle)}%</strong>
                  <i>
                    <b style={{ width: `${clamp(item.throttle, 0, 100)}%` }} />
                  </i>
                </div>

                <div>
                  <span>Freno</span>
                  <strong>{Math.round(item.brake)}%</strong>
                  <i>
                    <b style={{ width: `${clamp(item.brake, 0, 100)}%` }} />
                  </i>
                </div>
              </div>

              <div className="lap-replay-driver-state">
                <span>{drivingState(item.speed, item.throttle, item.brake)}</span>
                <strong>{item.progress.toFixed(1)}%</strong>
              </div>
            </div>
          ))}
        </aside>
      </div>

      {lapAnalysis && (
        <section className="lap-replay-explainer">
          <div className="lap-replay-explainer-head">
            <div>
              <span>Análisis de la vuelta</span>
              <h3>Por qué {lapAnalysis.winnerCode} fue más rápido</h3>
              <p>
                GridPulse divide la vuelta en pequeños tramos y observa dónde cambia el delta,
                combinándolo con velocidad, acelerador, freno y la geometría del circuito.
              </p>
            </div>

            <button
              type="button"
              className={`lap-replay-explainer-button ${showKeyZones ? "active" : ""}`}
              onClick={toggleKeyZones}
            >
              {showKeyZones ? "Ocultar zonas" : "Mostrar dónde se ganó la vuelta"}
            </button>
          </div>

          <div className="lap-replay-explainer-cards">
            <article>
              <span>Vuelta más rápida</span>
              <strong>{lapAnalysis.winnerCode}</strong>
              <b>{lapAnalysis.lapGap.toFixed(3)} s</b>
              <small>ventaja final sobre {lapAnalysis.rivalCode}</small>
            </article>

            <article>
              <span>Velocidad punta</span>
              <strong>{lapAnalysis.maxSpeed.winner}</strong>
              <b>{Math.round(lapAnalysis.maxSpeed.speed)} km/h</b>
              <small>+{lapAnalysis.maxSpeed.diff.toFixed(0)} km/h frente al rival</small>
            </article>

            <article>
              <span>Curvas lentas</span>
              <strong>{lapAnalysis.slow.winner}</strong>
              <b>{lapAnalysis.slow.gain ? `${lapAnalysis.slow.gain.toFixed(3)} s` : "≈"}</b>
              <small>ganancia acumulada estimada</small>
            </article>

            <article>
              <span>Curvas rápidas</span>
              <strong>{lapAnalysis.fast.winner}</strong>
              <b>{lapAnalysis.fast.gain ? `${lapAnalysis.fast.gain.toFixed(3)} s` : "≈"}</b>
              <small>ganancia acumulada estimada</small>
            </article>

            <article>
              <span>Rectas</span>
              <strong>{lapAnalysis.straight.winner}</strong>
              <b>{lapAnalysis.straight.gain ? `${lapAnalysis.straight.gain.toFixed(3)} s` : "≈"}</b>
              <small>ganancia acumulada estimada</small>
            </article>
          </div>

          {showKeyZones && (
            <div className="lap-replay-key-zone-list">
              <div className="lap-replay-key-zone-list-head">
                <span>Zonas decisivas</span>
                <strong>Top {keyZoneCount}</strong>
              </div>

              <div className="lap-replay-key-zone-items">
                {lapAnalysis.topZones.slice(0, keyZoneCount).map((zone) => (
                  <article key={`zone-card-${zone.rank}`}>
                    <b>{zone.rank}</b>
                    <div>
                      <span>{zone.label}</span>
                      <strong>{zone.type}</strong>
                      <p>{zone.reason}</p>
                    </div>
                    <em>+{zone.winnerGain.toFixed(3)} s</em>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="lap-replay-controls">
        <button
          type="button"
          className="lap-replay-play"
          onClick={togglePlay}
        >
          {playing ? "Pausar" : "Reproducir"}
        </button>

        <button
          type="button"
          className="lap-replay-reset"
          onClick={restart}
        >
          Reiniciar
        </button>

        <div className="lap-replay-timeline">
          <span>{formatReplayClock(frame.elapsed)}</span>

          <input
            type="range"
            min="0"
            max={totalDuration}
            step="0.05"
            value={Math.min(frame.elapsed, totalDuration)}
            onChange={(event) => seek(event.target.value)}
            aria-label="Posición de la reproducción"
          />

          <span>{formatReplayClock(totalDuration)}</span>
        </div>

        <div className="lap-replay-rates">
          {[1, 2, 4].map((value) => (
            <button
              type="button"
              key={value}
              className={rate === value ? "active" : ""}
              onClick={() => setRate(value)}
            >
              ×{value}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
