import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {safeNumber, average, median, cleanResults, qualifyingMetrics, analyzePracticeSession,
  practiceMetrics, buildTraining, buildPrediction, temporalValidation, calculateProbabilities,
  calibrateWithQualyPrior} from '../src/qualyEngine.js';
import {matchedTrackEvolution, normalizePredictedGaps} from '../src/qualySignals.js';

const session = {session_name:'Practice 3', date_start:'2026-07-01T12:00:00Z',date_end:'2026-07-01T13:00:00Z'};
const drivers = Array.from({length:12}, (_,i) => ({driver_number:i+1, team_name:`Team ${Math.floor(i/2)}`,
  name_acronym:`D${i+1}`, full_name:`Driver ${i+1}`}));
function bundle(index = 0) {
  const laps = drivers.flatMap((driver,i) => [1,2,3].map(n => ({driver_number:driver.driver_number,
    lap_number:n, lap_duration:90+i*0.14+(3-n)*0.05, date_start:`2026-07-01T12:${10+n}:00Z`,
    duration_sector_1:30+i*0.05,duration_sector_2:30+i*0.05,duration_sector_3:30+i*0.04})));
  const stints = drivers.map(driver => ({driver_number:driver.driver_number,lap_start:1,lap_end:3,
    tyre_age_at_start:0,compound:'SOFT'}));
  const qualifyingRows = cleanResults(drivers.map((driver,i) => ({driver_number:driver.driver_number,
    position:i+1, duration:[91+i*0.15, i<10?90+i*0.15:null, i<10?89+i*0.15:null]})));
  return {meeting:{year:2026, meeting_key:index+1,startDate:Date.UTC(2026,6,index+1), country_name:'Test'},
    drivers, profile:'balanced', qualifyingRows, practiceAnalyses:[analyzePracticeSession(session,laps,stints,drivers)]};
}

test('missing numeric inputs never masquerade as zero', () => {
  for (const value of [null,undefined,'',' ',false,NaN]) assert.equal(safeNumber(value),null);
  assert.equal(average([null,undefined,'',2,4]),3);
  assert.equal(median([null,2,4]),3);
  assert.equal(average([null]),null);
  assert.equal(safeNumber(0),0);
});

test('qualifying form uses a same-phase reference and preserves Q1 elimination', () => {
  const b = bundle();
  const q = qualifyingMetrics(b);
  const eliminated = q.byDriver.get(12);
  assert.ok(Math.abs(eliminated.formGap - (92.65/91-1)*89) < 1e-8);
  assert.equal(eliminated.gapComparable,false);
  assert.equal(q.byDriver.get(1).gapComparable,true);
  const training = buildTraining([b]);
  assert.ok(Number.isFinite(training.rows.find(row=>row.driverNumber===12).residualTarget));
});

test('unknown stints and invalid timestamps cannot create confident short runs', () => {
  const laps = [{driver_number:1,lap_number:1,lap_duration:90,date_start:session.date_start},
    {driver_number:1,lap_number:2,lap_duration:35,date_start:'invalid'}];
  const a = analyzePracticeSession(session,laps,[],drivers);
  assert.ok(a.byDriver.get(1).shortRunConfidence <= 0.25);
  assert.equal(a.byDriver.get(1).qualyRawDuration,90);
});

test('compound changes do not become track evolution', () => {
  const laps = drivers.flatMap(d => [{driver_number:d.driver_number,lap_number:1,lap_duration:92,date_start:'2026-07-01T12:10:00Z'},
    {driver_number:d.driver_number,lap_number:2,lap_duration:90,date_start:'2026-07-01T12:50:00Z'}]);
  const stints = drivers.flatMap(d => [{driver_number:d.driver_number,lap_start:1,lap_end:1,tyre_age_at_start:0,compound:'HARD'},
    {driver_number:d.driver_number,lap_start:2,lap_end:2,tyre_age_at_start:0,compound:'SOFT'}]);
  assert.equal(matchedTrackEvolution(laps,stints,session),0);
});

