"""Local CPU training. No network, cloud account, GPU or paid API is required."""
import json
import sys
from pathlib import Path
import numpy as np
from catboost import CatBoostRanker, Pool

ROOT = Path(__file__).resolve().parents[1]
year = int(sys.argv[1]) if len(sys.argv)>1 else 2026
dataset = json.loads((ROOT/'.qualy-cache'/f'dataset-{year}.json').read_text(encoding='utf-8'))
events = sorted(dataset['events'], key=lambda e:e['start'])
weights = [0, 0.5, 1]
past = []
deployed_past = []
snapshots = []
results = []
parity = []

def metrics(rows, order):
    positions = {row['driverNumber']:row['position'] for row in rows if row['position'] is not None}
    by_number = {row['driverNumber']:row for row in rows}
    slots = sorted(row['baseGap'] for row in rows)
    errors = [abs(slots[i]-by_number[n]['gap']) for i,n in enumerate(order) if by_number[n]['gapComparable']]
    field = max(positions.values())
    dcg = sum(max(0,field+1-positions.get(n,field+1))/np.log2(i+2) for i,n in enumerate(order))
    ideal = sum((field+1-p)/np.log2(i+2) for i,p in enumerate(sorted(positions.values())))
    return {'positionMae':sum(abs(i+1-positions[n]) for i,n in enumerate(order) if n in positions)/len(positions),
            'top3Hits':sum(positions.get(n,99)<=3 for n in order[:3]),
            'poleHit':int(positions.get(order[0])==1),'gapMae':float(np.mean(errors)) if errors else None,
            'ndcg':float(dcg/ideal) if ideal else None,'samples':len(errors)}

def blend(rows, scores, weight):
    learned=sorted(range(len(rows)),key=lambda i:(-scores[i],rows[i]['driverNumber']))
    ranks={i:rank for rank,i in enumerate(learned)}
    order=sorted(range(len(rows)),key=lambda i:((rows[i]['baseRank']-1)*(1-weight)+ranks[i]*weight,
        rows[i]['baseRank'],rows[i]['driverNumber']))
    return [rows[i]['driverNumber'] for i in order]

def select(history):
    if len(history)<3:
        return 0, {'events':len(history),'reason':'insufficient_validation'}
    summaries={}
    for w in weights:
        mae=np.mean([x[w]['positionMae'] for x in history])
        top=np.mean([x[w]['top3Hits']/3 for x in history])
        summaries[w]={'positionMae':float(mae),'top3Rate':float(top),'score':float(mae+0.75*(1-top)),
            'gapMae':float(np.mean([x[w]['gapMae'] for x in history if x[w]['gapMae'] is not None])),
            'ndcg':float(np.mean([x[w]['ndcg'] for x in history if x[w]['ndcg'] is not None])),
            'samples':sum(x[w]['samples'] for x in history)}
    best=min(weights,key=lambda w:summaries[w]['score'])
    improvement=summaries[0]['score']-summaries[best]['score']
    active=best>0 and improvement>=0.05 and summaries[best]['positionMae']<=summaries[0]['positionMae']
    chosen=best if active else 0
    return chosen, {**summaries[chosen],'events':len(history),'improvement':float(improvement),
        'baseline':summaries[0], 'reason':'validated_improvement' if active else 'baseline_retained'}

def deployed_metrics(history):
    if not history:
        return {'events':0,'positionMae':None,'top3Rate':None,'gapMae':None,'ndcg':None,'samples':0}
    return {'events':len(history),'positionMae':float(np.mean([x['positionMae'] for x in history])),
        'top3Rate':float(np.mean([x['top3Hits']/3 for x in history])),
        'gapMae':float(np.mean([x['gapMae'] for x in history if x['gapMae'] is not None])),
        'ndcg':float(np.mean([x['ndcg'] for x in history if x['ndcg'] is not None])),
        'samples':sum(x['samples'] for x in history)}

