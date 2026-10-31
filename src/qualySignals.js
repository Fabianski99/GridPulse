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

// A tyre stint can contain several pit exits. Reconstruct actual on-track runs.
export function practiceRunMetadata(laps, raceControl = []) {
  const deleted = new Set();
  // Race-control lap_number describes the race lap, NOT necessarily the deleted
  // practice lap. Resolve the explicit car and lap in the official message.
  for (const item of [...raceControl].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date))) {
    const message=item.message || '';
    if (!/DELETED|REINSTATED/i.test(message)) continue;
    const car=message.match(/\bCAR\s+(\d+)\b/i);
    const lap=message.match(/\bLAP\s+(\d+)\b/i);
    if (!car || !lap) continue;
    const key=`${Number(car[1])}:${Number(lap[1])}`;
    if (/REINSTATED/i.test(message)) deleted.delete(key);
    else deleted.add(key);
  }
  const groups = new Map();
  for (const lap of laps || []) {
    if (!groups.has(Number(lap.driver_number))) groups.set(Number(lap.driver_number), []);
    groups.get(Number(lap.driver_number)).push(lap);
  }
  const result = new Map();
  for (const [driver, driverLaps] of groups) {
    const ordered = [...driverLaps].sort((a,b)=>a.lap_number-b.lap_number);
    const runs=[];
    let run=[];
    for (const lap of ordered) {
      const previous=run.at(-1);
      const elapsed=previous ? (Date.parse(lap.date_start)-Date.parse(previous.date_start))/1000 : 0;
      const gap=previous && Number.isFinite(previous.lap_duration) && elapsed>previous.lap_duration+90;
      if (run.length && (lap.is_pit_out_lap || gap)) { runs.push(run); run=[]; }
      run.push(lap);
    }
    if (run.length) runs.push(run);
    runs.forEach((items,index)=> {
      const next=runs[index+1]?.[0];
      const inLap=next?.is_pit_out_lap && Number(next.lap_number)===Number(items.at(-1).lap_number)+1
        ? items.at(-1) : null;
      const timed=items.filter(lap=>!lap.is_pit_out_lap && lap!==inLap &&
        Number.isFinite(lap.lap_duration) && lap.lap_duration>=35 && lap.lap_duration<=240);
      for (const lap of items) result.set(`${driver}:${lap.lap_number}`, {
        runId:`${driver}:${index}`,runLength:timed.length,
        excluded:lap===inLap || deleted.has(`${driver}:${lap.lap_number}`),
      });
    });
  }
  return result;
}

export function weatherSummary(rows = [], cutoff = Infinity) {
  const usable=rows.filter(r=>Date.parse(r.date)<=cutoff);
  const med = key => {
    const values=usable.map(r=>r[key]).filter(v=>typeof v==='number' && Number.isFinite(v)).sort((a,b)=>a-b);
    if (!values.length) return null;
    const mid=Math.floor(values.length/2);
    return values.length%2 ? values[mid] : (values[mid-1]+values[mid])/2;
  };
  const rain=usable.map(r=>r.rainfall).filter(v=>v===0 || v===1);
  return {trackTemperature:med('track_temperature'),airTemperature:med('air_temperature'),
    windSpeed:med('wind_speed'),humidity:med('humidity'),
    rainShare:rain.length ? rain.reduce((s,v)=>s+v,0)/rain.length : null,
    samples:usable.length};
}

export function sprintQualifyingBefore(meeting, cutoff = Infinity) {
  const qualifying=(meeting.sessions || []).find(s=>s.session_name==='Qualifying');
  const before=Math.min(cutoff,Date.parse(qualifying?.date_start));
  return (meeting.sessions || []).filter(s=>/sprint/i.test(s.session_name) &&
    /qualifying|shootout/i.test(s.session_name) && !s.is_cancelled && Date.parse(s.date_end)<before)
    .sort((a,b)=>Date.parse(b.date_end)-Date.parse(a.date_end))[0] || null;
}
