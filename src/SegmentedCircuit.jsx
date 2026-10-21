import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CIRCUIT_VISUAL_OVERRIDES,
} from "./CircuitVisualOverrides";

import {
  CIRCUIT_CORNER_PROGRESS_OVERRIDES,
} from "./CircuitCornerOverrides";

import "./CircuitAnnotations.css";

const SECTORS = [
  ["s1", "S1"],
  ["s2", "S2"],
  ["s3", "S3"],
];

const VIEWBOX_CENTER = {
  x: 500,
  y: 350,
};

/*
  La geometría calculada queda guardada.

  Cuando vuelves a abrir un circuito,
  no repetimos todos los cálculos.
*/
const GEOMETRY_CACHE =
  new Map();


function normalizeAngle(
  angle
) {
  let value = angle;

  while (
    value >
    Math.PI
  ) {
    value -=
      Math.PI * 2;
  }

  while (
    value <
    -Math.PI
  ) {
    value +=
      Math.PI * 2;
  }

  return value;
}


function transformPoint(
  point,
  rotation = 0,
  scale = 1
) {
  const radians =
    (rotation *
      Math.PI) /
    180;

  const dx =
    (
      point.x -
      VIEWBOX_CENTER.x
    ) *
    scale;

  const dy =
    (
      point.y -
      VIEWBOX_CENTER.y
    ) *
    scale;

  const cos =
    Math.cos(
      radians
    );

  const sin =
    Math.sin(
      radians
    );

  return {
    x:
      VIEWBOX_CENTER.x +
      dx * cos -
      dy * sin,

    y:
      VIEWBOX_CENTER.y +
      dx * sin +
      dy * cos,
  };
}


function buildMapTransform(
  rotation = 0,
  scale = 1
) {
  return `
    translate(
      ${VIEWBOX_CENTER.x}
      ${VIEWBOX_CENTER.y}
    )
    rotate(${rotation})
    scale(${scale})
    translate(
      ${-VIEWBOX_CENTER.x}
      ${-VIEWBOX_CENTER.y}
    )
  `;
}


function buildCacheKey({
  circuitId,
  cornerCount,
  rotation,
  scale,
  markerOffset,
  track,
}) {
  const signature =
    SECTORS.map(
      ([sector]) => {
        const path =
          track
            ?.sectors
            ?.[sector] ||
          "";

        return [
          path.length,
          path.slice(
            0,
            16
          ),
          path.slice(
            -16
          ),
        ].join(":");
      }
    ).join("|");

  return [
    circuitId,
    cornerCount,
    rotation,
    scale,
    markerOffset,
    track?.viewBox ||
      "",
    signature,
  ].join("::");
}


/*
  Permite que la animación de apertura
  comience antes del cálculo pesado.
*/
function scheduleGeometryWork(
  callback
) {
  let cancelled =
    false;

  let frameId = 0;
  let idleId = 0;
  let timeoutId = 0;

  frameId =
    window.requestAnimationFrame(
      () => {
        if (
          cancelled
        ) {
          return;
        }

        if (
          "requestIdleCallback"
          in window
        ) {
          idleId =
            window.requestIdleCallback(
              () => {
                if (
                  !cancelled
                ) {
                  callback();
                }
              },
              {
                timeout: 140,
              }
            );

          return;
        }

        timeoutId =
          window.setTimeout(
            () => {
              if (
                !cancelled
              ) {
                callback();
              }
            },
            24
          );
      }
    );

  return () => {
    cancelled = true;

    if (frameId) {
      window.cancelAnimationFrame(
        frameId
      );
    }

    if (
      timeoutId
    ) {
      window.clearTimeout(
        timeoutId
      );
    }

    if (
      idleId &&
      "cancelIdleCallback"
      in window
    ) {
      window.cancelIdleCallback(
        idleId
      );
    }
  };
}


