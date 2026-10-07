import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CIRCUIT_VISUAL_OVERRIDES,
} from "./CircuitVisualOverrides";

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

function normalizeAngle(angle) {
  let value = angle;

  while (value > Math.PI) {
    value -= Math.PI * 2;
  }

  while (value < -Math.PI) {
    value += Math.PI * 2;
  }

  return value;
}

function transformPoint(
  point,
  rotation = 0,
  scale = 1
) {
  const radians =
    (rotation * Math.PI) / 180;

  const dx =
    (point.x - VIEWBOX_CENTER.x) *
    scale;

  const dy =
    (point.y - VIEWBOX_CENTER.y) *
    scale;

  const cos =
    Math.cos(radians);

  const sin =
    Math.sin(radians);

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
  ] = useState(null);

  const visual =
    CIRCUIT_VISUAL_OVERRIDES?.[
      circuitId
    ] || {};

  const rotation =
    Number(
      visual.rotation || 0
    );

  const scale =
    Number(
      visual.scale || 1
    );

  const markerOffset =
    Number(
      visual.markerOffset || 46
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

  useEffect(() => {
    if (!expanded) {
      setGeometry(null);
      return;
    }

    const paths =
      SECTORS.map(
        ([sector]) =>
          pathRefs.current[
            sector
          ]
      );

    if (
      paths.some(
        (path) => !path
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
          total + length,
        0
      );

    if (!totalLength) {
      return;
    }

    function wrapProgress(
      progress
    ) {
      let value =
        progress % 1;

      if (value < 0) {
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
          target <= length ||
          index ===
            paths.length - 1
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
            x: point.x,
            y: point.y,
          };
        }

        target -= length;
      }

      const lastIndex =
        paths.length - 1;

      const fallback =
        paths[
          lastIndex
        ].getPointAtLength(
          lengths[
            lastIndex
          ]
        );

      return {
        x: fallback.x,
        y: fallback.y,
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

    /*
      Muestra densa del mismo SVG
      que se ve en pantalla.
    */

    const sampleCount =
      Math.max(
        1800,
        Number(
          cornerCount || 0
        ) * 120
      );

    const rawSamples =
      Array.from(
        {
          length:
            sampleCount,
        },
        (
          _,
          index
        ) =>
          rawPointAtProgress(
            index /
              sampleCount
          )
      );

    const transformedSamples =
      rawSamples.map(
        (point) =>
          transformPoint(
            point,
            rotation,
            scale
          )
      );

    const center = {
      x:
        transformedSamples.reduce(
          (
            sum,
            point
          ) =>
            sum + point.x,
          0
        ) /
        transformedSamples.length,

      y:
        transformedSamples.reduce(
          (
            sum,
            point
          ) =>
            sum + point.y,
          0
        ) /
        transformedSamples.length,
    };

    /*
      Curvatura local.
    */

    const curvature =
      new Array(
        sampleCount
      ).fill(0);

    const look =
      Math.max(
        4,
        Math.round(
          sampleCount /
            430
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
        rawSamples[index];

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

      curvature[index] =
        Math.abs(
          normalizeAngle(
            angleAfter -
              angleBefore
          )
        );
    }

    const candidates = [];

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
        curvature[index];

      const next =
        curvature[
          (
            index +
            1
          ) %
            sampleCount
        ];

      if (
        current >= previous &&
        current >= next
      ) {
        candidates.push({
          index,
          score: current,
          progress:
            index /
            sampleCount,
        });
      }
    }

    candidates.sort(
      (a, b) =>
        b.score -
        a.score
    );

    const desired =
      Math.max(
        0,
        Number(
          cornerCount || 0
        )
      );

    const selected = [];

    const separations = [
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

        if (clear) {
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
      Garantía de cantidad:
      si todavía falta alguna curva,
      completamos con los máximos
      restantes de la geometría.
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
      Último respaldo si un SVG
      fuese demasiado suave:
      rellena posiciones sin dejar
      desaparecer los números.
    */

    if (
      selected.length <
      desired
    ) {
      for (
        let index = 0;
        index < desired;
        index += 1
      ) {
        const progress =
          (
            index +
            0.5
          ) /
          desired;

        if (
          selected.length >=
          desired
        ) {
          break;
        }

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
      (a, b) =>
        a.progress -
        b.progress
    );

    const corners =
      selected
        .slice(
          0,
          desired
        )
        .map(
          (
            item,
            index
          ) => {
            const progress =
              item.progress;

            const current =
              pointAtProgress(
                progress
              );

            const before =
              pointAtProgress(
                progress -
                  0.004
              );

            const after =
              pointAtProgress(
                progress +
                  0.004
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
              dotA >= dotB
                ? normalA
                : normalB;

            return {
              number:
                index + 1,

              progress,

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
      Etiquetas S1 / S2 / S3.
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
            lengths[index];

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
      Meta: inicio del trazado.
    */

    const metaPoint =
      pointAtProgress(0);

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
        (180 /
          Math.PI) +
      90;

    setGeometry({
      corners,
      sectorLabels,

      meta: {
        point:
          metaPoint,

        angle:
          metaAngle,
      },
    });
  }, [
    expanded,
    track,
    circuitId,
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
                      corner.number
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
                        corner.number
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
