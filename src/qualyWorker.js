import {buildPrediction} from './qualyEngine.js';

globalThis.onmessage = async ({data}) => {
  try {
    try {
      const year=Number(data[0]?.meeting?.year);
      const response=await fetch(`/models/qualy-${year}.json`);
      if (response.ok) data[5]={...data[5],rankingArtifact:await response.json()};
    } catch { /* Offline or no validated artifact: preserve the adaptive baseline. */ }
    globalThis.postMessage({result:buildPrediction(...data)});
  } catch (error) {
    globalThis.postMessage({error:error instanceof Error ? error.message : String(error)});
  }
};
