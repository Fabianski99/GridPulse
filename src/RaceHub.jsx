import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CountryFlag,
  FlagBackground,
} from "./CountryFlag";

import "./RaceHub.css";

const API = "https://api.jolpi.ca/ergast/f1";
const OPENF1 = "https://api.openf1.org/v1";
const DEFAULT_YEAR = 2026;
const REFRESH_MS = 5 * 60 * 1000;

const TRACK_BASE =
  "https://raw.githubusercontent.com/MasterPlay007/F1-Track-Layouts-SVG/main";

const TRACKS = {
  albert_park: "albert_park.svg",
  shanghai: "shanghai.svg",
  suzuka: "suzuka.svg",
  miami: "miami.svg",
  villeneuve: "villeneuve.svg",
  monaco: "monaco.svg",
  catalunya: "catalunya.svg",
  red_bull_ring: "red_bull_ring.svg",
  silverstone: "silverstone.svg",
  spa: "spa.svg",
  hungaroring: "hungaroring.svg",
  zandvoort: "zandvoort.svg",
  monza: "monza.svg",
  baku: "baku.svg",
  marina_bay: "marina_bay.svg",
  americas: "americas.svg",
  rodriguez: "rodriguez.svg",
  interlagos: "interlagos.svg",
  vegas: "vegas.svg",
  las_vegas: "vegas.svg",
  losail: "losail.svg",
  yas_marina: "yas_marina.svg",
  jeddah: "jeddah.svg",
  bahrain: "bahrain.svg",
};

const TEAM_COLORS = {
  mercedes: "#00f5d4",
  ferrari: "#ff294d",
  mclaren: "#ff9500",
  red_bull: "#5670ff",
  aston_martin: "#00d6a3",
  alpine: "#ff4fbd",
  williams: "#39a6ff",
  haas: "#d6d6d6",
  rb: "#6f86ff",
  audi: "#ff4255",
  cadillac: "#e4e4e4",
  sauber: "#72ff4d",
  alfa: "#a30036",
  alphatauri: "#7897ff",
  racing_point: "#ff7ac8",
  renault: "#ffd800",
};

const JOLPICA_CACHE = new Map();
const JOLPICA_INFLIGHT = new Map();
const OPENF1_CACHE = new Map();
const OPENF1_INFLIGHT = new Map();

let openF1Queue = Promise.resolve();
let lastOpenF1RequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedCountry(value = "") {
  const normalized = normalizeText(value);

  const aliases = {
    usa: "united states",
    "united states of america": "united states",
    uk: "great britain",
    "united kingdom": "great britain",
    uae: "united arab emirates",
  };

  return aliases[normalized] || normalized;
}

function teamColor(constructorId, fallback = "#00f5d4") {
  return TEAM_COLORS[constructorId] || fallback;
}

async function fetchJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error ${response.status}`);
  }

  return response.json();
}

async function cachedFetch(url, ttl = 5 * 60 * 1000) {
  const cached = JOLPICA_CACHE.get(url);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const inflight = JOLPICA_INFLIGHT.get(url);
  if (inflight) return inflight;

  const request = fetchJSON(url)
    .then((data) => {
      JOLPICA_CACHE.set(url, {
        data,
        expiresAt: Date.now() + ttl,
      });

      return data;
    })
    .finally(() => {
      JOLPICA_INFLIGHT.delete(url);
    });

  JOLPICA_INFLIGHT.set(url, request);
  return request;
}

function openF1Query(params = {}) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    query.set(key, String(value));
  });

  return query;
}

function scheduleOpenF1(task) {
  const run = async () => {
    const gap = 390;
    const elapsed = Date.now() - lastOpenF1RequestAt;

    if (elapsed < gap) {
      await wait(gap - elapsed);
    }

    lastOpenF1RequestAt = Date.now();
    return task();
  };

  const scheduled = openF1Queue.then(run, run);
  openF1Queue = scheduled.catch(() => undefined);
  return scheduled;
}

async function openF1(endpoint, params = {}, ttl = 20 * 60 * 1000) {
  const query = openF1Query(params);
  const url = `${OPENF1}/${endpoint}?${query.toString()}`;

  const cached = OPENF1_CACHE.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const inflight = OPENF1_INFLIGHT.get(url);
  if (inflight) return inflight;

  const request = scheduleOpenF1(async () => {
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url);

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          await wait(
            Number.isFinite(retryAfter)
              ? Math.max(900, retryAfter * 1000)
              : 900 * 2 ** attempt
          );
          continue;
        }

        if (!response.ok) {
          throw new Error(`OpenF1 respondió ${response.status}`);
        }

        const data = await response.json();
        OPENF1_CACHE.set(url, {
          data,
          expiresAt: Date.now() + ttl,
        });

        return data;
      } catch (error) {
        lastError = error;

        if (attempt < 2) {
          await wait(650 * (attempt + 1));
        }
      }
    }

    throw lastError || new Error("No fue posible consultar OpenF1.");
  }).finally(() => {
    OPENF1_INFLIGHT.delete(url);
  });

  OPENF1_INFLIGHT.set(url, request);
  return request;
}

function parseDate(date, time = "12:00:00Z") {
  if (!date) return null;

  const normalizedTime = time || "12:00:00Z";
  const hasZone = /Z$|[+-]\d\d:\d\d$/.test(normalizedTime);
  const value = new Date(`${date}T${normalizedTime}${hasZone ? "" : "Z"}`);

  return Number.isNaN(value.getTime()) ? null : value;
}

function formatDate(date) {
  if (!date) return "—";

  return new Intl.DateTimeFormat("es-CL", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatShortDate(date) {
  if (!date) return "—";

  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
  }).format(new Date(`${date}T12:00:00`));
}

function formatSessionTime(session) {
  const date = parseDate(session?.date, session?.time || "12:00:00Z");

  if (!date) return "Por confirmar";

  return new Intl.DateTimeFormat("es-CL", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "—";

  if (value >= 3600) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${secs
      .toFixed(3)
      .padStart(6, "0")}`;
  }

  const minutes = Math.floor(value / 60);
  const secs = value - minutes * 60;
  return `${minutes}:${secs.toFixed(3).padStart(6, "0")}`;
}

