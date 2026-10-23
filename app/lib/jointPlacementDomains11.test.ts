import assert from "node:assert/strict";
import test from "node:test";
import { CspCandidateIndex,CspDomainBudget,CspDomainDeadline } from "./cspCandidateDomains";
import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";
import { closeCrossingOpportunity,commitJointPlacement,emptyJointState,enumeratePlacementDomains,
  propagateJointDomains,newPlacementDomainMetrics,crossingOpportunities,type JointCandidate,type CrossingOpportunity } from "./jointPlacementDomains11";

const policies={isForbiddenPublishAnswer:()=>false};
const records:JointCandidate[]=["CATS","RAT","BAR","ART","STAR","CAR","CART","TAR","SAT"].map(answer=>({answer,thematic:answer==="CATS",source:"model"}));
const makeIndex=(budget?:CspDomainBudget)=>new CspCandidateIndex(records,normalizeCspAnswer11,budget);
const seed=(index=makeIndex())=>commitJointPlacement(emptyJointState(),index,index.id("CATS")!,{row:5,col:3,direction:"across"},policies)!;
const flatten=(domains:ReturnType<typeof enumeratePlacementDomains>)=>domains.flatMap(d=>d.domain.map(c=>`${d.row}:${d.col}:${d.direction}:${c.answer}`)).sort();

test("indexed placement domains match exhaustive naive legal commits across all opportunities",()=>{
  const index=makeIndex(),state=seed(index);
  const snapshot=JSON.stringify(state);
  for(const opportunity of crossingOpportunities(state)) {
    const expected:string[]=[];
    for(let id=0;id<index.size;id++) {
      const answer=index.candidate(id).answer;
      for(let offset=0;offset<answer.length;offset++) {
        if(answer[offset]!==state.grid[opportunity.row][opportunity.col]) continue;
        const geometry={row:opportunity.row-(opportunity.direction==="down"?offset:0),col:opportunity.col-(opportunity.direction==="across"?offset:0),direction:opportunity.direction};
        if(commitJointPlacement(state,index,id,geometry,policies)) expected.push(`${geometry.row}:${geometry.col}:${geometry.direction}:${answer}`);
      }
    }
    assert.deepEqual(flatten(enumeratePlacementDomains(state,opportunity,index,policies)),expected.sort());
  }
  assert.equal(JSON.stringify(state),snapshot);
});

test("one opportunity supports multiple starts and lengths with exact letter offsets",()=>{
  const index=makeIndex(),state=seed(index),opportunity:CrossingOpportunity={row:5,col:4,direction:"down"};
  const first=enumeratePlacementDomains(state,opportunity,index,policies);
  assert.ok(new Set(first.map(d=>d.row)).size>1);
  assert.ok(new Set(first.map(d=>d.length)).size>1);
  for(const d of first) for(const c of d.domain) assert.equal(c.answer[d.crossingOffset],"A");
  assert.deepEqual(flatten(first),flatten(enumeratePlacementDomains(state,opportunity,index,policies)));
});

test("known letters, blocks, same-direction ownership and exact endpoints filter geometry",()=>{
  const index=makeIndex(),state=seed(index);
  assert.equal(enumeratePlacementDomains(state,{row:5,col:4,direction:"across"},index,policies).length,0);
  const child=commitJointPlacement(state,index,index.id("RAT")!,{row:4,col:4,direction:"down"},policies)!;
  assert.ok(child);assert.equal(child.grid[3][4],"#");assert.equal(child.grid[7][4],"#");
  assert.equal(state.grid[3][4],"");
  assert.equal(child.ownership[5][4],3);
  assert.equal(commitJointPlacement(child,index,index.id("RAT")!,{row:4,col:4,direction:"down"},policies),null);
  assert.equal(commitJointPlacement(state,index,index.id("BAR")!,{row:4,col:3,direction:"down"},policies),null);
  assert.equal(commitJointPlacement(state,index,index.id("RAT")!,{row:-1,col:4,direction:"down"},policies),null);
  assert.equal(commitJointPlacement(state,index,index.id("RAT")!,{row:1,col:1,direction:"across"},policies),null);
  assert.equal(commitJointPlacement(state,index,index.id("CART")!,{row:5,col:3,direction:"across"},policies),null);
  const constrained={...state,grid:state.grid.map(row=>row.slice())};constrained.grid[4][4]="Z";constrained.grid[6][4]="#";
  assert.equal(enumeratePlacementDomains(constrained,{row:5,col:4,direction:"down"},index,policies).length,0);
});

