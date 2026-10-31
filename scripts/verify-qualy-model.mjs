import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as engine from '../src/qualyEngine.js';
import {cacheDir} from './qualy-data.mjs';

const year=Number(process.argv[2]||2026);
const raw=JSON.parse(await fs.readFile(new URL(`raw-${year}.json`,cacheDir),'utf8'));
const artifact=JSON.parse(await fs.readFile(`public/models/qualy-${year}.json`,'utf8'));
const report=JSON.parse(await fs.readFile(`reports/qualy-catboost-${year}.json`,'utf8'));
globalThis.fetch=async url=>new Response(await fs.readFile(new URL(Buffer.from(String(url)).toString('base64url')+'.json',cacheDir)));
const history=await engine.loadQualifyingHistory();
const bundles=raw.map(r=>({meeting:r.meeting,drivers:r.drivers,qualifying:r.qualifying,
  qualifyingRows:engine.cleanResults(r.qualifyingRows),sprint:r.sprint,sprintRows:engine.cleanResults(r.sprintRows),
  practices:r.practiceData.map(p=>p.session),practice:r.practiceData.at(-1).session,profile:engine.trackProfile(r.meeting),
  practiceAnalyses:r.practiceData.map(p=>engine.analyzePracticeSession(p.session,p.laps,p.stints,r.drivers,p.weather,p.raceControl))}));
// The last five GP include a shortened classified field, Sprint and standard weekends.
for (const expected of report.results.slice(-5)) {
  const index=bundles.findIndex(b=>b.meeting.meeting_key===expected.key);
  const target=bundles[index];
  const priors=engine.buildQualyPriors(history,target.meeting.startDate,year);
  const result=engine.buildPrediction(target,bundles.slice(Math.max(0,index-10),index),priors,history,null,
    {diagnostics:false,rankingArtifact:artifact});
  assert.ok(Math.abs(result.backtest.positionMae-expected.selected.positionMae)<1e-10,
    `${expected.location}: JS ${result.backtest.positionMae}, Python ${expected.selected.positionMae}`);
  assert.equal(result.backtest.top3Hits,expected.selected.top3Hits);
  assert.equal(Number(result.backtest.positions.get(result.predictions[0].driverNumber)===1),expected.selected.poleHit);
  assert.equal(result.packagedRanker?.weight || 0,expected.blendWeight);
  console.log('Verificado de extremo a extremo:',expected.location,result.backtest.positionMae.toFixed(3),result.backtest.top3Hits+'/3');
}
