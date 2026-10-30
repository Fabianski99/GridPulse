// Only matched driver/compound/tyre-age observations can inform track evolution.
// Different fuel loads remain unobserved: shrink the estimate towards zero.
export function matchedTrackEvolution(laps, stints, session) {
  const start = Date.parse(session.date_start);
  const duration = Date.parse(session.date_end) - start;
  if (!(duration > 0)) return 0;
  const groups = new Map();
  for (const lap of laps || []) {
    const time = lap.lap_duration;
    const progress = (Date.parse(lap.date_start) - start) / duration;
    if (lap.is_pit_out_lap || !Number.isFinite(time) || time < 35 || time > 240 ||
        !Number.isFinite(progress) || progress < 0 || progress > 1) continue;
    const stint = (stints || []).find(s => Number(s.driver_number) === Number(lap.driver_number) &&
      lap.lap_number >= s.lap_start && lap.lap_number <= s.lap_end);
    if (!stint || !['SOFT', 'MEDIUM', 'HARD'].includes(stint.compound) ||
        stint.tyre_age_at_start == null) continue;
    const age = Number(stint.tyre_age_at_start) + lap.lap_number - stint.lap_start;
    if (age < 0 || age > 4) continue;
    const key = `${lap.driver_number}:${stint.compound}:${Math.floor(age / 2)}`;
    if (!groups.has(key)) groups.set(key, { early: [], late: [], driver: lap.driver_number });
    if (progress <= 0.38) groups.get(key).early.push(time);
    if (progress >= 0.62) groups.get(key).late.push(time);
  }
  const byDriver = new Map();
  for (const {early, late, driver} of groups.values()) {
    if (!early.length || !late.length) continue;
    const delta = Math.min(...early) - Math.min(...late);
    if (Math.abs(delta) > 2) continue;
    if (!byDriver.has(driver)) byDriver.set(driver, []);
    byDriver.get(driver).push(delta);
  }
  const med = values => {
    const a = [...values].sort((x,y) => x-y);
    const i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i-1]+a[i])/2;
  };
  if (byDriver.size < 3) return 0;
  return Math.max(-0.8, Math.min(0.8, med([...byDriver.values()].map(med)) * 0.5));
}

// Recentring must be identical in validation and in the displayed prediction.
export function normalizePredictedGaps(rows) {
  const valid = rows.filter(row => Number.isFinite(row.predictedGap));
  if (!valid.length) return [];
  const minimum = Math.min(...valid.map(row => row.predictedGap));
  return valid.map(row => ({...row, predictedGap: Math.min(4.5, Math.max(0, row.predictedGap - minimum))}));
}
