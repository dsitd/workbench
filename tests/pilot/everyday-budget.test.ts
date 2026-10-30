import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {everydayBudget,availableSlots} from '../../scripts/harness-pilot/everyday/budget';
test('new benchmark preserves previous charges, unknown reserves, and simultaneous task reservations under the extended cap',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'everyday-budget-'));
 const write=async(p:string,x:unknown)=>{await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),JSON.stringify(x));};
 try{
  await write('previous/live/old/billing.json',{calls:[{state:'reported',costUsd:8},{state:'uncertain',reservationUsd:1.5}]});
  await write('current/live/a/billing.json',{calls:[{state:'reported',costUsd:0.02},{state:'reserved-no-cost',reservationUsd:0.03}]});
  const attempts=[{output:'/unused/a',status:'started',cap:0.3},{output:'/unused/b',status:'started',cap:0.3}];
  await write('current/live/attempts.json',attempts);
  const b=await everydayBudget(path.join(root,'previous'),path.join(root,'current'));
  assert.ok(Math.abs(b.encumberedUsd-10.1)<1e-9);assert.ok(Math.abs(b.accountedUsd-9.85)<1e-9);assert.equal(b.limitUsd,15);
  attempts[0].status='ended';await write('current/live/attempts.json',attempts);
  assert.ok(Math.abs((await everydayBudget(path.join(root,'previous'),path.join(root,'current'))).encumberedUsd-9.85)<1e-9);
  assert.equal(availableSlots(14.8,0.3,4),0);assert.equal(availableSlots(13.8,0.3,4),4);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
