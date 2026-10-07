import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API = "https://api.jolpi.ca/ergast/f1";

const YEARS = [2025, 2024, 2023, 2022, 2021, 2020];

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

const FLAGS = {
  Australia: "🇦🇺",
  China: "🇨🇳",
  Japan: "🇯🇵",
  USA: "🇺🇸",
  Canada: "🇨🇦",
  Monaco: "🇲🇨",
  Spain: "🇪🇸",
  Austria: "🇦🇹",
  UK: "🇬🇧",
  Belgium: "🇧🇪",
  Hungary: "🇭🇺",
  Netherlands: "🇳🇱",
  Italy: "🇮🇹",
  Azerbaijan: "🇦🇿",
  Singapore: "🇸🇬",
  Mexico: "🇲🇽",
  Brazil: "🇧🇷",
  Qatar: "🇶🇦",
  UAE: "🇦🇪",
  Bahrain: "🇧🇭",
  "Saudi Arabia": "🇸🇦",
  France: "🇫🇷",
  Portugal: "🇵🇹",
  Turkey: "🇹🇷",
  Russia: "🇷🇺",
  Germany: "🇩🇪",
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

const DRIVER_ASSETS = {
  hamilton: "/champions/drivers/hamilton.png",
  max_verstappen: "/champions/drivers/max-verstappen.png",
  norris: "/champions/drivers/norris.png",
  piastri: "/champions/drivers/piastri.png",
  leclerc: "/champions/drivers/leclerc.png",
};

const CONSTRUCTOR_ASSETS = {
  mercedes: "/champions/constructors/mercedes.png",
  red_bull: "/champions/constructors/red-bull.png",
  mclaren: "/champions/constructors/mclaren.png",
  ferrari: "/champions/constructors/ferrari.png",
};

const TROPHY_ASSETS = {
  driver: "/ui/wdc-trophy.png",
  constructor: "/ui/wcc-trophy.png",
};

async function getJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Error ${response.status}`);
  }

  return response.json();
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function localToday() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function daysUntil(date) {
  const today = new Date();
  const race = new Date(`${date}T12:00:00`);

  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  return Math.ceil((race - start) / 86400000);
}

function teamColor(id) {
  return TEAM_COLORS[id] || "#00f5d4";
}

function hexToRgba(hex, alpha = 1) {
  const cleanHex = hex.replace("#", "");

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getInitials(text = "") {
  return text
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function MediaOrFallback({
  src,
  alt,
  className = "",
  fallback = "IMG",
}) {
  const [failed, setFailed] = useState(!src);

  useEffect(() => {
    setFailed(!src);
  }, [src]);

  if (failed) {
    return (
      <div className={`${className} media-fallback`}>
        {fallback}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

function Track({ circuitId, className = "" }) {
  const [failed, setFailed] = useState(false);

  const file = TRACKS[circuitId];

  if (!file || failed) {
    return (
      <svg
        className={`track-fallback ${className}`}
        viewBox="0 0 180 90"
        fill="none"
      >
        <path
          d="M16 59C29 18 55 16 67 38C78 60 87 74 108 65C134 54 130 20 152 19C166 18 169 39 158 50C147 61 122 62 115 73C106 87 82 80 73 68C61 51 41 73 16 59Z"
          stroke="#00f5d4"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <img
      className={`track ${className}`}
      src={`${TRACK_BASE}/${file}`}
      alt="Trazado del circuito"
      onError={() => setFailed(true)}
    />
  );
}

function Loader() {
  return (
    <div className="loading">
      <div className="loader" />
    </div>
  );
}

function SectionTitle({ label, title, right }) {
  return (
    <div className="section-heading">
      <div>
        <div className="eyebrow">{label}</div>
        <h2>{title}</h2>
      </div>

      {right && <p>{right}</p>}
    </div>
  );
}

function RaceCard({ race, next }) {
  const country = race.Circuit?.Location?.country;
  const days = daysUntil(race.date);

  return (
    <article className={`race-card ${next ? "next" : ""}`}>
      {next && <div className="next-label">Próxima carrera</div>}

      <div className="round">Ronda {race.round}</div>

      <div className="track-wrap">
        <Track circuitId={race.Circuit?.circuitId} />
      </div>

      <div className="race-country">
        {FLAGS[country] || "🏁"} {country}
      </div>

      <h3>{race.raceName}</h3>

      <div className="race-card-footer">
        <span className="race-date">{formatDate(race.date)}</span>

        <span>
          {days === 0
            ? "Hoy"
            : days === 1
            ? "Mañana"
            : `${days} días`}
        </span>
      </div>
    </article>
  );
}

function DriverStandings({ standings }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Campeonato de pilotos</h3>
        <p>Clasificación actual · temporada 2026</p>
      </div>

      {standings.map((item) => {
        const constructor = item.Constructors?.[0];

        return (
          <div
            className="standings-row driver-row"
            key={item.Driver.driverId}
          >
            <div className="position">{item.position}</div>

            <div
              className="team-strip"
              style={{
                background: teamColor(constructor?.constructorId),
                boxShadow: `0 0 12px ${teamColor(
                  constructor?.constructorId
                )}`,
              }}
            />

            <div className="driver-name">
              {item.Driver.givenName} {item.Driver.familyName}

              <small>{item.Driver.code}</small>
            </div>

            <div className="team-name">{constructor?.name}</div>

            <div className="points">
              {item.points}
              <span>PTS</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConstructorStandings({ standings }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Constructores</h3>
        <p>Clasificación actual · temporada 2026</p>
      </div>

      {standings.map((item) => (
        <div
          className="standings-row constructor-row"
          key={item.Constructor.constructorId}
        >
          <div className="position">{item.position}</div>

          <div
            className="team-strip"
            style={{
              background: teamColor(item.Constructor.constructorId),
              boxShadow: `0 0 12px ${teamColor(
                item.Constructor.constructorId
              )}`,
            }}
          />

          <div className="constructor-name">
            {item.Constructor.name}
          </div>

          <div className="team-name">
            {item.wins} victorias
          </div>

          <div className="points">
            {item.points}
            <span>PTS</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Home() {
  const [races, setRaces] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [constructors, setConstructors] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadHome() {
      try {
        setLoading(true);

        const [raceData, driverData, constructorData] =
          await Promise.all([
            getJSON(`${API}/2026/races.json`),
            getJSON(`${API}/2026/driverstandings.json`),
            getJSON(`${API}/2026/constructorstandings.json`),
          ]);

        setRaces(
          raceData.MRData.RaceTable.Races || []
        );

        setDrivers(
          driverData.MRData.StandingsTable
            .StandingsLists?.[0]
            ?.DriverStandings || []
        );

        setConstructors(
          constructorData.MRData.StandingsTable
            .StandingsLists?.[0]
            ?.ConstructorStandings || []
        );
      } catch (err) {
        console.error(err);

        setError(
          "No fue posible conectar con los datos de Fórmula 1."
        );
      } finally {
        setLoading(false);
      }
    }

    loadHome();
  }, []);

  const upcoming = useMemo(() => {
    const today = localToday();

    return races.filter((race) => race.date >= today);
  }, [races]);

  return (
    <main className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">
            Temporada 2026
          </div>

          <h1>
            El campeonato.
            <br />
            En un solo lugar.
          </h1>

          <p>
            Calendario, clasificaciones y resultados de
            Fórmula 1. Una base preparada para crecer
            hacia análisis, telemetría, estrategia y
            datos en tiempo real.
          </p>
        </div>
      </section>

      {loading ? (
        <Loader />
      ) : error ? (
        <div className="error">{error}</div>
      ) : (
        <>
          <section className="section">
            <SectionTitle
              label="Calendario"
              title="Próximas carreras"
              right={`${upcoming.length} Grandes Premios restantes`}
            />

            {upcoming.length > 0 ? (
              <div className="race-grid">
                {upcoming.map((race, index) => (
                  <RaceCard
                    race={race}
                    next={index === 0}
                    key={`${race.season}-${race.round}`}
                  />
                ))}
              </div>
            ) : (
              <div className="empty">
                La temporada 2026 ha finalizado.
              </div>
            )}
          </section>

          <section className="section">
            <SectionTitle
              label="Standings"
              title="Campeonato 2026"
              right="Datos actualizados desde Jolpica F1"
            />

            <div className="tables-grid">
              <DriverStandings standings={drivers} />

              <ConstructorStandings
                standings={constructors}
              />
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function RaceResults({ race, loading }) {
  if (loading) {
    return (
      <div className="result-panel">
        <Loader />
      </div>
    );
  }

  if (!race) {
    return (
      <div className="result-panel">
        <div className="empty">
          Selecciona un Gran Premio para ver el
          resultado completo.
        </div>
      </div>
    );
  }

  const country =
    race.Circuit?.Location?.country;

  return (
    <div className="result-panel">
      <div className="result-hero">
        <div>
          <div className="eyebrow">
            {FLAGS[country] || "🏁"} {country} · Ronda{" "}
            {race.round}
          </div>

          <h2>{race.raceName}</h2>

          <p className="result-info">
            {race.Circuit?.circuitName} ·{" "}
            {formatDate(race.date)}
          </p>
        </div>

        <Track
          circuitId={race.Circuit?.circuitId}
          className="result-track"
        />
      </div>

      {race.Results?.map((result) => (
        <div
          className={`result-row ${
            Number(result.position) <= 3
              ? "podium"
              : ""
          }`}
          key={result.Driver.driverId}
        >
          <div className="result-pos">
            P{result.position}
          </div>

          <div className="result-driver">
            {result.Driver.givenName}{" "}
            {result.Driver.familyName}
          </div>

          <div className="result-team">
            {result.Constructor.name}
          </div>

          <div
            className="result-grid-position"
            title="Posición de salida"
          >
            G{result.grid}
          </div>

          <div className="result-points">
            {result.points} pts
          </div>
        </div>
      ))}
    </div>
  );
}

function SeasonSummaryPanel({
  year,
  championDriver,
  championConstructor,
}) {
  const driver = championDriver?.Driver;

  const driverTeam =
    championDriver?.Constructors?.[0];

  const constructor =
    championConstructor?.Constructor;

  const driverImage =
    DRIVER_ASSETS[driver?.driverId];

  const constructorLogo =
    CONSTRUCTOR_ASSETS[
      constructor?.constructorId
    ];

  const driverTeamColor = teamColor(
    driverTeam?.constructorId
  );

  const constructorTeamColor = teamColor(
    constructor?.constructorId
  );

  function championStyles(color) {
    return {
      "--team-color": color,
      "--team-soft": hexToRgba(color, 0.07),
      "--team-soft-2": hexToRgba(color, 0.13),
      "--team-medium": hexToRgba(color, 0.22),
      "--team-border": hexToRgba(color, 0.35),
      "--team-glow": hexToRgba(color, 0.18),
    };
  }

  return (
    <div className="result-panel season-summary-panel">
      <div className="season-summary-head">
        <div className="eyebrow">
          Resumen de temporada
        </div>

        <h2>{year}</h2>

        <p>
          Campeones de la temporada seleccionada.
          Cuando elijas un Gran Premio, este panel
          mostrará el resultado de esa carrera.
        </p>
      </div>

      <div className="champion-cards">
        {/* CAMPEÓN DE PILOTOS */}

        <article
          className="champion-card"
          style={championStyles(driverTeamColor)}
        >
          <div className="champion-glow" />

          <div className="champion-card-top">
            <span className="champion-label">
              Campeón de pilotos
            </span>

            <div className="champion-trophy-wrapper">
              <MediaOrFallback
                src={TROPHY_ASSETS.driver}
                alt="Trofeo campeonato de pilotos"
                className="champion-trophy"
                fallback="🏆"
              />
            </div>
          </div>

          <div className="champion-main">
            <MediaOrFallback
              src={driverImage}
              alt={
                driver
                  ? `${driver.givenName} ${driver.familyName}`
                  : "Piloto campeón"
              }
              className="champion-photo"
              fallback={getInitials(
                `${driver?.givenName || ""} ${
                  driver?.familyName || ""
                }`
              )}
            />

            <div className="champion-info">
              <h3>
                {driver
                  ? `${driver.givenName} ${driver.familyName}`
                  : "Sin datos"}
              </h3>

              <p>
                {driverTeam?.name || "Constructor"} ·{" "}
                {championDriver?.points || 0} pts
              </p>
            </div>
          </div>

          <div className="champion-stats">
            <div className="champion-stat">
              <span>Puntos</span>

              <strong>
                {championDriver?.points || 0}
              </strong>
            </div>

            <div className="champion-stat">
              <span>Victorias</span>

              <strong>
                {championDriver?.wins || 0}
              </strong>
            </div>
          </div>
        </article>

        {/* CAMPEÓN DE CONSTRUCTORES */}

        <article
          className="champion-card"
          style={championStyles(
            constructorTeamColor
          )}
        >
          <div className="champion-glow" />

          <div className="champion-card-top">
            <span className="champion-label">
              Campeón de constructores
            </span>

            <div className="champion-trophy-wrapper">
              <MediaOrFallback
                src={TROPHY_ASSETS.constructor}
                alt="Trofeo campeonato de constructores"
                className="champion-trophy"
                fallback="🏁"
              />
            </div>
          </div>

          <div className="champion-main">
            <MediaOrFallback
              src={constructorLogo}
              alt={
                constructor?.name ||
                "Constructor campeón"
              }
              className="champion-logo"
              fallback={getInitials(
                constructor?.name || "C"
              )}
            />

            <div className="champion-info">
              <h3>
                {constructor?.name || "Sin datos"}
              </h3>

              <p>
                Campeonato de constructores ·{" "}
                {championConstructor?.points || 0} pts
              </p>
            </div>
          </div>

          <div className="champion-stats">
            <div className="champion-stat">
              <span>Puntos</span>

              <strong>
                {championConstructor?.points || 0}
              </strong>
            </div>

            <div className="champion-stat">
              <span>Victorias</span>

              <strong>
                {championConstructor?.wins || 0}
              </strong>
            </div>
          </div>
        </article>
      </div>

      <div className="summary-hint">
        Selecciona un GP de la lista para ver el
        resultado completo.
      </div>
    </div>
  );
}

function Seasons() {
  const [year, setYear] = useState(2025);
  const [races, setRaces] = useState([]);

  const [selectedRound, setSelectedRound] =
    useState(null);

  const [selectedRace, setSelectedRace] =
    useState(null);

  const [championDriver, setChampionDriver] =
    useState(null);

  const [
    championConstructor,
    setChampionConstructor,
  ] = useState(null);

  const [loadingSeason, setLoadingSeason] =
    useState(true);

  const [loadingRace, setLoadingRace] =
    useState(false);

  const [error, setError] = useState("");

  useEffect(() => {
    async function loadSeason() {
      try {
        setLoadingSeason(true);
        setError("");
        setSelectedRound(null);
        setSelectedRace(null);
        setChampionDriver(null);
        setChampionConstructor(null);

        const [
          racesData,
          driverStandingsData,
          constructorStandingsData,
        ] = await Promise.all([
          getJSON(`${API}/${year}/races.json`),
          getJSON(
            `${API}/${year}/driverstandings.json`
          ),
          getJSON(
            `${API}/${year}/constructorstandings.json`
          ),
        ]);

        setRaces(
          racesData.MRData.RaceTable.Races || []
        );

        setChampionDriver(
          driverStandingsData.MRData
            .StandingsTable.StandingsLists?.[0]
            ?.DriverStandings?.[0] || null
        );

        setChampionConstructor(
          constructorStandingsData.MRData
            .StandingsTable.StandingsLists?.[0]
            ?.ConstructorStandings?.[0] || null
        );
      } catch (err) {
        console.error(err);

        setError(
          "No fue posible cargar esta temporada."
        );
      } finally {
        setLoadingSeason(false);
      }
    }

    loadSeason();
  }, [year]);

  async function selectRace(round) {
    try {
      setSelectedRound(round);
      setLoadingRace(true);

      const data = await getJSON(
        `${API}/${year}/${round}/results.json`
      );

      setSelectedRace(
        data.MRData.RaceTable.Races?.[0] || null
      );
    } catch (err) {
      console.error(err);
      setSelectedRace(null);
    } finally {
      setLoadingRace(false);
    }
  }

  return (
    <main className="page">
      <div className="seasons-header">
        <div className="eyebrow">
          Archivo histórico
        </div>

        <h1>Temporadas</h1>

        <p>
          Explora las temporadas anteriores y consulta
          el resultado completo de cada Gran Premio.
        </p>
      </div>

      <div className="seasons-toolbar">
        {YEARS.map((item) => (
          <button
            key={item}
            className={`season-btn ${
              year === item ? "active" : ""
            }`}
            onClick={() => setYear(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {loadingSeason ? (
        <Loader />
      ) : error ? (
        <div className="error">{error}</div>
      ) : (
        <div className="history-layout">
          <div className="gp-list">
            {races.map((race) => {
              const country =
                race.Circuit?.Location?.country;

              return (
                <button
                  key={race.round}
                  className={`gp-item ${
                    selectedRound === race.round
                      ? "active"
                      : ""
                  }`}
                  onClick={() =>
                    selectRace(race.round)
                  }
                >
                  <div className="gp-number">
                    R
                    {String(race.round).padStart(
                      2,
                      "0"
                    )}
                  </div>

                  <div>
                    <div className="gp-name">
                      {FLAGS[country] || "🏁"}{" "}
                      {race.raceName}
                    </div>

                    <div className="gp-place">
                      {race.Circuit?.circuitName}
                    </div>
                  </div>

                  <div className="gp-date">
                    {new Intl.DateTimeFormat(
                      "es-CL",
                      {
                        day: "2-digit",
                        month: "short",
                      }
                    ).format(
                      new Date(
                        `${race.date}T12:00:00`
                      )
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {selectedRace ? (
            <RaceResults
              race={selectedRace}
              loading={loadingRace}
            />
          ) : (
            <SeasonSummaryPanel
              year={year}
              championDriver={championDriver}
              championConstructor={
                championConstructor
              }
            />
          )}
        </div>
      )}
    </main>
  );
}

export default function App() {
  const [page, setPage] = useState("home");

  function navigate(destination) {
    setPage(destination);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  return (
    <div className="app">
      <header className="header">
        <nav className="nav">
          <div className="brand">
            <div className="brand-mark">
              GP
            </div>

            <div>
              GRID<span>PULSE</span>
            </div>
          </div>

          <div className="nav-links">
            <button
              className={`nav-button ${
                page === "home"
                  ? "active"
                  : ""
              }`}
              onClick={() => navigate("home")}
            >
              Inicio
            </button>

            <button
              className={`nav-button ${
                page === "seasons"
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                navigate("seasons")
              }
            >
              Temporadas
            </button>
          </div>
        </nav>
      </header>

      {page === "home" ? (
        <Home />
      ) : (
        <Seasons />
      )}

      <div className="page footer-page">
        <footer className="footer">
          <span>
            GRIDPULSE · Motorsport Data Platform
          </span>

          <span>
            Datos: Jolpica F1 · Circuitos: F1
            Track Layouts SVG
          </span>
        </footer>
      </div>
    </div>
  );
}