test('missing practice drivers remain in the field with explicit zero coverage', () => {
  const b = bundle();
  b.practiceAnalyses[0].byDriver.delete(12);
  const p = practiceMetrics(b);
  assert.equal(p.rows.length,12);
  assert.equal(p.byDriver.get(12).practiceCoverage,0);
});

test('team form counts GPs, and is invariant to result ordering', () => {
  const bs = [bundle(0),bundle(1),bundle(2)];
  const a = buildTraining(bs);
  const b = buildTraining(bs.map(x=>({...x,qualifyingRows:[...x.qualifyingRows].reverse()})));
  assert.deepEqual([...a.state.teamGap], [...b.state.teamGap].reverse());
  assert.equal(a.state.teamGap.get('Team 0').length,3);
});

test('a driver without history does not get a fabricated prior', () => {
  const rows = [{predictedGap:1}, {predictedGap:0.5,qualyPrior:{strength:0.8,events:4}}];
  assert.equal(calibrateWithQualyPrior(rows)[0].predictedGap,1);
});

test('validation measures recentered gaps, including negative residual predictions', () => {
  assert.deepEqual(normalizePredictedGaps([{predictedGap:-0.3},{predictedGap:0.2}]).map(r=>r.predictedGap),[0,0.5]);
  const rows = Array.from({length:3},(_,eventIndex)=>[0,1,2].map(i=>({eventIndex,driverNumber:i,
    historicalBaseGap:5+i,targetGap:i,targetPosition:i+1,gapComparable:true}))).flat();
  const validation = temporalValidation({rows});
  assert.equal(validation.mae,0);
  assert.equal(validation.positionMae,0);
});

test('target qualifying results and future bundles cannot change the prediction', () => {
  const history = [bundle(0),bundle(1),bundle(2),bundle(3)];
  const target = bundle(4);
  const a = buildPrediction(target,history);
  const b = buildPrediction({...target,qualifyingRows:[]},[...history,bundle(5)]);
  assert.deepEqual(a.predictions.map(r=>[r.driverNumber,r.predictedGap]),b.predictions.map(r=>[r.driverNumber,r.predictedGap]));
  assert.equal(a.estimatedPole,b.estimatedPole);
  assert.equal(a.validation.events,1);
  assert.equal(b.backtest,null);
});

test('simulation probabilities are deterministic, coherent and conserve pole mass', () => {
  const rows = Array.from({length:12},(_,i)=>({driverNumber:i,predictedGap:i*0.1,shortRunConfidence:0.6,practiceCoverage:1}));
  const a = calculateProbabilities(rows,0.3,42);
  assert.deepEqual(a,calculateProbabilities(rows,0.3,42));
  assert.ok(Math.abs([...a.values()].reduce((s,r)=>s+r.pole,0)-100)<1e-8);
  for (const p of a.values()) assert.ok(p.pole<=p.frontRow && p.frontRow<=p.top3 && p.top3<=p.q3);
});

test('worker transports maps and returns the same prediction as the engine', {timeout:30000}, async () => {
  const url = new URL('../src/qualyWorker.js', import.meta.url).href;
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    globalThis.postMessage = data => parentPort.postMessage(data);
    import(${JSON.stringify(url)}).then(() => parentPort.on('message', data => globalThis.onmessage({data})));
  `, {eval:true});
  const args = [bundle(3),[bundle(0),bundle(1),bundle(2)],new Map(),[]];
  try {
    const result = await new Promise((resolve,reject) => {
      worker.once('message',resolve); worker.once('error',reject); worker.postMessage(args);
    });
    assert.equal(result.error,undefined);
    assert.deepEqual(result.result.predictions,buildPrediction(...args).predictions);
    assert.ok(result.result.backtest.positions instanceof Map);
  } finally { await worker.terminate(); }
});
