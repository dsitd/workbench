import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {webDesktopBudget,slots} from '../../scripts/harness-pilot/web-desktop/budget';
test('web/desktop pilot keeps both the $5 campaign cap and the historical $15 cap, including unknown and concurrent costs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'web-desktop-budget-'));const base=path.join(root,'.workbench/comparison/web-desktop-20261029');
 const write=async(p:string,x:unknown)=>{const f=path.join(root,'.workbench/comparison',p);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(x));};
 try{
  await write('noncoding-20261028/live/old/billing.json',{calls:[{state:'reported',costUsd:8},{state:'uncertain',reservationUsd:1.5}]});
  await write('everyday-20261029/live/a/billing.json',{calls:[{state:'reported',costUsd:.3}]});
  await write('web-desktop-20261029/live/a/billing.json',{calls:[{state:'reported',costUsd:.02},{state:'uncertain',reservationUsd:.03}]});
  await write('web-desktop-20261029/live/attempts.json',[{output:'/unused/a',cap:.3,status:'started'},{output:'/unused/b',cap:.3,status:'started'}]);
  const b=await webDesktopBudget(root,base);
  assert.ok(Math.abs(b.encumberedUsd-10.4)<1e-9);assert.ok(Math.abs(b.campaignEncumberedUsd-.6)<1e-9);
  assert.equal(slots({encumberedUsd:14.6,campaignEncumberedUsd:4.8},.3,2),0);
  assert.equal(slots({encumberedUsd:14.8,campaignEncumberedUsd:4.5},.3,2),0);
  assert.equal(slots({encumberedUsd:14,campaignEncumberedUsd:4.2},.3,2),2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
