import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson } from '../noncoding/campaign-budget';
import { deltaBudget } from '../noncoding/delta-budget';

export async function everydayBudget(previousBase:string, base:string) {
 const previous=await deltaBudget(previousBase);
 let reportedUsd=previous.reportedUsd,reservedUsd=previous.reservedUsd,calls=previous.calls,committedRemainderUsd=previous.committedRemainderUsd;
 const own={reportedUsd:0,reservedUsd:0,calls:0}; const accounted=new Map<string,number>();
 const folder=path.join(base,'live');
 if(await exists(folder))for(const e of await fs.readdir(folder,{withFileTypes:true}))if(e.isDirectory()){
  const file=path.join(folder,e.name,'billing.json');if(!await exists(file))continue;let sum=0;
  for(const c of (await readJson(file)).calls){own.calls++;if(['reported','local-failure'].includes(c.state)){own.reportedUsd+=c.costUsd??0;sum+=c.costUsd??0;}else{own.reservedUsd+=c.reservationUsd;sum+=c.reservationUsd;}}
  accounted.set(e.name,sum);
 }
 const registry=path.join(folder,'attempts.json');
 for(const a of await exists(registry)?await readJson(registry):[]){
  const cost=accounted.get(path.basename(a.output));
  if(cost===undefined)own.reservedUsd+=a.cap;
  else if(a.status==='aborted-reserved')own.reservedUsd+=Math.max(0,a.cap-cost);
  else if(a.status!=='ended')committedRemainderUsd+=Math.max(0,a.cap-cost);
 }
 reportedUsd+=own.reportedUsd;reservedUsd+=own.reservedUsd;calls+=own.calls;
 const accountedUsd=reportedUsd+reservedUsd;
 return {reportedUsd,reservedUsd,accountedUsd,calls,committedRemainderUsd,encumberedUsd:accountedUsd+committedRemainderUsd,limitUsd:15,groups:{...previous.groups,'everyday-live':own}};
}
export function availableSlots(encumberedUsd:number,cap:number,concurrency:number){return Math.max(0,Math.min(concurrency,Math.floor((15-encumberedUsd+1e-9)/cap)));}