test("used IDs and forbidden answers are excluded without losing thematic provenance",()=>{
  const index=makeIndex(),state=seed(index);
  const used={...state,usedIds:new Set([...state.usedIds,index.id("RAT")!])};
  const domains=enumeratePlacementDomains(used,{row:5,col:4,direction:"down"},index,{isForbiddenPublishAnswer:a=>a==="BAR"});
  const values=domains.flatMap(d=>d.domain.map(c=>c.answer));
  assert.ok(!values.includes("RAT")&&!values.includes("BAR")&&!values.includes("CATS"));
  assert.equal(index.candidate(index.id("CATS")!).thematic,true);
});

test("optional empty opportunity is not contradiction while another crossing can satisfy entry",()=>{
  const index=new CspCandidateIndex<JointCandidate>([records[0],records[1]],normalizeCspAnswer11);
  const state=seed(index);
  const result=propagateJointDomains(state,index,policies,newPlacementDomainMetrics());
  assert.ok(result.domains.some(d=>!d.count));assert.ok(result.domains.some(d=>d.count));
  assert.equal(result.contradiction,false);
  const alone=new CspCandidateIndex([records[0]],normalizeCspAnswer11);
  assert.equal(propagateJointDomains(seed(alone),alone,policies,newPlacementDomainMetrics()).contradiction,true);
});

test("leave uncrossed reserves both sides immutably and cannot damage neighboring geometry",()=>{
  const index=makeIndex(),state=seed(index),snapshot=JSON.stringify(state);
  const closed=closeCrossingOpportunity(state,{row:5,col:4,direction:"down"})!;
  assert.ok(closed);assert.equal(closed.grid[4][4],"#");assert.equal(closed.grid[6][4],"#");
  assert.equal(closed.grid[5][4],"A");assert.equal(JSON.stringify(state),snapshot);
  assert.equal(enumeratePlacementDomains(closed,{row:5,col:4,direction:"down"},index,policies).length,0);
  assert.equal(closeCrossingOpportunity(closed,{row:5,col:4,direction:"down"}),null);
  const occupied={...state,grid:state.grid.map(row=>row.slice())};occupied.grid[4][4]="R";
  assert.equal(closeCrossingOpportunity(occupied,{row:5,col:4,direction:"down"}),null);
  const crossed=commitJointPlacement(state,index,index.id("RAT")!,{row:4,col:4,direction:"down"},policies)!;
  assert.equal(closeCrossingOpportunity(crossed,{row:5,col:4,direction:"down"}),null);
});

test("side-touch and occupied endpoints retain unchanged generic placement legality",()=>{
  const index=makeIndex(),state=seed(index);
  assert.equal(commitJointPlacement(state,index,index.id("RAT")!,{row:4,col:3,direction:"across"},policies),null);
  assert.equal(commitJointPlacement(state,index,index.id("RAT")!,{row:5,col:7,direction:"across"},policies),null);
});

test("cancellation during enumeration throws deadline rather than an empty domain",()=>{
  let checks=0,stop=Infinity;
  const budget=new CspDomainBudget(Infinity,()=>++checks>=stop),index=makeIndex(budget),state=seed(index);
  stop=checks+4;
  assert.throws(()=>enumeratePlacementDomains(state,{row:5,col:4,direction:"down"},index,policies),CspDomainDeadline);
});
