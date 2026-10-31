import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {groupMeetings, qualifyingSession, practicesBeforeQualy} from '../src/qualyEngine.js';

export const cacheDir = new URL('../.qualy-cache/', import.meta.url);
let lastRequest = 0;
export async function publicData(endpoint, params) {
  await fs.mkdir(cacheDir,{recursive:true});
  const url = `https://api.openf1.org/v1/${endpoint}?${new URLSearchParams(params)}`;
  const file = new URL(Buffer.from(url).toString('base64url')+'.json',cacheDir);
  try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { /* fetch missing data */ }
  for (let attempt=0;attempt<4;attempt++) {
    await new Promise(r=>setTimeout(r,Math.max(0,2200-(Date.now()-lastRequest))));
    lastRequest=Date.now();
    const response = await fetch(url); // Public historical endpoint: no credentials or paid API.
    if (response.status===429 && attempt<3) {
      await new Promise(r=>setTimeout(r,Math.min(30000,Math.max(5000,Number(response.headers.get('Retry-After')||5)*1000))));
      continue;
    }
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
    const data=await response.json();
    await fs.writeFile(file,JSON.stringify(data));
    return data;
  }
  throw new Error('OpenF1 rate limit');
}

export async function collectSeason(year) {
  const sessions = await publicData('sessions',{year});
  const meetings = groupMeetings(sessions).filter(m=> {
    const q=qualifyingSession(m);
    return q && Date.parse(q.date_end)+30*60000<Date.now() && practicesBeforeQualy(m).length;
  });
  const raw=[];
  for (const meeting of meetings) {
    console.log('Datos históricos gratuitos:',meeting.country_name,meeting.meeting_key);
    const practices=practicesBeforeQualy(meeting);
    const qualifying=qualifyingSession(meeting);
    const drivers=await publicData('drivers',{session_key:practices.at(-1).session_key});
    const stints=await publicData('stints',{meeting_key:meeting.meeting_key});
    const weather=await publicData('weather',{meeting_key:meeting.meeting_key});
    const raceControl=await publicData('race_control',{meeting_key:meeting.meeting_key});
    const practiceData=[];
    for (const session of practices) {
      practiceData.push({session,laps:await publicData('laps',{session_key:session.session_key}),
        stints:stints.filter(s=>Number(s.session_key)===Number(session.session_key)),
        weather:weather.filter(s=>Number(s.session_key)===Number(session.session_key)),
        raceControl:raceControl.filter(s=>Number(s.session_key)===Number(session.session_key))});
    }
    const sprint=meeting.sessions.find(s=>/sprint/i.test(s.session_name) && /qualifying|shootout/i.test(s.session_name) &&
      Date.parse(s.date_end)<Date.parse(qualifying.date_start));
    const sprintRows=sprint ? await publicData('session_result',{session_key:sprint.session_key}) : [];
    raw.push({meeting,drivers,practiceData,qualifying,
      qualifyingRows:await publicData('session_result',{session_key:qualifying.session_key}),sprint,sprintRows});
  }
  await fs.writeFile(new URL(`raw-${year}.json`,cacheDir),JSON.stringify(raw));
  return raw;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await collectSeason(Number(process.argv[2]||2026));
}
