import type { DerivedEntry } from "./crosswordTypes";
import { CspCandidateIndex, CspDomainBudget, CspDomainDeadline } from "./cspCandidateDomains";
import { normalizeCspAnswer11 } from "./crosswordCspAdapter11";
import { compareCspValuePriority } from "./crosswordCsp11";
import { deriveEntriesFromGrid } from "./publishPipeline/deriveEntries";
import { runGridValidation, minPublishEntriesForSize } from "./gridValidation/validateGrid";
import type { GridValidationPolicies } from "./gridValidation/gridValidationTypes";
import type { PlaceWordPolicies } from "./gridConstruction/gridConstructionTypes";
import { jointQualityIssue, summarizeJointQuality, validGeneralScore, validJointQualityPolicy,
  type JointQualityPolicy } from "./jointSearchQuality11";
import {
  closeCrossingOpportunity, commitJointPlacement, emptyJointState, newPlacementDomainMetrics,
  propagateJointDomains, type JointCandidate, type JointState, type OpportunityDomain,
} from "./jointPlacementDomains11";

export type JointPolicies = GridValidationPolicies & PlaceWordPolicies;
export type JointSearchOptions = {
  candidates: readonly JointCandidate[];
  targetThematicEntries: number;
  maxNodes: number;
  deadlineMs: number;
  seed: number;
  policies: JointPolicies;
  /** Opt-in keeps the Ticket 81 feasibility API available for controls. */
  qualityPolicy?: Readonly<JointQualityPolicy>;
  cancelled?: () => boolean;
};

function connectedLetters(grid: string[][]): boolean {
  const cells: number[]=[];
  for(let r=0;r<11;r++) for(let c=0;c<11;c++) if(grid[r][c]!=="#") cells.push(r*11+c);
  if(!cells.length) return false;
  const seen=new Set([cells[0]]), queue=[cells[0]];
  for(let i=0;i<queue.length;i++) {
    const r=Math.floor(queue[i]/11), c=queue[i]%11;
    for(const [nr,nc] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]) {
      const id=nr*11+nc;
      if(nr<0||nr>=11||nc<0||nc>=11||grid[nr][nc]==="#"||seen.has(id)) continue;
      seen.add(id);queue.push(id);
    }
  }
  return seen.size===cells.length;
}

/** A painted copy is a candidate terminal, never a topology planning stage. */
export function validateJointTerminal(
  state: JointState,index:CspCandidateIndex<JointCandidate>,target:number,policies:JointPolicies,
  qualityPolicy?: Readonly<JointQualityPolicy>,
) {
  index.budget.check();
  const grid=state.grid.map(row=>row.map(cell=>cell||"#"));
  const entries=deriveEntriesFromGrid(grid);
  const key=(row:number,col:number,direction:string)=>`${row}:${col}:${direction}`;
  const placements=new Map(state.placed.map(p=>[key(p.row,p.col,p.dir),p]));
  const identities=new Set<number>(),answers=new Set<string>();
  let agrees=entries.length===state.placed.length&&placements.size===state.placed.length;
  const composition: {entry:DerivedEntry;candidate:Readonly<JointCandidate>}[]=[];
  for(const entry of entries) {
    index.budget.step();
    const placed=placements.get(key(entry.row,entry.col,entry.direction));
    if(!placed || placed.word!==entry.answer || placed.candidateId<0 || placed.candidateId>=index.size) {agrees=false;continue;}
    const candidate=index.candidate(placed.candidateId);
    if(candidate.answer!==entry.answer||identities.has(placed.candidateId)||answers.has(entry.answer)||!state.usedIds.has(placed.candidateId)) agrees=false;
    identities.add(placed.candidateId);answers.add(entry.answer);
    composition.push({entry,candidate});
  }
  const thematicCount=composition.filter(item=>item.candidate.thematic).length;
  agrees=agrees&&identities.size===state.usedIds.size&&thematicCount===state.thematicCount;
  const connected=connectedLetters(grid);
  const validation=runGridValidation({grid,derived:entries,policies});
  const quality=summarizeJointQuality(composition.map(item=>item.candidate),qualityPolicy?.lowScoreThreshold);
  const reason=!agrees?"derivation-mismatch":!connected?"disconnected":thematicCount<target?"thematic-target":
    validation.issue ?? (qualityPolicy ? jointQualityIssue(quality,qualityPolicy,true) : null);
  index.budget.check();
  return {accepted:reason===null,reason,grid,entries,composition,thematicCount,connected,derivationAgrees:agrees,validation,quality};
}

