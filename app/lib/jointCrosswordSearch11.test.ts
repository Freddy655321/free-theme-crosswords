import assert from "node:assert/strict";
import test from "node:test";
import { CspCandidateIndex } from "./cspCandidateDomains";
import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";
import { compareCspValuePriority } from "./crosswordCsp11";
import { runJointCrosswordSearch11,validateJointTerminal,selectJointOpportunity } from "./jointCrosswordSearch11";
import { commitJointPlacement,emptyJointState,type JointCandidate } from "./jointPlacementDomains11";
import { deriveEntriesFromGrid } from "./publishPipeline/deriveEntries";
import { runGridValidation } from "./gridValidation/validateGrid";
import * as validationModule from "./gridValidation/validateGrid";

const policies={isForbiddenPublishAnswer:()=>false,isOverGenericThemeWord:()=>false};
const options={targetThematicEntries:1,maxNodes:100,deadlineMs:3000,seed:1,policies};

// Synthetic connected word lattice, used only to supply an inventory, never engine geometry.
const fixtureGrid=Array.from({length:11},(_,r)=>Array.from({length:11},(_,c)=>{
  if(r===0) return String.fromCharCode(65+c);
  if(c%2===0) return String((r+c)%10);
  if(r%2===0&&c!==5) return String.fromCharCode(76+((r*3+c)%15));
  return "#";
}));
const fixtureEntries=deriveEntriesFromGrid(fixtureGrid);
const candidates:JointCandidate[]=fixtureEntries.map(e=>({answer:e.answer,thematic:e.direction==="across",source:e.direction==="across"?"model":"filler"}));
const bridge=fixtureEntries[0].answer;
// A deterministic fixture seed makes the full-width answer the first seed value.
const fixtureSeed=Array.from({length:1000},(_,i)=>i).find(seed=>[...candidates].filter(c=>c.thematic).sort((a,b)=>compareCspValuePriority({candidate:a,remainingOptions:0},{candidate:b,remainingOptions:0},seed))[0].answer===bridge)!;

test("synthetic joint end-to-end generates geometry, interleaves fill, and passes unchanged validation",{timeout:15000},()=>{
  assert.equal(runGridValidation({grid:fixtureGrid,derived:fixtureEntries,policies}).accepted,true);
  assert.ok(Number.isInteger(fixtureSeed));
  const input=JSON.stringify(candidates);
  const result=runJointCrosswordSearch11({...options,candidates,targetThematicEntries:8,maxNodes:25000,deadlineMs:6000,seed:fixtureSeed});
  assert.equal(result.termination,"success",JSON.stringify({...result,result:null,bestState:undefined}));
  assert.ok(result.result?.validation.accepted);
  assert.ok(result.result.derivationAgrees&&result.result.connected);
  assert.ok(result.result.thematicCount>=8);
  assert.ok(result.metrics.generalPlacementsBeforeTarget>0);
  assert.ok(result.metrics.propagationCalls>0);
  assert.equal(new Set(result.result.entries.map(e=>e.answer)).size,result.result.entries.length);
  assert.equal(JSON.stringify(candidates),input);
  assert.deepEqual(result.result.entries,deriveEntriesFromGrid(result.result.grid));
  const again=runJointCrosswordSearch11({...options,candidates,targetThematicEntries:8,maxNodes:25000,deadlineMs:6000,seed:fixtureSeed});
  assert.equal(again.termination,"success");assert.deepEqual(again.result?.grid,result.result.grid);
  assert.equal(again.metrics.nodes,result.metrics.nodes);
});

test("terminal verifies correspondence, provenance, target, duplicates and connectedness",()=>{
  const index=new CspCandidateIndex(candidates,normalizeCspAnswer11);
  let state=emptyJointState();
  const ordered=[fixtureEntries[0],...fixtureEntries.filter(e=>e.direction==="down"),...fixtureEntries.filter(e=>e.direction==="across").slice(1)];
  for(const entry of ordered) {
    const child=commitJointPlacement(state,index,index.id(entry.answer)!,entry,policies);
    assert.ok(child,entry.answer);state=child;
  }
  const snapshot=JSON.stringify(state);
  const result=validateJointTerminal(state,index,8,policies);
  assert.equal(result.accepted,true);
  assert.equal(result.composition.filter(c=>c.candidate.source==="filler").length,6);
  assert.equal(validateJointTerminal(state,index,30,policies).reason,"thematic-target");
  assert.equal(validateJointTerminal({...state,placed:state.placed.slice(1)},index,8,policies).reason,"derivation-mismatch");
  assert.equal(validateJointTerminal({...state,placed:[...state.placed,state.placed[0]]},index,8,policies).accepted,false);
  assert.equal(validateJointTerminal(state,index,8,{...policies,isOverGenericThemeWord:()=>true}).validation.issue,"too-many-generic");
  assert.equal(JSON.stringify(state),snapshot);
});