function lastValidDuration(duration) {
  if (Array.isArray(duration)) {
    const values = duration.filter((value) => Number.isFinite(Number(value)));
    return values.length ? Number(values[values.length - 1]) : null;
  }

  const value = Number(duration);
  return Number.isFinite(value) ? value : null;
}

function formatOpenGap(gap) {
  if (Array.isArray(gap)) {
    const values = gap.filter((value) => value !== null && value !== undefined);
    return values.length ? formatOpenGap(values[values.length - 1]) : "—";
  }

  if (typeof gap === "string") return gap;

  const value = Number(gap);
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.0005) return "Líder";
  return `+${value.toFixed(3)} s`;
}

function driverName(driver) {
  if (!driver) return "—";
  return `${driver.givenName || ""} ${driver.familyName || ""}`.trim();
}

function driverCode(driver) {
  return (
    driver?.code ||
    driver?.familyName?.slice(0, 3)?.toUpperCase() ||
    "---"
  );
}

function sessionStatus(session, raceHasResult = false) {
  if (!session?.date) return "pending";
  if (session.key === "race" && raceHasResult) return "complete";

  const start = parseDate(session.date, session.time || "12:00:00Z");
  if (!start) return "pending";

  const now = Date.now();
  const startMs = start.getTime();
  const approximateEnd = startMs + (session.key === "race" ? 3 : 2) * 60 * 60 * 1000;

  if (now > approximateEnd) return "complete";
  if (now >= startMs - 30 * 60 * 1000 && now <= approximateEnd) return "live";
  return "upcoming";
}

function getWeekendSessions(race) {
  if (!race) return [];

  const sprintQualifying = race.SprintQualifying || race.SprintShootout;

  return [
    {
      key: "fp1",
      label: "Práctica 1",
      short: "FP1",
      source: "openf1",
      date: race.FirstPractice?.date,
      time: race.FirstPractice?.time,
      openName: "Practice 1",
    },
    {
      key: "fp2",
      label: "Práctica 2",
      short: "FP2",
      source: "openf1",
      date: race.SecondPractice?.date,
      time: race.SecondPractice?.time,
      openName: "Practice 2",
    },
    {
      key: "fp3",
      label: "Práctica 3",
      short: "FP3",
      source: "openf1",
      date: race.ThirdPractice?.date,
      time: race.ThirdPractice?.time,
      openName: "Practice 3",
    },
    {
      key: "sprintQualifying",
      label: "Clasificación Sprint",
      short: "SQ",
      source: "openf1",
      date: sprintQualifying?.date,
      time: sprintQualifying?.time,
      openName: "Sprint Qualifying",
    },
    {
      key: "sprint",
      label: "Sprint",
      short: "SPR",
      source: "jolpica",
      date: race.Sprint?.date,
      time: race.Sprint?.time,
    },
    {
      key: "qualifying",
      label: "Clasificación",
      short: "Q",
      source: "jolpica",
      date: race.Qualifying?.date,
      time: race.Qualifying?.time,
    },
    {
      key: "race",
      label: "Carrera",
      short: "RACE",
      source: "jolpica",
      date: race.date,
      time: race.time,
    },
  ].filter((session) => session.date);
}

function trackFile(circuitId) {
  return TRACKS[circuitId] || null;
}

