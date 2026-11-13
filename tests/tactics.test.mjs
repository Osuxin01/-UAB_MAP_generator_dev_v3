import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({stdin:{contents:'export * from "./src/mapGenerator"; export * from "./src/tacticalGeometry"; export * from "./src/tacticalEvaluation"; export * from "./src/tacticalSettings";',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const field = {width:8,height:18,gridSize:0.5,bottomStart:{x:4,y:0.5},topStart:{x:4,y:17.5}};
function box(id,x,y,w=1,h=1) { return {id,shape:'diamond',x:x+w/2,y:y+h/2,angle:0,seams:[],polygon:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]}; }
function seeded(fn) { const saved = Math.random; let seed = 1234; Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); try { return fn(); } finally { Math.random = saved; } }

test('barriers may touch all four field edges but may not extend past them', () => {
 for (const [x, y] of [[0, 0], [field.width - 1, field.height - 1]]) {
   assert.equal(m.barrierWithinPlacementBounds(field, box('edge', x, y)), true);
 }
 for (const [x, y] of [[-0.01, 2], [field.width - 0.99, 2], [2, -0.01], [2, field.height - 0.99]]) {
   assert.equal(m.barrierWithinPlacementBounds(field, box('outside', x, y)), false);
 }
});

test('points depend on opponent-side Y rows, not X; touching players each count', () => {
 const barriers=[box('center',3.5,8.5),box('left',0,9.5),box('right',6,9.7),box('deep',3,12),box('own',3,4)];
 const points=m.aggressivePoints(field,barriers,1);
 assert.equal(points.center,0); assert.equal(points.own,0); assert.equal(points.left,1); assert.equal(points.right,1); assert.equal(points.deep,2);
 assert.equal(m.aggressivePoints(field,barriers,-1).own,1);
 assert.equal(m.finalAggressiveScore(points,[{alive:true,touchingBarrierId:'deep'},{alive:true,touchingBarrierId:'deep'},{alive:true,touchingBarrierId:null}]),4);
 assert.equal(m.finalAggressiveScore(points,[{alive:false,touchingBarrierId:'deep'}]),0);
});
test('line of sight blocks solid cover including collinear edges', () => {
 const cover=box('wall',3,4,2,2);
 assert.equal(m.clearSegment({x:0,y:5},{x:8,y:5},[cover]),false);
 assert.equal(m.clearSegment({x:0,y:4},{x:8,y:4},[cover]),false);
 assert.equal(m.clearSegment({x:0,y:3},{x:8,y:3},[cover]),true);
});
test('routes go straight in open space, detour around cover, never pass through a wall', () => {
 const a={x:1,y:3},b={x:7,y:3};
 assert.deepEqual(m.createNavigator(8,8,[])(a,b),[a,b]);
 const obstacles=[box('cover',3,2,2,2)];
 const route=m.createNavigator(8,8,obstacles)(a,b);
 assert.ok(route && route.length>2);
 route.slice(1).forEach((p,i)=>assert.equal(m.clearSegment(route[i],p,obstacles,0.12),true));
 assert.equal(m.createNavigator(8,8,[box('wall',3,0,2,8)])(a,b),null);
});
test('shooting has exactly left/right options outside cover; no top position', () => {
 const barrier=box('cover',3,4,2,2);
 const positions=m.shootingPositions(barrier,1,field,[barrier]);
 assert.deepEqual(positions.map(p=>p.side),['left','right']);
 assert.ok(positions[0].x<3 && positions[1].x>5);
 positions.forEach(p=>assert.equal(m.inside(p,barrier.polygon),false));
});
test('cross angle is own-side angle, including obtuse angles', () => {
 const target={x:4,y:12};
 const a={x:4-Math.sqrt(3),y:11},b={x:4+Math.sqrt(3),y:11};
 assert.ok(Math.abs(m.firingAngle(a,b,target)-120)<1e-6);
 assert.ok(m.crossQuality({x:3,y:10},{x:5,y:10},target,1,field)>m.crossQuality(a,b,target,1,field));
 assert.equal(m.crossQuality({x:3,y:13},{x:5,y:13},target,1,field),0);
});
test('V cross suppresses two different routes without intersection or angle requirements', () => {
 const p={x:3.6,y:2},q={x:4.4,y:2};
 const hits=[{target:{x:1,y:4},p:true,q:false},{target:{x:7,y:4},p:false,q:true}];
 assert.equal(m.vCrossCoverage(p,q,hits,1),1);
 assert.equal(m.vCrossCoverage(p,q,[hits[0]],1),0);
 assert.equal(m.vCrossCoverage({x:1,y:2},{x:7,y:2},hits,1),0);
});
test('3-player threats use fixed sides, not all available shooting positions', () => {
 const option=(id,side,mask)=>({position:{x:0,y:0,barrierId:id,side},mask});
 const options=[option('a','left',[true,false,false,false,false]),option('a','right',[false,true,false,false,false]),option('b','left',[false,false,true,false,false]),option('c','left',[false,false,false,true,false]),option('d','left',[false,false,false,false,true])];
 const result=m.selectThreats(options,3);
 assert.equal(result.selected.length,3); assert.equal(new Set(result.selected.map(o=>o.position.barrierId)).size,3);
 assert.equal(result.covered.filter(Boolean).length,3);
});
test('retake rewards separated directions, not multiple collinear positions', () => {
 const target={x:4,y:10};
 assert.equal(m.multiDirectionQuality({x:4,y:2},{x:4,y:4},target),0);
 assert.ok(m.multiDirectionQuality({x:1,y:8},{x:7,y:8},target)>0.9);
});
test('main slider updates only tactical values and keeps cross strong on both ends', () => {
 const attack=m.styleSettings(0), defense=m.styleSettings(100);
 assert.ok(attack.advance>defense.advance && attack.support>defense.support && attack.gain>defense.gain && attack.retake>defense.retake);
 assert.ok(attack.cross>=70 && defense.cross>=70);
 assert.equal(m.styleSettings(-100).playStyle,0); assert.equal(m.styleSettings(999).playStyle,100);
 assert.equal(m.styleSettings(NaN).playStyle,50);
 assert.equal('triangleCount' in attack,false);
});
test('generated maps have six finite metrics, preserve counts and rotate symmetrically', () => seeded(() => {
 const config={...m.defaultGeneratorConfig,minScore:0,maxAttempts:50};
 const map=m.generateMap(config);
 assert.equal(map.barriers.length,10);
 for (const {x, y} of map.barriers.flatMap(barrier => barrier.polygon)) {
   assert.ok(x >= 0.5 - 1e-9 && x <= map.field.width - 0.5 + 1e-9);
   assert.ok(y >= 1 - 1e-9 && y <= map.field.height - 1 + 1e-9);
 }
 assert.equal(Object.keys(map.evaluation.details).length,6);
 Object.values(map.evaluation.details).forEach(value=>assert.ok(Number.isFinite(value) && value>=0 && value<=100));
 const attack=m.evaluateMap(map.field,map.barriers,{...config,...m.styleSettings(0)});
 const defense=m.evaluateMap(map.field,map.barriers,{...config,...m.styleSettings(100)});
 assert.notEqual(attack.score,defense.score);
 for(const label of ['上がりやすさ','援護','前進メリット','アグレッシブの取り返し']) assert.equal(attack.details[label],defense.details[label]);
 const rotated=map.barriers.map(b=>({...b,x:map.field.width-b.x,y:map.field.height-b.y,polygon:b.polygon.map(p=>({x:map.field.width-p.x,y:map.field.height-p.y}))}));
 const other=m.evaluateMap(map.field,rotated,config);
 for(const key of Object.keys(map.evaluation.details)) assert.ok(Math.abs(map.evaluation.details[key]-other.details[key])<2, key);
}));
test('invalid numeric settings are rejected and inaccessible maps do not score well', () => {
 assert.ok(m.validateConfig({...m.defaultGeneratorConfig,advance:NaN}));
 assert.ok(m.validateConfig({...m.defaultGeneratorConfig,retake:101}));
 assert.equal(m.evaluateMap(field,[],m.defaultGeneratorConfig).score,0);
});

test('generation selects different layouts for attack and defense from the same candidates', () => {
 const attack=seeded(()=>m.generateMap({...m.defaultGeneratorConfig,...m.styleSettings(0),maxAttempts:50}));
 const defense=seeded(()=>m.generateMap({...m.defaultGeneratorConfig,...m.styleSettings(100),maxAttempts:50}));
 assert.ok(attack.accepted && defense.accepted);
 assert.equal(attack.barriers.length,10); assert.equal(defense.barriers.length,10);
 assert.notDeepEqual(attack.barriers.map(b=>b.polygon),defense.barriers.map(b=>b.polygon));
});
test('generation worker returns successful maps and validation failures', async () => {
 const {Worker}=await import('node:worker_threads');
 const {once}=await import('node:events');
 const source=await build({entryPoints:['src/generateMap.worker.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
 const worker=new Worker('const {parentPort}=require("node:worker_threads"); globalThis.self={postMessage:data=>parentPort.postMessage(data)}; '+source.outputFiles[0].text+'; parentPort.on("message",data=>self.onmessage({data}));',{eval:true});
 try {
   const attempts=[];
   const success=new Promise(resolve=>{
     function onMessage(message) {
       if (message.type==='progress') {
         attempts.push(message.attempt);
         return;
       }
       worker.off('message',onMessage);
       resolve(message);
     }
     worker.on('message',onMessage);
   });
   worker.postMessage({...m.defaultGeneratorConfig,minScore:0,maxAttempts:50});
   const result=await success;
   assert.equal(result.type,'success');
   assert.equal(attempts[0],1);
   assert.ok(attempts.every((attempt,index)=>attempt<=50 && (index===0 || attempt>attempts[index-1])));
   assert.equal(result.map.barriers.length,10);
   assert.equal(Object.keys(result.map.evaluation.details).length,6);
   const failure=once(worker,'message');
   worker.postMessage({...m.defaultGeneratorConfig,triangleCount:3});
   assert.match((await failure)[0].error,/偶数/);
 } finally { await worker.terminate(); }
});

test('default priorities contribute equally, ignoring legacy importance values', () => seeded(() => {
 const config={...m.defaultGeneratorConfig,minScore:0,maxAttempts:50};
 const map=m.generateMap(config);
 const result=m.evaluateMap(map.field,map.barriers,config);
 const expected=m.TACTICAL_FIELDS.reduce((sum,f)=>sum+100-Math.abs(result.details[f.label]-config[f.key]),0)/m.TACTICAL_FIELDS.length;
 assert.ok(Math.abs(result.score-expected)<=0.55);
 const legacy=m.evaluateMap(map.field,map.barriers,{...config,advanceImportance:10000,supportImportance:0,gainImportance:0,retakeImportance:0,crossImportance:0});
 assert.deepEqual(legacy,result);
 assert.ok(Object.keys(m.styleSettings(0)).every(key=>!key.endsWith('Importance')));
}));

test('route sampling uses 0.25m distances including endpoints and the last short interval', () => {
 const samples=m.samplePath([{x:0,y:0},{x:1.1,y:0}]);
 assert.deepEqual(samples.map(p=>p.x),[0,0.25,0.5,0.75,1,1.1]);
 assert.equal(m.samplePath([{x:0,y:0},{x:5,y:0}]).length,21);
 assert.equal(m.samplePath([{x:0,y:0},{x:10,y:0}]).length,41);
 assert.deepEqual(m.samplePath([{x:0,y:0},{x:0.1,y:0}]),[{x:0,y:0},{x:0.1,y:0}]);
 assert.deepEqual(m.samplePath([{x:1,y:2},{x:1,y:2}]),[{x:1,y:2}]);
 assert.deepEqual(m.samplePath([]),[]);
 assert.throws(()=>m.samplePath([{x:0,y:0}],0));
});
test('sampling follows bends and equal-speed break positions stop at the actual endpoint', () => {
 const path=[{x:0,y:0},{x:0.3,y:0},{x:0.3,y:0.7}];
 const samples=m.samplePath(path);
 assert.equal(samples.length,5);
 assert.ok(Math.abs(samples[2].x-0.3)<1e-9 && Math.abs(samples[2].y-0.2)<1e-9);
 assert.deepEqual(m.pointAtDistance(path,5),{x:0.3,y:0.7});
 assert.deepEqual(m.pointAtDistance([{x:0,y:0},{x:0,y:0},{x:1,y:0}],0.5),{x:0.5,y:0});
});

test('break slider uses opening firing exposure and contributes to matching independently', () => seeded(() => {
 const config={...m.defaultGeneratorConfig,minScore:0,maxAttempts:50};
 const map=m.generateMap(config);
 const actual=map.evaluation.details['ブレイク'];
 assert.equal(actual,map.evaluation.diagnostics.breakPressure);
 assert.ok(actual>=0 && actual<=100);
 assert.equal(m.styleSettings(0).breakPressure,35);
 assert.equal(m.styleSettings(100).breakPressure,75);
 assert.equal(m.styleSettings(50).breakPressure,55);
 assert.equal(m.styleSettings(25).breakPressure,45);
 assert.equal(m.styleSettings(75).breakPressure,65);
 const matched=m.evaluateMap(map.field,map.barriers,{...config,breakPressure:actual});
 const opposite=m.evaluateMap(map.field,map.barriers,{...config,breakPressure:actual>=50?0:100});
 assert.deepEqual(matched.details,opposite.details);
 assert.ok(matched.score>opposite.score);
 assert.ok(m.validateConfig({...config,breakPressure:101}));
}));

test('priority changes matching influence but preserves map metrics and survives main slider changes', () => seeded(() => {
 const config={...m.defaultGeneratorConfig,minScore:0,maxAttempts:50};
 const map=m.generateMap(config);
 const actual=map.evaluation.details['ブレイク'];
 const base={...config,breakPressure:actual>=50?0:100};
 const low={...base,breakPressurePriority:6}, high={...base,breakPressurePriority:1};
 const a=m.evaluateMap(map.field,map.barriers,low), b=m.evaluateMap(map.field,map.barriers,high);
 assert.deepEqual(a.details,b.details);
 for(const [result,cfg] of [[a,low],[b,high]]) {
   const weight=m.TACTICAL_FIELDS.reduce((sum,f)=>sum+(7-cfg[f.priorityKey]),0);
   const expected=m.TACTICAL_FIELDS.reduce((sum,f)=>sum+(100-Math.abs(result.details[f.label]-cfg[f.key]))*(7-cfg[f.priorityKey]),0)/weight;
   assert.ok(Math.abs(result.score-expected)<=0.55);
 }
 assert.ok(b.score<a.score);
 const changed={...high,...m.styleSettings(100)};
 assert.equal(changed.breakPressurePriority,1);
 assert.equal(changed.breakPressure,75);
 assert.ok(m.validateConfig({...config,advancePriority:0}));
 assert.ok(m.validateConfig({...config,crossPriority:NaN}));
 assert.equal(m.validateConfig({...config,retakePriority:4}),null);
}));

test('priority accepts all six integer levels and rejects values outside the scale', () => {
 assert.deepEqual(m.PRIORITY_OPTIONS.map(o=>o.value),[1,2,3,4,5,6]);
 for(const field of m.TACTICAL_FIELDS) {
   assert.equal(m.defaultGeneratorConfig[field.priorityKey],3);
   for(const value of [1,2,3,4,5,6]) assert.equal(m.validateConfig({...m.defaultGeneratorConfig,[field.priorityKey]:value}),null);
   for(const value of [0,7,2.5,NaN]) assert.ok(m.validateConfig({...m.defaultGeneratorConfig,[field.priorityKey]:value}));
 }
});