test("MRV ignores empty optional domains and uses deterministic coordinate ties",()=>{
  const domains=[{opportunity:{row:5,col:2,direction:"down" as const},count:0,alternatives:[]},
    {opportunity:{row:5,col:3,direction:"down" as const},count:2,alternatives:[]},
    {opportunity:{row:1,col:3,direction:"across" as const},count:2,alternatives:[]}];
  assert.equal(selectJointOpportunity(domains)?.opportunity.row,1);
  assert.equal(selectJointOpportunity(domains.slice(0,1)),null);
});

test("failed terminal validation continues through legal expansions",{timeout:10000},context=>{
  const validate=validationModule.runGridValidation;
  let calls=0;
  context.mock.method(validationModule,"runGridValidation",(input:Parameters<typeof validate>[0])=>{
    const actual=validate(input);
    return ++calls===1?{...actual,accepted:false,issue:"synthetic-extra-rejection"}:actual;
  });
  const report=runJointCrosswordSearch11({...options,candidates,targetThematicEntries:8,seed:fixtureSeed,maxNodes:25000,deadlineMs:6000});
  assert.equal(report.termination,"success");
  assert.equal(report.metrics.terminalRejections["synthetic-extra-rejection"],1);
  assert.ok(report.metrics.terminalStatesTested>=2);
  assert.ok(report.result!.entries.length>15);
});

test("disconnected terminal is rejected even with accurate independent answer records",()=>{
  const records:JointCandidate[]=[{answer:"CAT",thematic:true,source:"model"},{answer:"DOG",thematic:true,source:"model"}];
  const index=new CspCandidateIndex(records,normalizeCspAnswer11),state=emptyJointState();
  for(const [id,row] of [[0,0],[1,10]]) {
    const word=records[id].answer;
    for(let col=0;col<3;col++) {state.grid[row][col]=word[col];state.ownership[row][col]=1;}
    state.placed.push({candidateId:id,word,row,col:0,dir:"across"});
  }
  state.usedIds=new Set([0,1]);state.thematicCount=2;
  const terminal=validateJointTerminal(state,index,2,policies);
  assert.equal(terminal.derivationAgrees,true);assert.equal(terminal.reason,"disconnected");
});

test("thematic seed preference and general support coexist before target",()=>{
  const records:JointCandidate[]=[{answer:"CATS",thematic:true,source:"model"},{answer:"BAR",thematic:false,source:"filler"},{answer:"RAT",thematic:true,source:"model"}];
  const result=runJointCrosswordSearch11({...options,candidates:records,targetThematicEntries:2,maxNodes:4});
  assert.equal(result.termination,"node-limit");
  assert.ok(result.bestState.placed.length>=1);
  const first=result.bestState.placed[0].candidateId;
  assert.equal(records[first].thematic,true);
});

test("node and deadline limits remain bounded, not contradictions",()=>{
  assert.equal(runJointCrosswordSearch11({...options,candidates,maxNodes:0}).termination,"node-limit");
  assert.equal(runJointCrosswordSearch11({...options,candidates,cancelled:()=>true}).termination,"deadline");
  let calls=0;
  const stopped=runJointCrosswordSearch11({...options,candidates,cancelled:()=>++calls>60});
  assert.equal(stopped.termination,"deadline");
  assert.equal(runJointCrosswordSearch11({...options,candidates,targetThematicEntries:-1}).termination,"invalid-input");
});

test("safe thematic identity bound exhausts without accepting a below-target terminal",()=>{
  const result=runJointCrosswordSearch11({...options,candidates:candidates.map(c=>({...c,thematic:false})),targetThematicEntries:1});
  assert.equal(result.termination,"exhausted");assert.equal(result.metrics.thematicBoundPrunes,1);assert.equal(result.result,null);
});