const RaceHubTrack = memo(function RaceHubTrack({ circuitId }) {
  const [failed, setFailed] = useState(false);
  const file = trackFile(circuitId);

  if (!file || failed) {
    return (
      <svg className="racehub-track-fallback" viewBox="0 0 180 90" fill="none">
        <path
          d="M16 59C29 18 55 16 67 38C78 60 87 74 108 65C134 54 130 20 152 19C166 18 169 39 158 50C147 61 122 62 115 73C106 87 82 80 73 68C61 51 41 73 16 59Z"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <img
      className="racehub-track-image"
      src={`${TRACK_BASE}/${file}`}
      alt="Trazado del circuito"
      loading="eager"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
});

function getRoundRace(data) {
  return data?.MRData?.RaceTable?.Races?.[0] || null;
}

function sessionHasStarted(session) {
  if (!session?.date) return false;

  const start = parseDate(session.date, session.time || "12:00:00Z");
  if (!start) return false;

  return Date.now() >= start.getTime() - 15 * 60 * 1000;
}

function raceStartTimestamp(race) {
  const start = parseDate(race?.date, race?.time || "12:00:00Z");
  return start?.getTime() || null;
}

function completedRoundsFromSeasonData(data) {
  return new Set(
    (data?.MRData?.RaceTable?.Races || [])
      .filter((race) => race?.Results?.length > 0)
      .map((race) => String(race.round))
  );
}

function findDefaultRace(races, completedRounds) {
  if (!races.length) return null;

  const now = Date.now();
  const currentGrace = 4 * 60 * 60 * 1000;

  const candidate = races.find((race) => {
    const round = String(race.round);

    if (completedRounds.has(round)) {
      return false;
    }

    const start = raceStartTimestamp(race);

    if (!start) {
      return new Date(`${race.date}T23:59:59`).getTime() >= now;
    }

    /*
      Una carrera que empezó hace menos de 4 horas sigue siendo
      el evento actual mientras todavía no exista resultado oficial.
      En cuanto Jolpica publica Results, desaparece inmediatamente
      de esta búsqueda y pasa al siguiente GP.
    */
    return start >= now - currentGrace;
  });

  return candidate || races[races.length - 1];
}

async function loadRoundCore(year, round, race, { force = false } = {}) {
  const suffix = force ? `&_=${Date.now()}` : "";
  const ttl = force ? 1000 : 5 * 60 * 1000;

  /*
    Para un GP futuro no tiene sentido pedir clasificación y Sprint
    antes de que esas sesiones hayan empezado. Esto reduce peticiones
    al entrar al Race Hub y mantiene Jolpica como fuente principal.
  */
  const qualifyingRequest =
    race?.Qualifying && sessionHasStarted(race.Qualifying)
      ? cachedFetch(`${API}/${year}/${round}/qualifying.json?limit=100${suffix}`, ttl)
      : Promise.resolve(null);

  const sprintRequest =
    race?.Sprint && sessionHasStarted(race.Sprint)
      ? cachedFetch(`${API}/${year}/${round}/sprint.json?limit=100${suffix}`, ttl)
      : Promise.resolve(null);

  const [raceResult, qualifying, sprint] = await Promise.allSettled([
    cachedFetch(`${API}/${year}/${round}/results.json?limit=100${suffix}`, ttl),
    qualifyingRequest,
    sprintRequest,
  ]);

  return {
    race: raceResult.status === "fulfilled" ? getRoundRace(raceResult.value) : null,
    qualifying:
      qualifying.status === "fulfilled" && qualifying.value
        ? getRoundRace(qualifying.value)
        : null,
    sprint:
      sprint.status === "fulfilled" && sprint.value
        ? getRoundRace(sprint.value)
        : null,
  };
}

function scoreMeetingMatch(meeting, race) {
  let score = 0;
  const meetingCountry = normalizedCountry(meeting?.country_name);
  const raceCountry = normalizedCountry(race?.Circuit?.Location?.country);

  if (meetingCountry && raceCountry && meetingCountry === raceCountry) {
    score += 100;
  }

  const meetingLocation = normalizeText(meeting?.location);
  const raceLocality = normalizeText(race?.Circuit?.Location?.locality);
  const raceCircuit = normalizeText(race?.Circuit?.circuitName);

  if (
    meetingLocation &&
    raceLocality &&
    (meetingLocation.includes(raceLocality) || raceLocality.includes(meetingLocation))
  ) {
    score += 80;
  }

  if (
    meetingLocation &&
    raceCircuit &&
    (raceCircuit.includes(meetingLocation) || meetingLocation.includes(raceCircuit))
  ) {
    score += 35;
  }

  const meetingDate = new Date(meeting?.date_start || 0).getTime();
  const raceDate = new Date(`${race?.date || "1970-01-01"}T12:00:00Z`).getTime();

  if (Number.isFinite(meetingDate) && Number.isFinite(raceDate)) {
    const dayDifference = Math.abs(meetingDate - raceDate) / 86400000;
    score += Math.max(0, 30 - dayDifference * 3);
  }

  return score;
}

async function findOpenF1Meeting(race, year) {
  const meetings = await openF1("meetings", { year }, 30 * 60 * 1000);

  return [...meetings]
    .map((meeting) => ({
      meeting,
      score: scoreMeetingMatch(meeting, race),
    }))
    .sort((a, b) => b.score - a.score)[0]?.meeting || null;
}

async function loadOpenGrid(race, year) {
  const meeting = await findOpenF1Meeting(race, year);
  if (!meeting) throw new Error("No se encontró el Gran Premio en OpenF1.");

  const sessions = await openF1(
    "sessions",
    { meeting_key: meeting.meeting_key },
    30 * 60 * 1000
  );

  const raceSession = sessions.find(
    (item) => normalizeText(item.session_name) === "race"
  );

  if (!raceSession) {
    throw new Error("OpenF1 todavía no tiene la sesión de carrera.");
  }

  const [grid, drivers] = await Promise.all([
    openF1("starting_grid", { session_key: raceSession.session_key }),
    openF1("drivers", { session_key: raceSession.session_key }),
  ]);

  const driverMap = new Map(
    drivers.map((driver) => [Number(driver.driver_number), driver])
  );

  return [...grid]
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((entry) => {
      const driver = driverMap.get(Number(entry.driver_number));

      return {
        position: Number(entry.position),
        code: driver?.name_acronym || String(entry.driver_number),
        name: driver?.full_name || driver?.broadcast_name || "Piloto",
        team: driver?.team_name || "—",
        color: driver?.team_colour ? `#${driver.team_colour}` : "#00f5d4",
      };
    });
}

async function loadOpenSession(race, year, sessionName) {
  const meeting = await findOpenF1Meeting(race, year);
  if (!meeting) throw new Error("No se encontró el Gran Premio en OpenF1.");

  const sessions = await openF1(
    "sessions",
    { meeting_key: meeting.meeting_key },
    30 * 60 * 1000
  );

  const wanted = normalizeText(sessionName);
  const session = sessions.find(
    (item) => normalizeText(item.session_name) === wanted
  );

  if (!session) {
    throw new Error(`OpenF1 todavía no tiene ${sessionName} para este GP.`);
  }

  const [results, drivers] = await Promise.all([
    openF1("session_result", { session_key: session.session_key }),
    openF1("drivers", { session_key: session.session_key }),
  ]);

  const driverMap = new Map(
    drivers.map((driver) => [Number(driver.driver_number), driver])
  );

  return {
    session,
    rows: [...results]
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((result) => ({
        ...result,
        driver: driverMap.get(Number(result.driver_number)) || null,
      })),
  };
}

function sessionResultRows(sessionKey, core, openSession) {
  if (sessionKey === "race") {
    return (core.race?.Results || []).map((result) => ({
      type: "race",
      position: Number(result.position),
      code: driverCode(result.Driver),
      name: driverName(result.Driver),
      team: result.Constructor?.name || "—",
      teamColor: teamColor(result.Constructor?.constructorId),
      primary:
        result.Time?.time ||
        (result.status === "Finished" ? "Finalizó" : result.status || "—"),
      secondary: `${result.points || 0} pts`,
    }));
  }

  if (sessionKey === "sprint") {
    return (core.sprint?.SprintResults || []).map((result) => ({
      type: "sprint",
      position: Number(result.position),
      code: driverCode(result.Driver),
      name: driverName(result.Driver),
      team: result.Constructor?.name || "—",
      teamColor: teamColor(result.Constructor?.constructorId),
      primary: result.Time?.time || result.status || "—",
      secondary: `${result.points || 0} pts`,
    }));
  }

  if (sessionKey === "qualifying") {
    return (core.qualifying?.QualifyingResults || []).map((result) => ({
      type: "qualifying",
      position: Number(result.position),
      code: driverCode(result.Driver),
      name: driverName(result.Driver),
      team: result.Constructor?.name || "—",
      teamColor: teamColor(result.Constructor?.constructorId),
      q1: result.Q1 || "—",
      q2: result.Q2 || "—",
      q3: result.Q3 || "—",
      primary: result.Q3 || result.Q2 || result.Q1 || "—",
      secondary: "Mejor tiempo",
    }));
  }

  if (openSession?.rows) {
    return openSession.rows.map((result) => ({
      type: "openf1",
      position: Number(result.position),
      code: result.driver?.name_acronym || String(result.driver_number),
      name: result.driver?.full_name || result.driver?.broadcast_name || "Piloto",
      team: result.driver?.team_name || "—",
      teamColor: result.driver?.team_colour
        ? `#${result.driver.team_colour}`
        : "#00f5d4",
      primary: formatDuration(lastValidDuration(result.duration)),
      secondary: formatOpenGap(result.gap_to_leader),
      laps: result.number_of_laps,
      dnf: result.dnf,
      dns: result.dns,
      dsq: result.dsq,
    }));
  }

  return [];
}

function lapTimeSeconds(value) {
  if (!value) return Infinity;
  const parts = String(value).split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Infinity;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Infinity;
}

function getFastestLap(raceResult) {
  const results = raceResult?.Results || [];

  return (
    results.find((result) => String(result.FastestLap?.rank) === "1") ||
    results
      .filter((result) => result.FastestLap?.Time?.time)
      .sort(
        (a, b) =>
          lapTimeSeconds(a.FastestLap?.Time?.time) -
          lapTimeSeconds(b.FastestLap?.Time?.time)
      )[0] ||
    null
  );
}

function isRetirement(result) {
  const status = String(result?.status || "");

  if (!status) return false;
  if (status === "Finished") return false;
  if (/^\+\d+\s+Lap/i.test(status)) return false;
  if (/Lapped/i.test(status)) return false;

  return true;
}

function buildGrid(raceResult, qualifying) {
  if (raceResult?.Results?.length) {
    return raceResult.Results
      .filter((result) => Number(result.grid) > 0)
      .map((result) => ({
        position: Number(result.grid),
        code: driverCode(result.Driver),
        name: driverName(result.Driver),
        team: result.Constructor?.name || "—",
        color: teamColor(result.Constructor?.constructorId),
      }))
      .sort((a, b) => a.position - b.position);
  }

  return (qualifying?.QualifyingResults || []).map((result) => ({
    position: Number(result.position),
    code: driverCode(result.Driver),
    name: driverName(result.Driver),
    team: result.Constructor?.name || "—",
    color: teamColor(result.Constructor?.constructorId),
  }));
}

function ResultTable({ rows, sessionKey }) {
  if (!rows.length) {
    return (
      <div className="racehub-empty-panel">
        Todavía no hay resultados disponibles para esta sesión.
      </div>
    );
  }

  const qualifying = sessionKey === "qualifying";

  return (
    <div className="racehub-classification">
      <div className={`racehub-result-head ${qualifying ? "is-qualifying" : ""}`}>
        <span>Pos.</span>
        <span>Piloto</span>
        <span>Equipo</span>
        {qualifying ? (
          <>
            <span>Q1</span>
            <span>Q2</span>
            <span>Q3</span>
          </>
        ) : (
          <>
            <span>Tiempo / Estado</span>
            <span>Detalle</span>
          </>
        )}
      </div>

      {rows.map((row) => (
        <div
          className={`racehub-result-row ${qualifying ? "is-qualifying" : ""}`}
          key={`${sessionKey}-${row.position}-${row.code}`}
        >
          <strong className="racehub-result-position">P{row.position}</strong>

          <div className="racehub-result-driver">
            <span
              className="racehub-team-line"
              style={{
                background: row.teamColor,
                boxShadow: `0 0 12px ${row.teamColor}`,
              }}
            />
            <div>
              <strong>{row.code}</strong>
              <small>{row.name}</small>
            </div>
          </div>

          <span className="racehub-result-team">{row.team}</span>

          {qualifying ? (
            <>
              <span className="racehub-result-time">{row.q1}</span>
              <span className="racehub-result-time">{row.q2}</span>
              <span className="racehub-result-time">{row.q3}</span>
            </>
          ) : (
            <>
              <span className="racehub-result-time">{row.primary}</span>
              <span className="racehub-result-detail">
                {row.laps ? `${row.laps} vueltas · ` : ""}
                {row.secondary}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function StartingGrid({ rows }) {
  if (!rows.length) {
    return (
      <div className="racehub-empty-panel">
        La parrilla todavía no está disponible.
      </div>
    );
  }

  return (
    <div className="racehub-grid-layout">
      {rows.map((row) => (
        <div
          className={`racehub-grid-slot ${row.position % 2 === 0 ? "right" : "left"}`}
          key={`${row.position}-${row.code}`}
        >
          <span className="racehub-grid-position">{row.position}</span>
          <span
            className="racehub-grid-color"
            style={{ background: row.color, boxShadow: `0 0 12px ${row.color}` }}
          />
          <div>
            <strong>{row.code}</strong>
            <small>{row.team}</small>
          </div>
        </div>
      ))}
    </div>
  );
}


function getPoleResult(core) {
  const qualifying = core.qualifying?.QualifyingResults || [];

  if (qualifying.length) {
    return qualifying
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position))[0];
  }

  return (core.race?.Results || []).find((result) => Number(result.grid) === 1) || null;
}

function winnerMargin(results) {
  if (results.length < 2) return "—";

  const second = results[1];

  if (second?.Time?.time) {
    return second.Time.time;
  }

  if (second?.status && second.status !== "Finished") {
    return second.status;
  }

  return "—";
}

function bestRecovery(results) {
  const candidates = results
    .map((result) => {
      const grid = Number(result.grid);
      const finish = Number(result.position);

      return {
        result,
        gained:
          Number.isFinite(grid) && grid > 0 && Number.isFinite(finish)
            ? grid - finish
            : 0,
      };
    })
    .sort((a, b) => b.gained - a.gained);

  return candidates[0] || null;
}

function classifiedCount(results) {
  return results.filter((result) => !isRetirement(result)).length;
}

function nextWeekendSession(sessions, raceCompleted) {
  if (raceCompleted) return null;

  return (
    sessions.find((session) => sessionStatus(session, false) === "live") ||
    sessions.find((session) => sessionStatus(session, false) === "upcoming") ||
    null
  );
}

function Overview({ race, core, sessions, onSelectSession }) {
  const results = core.race?.Results || [];
  const podium = results.slice(0, 3);
  const fastest = getFastestLap(core.race);
  const retirements = results.filter(isRetirement);
  const completed = results.length > 0;
  const pole = getPoleResult(core);
  const recovery = bestRecovery(results);
  const classified = classifiedCount(results);
  const nextSession = nextWeekendSession(sessions, completed);
  const sprintWinner = core.sprint?.SprintResults?.[0] || null;

  const winnerTime =
    podium[0]?.Time?.time ||
    podium[0]?.status ||
    "—";

  const recoveryText =
    recovery?.gained > 0
      ? `+${recovery.gained} posiciones`
      : "Sin gran remontada";

  return (
    <div className="racehub-overview-grid">
      <section className="racehub-card racehub-podium-card">
        <div className="racehub-card-heading">
          <div>
            <span>{completed ? "Resultado oficial" : "Vista previa"}</span>
            <h3>{completed ? "Podio" : "Próxima carrera"}</h3>
          </div>

          {completed && (
            <small>
              {winnerTime !== "—" ? `Tiempo ganador · ${winnerTime}` : "Clasificación final"}
            </small>
          )}
        </div>

        {completed ? (
          <>
            <div className="racehub-podium racehub-podium--detailed">
              {[1, 0, 2].map((index) => {
                const result = podium[index];
                if (!result) return null;

                const color = teamColor(result.Constructor?.constructorId);
                const grid = Number(result.grid);

                const raceDetail =
                  index === 0
                    ? winnerTime
                    : result.Time?.time ||
                      (result.status && result.status !== "Finished"
                        ? result.status
                        : "—");

                const startDetail =
                  Number.isFinite(grid) && grid > 0
                    ? `Salida P${grid}`
                    : grid === 0
                    ? "Salida Pit lane"
                    : "Salida —";

                return (
                  <div
                    className={`racehub-podium-place p${index + 1}`}
                    key={result.Driver?.driverId || index}
                  >
                    <span className="racehub-podium-rank">P{index + 1}</span>

                    <span
                      className="racehub-podium-accent"
                      style={{ background: color, boxShadow: `0 0 22px ${color}` }}
                    />

                    <strong>{driverCode(result.Driver)}</strong>
                    <p>{driverName(result.Driver)}</p>
                    <small>{result.Constructor?.name}</small>

                    <div className="racehub-podium-race-info">
                      <div>
                        <span>{index === 0 ? "Tiempo total" : "Diferencia"}</span>
                        <strong>{raceDetail}</strong>
                      </div>

                      <div>
                        <span>Parrilla</span>
                        <strong>{startDetail}</strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="racehub-preview-copy">
            <strong>{formatDate(race.date)}</strong>
            <p>
              El Race Hub cambia automáticamente de vista previa a resultados
              cuando Jolpica publica el resultado oficial.
            </p>

            <div className="racehub-preview-grid">
              <div>
                <span>Próxima sesión</span>
                <strong>{nextSession?.label || "Por confirmar"}</strong>
                <small>{nextSession ? formatSessionTime(nextSession) : "Sin sesión pendiente"}</small>
              </div>

              <div>
                <span>Formato</span>
                <strong>{race.Sprint ? "Sprint" : "Clásico"}</strong>
                <small>{sessions.length} sesiones del fin de semana</small>
              </div>

              <div>
                <span>Circuito</span>
                <strong>{race.Circuit?.Location?.locality || "—"}</strong>
                <small>{race.Circuit?.circuitName || "—"}</small>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="racehub-card racehub-weekend-card">
        <div className="racehub-card-heading">
          <div>
            <span>Programa</span>
            <h3>Sesiones</h3>
          </div>

          <small>
            {completed ? `${sessions.length} sesiones finalizadas` : `${sessions.length} sesiones`}
          </small>
        </div>

        <div className="racehub-schedule-list">
          {sessions.map((session) => {
            const status = sessionStatus(session, completed);

            return (
              <button
                type="button"
                className="racehub-schedule-row"
                key={session.key}
                onClick={() => onSelectSession(session.key)}
              >
                <span className={`racehub-session-code ${session.key}`}>
                  {session.short}
                </span>

                <span className="racehub-session-copy">
                  <strong>{session.label}</strong>
                  <small>{formatSessionTime(session)}</small>
                </span>

                <span className={`racehub-session-status ${status}`}>
                  {status === "complete"
                    ? "Finalizada"
                    : status === "live"
                    ? "En curso"
                    : status === "upcoming"
                    ? "Próxima"
                    : "Pendiente"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="racehub-card racehub-facts-card">
        <div className="racehub-card-heading">
          <div>
            <span>Carrera</span>
            <h3>Datos clave</h3>
          </div>

          <small>{completed ? "Resumen del GP" : "Se completará tras la carrera"}</small>
        </div>

        <div className="racehub-facts-grid">
          <div>
            <span>Pole</span>
            <strong>{pole ? driverCode(pole.Driver) : "—"}</strong>
            <small>{pole?.Constructor?.name || "Pendiente"}</small>
          </div>

          <div>
            <span>Vuelta rápida</span>
            <strong>
              {fastest
                ? `${driverCode(fastest.Driver)} · ${fastest.FastestLap?.Time?.time || "—"}`
                : "—"}
            </strong>
            <small>{fastest?.Constructor?.name || "Sin dato"}</small>
          </div>

          <div>
            <span>Vueltas de carrera</span>
            <strong>{completed ? podium[0]?.laps || "—" : "—"}</strong>
            <small>{completed ? "Completadas por el ganador" : "Pendiente"}</small>
          </div>

          <div>
            <span>Mayor remontada</span>
            <strong>
              {completed && recovery ? driverCode(recovery.result.Driver) : "—"}
            </strong>
            <small>{completed ? recoveryText : "Pendiente"}</small>
          </div>

          <div>
            <span>Clasificados</span>
            <strong>{completed ? `${classified}/${results.length}` : "—"}</strong>
            <small>
              {completed
                ? `${retirements.length} ${retirements.length === 1 ? "abandono" : "abandonos"}`
                : "Pendiente"}
            </small>
          </div>

          <div>
            <span>{sprintWinner ? "Ganador Sprint" : "Abandonos"}</span>
            <strong>
              {sprintWinner
                ? driverCode(sprintWinner.Driver)
                : completed
                ? retirements.length
                : "—"}
            </strong>
            <small>
              {sprintWinner
                ? sprintWinner.Constructor?.name || "—"
                : completed
                ? "Pilotos que no finalizaron"
                : "Pendiente"}
            </small>
          </div>
        </div>
      </section>

      <section className="racehub-card racehub-retirements-card">
        <div className="racehub-card-heading">
          <div>
            <span>Incidencias</span>
            <h3>Abandonos</h3>
          </div>

          {completed && (
            <small>
              {retirements.length} abandonos · {classified} clasificados
            </small>
          )}
        </div>

        {completed ? (
          retirements.length ? (
            <div className="racehub-retirement-list">
              {retirements.map((result) => (
                <div key={result.Driver?.driverId}>
                  <div className="racehub-retirement-driver">
                    <span
                      className="racehub-retirement-color"
                      style={{
                        background: teamColor(result.Constructor?.constructorId),
                        boxShadow: `0 0 10px ${teamColor(
                          result.Constructor?.constructorId
                        )}`,
                      }}
                    />
                    <div>
                      <strong>{driverCode(result.Driver)}</strong>
                      <b>{driverName(result.Driver)}</b>
                      <small>{result.Constructor?.name || "—"}</small>
                    </div>
                  </div>

                  <span className="racehub-retirement-status">{result.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="racehub-clean-race">
              <strong>Sin abandonos</strong>
              <span>Todos los clasificados llegaron al final.</span>
            </div>
          )
        ) : (
          <div className="racehub-clean-race">
            <strong>Sin datos todavía</strong>
            <span>Las incidencias aparecerán después de la carrera.</span>
          </div>
        )}
      </section>
    </div>
  );
}

export default function RaceHub({ initialRace = null, onNavigateHome }) {
  const [calendar, setCalendar] = useState([]);
  const [round, setRound] = useState(initialRace?.round ? String(initialRace.round) : "");
  const [core, setCore] = useState({ race: null, qualifying: null, sprint: null });
  const [openSessionData, setOpenSessionData] = useState({});
  const [openGridRows, setOpenGridRows] = useState([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [loadingCalendar, setLoadingCalendar] = useState(true);
  const [loadingCore, setLoadingCore] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);

  const year = Number(initialRace?.season || DEFAULT_YEAR);

  useEffect(() => {
    let cancelled = false;

    async function loadCalendar() {
      try {
        setLoadingCalendar(true);
        setError("");

        /*
          Calendario + resultados de temporada en paralelo.

          El calendario nos dice qué carreras existen.
          Los resultados nos dicen cuáles ya terminaron realmente.

          Así, si el GP de hoy ya publicó Results, el Race Hub pasa
          inmediatamente al siguiente GP sin esperar a medianoche.
        */
        const [calendarRequest, resultsRequest] = await Promise.allSettled([
          cachedFetch(`${API}/${year}/races.json`, 10 * 60 * 1000),
          cachedFetch(`${API}/${year}/results.json?limit=2000`, 5 * 60 * 1000),
        ]);

        if (calendarRequest.status !== "fulfilled") {
          throw calendarRequest.reason || new Error("No se pudo cargar el calendario.");
        }

        const races = calendarRequest.value?.MRData?.RaceTable?.Races || [];
        const completedRounds =
          resultsRequest.status === "fulfilled"
            ? completedRoundsFromSeasonData(resultsRequest.value)
            : new Set();

        if (cancelled) return;

        setCalendar(races);

        /*
          Si llegamos al Race Hub desde una carrera concreta del Inicio
          o desde Resultados, respetamos esa carrera.

          Si entramos desde el botón "Race Hub" de la navegación,
          siempre elegimos el próximo GP pendiente.
        */
        if (
          initialRace?.round &&
          races.some((race) => String(race.round) === String(initialRace.round))
        ) {
          setRound(String(initialRace.round));
          return;
        }

        const nextRace = findDefaultRace(races, completedRounds);
        setRound(nextRace ? String(nextRace.round) : "");
      } catch (loadError) {
        if (!cancelled) {
          setError(`No se pudo cargar el calendario: ${loadError.message}`);
        }
      } finally {
        if (!cancelled) setLoadingCalendar(false);
      }
    }

    loadCalendar();

    return () => {
      cancelled = true;
    };
  }, [initialRace, year]);

  const selectedRace = useMemo(
    () =>
      calendar.find((race) => String(race.round) === String(round)) ||
      (initialRace && String(initialRace.round) === String(round) ? initialRace : null),
    [calendar, initialRace, round]
  );

  const loadCore = useCallback(
    async ({ force = false } = {}) => {
      if (!round) return;

      const requestId = ++requestIdRef.current;

      try {
        setLoadingCore(true);
        setError("");
        const data = await loadRoundCore(year, round, selectedRace, { force });

        if (requestId !== requestIdRef.current) return;
        setCore(data);
      } catch (loadError) {
        if (requestId === requestIdRef.current) {
          setError(`No se pudieron cargar los datos del GP: ${loadError.message}`);
        }
      } finally {
        if (requestId === requestIdRef.current) setLoadingCore(false);
      }
    },
    [round, selectedRace, year]
  );

  useEffect(() => {
    setCore({ race: null, qualifying: null, sprint: null });
    setOpenSessionData({});
    setOpenGridRows([]);
    setActiveTab("overview");
    loadCore();
  }, [loadCore]);

  useEffect(() => {
    if (!selectedRace || core.race?.Results?.length) return undefined;

    const raceDate = new Date(`${selectedRace.date}T00:00:00`).getTime();
    const now = Date.now();

    if (Math.abs(now - raceDate) > 2 * 86400000) return undefined;

    const timer = window.setInterval(() => {
      loadCore({ force: true });
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [core.race, loadCore, selectedRace]);

  const sessions = useMemo(() => getWeekendSessions(selectedRace), [selectedRace]);
  const raceCompleted = Boolean(core.race?.Results?.length);
  const country = selectedRace?.Circuit?.Location?.country;

  async function selectTab(key) {
    setActiveTab(key);
    setError("");

    if (key === "grid") {
      if (core.race?.Results?.length || openGridRows.length) return;

      try {
        setLoadingSession(true);
        const rows = await loadOpenGrid(selectedRace, year);
        setOpenGridRows(rows);
      } catch (gridError) {
        setError(
          `${gridError.message} Se mostrará provisionalmente el orden de clasificación.`
        );
      } finally {
        setLoadingSession(false);
      }

      return;
    }

    const session = sessions.find((item) => item.key === key);
    if (!session || session.source !== "openf1" || openSessionData[key]) return;

    try {
      setLoadingSession(true);
      const data = await loadOpenSession(selectedRace, year, session.openName);
      setOpenSessionData((current) => ({ ...current, [key]: data }));
    } catch (sessionError) {
      setError(sessionError.message);
    } finally {
      setLoadingSession(false);
    }
  }

  const selectedSessionRows = useMemo(
    () => sessionResultRows(activeTab, core, openSessionData[activeTab]),
    [activeTab, core, openSessionData]
  );

  const gridRows = useMemo(
    () =>
      core.race?.Results?.length
        ? buildGrid(core.race, core.qualifying)
        : openGridRows.length
        ? openGridRows
        : buildGrid(core.race, core.qualifying),
    [core.qualifying, core.race, openGridRows]
  );

  if (loadingCalendar && !selectedRace) {
    return (
      <main className="page racehub-page">
        <div className="racehub-loader"><span /></div>
      </main>
    );
  }

  return (
    <main className="page racehub-page">
      <section className="racehub-toolbar">
        <div>
          <span className="racehub-kicker">GridPulse Race Hub</span>
          <h1>Centro del Gran Premio</h1>
        </div>

        <div className="racehub-toolbar-actions">
          {onNavigateHome && (
            <button type="button" className="racehub-back" onClick={onNavigateHome}>
              ← Inicio
            </button>
          )}

          <label className="racehub-race-select">
            <span>Gran Premio</span>
            <select value={round} onChange={(event) => setRound(event.target.value)}>
              {calendar.map((race) => (
                <option value={race.round} key={`${race.season}-${race.round}`}>
                  R{race.round} · {race.raceName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {selectedRace && (
        <>
          <section className={`racehub-hero ${raceCompleted ? "is-complete" : "is-preview"}`}>
            <FlagBackground country={country} variant="race" />

            <div className="racehub-hero-copy">
              <div className="racehub-hero-badges">
                <span>Ronda {selectedRace.round}</span>
                <span className={raceCompleted ? "complete" : "preview"}>
                  {raceCompleted ? "Resultado oficial" : "Vista previa"}
                </span>
                {selectedRace.Sprint && <span className="sprint">Sprint</span>}
              </div>

              <div className="racehub-country">
                <CountryFlag country={country} />
                <span>{country}</span>
              </div>

              <h2>{selectedRace.raceName}</h2>
              <p>{selectedRace.Circuit?.circuitName}</p>

              <div className="racehub-hero-meta">
                <span>{selectedRace.Circuit?.Location?.locality}</span>
                <span>{formatDate(selectedRace.date)}</span>
              </div>
            </div>

            <div className="racehub-track-stage">
              <RaceHubTrack circuitId={selectedRace.Circuit?.circuitId} />
            </div>

            <div className="racehub-hero-statline">
              <div>
                <span>Estado</span>
                <strong>{raceCompleted ? "Finalizada" : "Fin de semana"}</strong>
              </div>
              <div>
                <span>Sesiones</span>
                <strong>{sessions.length}</strong>
              </div>
              <div>
                <span>Formato</span>
                <strong>{selectedRace.Sprint ? "Sprint" : "Clásico"}</strong>
              </div>
              <div>
                <span>Fecha</span>
                <strong>{formatShortDate(selectedRace.date)}</strong>
              </div>
            </div>
          </section>

          <section className="racehub-tabs-shell">
            <div className="racehub-tabs" role="tablist" aria-label="Secciones del GP">
              <button
                type="button"
                className={activeTab === "overview" ? "active" : ""}
                onClick={() => setActiveTab("overview")}
              >
                Resumen
              </button>

              {sessions.map((session) => (
                <button
                  type="button"
                  className={activeTab === session.key ? "active" : ""}
                  onClick={() => selectTab(session.key)}
                  key={session.key}
                >
                  {session.short}
                </button>
              ))}

              <button
                type="button"
                className={activeTab === "grid" ? "active" : ""}
                onClick={() => selectTab("grid")}
              >
                Parrilla
              </button>
            </div>
          </section>

          {error && <div className="racehub-error">{error}</div>}

          <section className="racehub-content">
            {(loadingCore || loadingSession) && (
              <div className="racehub-inline-loading">
                <span />
                Cargando datos de la sesión…
              </div>
            )}

            {activeTab === "overview" ? (
              <Overview
                race={selectedRace}
                core={core}
                sessions={sessions}
                onSelectSession={selectTab}
              />
            ) : activeTab === "grid" ? (
              <section className="racehub-card racehub-grid-card">
                <div className="racehub-card-heading">
                  <div>
                    <span>Salida</span>
                    <h3>Parrilla</h3>
                  </div>
                  <small>
                    {raceCompleted
                      ? "Posiciones de salida registradas en el resultado oficial"
                      : "Basada en la clasificación disponible"}
                  </small>
                </div>
                <StartingGrid rows={gridRows} />
              </section>
            ) : (
              <section className="racehub-card racehub-session-card">
                <div className="racehub-card-heading">
                  <div>
                    <span>Clasificación de sesión</span>
                    <h3>
                      {sessions.find((session) => session.key === activeTab)?.label ||
                        "Sesión"}
                    </h3>
                  </div>
                  <small>
                    {sessions.find((session) => session.key === activeTab)
                      ? formatSessionTime(
                          sessions.find((session) => session.key === activeTab)
                        )
                      : ""}
                  </small>
                </div>

                <ResultTable rows={selectedSessionRows} sessionKey={activeTab} />
              </section>
            )}
          </section>
        </>
      )}
    </main>
  );
}
