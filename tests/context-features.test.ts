import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/agent/context';
import type { AgentDependencies } from '../src/shared/agent';
import type { ChatMessage, ModelConfig, Project, Session } from '../src/shared/types';

const project: Project = { id: 'p', name: 'Context', folders: [{path:'/tmp/p',access:'write'}], internet:false, commandPolicy:'ask', instructions:'', memory:'Keep public exports stable.', createdAt:'', updatedAt:'' };
const session: Session = {id:'s',projectId:'p',modelId:'m',title:'Task',summary:'',status:'idle',createdAt:'',updatedAt:''};
const model: ModelConfig = {id:'m',name:'Fixture',kind:'demo',baseUrl:'',apiKeyEnv:'',model:'demo',enabled:true,vision:false,contextWindow:1_000_000,maxOutputTokens:2000};
const message = (id:string,role:ChatMessage['role'],content:string,extra:Partial<ChatMessage> = {}):ChatMessage => ({id,role,content,createdAt:'',...extra});
function dependencies(): AgentDependencies {
  return {getSession:async()=>session,getProject:async()=>project,getModel:async()=>model,getMessages:async()=>[],appendMessage:async()=>{},updateSession:async()=>session,loadInstructions:async()=>[],listSkills:async()=>[],readSkill:async()=>'',getAttachment:async()=>{throw Error('unused');},resolveImage:async()=>{throw Error('unused');},resolveCredential:async()=>undefined,tools:[],executeTool:async()=>({text:''}),emit:()=>{},saveContext:()=>{},getSettings:async()=>({autoTitle:{enabled:false,model:'fixture'},runLimits:{},contextPolicy: 'custom', contextBudgetTokens:4000}),getProjectContext:async()=>({pins:[{source:'/tmp/p/api.ts:3-4 [version]',content:'export const api = 1;'}],map:{files:[{path:'/tmp/p/api.ts',relativePath:'api.ts',symbols:['api'],kind:'typescript'}],scanned:1,truncated:false,generatedAt:''}})};
}
test('target context prunes older history while pins, project memory and latest paired tool group survive',async()=>{
  const history:ChatMessage[] = Array.from({length:30},(_,i)=>message('old'+i,i%2?'assistant':'user','old text '.repeat(200)));
  history.push(message('task','user','inspect @file:api.ts'),message('call','assistant','Inspecting',{toolCalls:[{id:'c',name:'read_file',arguments:{path:'api.ts'}}]}),message('result','tool','recent file content',{toolCallId:'c',toolName:'read_file'}));
  const context = await buildContext(dependencies(),session,project,model,history,[],new AbortController().signal);
  assert.ok(context.report.omittedMessages > 0); assert.ok(context.report.estimatedTokens <= context.report.budget);
  assert.doesNotMatch(context.system,/export const api = 1|Keep public exports stable|Selected project file\/symbol map/);
  const snapshot=context.messages.at(-1)!;
  assert.equal(snapshot.contextData,true); assert.match(snapshot.content,/export const api = 1/); assert.match(snapshot.content,/Keep public exports stable/); assert.match(snapshot.content,/Selected project file\/symbol map/);
  const conversation=context.messages.filter(item=>!item.contextData);
  assert.deepEqual(conversation.slice(-3).map(item=>item.role),['user','assistant','tool']); assert.equal(conversation.at(-1)?.toolCallId,'c');
  assert.ok(context.report.summaryUsed);
});
test('current tool group may exceed the target but must still fit the actual model window',async()=>{
  const history=[message('u','user','Inspect file'),message('a','assistant','',{toolCalls:[{id:'c',name:'read_file',arguments:{path:'api.ts'}}]}),message('t','tool','x'.repeat(17_000),{toolCallId:'c',toolName:'read_file'})];
  const context = await buildContext(dependencies(),session,project,model,history,[],new AbortController().signal);
  assert.ok(context.report.budget > 4000); assert.equal(context.messages.filter(item=>!item.contextData).length,3);
  await assert.rejects(buildContext(dependencies(),session,project,{...model,contextWindow:7000},history,[],new AbortController().signal),/Последний вызов/);
});
test('a protected or missing explicit context fragment fails before any provider request',async()=>{
  const deps=dependencies(); deps.getProjectContext=async()=>{throw Error('Protected file content is blocked.');};
  await assert.rejects(buildContext(deps,session,project,model,[message('u','user','@file:.env')],[],new AbortController().signal),/Protected/);
});
test('a long single task summarizes omitted tool groups after its retained original user request',async()=>{
  const history=[message('u','user','Continue this long task')];
  for(let i=0;i<20;i++) history.push(message('a'+i,'assistant','Checked step '+i,{toolCalls:[{id:'c'+i,name:'read_file',arguments:{path:'file'+i+'.ts'}}]}),message('t'+i,'tool','step '+i+' '+'x'.repeat(3000),{toolCallId:'c'+i,toolName:'read_file'}));
  const context=await buildContext(dependencies(),session,project,model,history,[],new AbortController().signal);
  assert.ok(context.report.omittedMessages>0); assert.ok(context.report.summaryUsed);
  assert.match(context.messages.at(-1)!.content,/workbench-task-checkpoint/);
  assert.ok(context.checkpoint.files.some(file=>file.path.startsWith('file')));
  assert.equal(context.messages[0].content,'Continue this long task');
  assert.equal(context.messages.filter(item=>!item.contextData).at(-1)?.toolCallId,'c19');
  assert.ok(Math.abs(context.report.sections.reduce((sum,section)=>sum+section.tokens,0)-context.report.estimatedTokens)<200);
});