export function compareJointQualityValues(a:Readonly<JointCandidate>,b:Readonly<JointCandidate>,seed:number):number {
  if(a.thematic!==b.thematic) return a.thematic?-1:1;
  if(!a.thematic) {
    const scoreA=validGeneralScore(a.score)?a.score:-1,scoreB=validGeneralScore(b.score)?b.score:-1;
    if(scoreA!==scoreB) return scoreB-scoreA;
  }
  return compareCspValuePriority({candidate:a,remainingOptions:0},{candidate:b,remainingOptions:0},seed);
}

export function selectJointOpportunity(domains:OpportunityDomain[]):OpportunityDomain|null {
  // An empty optional domain is not a mandatory wipeout. It need not be closed now.
  let best:OpportunityDomain|null=null;
  for(const domain of domains) {
    if(!domain.count) continue;
    const a=domain.opportunity,b=best?.opportunity;
    if(!best||domain.count<best.count||(domain.count===best.count&&b&&
      (a.row<b.row||(a.row===b.row&&(a.col<b.col||(a.col===b.col&&a.direction.localeCompare(b.direction)<0)))))) best=domain;
  }
  return best;
}

class JointNodeLimit extends Error {}

/** One bounded tree; thematic and general answers share every dynamic domain. */
export function runJointCrosswordSearch11(opts:JointSearchOptions) {
  const started=Date.now();
  let deadlineAt=Infinity;
  const budget=new CspDomainBudget(Infinity,()=>Boolean(opts.cancelled?.())||Date.now()>deadlineAt);
  const metrics={nodes:0,backtracks:0,deepestPlacedEntries:0,alternativesConsidered:0,
    propagationCalls:0,mandatoryDomainWipeouts:0,transitionRejections:0,closureBranches:0,
    thematicBoundPrunes:0,terminalStatesTested:0,terminalRejections:{} as Record<string,number>,
    qualityPrunes:{} as Record<string,number>,
    generalPlacementsBeforeTarget:0,domains:newPlacementDomainMetrics()};
  let index:CspCandidateIndex<JointCandidate>|null=null;
  let bestState=emptyJointState();
  let result:ReturnType<typeof validateJointTerminal>|null=null;
  let indexMs=0,searchStarted=Date.now();
  let termination:"success"|"exhausted"|"deadline"|"node-limit"|"invalid-input"="exhausted";
  const finish=()=>({termination,result,bestState,metrics,indexConstructionMs:indexMs,
    engineElapsedMs:Date.now()-searchStarted,totalElapsedMs:Date.now()-started,indexSize:index?.size??0});
  if(!Number.isInteger(opts.targetThematicEntries)||opts.targetThematicEntries<0||
    !Number.isInteger(opts.maxNodes)||opts.maxNodes<0||!Number.isFinite(opts.deadlineMs)||opts.deadlineMs<0||
    (opts.qualityPolicy && !validJointQualityPolicy(opts.qualityPolicy))) {
    termination="invalid-input";return finish();
  }
  try {
    index=new CspCandidateIndex(opts.candidates,normalizeCspAnswer11,budget);
    indexMs=Date.now()-started;
    searchStarted=Date.now();deadlineAt=searchStarted+opts.deadlineMs;
    const source=index;
    let thematicAvailable=0;
    const thematicIds:number[]=[],generalIds:number[]=[];
    for(let id=0;id<source.size;id++) {
      budget.step();const candidate=source.candidate(id);
      if(candidate.answer.length<3||candidate.answer.length>11||opts.policies.isForbiddenPublishAnswer(candidate.answer)) continue;
      if(candidate.thematic) {thematicAvailable++;thematicIds.push(id);} else generalIds.push(id);
    }
    const compareIds=(a:number,b:number)=>{
      budget.step();
      if(opts.qualityPolicy) return compareJointQualityValues(source.candidate(a),source.candidate(b),opts.seed);
      return compareCspValuePriority({candidate:source.candidate(a),remainingOptions:0},
        {candidate:source.candidate(b),remainingOptions:0},opts.seed);
    };
    const enter=(state:JointState)=>{
      budget.check();
      if(metrics.nodes>=opts.maxNodes) throw new JointNodeLimit();
      metrics.nodes++;
      if(state.placed.length>metrics.deepestPlacedEntries) {metrics.deepestPlacedEntries=state.placed.length;bestState=state;}
    };
    const search=(state:JointState):boolean=>{
      enter(state);
      if(opts.qualityPolicy) {
        const quality=summarizeJointQuality(state.placed.map(p=>source.candidate(p.candidateId)),opts.qualityPolicy.lowScoreThreshold);
        const issue=jointQualityIssue(quality,opts.qualityPolicy,false);
        if(issue) {metrics.qualityPrunes[issue]=(metrics.qualityPrunes[issue]??0)+1;return false;}
      }
      // This deliberately optimistic bound never assumes unseen future opportunities are absent.
      const unusedThematic=thematicAvailable-state.thematicCount;
      if(state.thematicCount+unusedThematic<opts.targetThematicEntries) {metrics.thematicBoundPrunes++;return false;}
      if(state.placed.length>=minPublishEntriesForSize(11)&&state.thematicCount>=opts.targetThematicEntries) {
        metrics.terminalStatesTested++;
        const terminal=validateJointTerminal(state,source,opts.targetThematicEntries,opts.policies,opts.qualityPolicy);
        if(terminal.accepted) {result=terminal;return true;}
        const reason=terminal.reason??"unknown";
        metrics.terminalRejections[reason]=(metrics.terminalRejections[reason]??0)+1;
      }
      metrics.propagationCalls++;
      const propagated=propagateJointDomains(state,source,opts.policies,metrics.domains);
      if(propagated.contradiction) {metrics.mandatoryDomainWipeouts++;return false;}
      const selected=selectJointOpportunity(propagated.domains);
      if(!selected) return false;
      const values:{id:number;row:number;col:number;direction:"across"|"down"}[]=[];
      for(const alternative of selected.alternatives) for(const candidate of alternative.domain) {
        budget.step();values.push({id:source.id(candidate.answer)!,row:alternative.row,col:alternative.col,direction:alternative.direction});
      }
      values.sort((a,b)=>compareIds(a.id,b.id)||a.row-b.row||a.col-b.col||a.direction.localeCompare(b.direction));
      for(const value of values) {
        budget.check();metrics.alternativesConsidered++;
        const child=commitJointPlacement(state,source,value.id,value,opts.policies);
        if(!child) {metrics.transitionRejections++;continue;}
        if(!source.candidate(value.id).thematic&&state.thematicCount<opts.targetThematicEntries) metrics.generalPlacementsBeforeTarget++;
        if(search(child)) return true;
        metrics.backtracks++;
      }
      const closed=closeCrossingOpportunity(state,selected.opportunity);
      if(closed) {
        metrics.closureBranches++;
        if(search(closed)) return true;
        metrics.backtracks++;
      }
      return false;
    };
    enter(bestState);
    if(thematicAvailable<opts.targetThematicEntries) {metrics.thematicBoundPrunes++;return finish();}
    // Lazy second class: do not sort the entire general lexicon before trying thematic seeds.
    for(const ids of [thematicIds,generalIds]) {
      ids.sort(compareIds);
      for(const id of ids) {
        const length=source.candidate(id).answer.length;
        for(let row=0;row<11;row++) for(let col=0;col<11;col++) for(const direction of ["across","down"] as const) {
          budget.check();
          if((direction==="across"?col:row)+length>11) continue;
          metrics.alternativesConsidered++;
          const child=commitJointPlacement(emptyJointState(),source,id,{row,col,direction},opts.policies);
          if(!child) {metrics.transitionRejections++;continue;}
          if(search(child)) {termination="success";return finish();}
          metrics.backtracks++;
        }
      }
    }
  } catch(error) {
    if(error instanceof CspDomainDeadline) termination="deadline";
    else if(error instanceof JointNodeLimit) termination="node-limit";
    else throw error;
  }
  return finish();
}