def train(history):
    rows=[row for event in history for row in event['rows'] if row['position'] is not None]
    x=np.asarray([row['features'] for row in rows],dtype=np.float32)
    y=[max(0,len(event['rows'])+1-row['position']) for event in history for row in event['rows'] if row['position'] is not None]
    groups=[i for i,event in enumerate(history) for row in event['rows'] if row['position'] is not None]
    model=CatBoostRanker(iterations=220,depth=4,learning_rate=0.04,l2_leaf_reg=10,
        loss_function='YetiRank',random_seed=42,thread_count=2,verbose=False,allow_writing_files=False)
    model.fit(Pool(x,label=y,group_id=groups,feature_names=dataset['features']))
    temporary=ROOT/'.qualy-cache'/'catboost-export.json'
    model.save_model(str(temporary),format='json')
    raw=json.loads(temporary.read_text(encoding='utf-8'))
    # Numeric symmetric trees only. No CatBoost runtime is shipped to the browser.
    feature_map={f['feature_index']:f['flat_feature_index'] for f in raw['features_info']['float_features']}
    trees=[]
    for tree in raw['oblivious_trees']:
        splits=[]
        for split in tree.get('splits') or []:
            if split['split_type']!='FloatFeature': raise ValueError('Unsupported categorical tree')
            splits.append([feature_map[split['float_feature_index']],split['border']])
        trees.append({'splits':splits,'leaves':tree['leaf_values']})
    scale,bias=raw.get('scale_and_bias',[1,[0]])
    return model, {'trees':trees,'scale':scale,'bias':bias[0]}

for index in range(4,len(events)+1):
    history=events[:index]
    chosen,validation=select(past) # BEFORE observing the next GP's result.
    model,compact=train(history)
    snapshot={'trainedThrough':max(e['end'] for e in history),
        'trainedThroughMeeting':history[-1]['key'],'trainingEvents':len(history),
        'blendWeight':chosen,'selectionValidation':validation,
        'validation':deployed_metrics(deployed_past),'model':compact}
    snapshots.append(snapshot)
    if index==len(events): break
    event=events[index]
    x=np.asarray([row['features'] for row in event['rows']],dtype=np.float32)
    scores=model.predict(x)
    candidates={w:metrics(event['rows'],blend(event['rows'],scores,w)) for w in weights}
    result={'key':event['key'],'name':event['name'],'location':event['location'],
        'trainingEvents':index,'blendWeight':chosen,'previous':event['previous'],
        'signalsOnly':candidates[0],'catboostOnly':candidates[1],'selected':candidates[chosen]}
    results.append(result)
    past.append(candidates)
    deployed_past.append(candidates[chosen])
    parity.append({'snapshot':len(snapshots)-1,'features':event['rows'][0]['features'],'score':float(scores[0])})
    print(json.dumps(result),flush=True)

output=ROOT/'public'/'models'
output.mkdir(parents=True,exist_ok=True)
artifact={'schemaVersion':1,'featureVersion':dataset['featureVersion'],'season':year,
    'features':dataset['features'],'baselineCommit':dataset['baselineCommit'],
    'algorithm':'CatBoost YetiRank','snapshots':snapshots}
(output/f'qualy-{year}.json').write_text(json.dumps(artifact,separators=(',',':')),encoding='utf-8')
(ROOT/'reports'/f'qualy-catboost-{year}.json').write_text(json.dumps({'baselineCommit':dataset['baselineCommit'],
    'method':'Expanding chronological training; blend chosen on earlier out-of-sample events only',
    'results':results,'latestValidation':snapshots[-1]['validation'],
    'latestSelection':snapshots[-1]['selectionValidation']},indent=2)+'\n',encoding='utf-8')
fixtures=ROOT/'tests'/'fixtures'
fixtures.mkdir(exist_ok=True)
(fixtures/'catboost-parity.json').write_text(json.dumps(parity,indent=2)+'\n',encoding='utf-8')
print('Model ready:',output/f'qualy-{year}.json', 'latest blend:',snapshots[-1]['blendWeight'])
