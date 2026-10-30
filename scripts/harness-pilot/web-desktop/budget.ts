import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson } from '../noncoding/campaign-budget';
import { everydayBudget } from '../everyday/budget';
export async function webDesktopBudget(root:string,base:string){
 const prior=await everydayBudget(path.join(root,'.workbench/comparison/noncoding-20261028'),path.join(root,'.workbench/comparison/everyday-20261029'));
 const own={reportedUsd:0,reservedUsd:0,calls:0,committedRemainderUsd:0};const charged=new Map<string,number>();
 const folder=path.join(base,'live');
 if(await exists(folder))for(const e of await fs.readdir(folder,{withFileTypes:true}))if(e.isDirectory()){
  const file=path.join(folder,e.name,'billing.json');if(!await exists(file))continue;let cost=0;
  for(const c of (await readJson(file)).calls){own.calls++;const v=['reported','local-failure'].includes(c.state)?c.costUsd??0:c.reservationUsd;cost+=v;if(['reported','local-failure'].includes(c.state))own.reportedUsd+=v;else own.reservedUsd+=v;}
  charged.set(e.name,cost);
 }
 for(const a of await exists(path.join(folder,'attempts.json'))?await readJson(path.join(folder,'attempts.json')):[]){
  const v=charged.get(path.basename(a.output));if(v===undefined)own.reservedUsd+=a.cap;
  else if(a.status==='aborted-reserved')own.reservedUsd+=Math.max(0,a.cap-v);
  else if(a.status!=='ended')own.committedRemainderUsd+=Math.max(0,a.cap-v);
 }
 const campaignAccountedUsd=own.reportedUsd+own.reservedUsd;
 const campaignEncumberedUsd=campaignAccountedUsd+own.committedRemainderUsd;
 return {reportedUsd:prior.reportedUsd+own.reportedUsd,reservedUsd:prior.reservedUsd+own.reservedUsd,accountedUsd:prior.accountedUsd+campaignAccountedUsd,encumberedUsd:prior.encumberedUsd+campaignEncumberedUsd,committedRemainderUsd:prior.committedRemainderUsd+own.committedRemainderUsd,calls:prior.calls+own.calls,limitUsd:15,campaignLimitUsd:5,campaignAccountedUsd,campaignEncumberedUsd,groups:{...prior.groups,'web-desktop-live':own}};
}
export function slots(b:{encumberedUsd:number;campaignEncumberedUsd:number},cap:number,concurrency:number){return Math.max(0,Math.min(concurrency,Math.floor((15-b.encumberedUsd+1e-9)/cap),Math.floor((5-b.campaignEncumberedUsd+1e-9)/cap)));}
