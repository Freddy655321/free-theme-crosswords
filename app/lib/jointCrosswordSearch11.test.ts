import assert from "node:assert/strict";
import test from "node:test";
import { CspCandidateIndex, CspDomainBudget, CspDomainDeadline } from "./cspCandidateDomains";
import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";
import { compareCspValuePriority } from "./crosswordCsp11";
import { runJointCrosswordSearch11,validateJointTerminal,selectJointOpportunity,compareJointQualityValues } from "./jointCrosswordSearch11";
import { DEFAULT_JOINT_QUALITY_POLICY, jointQualityIssue, summarizeJointQuality } from "./jointSearchQuality11";
import { commitJointPlacement,emptyJointState,type JointCandidate,type OpportunityDomain } from "./jointPlacementDomains11";
import { deriveEntriesFromGrid } from "./publishPipeline/deriveEntries";
import { runGridValidation } from "./gridValidation/validateGrid";
import * as validationModule from "./gridValidation/validateGrid";
import * as qualityModule from "./jointSearchQuality11";
import * as placementModule from "./jointPlacementDomains11";

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

function opportunityFixture() {
  const index=new CspCandidateIndex<JointCandidate>([
    {answer:"CAT",thematic:true,source:"model"},
    {answer:"CAR",thematic:false,source:"filler",score:90},
    {answer:"BAR",thematic:false,source:"filler",score:80},
  ],normalizeCspAnswer11);
  const make=(row:number,col:number,answers:string[],direction:"across"|"down"="down"):OpportunityDomain=>{
    const domain=index.domain(3).filter(c=>answers.includes(c.answer));
    return {opportunity:{row,col,direction},count:domain.length,
      alternatives:[{row,col,direction,length:3,crossingOffset:0,domain}]};
  };
  return {index,make,preference:{count:1,target:2,ids:[index.id("CAT")!]}};
}

test("below target thematic-capable opportunity beats smaller general-only MRV without changing domains",()=>{
  const {make,preference}=opportunityFixture();
  const general=make(0,0,["BAR"]),mixed=make(3,3,["CAT","CAR"]),domains=[general,mixed];
  const before=domains.map(d=>d.alternatives[0].domain.map(c=>c.answer));
  assert.equal(selectJointOpportunity(domains),general);
  assert.equal(selectJointOpportunity(domains,preference),mixed);
  assert.deepEqual(domains.map(d=>d.alternatives[0].domain.map(c=>c.answer)),before);
  assert.equal(mixed.count,2);
  assert.ok([...mixed.alternatives[0].domain].some(c=>!c.thematic));
});

test("thematic-capable class preserves mixed-domain MRV and row column direction ties",()=>{
  const {make,preference}=opportunityFixture();
  const larger=make(0,0,["CAT","CAR","BAR"]),smaller=make(8,8,["CAT","CAR"]);
  assert.equal(selectJointOpportunity([larger,smaller],preference),smaller);
  const row=make(1,8,["CAT","CAR"]),col=make(1,2,["CAT","CAR"]),across=make(1,2,["CAT","CAR"],"across");
  for(const domains of [[smaller,col,larger,across,row],[row,across,larger,col,smaller]]) {
    assert.equal(selectJointOpportunity(domains,preference),across);
  }
});

test("fallback and at-or-above-target selection preserve existing MRV",()=>{
  const {make,preference}=opportunityFixture();
  const general=make(0,0,["BAR"]),mixed=make(3,3,["CAT","CAR"]),empty=make(0,0,[]);
  for(const count of [2,3]) assert.equal(selectJointOpportunity([mixed,general],{...preference,count}),general);
  const noThematic=[make(2,2,["CAR","BAR"]),general,empty];
  assert.equal(selectJointOpportunity(noThematic,preference),selectJointOpportunity(noThematic));
  assert.equal(selectJointOpportunity([empty],preference),null);
});

test("thematic membership can occur in a later geometry alternative",()=>{
  const {make,preference}=opportunityFixture();
  const mixed=make(2,2,["CAR"]),later=make(3,2,["CAT"]);
  mixed.alternatives.push(...later.alternatives);mixed.count++;
  assert.equal(selectJointOpportunity([make(0,0,["BAR"]),mixed],preference),mixed);
});

