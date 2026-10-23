import type { Cell, Direction, Placement, WordCandidate } from "./crosswordTypes";
import { CspCandidateDomain, CspCandidateIndex } from "./cspCandidateDomains";
import { canPlaceWord, makeEmptyWorkingGrid, placeWordWithPolicies } from "./gridConstruction/gridConstruction";
import type { PlaceWordPolicies } from "./gridConstruction/gridConstructionTypes";

export type JointCandidate = WordCandidate & { score?: number };
export type JointPlaced = Placement & { candidateId: number };
export type JointState = {
  grid: Cell[][];
  /** Across=1, Down=2. Both=3 is a genuine checked cell. */
  ownership: number[][];
  placed: JointPlaced[];
  usedIds: ReadonlySet<number>;
  thematicCount: number;
};
export type CrossingOpportunity = { row: number; col: number; direction: Direction };
export type PlacementDomain = CrossingOpportunity & {
  length: number;
  crossingOffset: number;
  domain: CspCandidateDomain<JointCandidate>;
};
export type PlacementDomainMetrics = {
  enumerations: number;
  geometriesConsidered: number;
  geometryRejected: number;
  lexicalRejected: number;
  duplicateRejected: number;
};
export const newPlacementDomainMetrics = (): PlacementDomainMetrics => ({
  enumerations: 0, geometriesConsidered: 0, geometryRejected: 0, lexicalRejected: 0, duplicateRejected: 0,
});
export const directionBit = (direction: Direction) => direction === "across" ? 1 : 2;
export const opportunityKey = (o: CrossingOpportunity) => `${o.row}:${o.col}:${o.direction}`;
const inside = (r: number, c: number) => r >= 0 && r < 11 && c >= 0 && c < 11;
export function placementCell(p: Placement, offset: number) {
  return { row: p.row + (p.dir === "down" ? offset : 0), col: p.col + (p.dir === "across" ? offset : 0) };
}
export function emptyJointState(): JointState {
  return { grid: makeEmptyWorkingGrid(11), ownership: Array.from({length:11},()=>Array<number>(11).fill(0)),
    placed: [], usedIds: new Set(), thematicCount: 0 };
}

export function crossingOpportunities(state: JointState): CrossingOpportunity[] {
  const result: CrossingOpportunity[] = [];
  for (let row=0;row<11;row++) for (let col=0;col<11;col++) {
    const owner=state.ownership[row][col];
    if (owner===1 || owner===2) result.push({row,col,direction:owner===1?"down":"across"});
  }
  return result;
}

/** Actual answer plus geometry. No parent writes, including rejected transitions. */
export function commitJointPlacement(
  state: JointState, index: CspCandidateIndex<JointCandidate>, candidateId: number,
  geometry: CrossingOpportunity, policies: PlaceWordPolicies,
): JointState | null {
  index.budget.check();
  if (!Number.isInteger(candidateId) || candidateId<0 || candidateId>=index.size || state.usedIds.has(candidateId)) return null;
  const candidate=index.candidate(candidateId);
  if (candidate.answer.length<3 || candidate.answer.length>11) return null;
  const p: JointPlaced={candidateId,word:candidate.answer,row:geometry.row,col:geometry.col,dir:geometry.direction};
  const bit=directionBit(p.dir);
  let crossings=0;
  for(let i=0;i<p.word.length;i++) {
    const {row,col}=placementCell(p,i);
    if(!inside(row,col) || (state.ownership[row][col]&bit)!==0) return null;
    if(state.ownership[row][col]!==0) crossings++;
  }
  if(state.placed.length && !crossings) return null;
  const grid=state.grid.map(row=>row.slice());
  if(!placeWordWithPolicies(grid,p.word,p.row,p.col,p.dir,policies)) return null;
  const ownership=state.ownership.map(row=>row.slice());
  for(let i=0;i<p.word.length;i++) {
    const {row,col}=placementCell(p,i); ownership[row][col]|=bit;
  }
  for(const offset of [-1,p.word.length]) {
    const {row,col}=placementCell(p,offset);
    if(inside(row,col)) grid[row][col]="#";
  }
  return {grid,ownership,placed:[...state.placed,p],usedIds:new Set(state.usedIds).add(candidateId),
    thematicCount:state.thematicCount+Number(candidate.thematic)};
}

