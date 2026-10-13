import {
  useMemo,
  useState,
} from "react";

import {
  CountryFlag,
} from "./CountryFlag";

import "./CurrentSeasonResults.css";


/* ============================================================
   HELPERS
============================================================ */

function formatCurrentRaceDate(
  dateString
) {
  if (!dateString) {
    return "";
  }

  const date =
    new Date(
      `${dateString}T12:00:00`
    );

  return new Intl.DateTimeFormat(
    "es-CL",
    {
      day: "2-digit",
      month: "short",
    }
  ).format(date);
}


function getDriverCode(
  result
) {
  if (
    result?.Driver?.code
  ) {
    return result.Driver.code;
  }

  const surname =
    result?.Driver
      ?.familyName ||
    "";

  return (
    surname
      .slice(0, 3)
      .toUpperCase() ||
    "---"
  );
}


function getSortedResults(
  race
) {
  return [
    ...(race?.Results || []),
  ].sort(
    (a, b) =>
      Number(
        a.position
      ) -
      Number(
        b.position
      )
  );
}


/* ============================================================
   PODIO COMPACTO
============================================================ */

function RacePodium({
  race,
  getTeamColor,
}) {
  const podium =
    getSortedResults(
      race
    ).slice(
      0,
      3
    );

  return (
    <div className="current-race-podium">
      {podium.map(
        (
          result,
          index
        ) => {
          const constructorId =
            result
              .Constructor
              ?.constructorId;

          const color =
            getTeamColor?.(
              constructorId
            ) ||
            "#00f5d4";

          return (
            <div
              className="current-podium-driver"
              key={
                result.Driver
                  ?.driverId ||
                index
              }
            >
              <span className="current-podium-position">
                {index + 1}
              </span>

              <span
                className="current-podium-strip"
                style={{
                  background:
                    color,

                  boxShadow:
                    `0 0 10px ${color}`,
                }}
              />

              <div className="current-podium-info">
                <strong>
                  {getDriverCode(
                    result
                  )}
                </strong>

                <span className="current-podium-team">
                  {
                    result
                      .Constructor
                      ?.name
                  }
                </span>
              </div>
            </div>
          );
        }
      )}
    </div>
  );
}


/* ============================================================
   RESULTADO COMPLETO
============================================================ */

