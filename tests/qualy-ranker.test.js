import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {predictCatBoost,selectSnapshot,applyPackagedRanker} from '../src/qualyRanker.js';
import {modelFeatures,MODEL_FEATURES} from '../src/qualyModelFeatures.js';
import {practiceRunMetadata,weatherSummary,sprintQualifyingBefore} from '../src/qualySignals.js';
import proxy from '../api/openf1.js';

const artifact=JSON.parse(fs.readFileSync(new URL('../public/models/qualy-2026.json',import.meta.url)));
const parity=JSON.parse(fs.readFileSync(new URL('./fixtures/catboost-parity.json',import.meta.url)));

test('browser evaluator matches native CatBoost scores for every historical model',()=>{
  for (const item of parity) {
    const actual=predictCatBoost(artifact.snapshots[item.snapshot].model,item.features);
    assert.ok(Math.abs(actual-item.score)<1e-10,`${actual} vs ${item.score}`);
  }
});

test('historical predictions cannot use a model trained on the target or a future event',()=>{
  const first=artifact.snapshots[0];
  assert.equal(selectSnapshot(artifact,{meeting:{year:2026,startDate:first.trainedThrough}}),null);
  assert.equal(selectSnapshot(artifact,{meeting:{year:2025,startDate:first.trainedThrough+1}}),null);
  assert.equal(selectSnapshot(artifact,{meeting:{year:2026,startDate:first.trainedThrough+1}}),first);
  const last=artifact.snapshots.at(-1);
  assert.equal(selectSnapshot(artifact,{meeting:{year:2026,startDate:last.trainedThrough+61*86400000}}),null);
  assert.equal(selectSnapshot({...artifact,features:['wrong']},{meeting:{year:2026,startDate:last.trainedThrough+1}}),null);
});

test('malformed or absent artifacts preserve the baseline order and gaps',()=>{
  const rows=[{driverNumber:1,predictedGap:0},{driverNumber:2,predictedGap:0.2}];
  const bundle={meeting:{year:2026,startDate:artifact.snapshots.at(-1).trainedThrough+1}};
  for (const data of [null,{}, {...artifact,snapshots:{}}]) assert.deepEqual(applyPackagedRanker(rows,bundle,data).rows,rows);
});

test('separate pit exits on the same tyres are separate runs; in-laps are excluded',()=>{
  const laps=Array.from({length:8},(_,i)=>({driver_number:7,lap_number:i+1,
    lap_duration:90,date_start:new Date(Date.UTC(2026,0,1,12,i*2)).toISOString(),is_pit_out_lap:i===0||i===4}));
  const meta=practiceRunMetadata(laps);
  assert.notEqual(meta.get('7:2').runId,meta.get('7:6').runId);
  assert.equal(meta.get('7:4').excluded,true);
  assert.equal(meta.get('7:2').runLength,2);
});

test('deleted laps are resolved from explicit messages, including reinstatement',()=>{
  const laps=[{driver_number:63,lap_number:5,lap_duration:90}];
  const deleted={date:'2026-01-01T12:01:00Z',driver_number:null,lap_number:null,
    message:'CAR 63 (RUS) TIME 1:30.000 DELETED - TRACK LIMITS AT TURN 9 LAP 5 12:00:00'};
  assert.equal(practiceRunMetadata(laps,[deleted]).get('63:5').excluded,true);
  const restored={...deleted,date:'2026-01-01T12:02:00Z',message:'CAR 63 (RUS) LAP 5 TIME REINSTATED'};
  assert.equal(practiceRunMetadata(laps,[restored,deleted]).get('63:5').excluded,false);
});

test('weather and sprint inputs obey prediction cutoffs and preserve missingness',()=>{
  const weather=weatherSummary([{date:'2026-01-01T12:00:00Z',track_temperature:null,rainfall:0},
    {date:'2026-01-01T14:00:00Z',track_temperature:80,rainfall:1}],Date.parse('2026-01-01T13:00:00Z'));
  assert.equal(weather.trackTemperature,null);assert.equal(weather.rainShare,0);assert.equal(weather.samples,1);
  const meeting={sessions:[{session_name:'Qualifying',date_start:'2026-01-02T12:00:00Z'},
    {session_name:'Sprint Qualifying',date_end:'2026-01-01T12:00:00Z'},
    {session_name:'Sprint Shootout',date_end:'2026-01-03T12:00:00Z'}]};
  assert.equal(sprintQualifyingBefore(meeting).session_name,'Sprint Qualifying');
  assert.equal(sprintQualifyingBefore(meeting,Date.parse('2025-12-31T12:00:00Z')),null);
});

test('ranking features do not read target qualifying results or future sprint results',()=>{
  const row={driverNumber:7,qualyPriorPosition:0.5,driverFormGap:0.4};
  const bundle={meeting:{year:2026},qualifying:{date_start:'2026-01-01T12:00:00Z'},
    sprint:{date_end:'2026-01-02T12:00:00Z'},sprintRows:[{driver_number:7,positionValue:1,duration:[80,79,78]}]};
  const a=modelFeatures(row,bundle);
  assert.equal(a.length,MODEL_FEATURES.length);
  assert.ok(a.every(Number.isFinite));
  assert.equal(a[MODEL_FEATURES.indexOf('hasSprint')],0);
  assert.deepEqual(a,modelFeatures(row,{...bundle,qualifyingRows:[{driver_number:7,position:1,duration:[1,2,3]}]}));
});

test('public predictor requests never authenticate or forward the public_only marker',async()=>{
  const savedFetch=globalThis.fetch;
  const savedUser=process.env.OPENF1_USERNAME,savedPassword=process.env.OPENF1_PASSWORD;
  process.env.OPENF1_USERNAME='test-only';process.env.OPENF1_PASSWORD='test-only';
  const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});};
  const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  try {
    await proxy({method:'GET',url:'/api/openf1?public_only=1&endpoint=weather&session_key=123'},response);
    assert.equal(response.code,200);assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://api.openf1.org/v1/weather?session_key=123');
    assert.equal(calls[0].options.headers.Authorization,undefined);
  } finally {
    globalThis.fetch=savedFetch;
    if (savedUser===undefined) delete process.env.OPENF1_USERNAME;else process.env.OPENF1_USERNAME=savedUser;
    if (savedPassword===undefined) delete process.env.OPENF1_PASSWORD;else process.env.OPENF1_PASSWORD=savedPassword;
  }
});