export default function SegmentedCircuit({
  circuitId,
  circuitName,
  cornerCount = 0,
  expanded,
  track,
}) {
  const pathRefs =
    useRef({});

  const [
    geometry,
    setGeometry,
  ] =
    useState(null);

  const visual =
    CIRCUIT_VISUAL_OVERRIDES?.[
      circuitId
    ] || {};

  const rotation =
    Number(
      visual.rotation ||
        0
    );

  const scale =
    Number(
      visual.scale ||
        1
    );

  const markerOffset =
    Number(
      visual.markerOffset ||
        46
    );

  const mapTransform =
    useMemo(
      () =>
        buildMapTransform(
          rotation,
          scale
        ),
      [
        rotation,
        scale,
      ]
    );

  const cacheKey =
    useMemo(
      () =>
        buildCacheKey({
          circuitId,
          cornerCount,
          rotation,
          scale,
          markerOffset,
          track,
        }),
      [
        circuitId,
        cornerCount,
        rotation,
        scale,
        markerOffset,
        track,
      ]
    );


  useEffect(() => {
    /*
      Ya NO eliminamos
      geometry al cerrar.

      Esto hace que volver
      a abrir sea instantáneo.
    */
    if (
      !expanded
    ) {
      return undefined;
    }


    /*
      PRIMERO MIRAMOS LA CACHÉ.
    */
    const cached =
      GEOMETRY_CACHE.get(
        cacheKey
      );

    if (cached) {
      setGeometry(
        cached
      );

      return undefined;
    }


    /*
      Si todavía no existe,
      lo calculamos cuando el
      navegador tenga tiempo.
    */
    return scheduleGeometryWork(
      () => {
        const paths =
          SECTORS.map(
            ([sector]) =>
              pathRefs.current[
                sector
              ]
          );

        if (
          paths.some(
            (path) =>
              !path
          )
        ) {
          return;
        }


        const lengths =
          paths.map(
            (path) =>
              path.getTotalLength()
          );

        const totalLength =
          lengths.reduce(
            (
              total,
              length
            ) =>
              total +
              length,
            0
          );

        if (
          !totalLength
        ) {
          return;
        }


        function wrapProgress(
          progress
        ) {
          let value =
            progress % 1;

          if (
            value < 0
          ) {
            value += 1;
          }

          return value;
        }


        function rawPointAtProgress(
          progress
        ) {
          const normalized =
            wrapProgress(
              progress
            );

          let target =
            normalized *
            totalLength;

          for (
            let index = 0;
            index <
            paths.length;
            index += 1
          ) {
            const path =
              paths[index];

            const length =
              lengths[index];

            if (
              target <=
                length ||
              index ===
                paths.length -
                  1
            ) {
              const point =
                path.getPointAtLength(
                  Math.max(
                    0,
                    Math.min(
                      length,
                      target
                    )
                  )
                );

              return {
                x:
                  point.x,

                y:
                  point.y,
              };
            }

            target -=
              length;
          }


          const lastIndex =
            paths.length -
            1;

          const fallback =
            paths[
              lastIndex
            ]
              .getPointAtLength(
                lengths[
                  lastIndex
                ]
              );

          return {
            x:
              fallback.x,

            y:
              fallback.y,
          };
        }


        function pointAtProgress(
          progress
        ) {
          return transformPoint(
            rawPointAtProgress(
              progress
            ),
            rotation,
            scale
          );
        }


        const desired =
          Math.max(
            0,
            Number(
              cornerCount ||
                0
            )
          );


        /*
          ANTES:
          mínimo 1800 muestras
          y curvas * 120.

          AHORA:
          mínimo 900
          y curvas * 55.

          Visualmente conserva
          muchísimo detalle.
        */
        const sampleCount =
          Math.max(
            900,
            desired * 55
          );


        const rawSamples =
          new Array(
            sampleCount
          );

        let centerX = 0;
        let centerY = 0;


        /*
          UNA SOLA PASADA
          POR EL SVG.
        */
        for (
          let index = 0;
          index <
          sampleCount;
          index += 1
        ) {
          const point =
            rawPointAtProgress(
              index /
                sampleCount
            );

          rawSamples[
            index
          ] =
            point;

          centerX +=
            point.x;

          centerY +=
            point.y;
        }


        /*
          Antes se transformaba
          cada muestra para obtener
          el centro.

          Ahora transformamos
          solo el centro final.
        */
        const center =
          transformPoint(
            {
              x:
                centerX /
                sampleCount,

              y:
                centerY /
                sampleCount,
            },
            rotation,
            scale
          );


        /*
          Float32Array es más ligero
          que un Array normal para
          miles de números.
        */
        const curvature =
          new Float32Array(
            sampleCount
          );

        const look =
          Math.max(
            4,
            Math.round(
              sampleCount /
                360
            )
          );


        for (
          let index = 0;
          index <
          sampleCount;
          index += 1
        ) {
          const before =
            rawSamples[
              (
                index -
                look +
                sampleCount
              ) %
                sampleCount
            ];

          const current =
            rawSamples[
              index
            ];

          const after =
            rawSamples[
              (
                index +
                look
              ) %
                sampleCount
            ];


          const angleBefore =
            Math.atan2(
              current.y -
                before.y,

              current.x -
                before.x
            );


          const angleAfter =
            Math.atan2(
              after.y -
                current.y,

              after.x -
                current.x
            );


          curvature[
            index
          ] =
            Math.abs(
              normalizeAngle(
                angleAfter -
                  angleBefore
              )
            );
        }


        const candidates =
          [];


        for (
          let index = 0;
          index <
          sampleCount;
          index += 1
        ) {
          const previous =
            curvature[
              (
                index -
                1 +
                sampleCount
              ) %
                sampleCount
            ];

          const current =
            curvature[
              index
            ];

          const next =
            curvature[
              (
                index +
                1
              ) %
                sampleCount
            ];


          if (
            current >=
              previous &&
            current >=
              next
          ) {
            candidates.push(
              {
                index,

                score:
                  current,

                progress:
                  index /
                  sampleCount,
              }
            );
          }
        }


        candidates.sort(
          (
            a,
            b
          ) =>
            b.score -
            a.score
        );


        const selected =
          [];

        const separations =
          [
            0.026,
            0.021,
            0.017,
            0.013,
            0.009,
            0.006,
            0.003,
          ];


        function circularDistance(
          a,
          b
        ) {
          const direct =
            Math.abs(
              a - b
            );

          return Math.min(
            direct,
            1 - direct
          );
        }


        for (
          const separation
          of separations
        ) {
          for (
            const candidate
            of candidates
          ) {
            if (
              selected.some(
                (item) =>
                  item.index ===
                  candidate.index
              )
            ) {
              continue;
            }


            const clear =
              selected.every(
                (item) =>
                  circularDistance(
                    item.progress,
                    candidate.progress
                  ) >=
                  separation
              );


            if (
              clear
            ) {
              selected.push(
                candidate
              );
            }


            if (
              selected.length >=
              desired
            ) {
              break;
            }
          }


          if (
            selected.length >=
            desired
          ) {
            break;
          }
        }


        /*
          GARANTÍA DE CANTIDAD.
        */
        if (
          selected.length <
          desired
        ) {
          for (
            const candidate
            of candidates
          ) {
            if (
              selected.length >=
              desired
            ) {
              break;
            }

            if (
              selected.some(
                (item) =>
                  item.index ===
                  candidate.index
              )
            ) {
              continue;
            }

            selected.push(
              candidate
            );
          }
        }


        /*
          ÚLTIMO FALLBACK.
        */
        if (
          selected.length <
          desired
        ) {
          for (
            let index = 0;
            index <
            desired;
            index += 1
          ) {
            if (
              selected.length >=
              desired
            ) {
              break;
            }


            const progress =
              (
                index +
                0.5
              ) /
              desired;


            const sampleIndex =
              Math.floor(
                progress *
                  sampleCount
              ) %
              sampleCount;


            if (
              selected.some(
                (item) =>
                  circularDistance(
                    item.progress,
                    progress
                  ) <
                  0.002
              )
            ) {
              continue;
            }


            selected.push({
              index:
                sampleIndex,

              score:
                curvature[
                  sampleIndex
                ],

              progress,
            });
          }
        }


        selected.sort(
          (
            a,
            b
          ) =>
            a.progress -
            b.progress
        );


        /*
          Algunos circuitos necesitan una referencia manual porque
          la numeración oficial no equivale simplemente a los picos
          geométricos más fuertes. Monza es el caso principal:
          T1/T2, T4/T5 y T8/T9/T10 son complejos de chicanes.
        */
        const manualProgresses =
          CIRCUIT_CORNER_PROGRESS_OVERRIDES?.[
            circuitId
          ] || null;

        const cornerSource =
          manualProgresses?.length
            ? manualProgresses.map(
                (
                  progress,
                  index
                ) => ({
                  index:
                    Math.round(
                      (
                        progress /
                        100
                      ) *
                        sampleCount
                    ) %
                    sampleCount,

                  progress:
                    progress /
                    100,

                  number:
                    index +
                    1,
                })
              )
            : selected.slice(
                0,
                desired
              );


        /*
          Antes se pedían puntos
          nuevos al SVG para cada
          marcador.

          Ahora reutilizamos
          rawSamples.
        */
        const tangentStep =
          Math.max(
            2,
            Math.round(
              sampleCount *
                0.004
            )
          );


        const corners =
          cornerSource
            .map(
              (
                item,
                index
              ) => {
                const sampleIndex =
                  item.index;


                const beforeRaw =
                  rawSamples[
                    (
                      sampleIndex -
                      tangentStep +
                      sampleCount
                    ) %
                      sampleCount
                  ];


                const currentRaw =
                  rawSamples[
                    sampleIndex
                  ];


                const afterRaw =
                  rawSamples[
                    (
                      sampleIndex +
                      tangentStep
                    ) %
                      sampleCount
                  ];


                const before =
                  transformPoint(
                    beforeRaw,
                    rotation,
                    scale
                  );


                const current =
                  transformPoint(
                    currentRaw,
                    rotation,
                    scale
                  );


                const after =
                  transformPoint(
                    afterRaw,
                    rotation,
                    scale
                  );


                const tangent = {
                  x:
                    after.x -
                    before.x,

                  y:
                    after.y -
                    before.y,
                };


                const tangentLength =
                  Math.hypot(
                    tangent.x,
                    tangent.y
                  ) || 1;


                const normalA = {
                  x:
                    -tangent.y /
                    tangentLength,

                  y:
                    tangent.x /
                    tangentLength,
                };


                const normalB = {
                  x:
                    -normalA.x,

                  y:
                    -normalA.y,
                };


                const outward = {
                  x:
                    current.x -
                    center.x,

                  y:
                    current.y -
                    center.y,
                };


                const dotA =
                  normalA.x *
                    outward.x +
                  normalA.y *
                    outward.y;


                const dotB =
                  normalB.x *
                    outward.x +
                  normalB.y *
                    outward.y;


                const normal =
                  dotA >=
                  dotB
                    ? normalA
                    : normalB;


                return {
                  number:
                    item.number ||
                    index + 1,

                  progress:
                    item.progress,

                  point: {
                    x:
                      current.x +
                      normal.x *
                        markerOffset,

                    y:
                      current.y +
                      normal.y *
                        markerOffset,
                  },
                };
              }
            );


        /*
          SECTORES
        */
        let accumulated =
          0;


        const sectorLabels =
          SECTORS.map(
            (
              [
                sector,
                label,
              ],
              index
            ) => {
              const start =
                accumulated;

              const end =
                accumulated +
                lengths[
                  index
                ];


              const midpoint =
                (
                  start +
                  (
                    end -
                    start
                  ) *
                    0.5
                ) /
                totalLength;


              accumulated =
                end;


              return {
                sector,
                label,

                point:
                  pointAtProgress(
                    midpoint
                  ),
              };
            }
          );


        /*
          META
        */
        const metaPoint =
          pointAtProgress(
            0
          );

        const metaBefore =
          pointAtProgress(
            0.997
          );

        const metaAfter =
          pointAtProgress(
            0.003
          );


        const metaAngle =
          Math.atan2(
            metaAfter.y -
              metaBefore.y,

            metaAfter.x -
              metaBefore.x
          ) *
            (
              180 /
              Math.PI
            ) +
          90;


        const nextGeometry = {
          corners,
          sectorLabels,

          meta: {
            point:
              metaPoint,

            angle:
              metaAngle,
          },
        };


        /*
          GUARDAMOS EN CACHÉ.
        */
        GEOMETRY_CACHE.set(
          cacheKey,
          nextGeometry
        );


        setGeometry(
          nextGeometry
        );
      }
    );
  }, [
    expanded,
    cacheKey,
    track,
    cornerCount,
    markerOffset,
    rotation,
    scale,
  ]);


  return (
    <svg
      className={`circuit-track-svg ${
        expanded
          ? "is-expanded"
          : ""
      }`}
      viewBox={
        track.viewBox
      }
      role="img"
      aria-label={`Trazado sectorizado de ${circuitName}`}
      fill="none"
    >
      <g
        className="circuit-map-layer"
        transform={
          mapTransform
        }
      >
        {SECTORS.map(
          (
            [
              sector,
              label,
            ]
          ) => (
            <path
              key={
                sector
              }
              ref={(
                element
              ) => {
                pathRefs.current[
                  sector
                ] =
                  element;
              }}
              className={`circuit-sector circuit-sector--${sector}`}
              d={
                track
                  .sectors[
                  sector
                ]
              }
              pathLength="1"
              aria-label={
                label
              }
            />
          )
        )}
      </g>


      {expanded &&
        geometry && (
          <g className="circuit-annotations">

            {geometry
              .sectorLabels
              .map(
                (
                  item
                ) => (
                  <g
                    key={
                      item
                        .sector
                    }
                    className={`circuit-sector-tag circuit-sector-tag--${item.sector}`}
                    transform={`translate(${item.point.x} ${item.point.y})`}
                  >
                    <rect
                      x="-33"
                      y="-22"
                      width="66"
                      height="44"
                      rx="20"
                    />

                    <text
                      x="0"
                      y="1"
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {
                        item.label
                      }
                    </text>
                  </g>
                )
              )}


            <g
              className="circuit-start-finish"
              transform={`translate(${geometry.meta.point.x} ${geometry.meta.point.y}) rotate(${geometry.meta.angle})`}
            >
              <line
                x1="-46"
                y1="0"
                x2="46"
                y2="0"
              />


              {[
                -36,
                -24,
                -12,
                0,
                12,
                24,
              ].map(
                (
                  x,
                  index
                ) => (
                  <rect
                    key={
                      x
                    }
                    x={
                      x
                    }
                    y={
                      index %
                        2 ===
                      0
                        ? -10
                        : 0
                    }
                    width="12"
                    height="10"
                  />
                )
              )}


              <text
                x="0"
                y="-28"
                textAnchor="middle"
              >
                META
              </text>
            </g>


            {geometry
              .corners
              .map(
                (
                  corner
                ) => (
                  <g
                    key={
                      corner
                        .number
                    }
                    className="circuit-corner-marker"
                    transform={`translate(${corner.point.x} ${corner.point.y})`}
                  >
                    <circle
                      cx="0"
                      cy="0"
                      r="24"
                    />

                    <text
                      x="0"
                      y="1"
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {
                        corner
                          .number
                      }
                    </text>
                  </g>
                )
              )}
          </g>
        )}
    </svg>
  );
}