function FullRaceResult({
  race,
  getTeamColor,
  onClose,
  onOpenRaceHub,
}) {
  const results =
    getSortedResults(
      race
    );

  const country =
    race.Circuit
      ?.Location
      ?.country;

  return (
    <div className="current-result-detail">
      <div className="current-result-detail-head">
        <div>
          <div className="current-result-detail-eyebrow">
            <CountryFlag
              country={
                country
              }
            />

            <span>
              Ronda{" "}
              {race.round}
            </span>
          </div>

          <h4>
            {race.raceName}
          </h4>

          <p>
            {
              race.Circuit
                ?.circuitName
            }{" "}
            ·{" "}
            {formatCurrentRaceDate(
              race.date
            )}
          </p>
        </div>

        <div className="current-result-actions">
          {onOpenRaceHub && (
            <button
              type="button"
              className="current-result-hub"
              onClick={() => onOpenRaceHub(race)}
            >
              Race Hub ↗
            </button>
          )}

          <button
            type="button"
            className="current-result-close"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>
      </div>

      <div className="current-result-table-head">
        <span>
          Pos.
        </span>

        <span>
          Piloto
        </span>

        <span>
          Escudería
        </span>

        <span>
          Salida
        </span>

        <span>
          Pts.
        </span>
      </div>

      <div className="current-result-table">
        {results.map(
          (result) => {
            const constructorId =
              result
                .Constructor
                ?.constructorId;

            const color =
              getTeamColor?.(
                constructorId
              ) ||
              "#00f5d4";

            const fullName =
              `${
                result.Driver
                  ?.givenName ||
                ""
              } ${
                result.Driver
                  ?.familyName ||
                ""
              }`.trim();

            return (
              <div
                className={`current-result-row ${
                  Number(
                    result.position
                  ) <= 3
                    ? "podium"
                    : ""
                }`}
                key={
                  result.Driver
                    ?.driverId
                }
              >
                <div className="current-result-position">
                  P
                  {
                    result.position
                  }
                </div>

                <div className="current-result-driver">
                  <span
                    className="current-result-team-strip"
                    style={{
                      background:
                        color,

                      boxShadow:
                        `0 0 9px ${color}`,
                    }}
                  />

                  <div>
                    <strong>
                      {getDriverCode(
                        result
                      )}
                    </strong>

                    <small>
                      {fullName}
                    </small>
                  </div>
                </div>

                <div className="current-result-constructor">
                  {
                    result
                      .Constructor
                      ?.name
                  }
                </div>

                <div className="current-result-grid">
                  G
                  {
                    result.grid
                  }
                </div>

                <div className="current-result-points">
                  {
                    result.points
                  }
                </div>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}


/* ============================================================
   PANEL PRINCIPAL
============================================================ */

export default function CurrentSeasonResults({
  races = [],
  loading = false,
  getTeamColor,
  onOpenRaceHub,
}) {
  const [
    showAll,
    setShowAll,
  ] =
    useState(false);

  const [
    selectedRound,
    setSelectedRound,
  ] =
    useState(null);


  /*
    IMPORTANTE:

    Ahora las carreras se ordenan
    desde la primera hasta la última.

    R1
    R2
    R3
    ...
  */

  const orderedRaces =
    useMemo(
      () =>
        [...races]
          .filter(
            (race) =>
              race.Results
                ?.length >
              0
          )
          .sort(
            (a, b) =>
              Number(
                a.round
              ) -
              Number(
                b.round
              )
          ),
      [
        races,
      ]
    );


  /*
    Cerrado:
    R1 → R5

    Abierto:
    R1 → última carrera disputada
  */

  const visibleRaces =
    showAll
      ? orderedRaces
      : orderedRaces.slice(
          0,
          5
        );




  function toggleRace(
    race
  ) {
    setSelectedRound(
      (current) =>
        String(
          current
        ) ===
        String(
          race.round
        )
          ? null
          : race.round
    );
  }


  function toggleAllRaces() {
    setShowAll(
      (current) => {
        const next =
          !current;

        /*
          Si volvemos a las
          primeras cinco,
          cerramos un resultado
          que pueda haber quedado
          abierto más abajo.
        */

        if (!next) {
          setSelectedRound(
            null
          );
        }

        return next;
      }
    );
  }


  if (loading) {
    return (
      <aside className="current-season-results">
        <div className="current-season-results-head">
          <div>
            <span>
              Temporada 2026
            </span>

            <h3>
              Resultados
            </h3>

            <p>
              Cargando Grandes
              Premios disputados...
            </p>
          </div>

          <div className="current-results-live">
            Actual
          </div>
        </div>

        <div className="current-results-loading">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </aside>
    );
  }


  if (
    orderedRaces.length ===
    0
  ) {
    return (
      <aside className="current-season-results">
        <div className="current-season-results-head">
          <div>
            <span>
              Temporada 2026
            </span>

            <h3>
              Resultados
            </h3>
          </div>
        </div>

        <div className="current-results-empty">
          Todavía no hay
          resultados disponibles.
        </div>
      </aside>
    );
  }


  return (
    <aside className="current-season-results">
      <div className="current-season-results-head">
        <div>
          <span>
            Temporada 2026
          </span>

          <h3>
            Resultados
          </h3>

          <p>
            {
              orderedRaces.length
            }{" "}
            Grandes Premios
            disputados
          </p>
        </div>

        <div className="current-results-live">
          Actual
        </div>
      </div>


      <div className="current-results-list">
        {visibleRaces.map(
          (race) => {
            const country =
              race.Circuit
                ?.Location
                ?.country;

            const isOpen =
              String(
                selectedRound
              ) ===
              String(
                race.round
              );

            return (
              <div
                className={`current-race-result-wrapper ${
                  isOpen
                    ? "is-open"
                    : ""
                }`}
                key={
                  `${race.season}-${race.round}`
                }
              >
                <button
                  type="button"
                  className="current-race-result-card"
                  onClick={() =>
                    toggleRace(
                      race
                    )
                  }
                  aria-expanded={
                    isOpen
                  }
                >
                  <div className="current-race-result-info">
                    <div className="current-race-result-meta">
                      <CountryFlag
                        country={
                          country
                        }
                      />

                      <span>
                        R
                        {
                          race.round
                        }
                      </span>

                      <span>
                        {formatCurrentRaceDate(
                          race.date
                        )}
                      </span>
                    </div>

                    <strong>
                      {
                        race.raceName
                      }
                    </strong>
                  </div>

                  <RacePodium
                    race={
                      race
                    }
                    getTeamColor={
                      getTeamColor
                    }
                  />

                  <span className="current-race-result-arrow">
                    {isOpen
                      ? "−"
                      : "+"}
                  </span>
                </button>

                {isOpen && (
                  <FullRaceResult
                    race={race}
                    getTeamColor={getTeamColor}
                    onOpenRaceHub={onOpenRaceHub}
                    onClose={() =>
                      setSelectedRound(null)
                    }
                  />
                )}
              </div>
            );
          }
        )}
      </div>


      {orderedRaces.length >
        5 && (
        <button
          type="button"
          className="current-results-toggle"
          onClick={
            toggleAllRaces
          }
        >
          <span>
            {showAll
              ? "Mostrar primeras 5"
              : "Ver todas las carreras"}
          </span>

          <span>
            {showAll
              ? "↑"
              : "↓"}
          </span>
        </button>
      )}

    </aside>
  );
}