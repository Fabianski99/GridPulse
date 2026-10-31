import {FEATURE_VERSION,MODEL_FEATURES,modelFeatures} from './qualyModelFeatures.js';

export function selectSnapshot(artifact, bundle) {
  if (artifact?.schemaVersion!==1 || artifact.featureVersion!==FEATURE_VERSION ||
      artifact.season!==Number(bundle.meeting.year) ||
      !Array.isArray(artifact.snapshots) ||
      JSON.stringify(artifact.features)!==JSON.stringify(MODEL_FEATURES)) return null;
  // A historical prediction can never use a model trained on that GP or a later GP.
  const cutoff=Number(bundle.meeting.startDate);
  const candidates=(artifact.snapshots || []).filter(s=>Number.isFinite(s.trainedThrough) && s.trainedThrough<cutoff);
  const snapshot=candidates.sort((a,b)=>b.trainedThrough-a.trainedThrough)[0];
  // Fall back to the browser's adaptive model if the packaged model is stale.
  if (!snapshot || cutoff-snapshot.trainedThrough>60*86400000 || ![0,0.5,1].includes(snapshot.blendWeight)) return null;
  if (snapshot.blendWeight>0 && (!(snapshot.validation?.events>=3) ||
      !['positionMae','top3Rate','gapMae','ndcg','samples'].every(key=>Number.isFinite(snapshot.validation[key])))) return null;
  return snapshot;
}

export function predictCatBoost(model, features) {
  // CatBoost evaluates float features as float32; preserve split-boundary parity.
  const values=features.map(Math.fround);
  let sum=0;
  for (const tree of model.trees) {
    let leaf=0;
    tree.splits.forEach(([feature,border],bit)=>{ if (values[feature]>border) leaf|=1<<bit; });
    sum+=tree.leaves[leaf];
  }
  return sum*model.scale+model.bias;
}

export function applyPackagedRanker(rows,bundle,artifact) {
  const snapshot=selectSnapshot(artifact,bundle);
  if (!snapshot || snapshot.blendWeight===0) return {rows,snapshot,active:false};
  try {
    const scored=rows.map((row,index)=>({row,index,score:predictCatBoost(snapshot.model,modelFeatures(row,bundle))}));
    if (!scored.every(item=>Number.isFinite(item.score))) return {rows,snapshot:null,active:false};
    const order=[...scored].sort((a,b)=>b.score-a.score || a.row.driverNumber-b.row.driverNumber);
    const ranks=new Map(order.map((item,index)=>[item.row.driverNumber,index]));
    const weight=snapshot.blendWeight;
    const final=scored.sort((a,b)=>
      ((a.index*(1-weight)+ranks.get(a.row.driverNumber)*weight)-(b.index*(1-weight)+ranks.get(b.row.driverNumber)*weight)) ||
      a.index-b.index || a.row.driverNumber-b.row.driverNumber);
    const gaps=rows.map(row=>row.predictedGap).sort((a,b)=>a-b);
    return {rows:final.map((item,index)=>({...item.row,predictedGap:gaps[index],catBoostScore:item.score})),snapshot,active:true};
  } catch { return {rows,snapshot:null,active:false}; }
}