/** Close only the unused perpendicular direction, by reserving both adjacent cells. */
export function closeCrossingOpportunity(state: JointState, opportunity: CrossingOpportunity): JointState | null {
  const {row,col,direction}=opportunity;
  if(!inside(row,col)) return null;
  const owner=state.ownership[row][col];
  if(!owner || (owner&directionBit(direction))) return null;
  const adjacent=[-1,1].map(offset=>({row:row+(direction==="down"?offset:0),col:col+(direction==="across"?offset:0)}));
  if(adjacent.some(cell=>inside(cell.row,cell.col)&&state.grid[cell.row][cell.col]!==""&&state.grid[cell.row][cell.col]!=="#")) return null;
  if(adjacent.every(cell=>!inside(cell.row,cell.col)||state.grid[cell.row][cell.col]==="#")) return null;
  const grid=state.grid.map(r=>r.slice());
  for(const cell of adjacent) if(inside(cell.row,cell.col)) grid[cell.row][cell.col]="#";
  return {...state,grid};
}

/** Enumerate exact legal placements, not hypothetical empty slots. */
export function enumeratePlacementDomains(
  state: JointState, opportunity: CrossingOpportunity, index: CspCandidateIndex<JointCandidate>,
  policies: PlaceWordPolicies, metrics=newPlacementDomainMetrics(),
): PlacementDomain[] {
  index.budget.check(); metrics.enumerations++;
  const {row,col,direction}=opportunity;
  if(!inside(row,col) || !state.ownership[row][col] || (state.ownership[row][col]&directionBit(direction))) return [];
  const answerDomains: PlacementDomain[]=[];
  for(let length=3;length<=11;length++) for(let offset=0;offset<length;offset++) {
    index.budget.step();
    const startRow=row-(direction==="down"?offset:0), startCol=col-(direction==="across"?offset:0);
    const endRow=startRow+(direction==="down"?length-1:0), endCol=startCol+(direction==="across"?length-1:0);
    if(!inside(startRow,startCol)||!inside(endRow,endCol)) continue;
    metrics.geometriesConsidered++;
    const known: {position:number;letter:string}[]=[];
    const dummy: string[]=[];
    let conflict=false;
    for(let i=0;i<length;i++) {
      const r=startRow+(direction==="down"?i:0), c=startCol+(direction==="across"?i:0);
      const cell=state.grid[r][c];
      if(cell==="#" || (state.ownership[r][c]&directionBit(direction))) {conflict=true;break;}
      dummy.push(cell||"A");
      if(cell) known.push({position:i,letter:cell});
    }
    if(conflict || !canPlaceWord(state.grid,dummy.join(""),startRow,startCol,direction).ok) {metrics.geometryRejected++;continue;}
    // Start with a posting, not a scan of the complete length domain.
    const posting=index.posting(length,offset,state.grid[row][col]);
    let domain=new CspCandidateDomain(index,length,posting);
    const before=domain.length;
    for(const constraint of known) domain=domain.matching(constraint.position,constraint.letter);
    domain=domain.filter(candidate=>{
      const id=index.id(candidate.answer)!;
      if(state.usedIds.has(id)) {metrics.duplicateRejected++;return false;}
      return !policies.isForbiddenPublishAnswer(candidate.answer);
    });
    metrics.lexicalRejected+=before-domain.length;
    if(domain.length) answerDomains.push({row:startRow,col:startCol,direction,length,crossingOffset:offset,domain});
  }
  index.budget.check();
  return answerDomains.sort((a,b)=>a.row-b.row||a.col-b.col||a.length-b.length);
}

export type OpportunityDomain = { opportunity: CrossingOpportunity; alternatives: PlacementDomain[]; count: number };
/** Empty optional domains are retained as facts, never independently declared contradictions. */
export function propagateJointDomains(
  state: JointState,index: CspCandidateIndex<JointCandidate>,policies:PlaceWordPolicies,metrics:PlacementDomainMetrics,
): {domains:OpportunityDomain[];contradiction:boolean} {
  const domains=crossingOpportunities(state).map(opportunity=>{
    const alternatives=enumeratePlacementDomains(state,opportunity,index,policies,metrics);
    return {opportunity,alternatives,count:alternatives.reduce((sum,a)=>sum+a.domain.length,0)};
  });
  const counts=new Map(domains.map(d=>[opportunityKey(d.opportunity),d.count]));
  for(const p of state.placed) {
    index.budget.check();
    let checked=false,supported=false;
    for(let i=0;i<p.word.length;i++) {
      const cell=placementCell(p,i);
      if(state.ownership[cell.row][cell.col]===3) checked=true;
      if((counts.get(opportunityKey({...cell,direction:p.dir==="across"?"down":"across"}))??0)>0) supported=true;
    }
    if(!checked&&!supported) return {domains,contradiction:true};
  }
  return {domains,contradiction:false};
}
