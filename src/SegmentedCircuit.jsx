const SECTORS = [
  ["s1", "Sector 1"],
  ["s2", "Sector 2"],
  ["s3", "Sector 3"],
];

export default function SegmentedCircuit({
  circuitName,
  expanded,
  track,
}) {
  return (
    <svg
      className={`circuit-track-svg ${expanded ? "is-expanded" : ""}`}
      viewBox={track.viewBox}
      role="img"
      aria-label={`Trazado sectorizado de ${circuitName}`}
      fill="none"
    >
      {SECTORS.map(([sector, label]) => (
        <path
          key={sector}
          className={`circuit-sector circuit-sector--${sector}`}
          d={track.sectors[sector]}
          pathLength="1"
          aria-label={label}
        />
      ))}
    </svg>
  );
}