test("thematic opportunity membership checks remain cooperatively cancellable",()=>{
  let cancelled=false;
  const budget=new CspDomainBudget(Infinity,()=>cancelled);
  const index=new CspCandidateIndex<JointCandidate>([{answer:"BAR",thematic:false,source:"filler"}],normalizeCspAnswer11,budget);
  const domain:OpportunityDomain={opportunity:{row:0,col:0,direction:"down"},count:1,
    alternatives:[{row:0,col:0,direction:"down",length:3,crossingOffset:0,domain:index.domain(3)}]};
  cancelled=true;
  assert.throws(()=>selectJointOpportunity([domain],{count:0,target:1,ids:Array(512).fill(100)}),CspDomainDeadline);
});

test("thematic opportunity preference retains closure backtracking and deterministic bounded search",()=>{
  const records:JointCandidate[]=["CATS","BAR","RAT","CAR","BAT","TAR","ART"].map((answer,i)=>
    ({answer,thematic:i%2===0,source:i%2===0?"model":"filler"}));
  const config={...options,candidates:records,targetThematicEntries:2,maxNodes:1000};
  const first=runJointCrosswordSearch11(config),second=runJointCrosswordSearch11(config);
  assert.equal(first.termination,"node-limit");
  assert.ok(first.metrics.backtracks>0&&first.metrics.closureBranches>0);
  assert.ok(first.metrics.generalPlacementsBeforeTarget>0);
  assert.deepEqual(first.metrics,second.metrics);
  assert.deepEqual(first.bestState,second.bestState);
});

