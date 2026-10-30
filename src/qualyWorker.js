import {buildPrediction} from './qualyEngine.js';

globalThis.onmessage = ({data}) => {
  try {
    globalThis.postMessage({result:buildPrediction(...data)});
  } catch (error) {
    globalThis.postMessage({error:error instanceof Error ? error.message : String(error)});
  }
};
