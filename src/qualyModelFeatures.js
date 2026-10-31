export const FEATURE_VERSION = 1;
export const BASE_FEATURES = ['qualyPaceGap','theoreticalGap','practicePosition','shortRunConfidence',
  'longRunGap','teammateDelta','trackEvolutionExposure','driverFormGap','teamFormGap','teamTrend',
  'trackFitGap','driverFormPosition','practiceCoverage','qualyPriorStrength','qualyPriorPosition',
  'qualyPriorMomentum','latestQualyGap','latestTheoreticalGap','shortRunSpread','topSpeedDeficit'];
export const MODEL_FEATURES = [...BASE_FEATURES,'baseGap','lapScale','sprintPosition','sprintGap','hasSprint',
  'trackTemperature','airTemperature','windSpeed','humidity','rainShare','hasWeather',
  'profilePower','profileHighSpeed','profileDownforce'];

export function modelFeatures(row, bundle) {
  const analyses = bundle.practiceAnalyses || [];
  const last=analyses.at(-1);
  const weather=last?.conditions || {};
  const lap=last?.leaderRawQualy;
  const scale=Number.isFinite(lap) && lap>35 ? lap/90 : 1;
  const cutoff=Date.parse(bundle.qualifying?.date_start);
  const sprintValid=bundle.sprint && Date.parse(bundle.sprint.date_end)<cutoff;
  const sprint=sprintValid ? (bundle.sprintRows || []) : [];
  const result=sprint.find(r=>Number(r.driver_number)===Number(row.driverNumber));
  let sprintGap=null;
  if (result && Array.isArray(result.duration)) {
    const phase=result.duration.findLastIndex(t=>typeof t==='number' && t>=35 && t<=240);
    const times=sprint.map(r=>r.duration?.[phase]).filter(t=>typeof t==='number' && t>=35 && t<=240);
    if (phase>=0 && times.length) sprintGap=(result.duration[phase]/Math.min(...times)-1)*90;
  }
  const values={...row,
    baseGap:row.preModelGap ?? row.historicalBaseGap ?? row.predictedGap ?? 0,
    lapScale:scale,
    sprintPosition:result ? (result.positionValue-1)/Math.max(1,sprint.length-1) : row.qualyPriorPosition,
    sprintGap:sprintGap ?? row.driverFormGap/scale,
    hasSprint:result ? 1 : 0,
    trackTemperature:weather.trackTemperature ?? 30,airTemperature:weather.airTemperature ?? 22,
    windSpeed:weather.windSpeed ?? 0,humidity:weather.humidity ?? 50,rainShare:weather.rainShare ?? 0,
    hasWeather:weather.samples>0 ? 1 : 0,
    profilePower:bundle.profile==='power'?1:0,profileHighSpeed:bundle.profile==='high_speed'?1:0,
    profileDownforce:bundle.profile==='downforce'?1:0,
  };
  return MODEL_FEATURES.map(key=>Number.isFinite(values[key]) ? values[key] : 0);
}