test("failed terminal validation continues through legal expansions or backtracking",{timeout:10000},context=>{
  const validate=validationModule.runGridValidation;
  let calls=0;
  let rejectedGrid="";
  context.mock.method(validationModule,"runGridValidation",(input:Parameters<typeof validate>[0])=>{
    const actual=validate(input);
    if(calls===0) rejectedGrid=JSON.stringify(input.grid);
    return ++calls===1?{...actual,accepted:false,issue:"synthetic-extra-rejection"}:actual;
  });
  const report=runJointCrosswordSearch11({...options,candidates,targetThematicEntries:8,seed:fixtureSeed,maxNodes:25000,deadlineMs:6000});
  assert.equal(report.termination,"success");
  assert.equal(report.metrics.terminalRejections["synthetic-extra-rejection"],1);
  assert.ok(report.metrics.terminalStatesTested>=2);
  assert.ok(report.result!.entries.length>=15);
  assert.notEqual(JSON.stringify(report.result!.grid),rejectedGrid);
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

const qualityPolicy=DEFAULT_JOINT_QUALITY_POLICY;
const qualityCandidates=(scores:(number|undefined)[],thematic=9):JointCandidate[]=>[
  ...Array.from({length:thematic},(_,i)=>({answer:`THEME${i}`,thematic:true,source:"model" as const})),
  ...scores.map((score,i)=>({answer:`GENERAL${i}`,thematic:false,source:"filler" as const,score})),
];
const issueFor=(scores:(number|undefined)[],thematic=9,terminal=true)=>
  jointQualityIssue(summarizeJointQuality(qualityCandidates(scores,thematic)),qualityPolicy,terminal);

test("quality checks the actual denominator and accepts only a strict thematic majority",()=>{
  assert.equal(issueFor(Array(8).fill(80)),null); // 9/17
  assert.equal(issueFor(Array(9).fill(80)),"thematic-majority"); // 9/18
  assert.equal(issueFor(Array(10).fill(80)),"thematic-majority"); // 9/19
  assert.equal(issueFor([],1),null); // No general fill: aggregates are not invented.
  assert.equal(issueFor([],0),"thematic-majority");
});

test("fill floor and low-score count cannot be concealed by a high average",()=>{
  assert.equal(issueFor([19,100,100,100]),"general-score-floor");
  assert.equal(issueFor([20,49,49,100,100,100,100]),"general-low-score-limit");
  assert.equal(issueFor([20,49,90,90]),null);
  assert.equal(issueFor([50,50,60,60]),null); // Median 55, mean 55, zero below 50.
  for(const score of [undefined,NaN,Infinity,-1,101]) {
    assert.equal(issueFor([score,90]),"general-score-missing-or-invalid");
  }
});

test("median and mean are independent terminal gates; repairable partial states survive",()=>{
  assert.equal(issueFor([40,40,50],4),"general-score-median");
  assert.equal(issueFor([20,50,50,50],5),"general-score-mean");
  assert.equal(issueFor([20,50,50,50],1,false),null);
  assert.equal(issueFor([40,40,50],1,false),null);
  assert.equal(issueFor([19],9,false),"general-score-floor");
  assert.equal(issueFor([20,30,40],9,false),"general-low-score-limit");
});

test("quality ordering preserves thematic priority, ranks general scores and has stable seeded ties",()=>{
  const thematic:JointCandidate={answer:"THEME",thematic:true,source:"model"};
  const low:JointCandidate={answer:"LOW",thematic:false,source:"filler",score:20};
  const high:JointCandidate={answer:"HIGH",thematic:false,source:"filler",score:90};
  assert.ok(compareJointQualityValues(thematic,high,1)<0);
  assert.ok(compareJointQualityValues(high,low,1)<0);
  assert.ok(compareJointQualityValues(low,{...high,score:undefined},1)<0);
  const tied={...low,score:90};
  assert.equal(compareJointQualityValues(high,tied,13),compareCspValuePriority(
    {candidate:high,remainingOptions:0},{candidate:tied,remainingOptions:0},13));
});

test("authoritative terminal composition applies quality independently of structural acceptance",()=>{
  const check=(scores:(number|undefined)[])=>{
    let general=0;
    const scored=candidates.map(candidate=>({...candidate,score:candidate.thematic?undefined:scores[general++]}));
    const index=new CspCandidateIndex(scored,normalizeCspAnswer11);
    let state=emptyJointState();
    const ordered=[fixtureEntries[0],...fixtureEntries.filter(e=>e.direction==="down"),...fixtureEntries.filter(e=>e.direction==="across").slice(1)];
    for(const entry of ordered) {
      const child=commitJointPlacement(state,index,index.id(entry.answer)!,entry,policies);
      assert.ok(child);state=child;
    }
    const terminal=validateJointTerminal(state,index,8,policies,qualityPolicy);
    assert.equal(terminal.validation.accepted,true);
    assert.equal(terminal.derivationAgrees,true);
    return terminal;
  };
  const accepted=check(Array(6).fill(80));
  assert.equal(accepted.accepted,true);
  assert.equal(accepted.quality.generalEntries,6);
  assert.equal(accepted.quality.mean,80);
  assert.equal(check([19,100,100,100,100,100]).reason,"general-score-floor");
  assert.equal(check([20,30,40,100,100,100]).reason,"general-low-score-limit");
  assert.equal(check([20,50,50,50,50,50]).reason,"general-score-mean");
  assert.equal(check([undefined,80,80,80,80,80]).reason,"general-score-missing-or-invalid");
});

test("quality search passes unchanged structural validation with interleaved scored fill",{timeout:10000},()=>{
  const scored=candidates.map(candidate=>({...candidate,score:candidate.thematic?undefined:80}));
  const report=runJointCrosswordSearch11({...options,candidates:scored,targetThematicEntries:8,
    maxNodes:25000,deadlineMs:6000,seed:fixtureSeed,qualityPolicy});
  assert.equal(report.termination,"success");
  assert.ok(report.result?.accepted && report.result.validation.accepted);
  assert.ok(report.result.thematicCount*2>report.result.entries.length);
  assert.equal(report.result.quality.mean,80);
  assert.ok(report.metrics.generalPlacementsBeforeTarget>0);
  assert.equal(report.indexSize,candidates.length);
});

test("quality policy rejects invalid configuration and retains distinct bounded outcomes",()=>{
  for(const policy of [{...qualityPolicy,maximumLowScoreEntries:-1},{...qualityPolicy,minimumGeneralMean:NaN},
    {...qualityPolicy,minimumGeneralScore:101},{...qualityPolicy,maximumLowScoreEntries:0.5}]) {
    assert.equal(runJointCrosswordSearch11({...options,candidates,qualityPolicy:policy}).termination,"invalid-input");
  }
  assert.equal(runJointCrosswordSearch11({...options,candidates,qualityPolicy,maxNodes:0}).termination,"node-limit");
  assert.equal(runJointCrosswordSearch11({...options,candidates,qualityPolicy,cancelled:()=>true}).termination,"deadline");
  const records:JointCandidate[]=[{answer:"CATS",thematic:true,source:"model"},
    {answer:"BAR",thematic:false,source:"filler",score:19}];
  const result=runJointCrosswordSearch11({...options,candidates:records,qualityPolicy,maxNodes:1000});
  assert.ok(result.metrics.qualityPrunes["general-score-floor"]>0);
  assert.equal(result.result,null);
});

test("without quality policy scores do not change Ticket 81 assignments or search order",()=>{
  const config={...options,targetThematicEntries:8,maxNodes:25000,deadlineMs:6000,seed:fixtureSeed};
  const original=runJointCrosswordSearch11({...config,candidates});
  const scored=candidates.map((candidate,i)=>({...candidate,score:i%2?0:100}));
  const control=runJointCrosswordSearch11({...config,candidates:scored});
  assert.equal(original.termination,"success");
  assert.equal(control.termination,original.termination);
  assert.deepEqual(control.result?.entries,original.result?.entries);
  assert.deepEqual(control.metrics,original.metrics);
});

test("quality rejection of a terminal continues search, with policy active on later terminals",context=>{
  const check=qualityModule.jointQualityIssue;
  let terminals=0;
  // Isolate search continuation; the real majority/aggregate calculations are tested above.
  context.mock.method(qualityModule,"jointQualityIssue",(...args:Parameters<typeof check>)=>{
    if(args[2] && ++terminals===1) return "thematic-majority";
    return check(...args);
  });
  const scored=candidates.map(candidate=>({...candidate,score:80}));
  const config={...options,candidates:scored,targetThematicEntries:8,maxNodes:25000,
    deadlineMs:6000,seed:fixtureSeed,qualityPolicy};
  const report=runJointCrosswordSearch11(config);
  assert.equal(report.termination,"success");
  assert.equal(report.metrics.terminalRejections["thematic-majority"],1);
  assert.ok(terminals>=2);
  assert.ok(report.result?.accepted && report.result.validation.accepted);
  assert.equal(check(report.result.quality,qualityPolicy,true),null);
});

test("quality keeps low and missing scores in lexical support and prunes only after commitment",context=>{
  const propagate=placementModule.propagateJointDomains;
  const observed=new Set<string>();
  context.mock.method(placementModule,"propagateJointDomains",(...args:Parameters<typeof propagate>)=>{
    const result=propagate(...args);
    for(const domain of result.domains) for(const alternative of domain.alternatives) {
      for(const candidate of alternative.domain) observed.add(candidate.answer);
    }
    return result;
  });
  const records:JointCandidate[]=[{answer:"CATS",thematic:true,source:"model"},
    {answer:"BAR",thematic:false,source:"filler",score:19},
    {answer:"RAT",thematic:false,source:"filler"}];
  const report=runJointCrosswordSearch11({...options,candidates:records,qualityPolicy,maxNodes:1000});
  assert.equal(report.indexSize,records.length);
  assert.ok(observed.has("BAR") && observed.has("RAT"));
  assert.ok(report.metrics.qualityPrunes["general-score-floor"]>0);
  assert.ok(report.metrics.qualityPrunes["general-score-missing-or-invalid"]>0);
});

test("quality search is deterministic and cancellation during active search remains bounded",()=>{
  const scored=candidates.map(candidate=>({...candidate,score:80}));
  const config={...options,candidates:scored,targetThematicEntries:8,maxNodes:25000,
    deadlineMs:6000,seed:fixtureSeed,qualityPolicy};
  const first=runJointCrosswordSearch11(config),second=runJointCrosswordSearch11(config);
  assert.equal(first.termination,"success");
  assert.deepEqual(first.result?.entries,second.result?.entries);
  assert.deepEqual(first.metrics,second.metrics);
  let checks=0;
  const cancelled=runJointCrosswordSearch11({...config,cancelled:()=>++checks>60});
  assert.equal(cancelled.termination,"deadline");
  assert.ok(cancelled.metrics.nodes>0);
  assert.equal(cancelled.result,null);
});
