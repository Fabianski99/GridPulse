import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import * as engine from '../src/qualyEngine.js';
import {MODEL_FEATURES, FEATURE_VERSION, modelFeatures} from '../src/qualyModelFeatures.js';
import {cacheDir} from './qualy-data.mjs';

const year=Number(process.argv[2]||2026);
const baselineCommit='9cfe638a230ebe242920776947ddcb12b9015786';
const frozen=new URL('baseline-9cfe638/',cacheDir);
await fs.mkdir(frozen,{recursive:true});
for (const name of ['qualyEngine.js','qualySignals.js']) {
  let source=execFileSync('git',['show',`${baselineCommit}:src/${name}`],{encoding:'utf8'});
  // Skip only expensive diagnostic simulation; ordering and pole are unchanged.
  source=source.replace('const heldOut = validatePipeline(training);',
    'const heldOut = {mae:null,positionMae:null,ndcg:null,top3Rate:null,samples:0,events:0};');
  await fs.writeFile(new URL(name,frozen),source);
}
const old=await import(new URL('qualyEngine.js',frozen));
const raw=JSON.parse(await fs.readFile(new URL(`raw-${year}.json`,cacheDir),'utf8'));
// Reuse exactly the history responses used by the application; no paid requests.
const nativeFetch=globalThis.fetch;
globalThis.fetch=async url=> {
  const file=new URL(Buffer.from(String(url)).toString('base64url')+'.json',cacheDir);
  try {return new Response(await fs.readFile(file));} catch {return nativeFetch(url);}
};
const history=await engine.loadQualifyingHistory();
function bundleOf(r,e) {
  return {meeting:r.meeting,drivers:r.drivers,qualifying:r.qualifying,
    qualifyingRows:e.cleanResults(r.qualifyingRows),sprint:r.sprint,sprintRows:e.cleanResults(r.sprintRows),
    practices:r.practiceData.map(p=>p.session),practice:r.practiceData.at(-1).session,
    profile:e.trackProfile(r.meeting),practiceAnalyses:r.practiceData.map(p=>e.analyzePracticeSession(p.session,p.laps,p.stints,r.drivers,p.weather,p.raceControl))};
}
const bundles=[],oldBundles=[],events=[];
for (const r of raw) {
  const bundle=bundleOf(r,engine), oldBundle=bundleOf(r,old);
  if (bundles.length>=3) {
    console.log('Preparando evaluación:',r.meeting.country_name,r.meeting.meeting_key);
    const priors=engine.buildQualyPriors(history,r.meeting.startDate,year);
    const referenceFile=new URL(`reference-9cfe638-${r.meeting.meeting_key}.json`,cacheDir);
    let before;
    try { before=JSON.parse(await fs.readFile(referenceFile,'utf8')); }
    catch {
      before=old.buildPrediction(oldBundle,oldBundles.slice(-10),priors,history);
      await fs.writeFile(referenceFile,JSON.stringify(before));
    }
    const current=engine.buildPrediction(bundle,bundles.slice(-10),priors,history,null,{diagnostics:false});
    const actual=engine.qualifyingMetrics(bundle);
    // Keep the full predicted field. Removing DNS/no-time drivers using the
    // eventual result would leak target information into the ranking benchmark.
    const rows=current.predictions.map(row=>({
      driverNumber:row.driverNumber,driver:row.driver.name_acronym,features:modelFeatures(row,bundle),
      position:actual.byDriver.get(row.driverNumber)?.position ?? null,gap:actual.byDriver.get(row.driverNumber)?.gap ?? null,
      gapComparable:Boolean(actual.byDriver.get(row.driverNumber)?.gapComparable),
      baseRank:row.predictedPosition,baseGap:row.predictedGap,
      previousRank:before.predictions.find(p=>p.driverNumber===row.driverNumber)?.predictedPosition,
    }));
    events.push({key:r.meeting.meeting_key,name:r.meeting.country_name,location:r.meeting.location,
      year,start:r.meeting.startDate,end:Date.parse(r.qualifying.date_end),rows,
      previous:before.backtest,current:current.backtest,estimatedPole:current.estimatedPole});
  }
  bundles.push(bundle);oldBundles.push(oldBundle);
}
await fs.writeFile(new URL(`dataset-${year}.json`,cacheDir),JSON.stringify({year,baselineCommit,featureVersion:FEATURE_VERSION,features:MODEL_FEATURES,events}));
console.log('Dataset completo:',events.length,'GP; sin datos futuros en las variables.');
