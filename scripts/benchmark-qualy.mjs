import fs from 'node:fs/promises';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import * as engine from '../src/qualyEngine.js';

// Cache raw provider responses locally; never include them in the application bundle.
const year = Number(process.argv[2] || 2026);
const cacheDir = new URL('../.qualy-cache/', import.meta.url);
await fs.mkdir(cacheDir, {recursive:true});
const nativeFetch = globalThis.fetch;
let lastRequest = 0;
globalThis.fetch = async input => {
  let url = String(input);
  if (url.startsWith('/api/openf1')) {
    const query = new URL(url, 'https://local.invalid').searchParams;
    const endpoint = query.get('endpoint'); query.delete('endpoint');
    url = `https://api.openf1.org/v1/${endpoint}?${query}`;
  }
  const file = new URL(Buffer.from(url).toString('base64url')+'.json', cacheDir);
  try { return new Response(await fs.readFile(file), {status:200}); } catch { /* cache miss */ }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 2100-(Date.now()-lastRequest))));
  lastRequest = Date.now();
  const response = await nativeFetch(url);
  if (response.ok) await fs.writeFile(file, await response.clone().text());
  return response;
};
const baselineCommit = '2af6a430924550d208ea1e988dc7b9036a9aadd1';
const oldSource = execFileSync('git', ['show', `${baselineCommit}:src/QualyPredictor.jsx`], {encoding:'utf8'});
const context = vm.createContext({console, URLSearchParams, fetch:globalThis.fetch,
  window:{setTimeout}, setTimeout});
vm.runInContext(oldSource.slice(oldSource.indexOf('const OPENF1'), oldSource.indexOf('function ScoreBar')) +
  '\nglobalThis.oldEngine = {buildPrediction, analyzePracticeSession};', context);
async function data(endpoint, params) {
  const response = await fetch('/api/openf1?'+new URLSearchParams({endpoint,...params}));
  if (!response.ok) throw new Error(`${endpoint}: ${response.status}`);
  return response.json();
}
const sessions = await data('sessions', {year});
const meetings = engine.groupMeetings(sessions).filter(m => {
  const q = engine.qualifyingSession(m);
  return q && Date.parse(q.date_end) < Date.now() && engine.practicesBeforeQualy(m).length;
}).slice(-15);
if (meetings.length < 5) throw new Error(`Only ${meetings.length} completed weekends in ${year}`);
const history = await engine.loadQualifyingHistory();
const bundles = [], oldBundles = [], results = [];
for (const meeting of meetings) {
  console.log('Loading', year, meeting.country_name, meeting.meeting_key);
  const practices = engine.practicesBeforeQualy(meeting);
  const drivers = await data('drivers', {session_key:practices.at(-1).session_key});
  const meetingStints = await data('stints', {meeting_key:meeting.meeting_key});
  const qualifying = engine.qualifyingSession(meeting);
  const qualifyingRows = engine.cleanResults(await data('session_result',{session_key:qualifying.session_key}));
  const bundle = {meeting,practices,practice:practices.at(-1),drivers,qualifying,qualifyingRows,
    profile:engine.trackProfile(meeting),practiceAnalyses:[]};
  const oldAnalyses = [];
  for (const practice of bundle.practices) {
    const laps = await data('laps', {session_key:practice.session_key});
    const stints = meetingStints
      .filter(s => Number(s.session_key) === Number(practice.session_key));
    bundle.practiceAnalyses.push(engine.analyzePracticeSession(practice,laps,stints,bundle.drivers));
    oldAnalyses.push(context.oldEngine.analyzePracticeSession(practice,laps,stints,bundle.drivers));
  }
  const oldBundle = {...bundle, practiceAnalyses:oldAnalyses};
  if (bundles.length >= 10) {
    const priors = engine.buildQualyPriors(history, meeting.startDate, year);
    const before = context.oldEngine.buildPrediction(oldBundle,oldBundles.slice(-10),priors,history);
    const after = engine.buildPrediction(bundle,bundles.slice(-10),priors,history);
    const result = {meeting:meeting.country_name, meetingKey:meeting.meeting_key,
      trainingEvents:10, before:before.backtest, after:after.backtest};
    delete result.before.positions; delete result.after.positions;
    results.push(result); console.log(JSON.stringify(result));
  }
  bundles.push(bundle); oldBundles.push(oldBundle);
}
const report = {year, source:'OpenF1 + Jolpica', baselineCommit, results};
await fs.mkdir('reports',{recursive:true});
await fs.writeFile(`reports/qualy-benchmark-${year}.json`,JSON.stringify(report,null,2)+'\n');
