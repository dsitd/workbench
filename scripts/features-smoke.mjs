import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const runDir = path.resolve('.workbench/acceptance', randomUUID());
const projectRoot = path.join(runDir, 'project');
await fs.mkdir(projectRoot, { recursive: true });
const file = path.join(projectRoot, 'api.ts');
await fs.writeFile(file, 'export const api = 1;\n');
const cacheFile = path.join(projectRoot, 'cache.ts');
await fs.writeFile(cacheFile, Array.from({ length: 100 }, (_, index) => `export const cacheItem${index} = 'Stable public fixture data, preserved across repeated reads.';`).join('\n') + '\n');
await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'Read before edits. Preserve the public export.\n');
execFileSync('/usr/bin/git', ['init', '-b', 'main', projectRoot], {stdio:'ignore'});
execFileSync('/usr/bin/git', ['-C', projectRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', 'api.ts', 'AGENTS.md']);
execFileSync('/usr/bin/git', ['-C', projectRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial fixture'], {stdio:'ignore'});
const markdown = '# Проверенный результат\n\n- **Защита от выхода за папку.** Я проверил случай с `canonicalTarget`, `O_NOFOLLOW` и записью через `rename`. Каждый фрагмент остаётся в одном пункте списка.\n- **Запись.** Сохранена версия файла и контрольная точка.\n\n## Найденные проблемы\n\n- **Таймаут действует на весь запрос, включая стриминг.** Раньше длинный ответ обрывался. Теперь idle-таймаут сбрасывается при поступлении данных.\n- **Нет ретраев.** Временная ошибка теперь учитывается в журнале.\n\n| Проверка | Результат |\n| --- | --- |\n| API | Успех |\n| Контекст | Только нужные фрагменты |\n\n```typescript\nexport const api = 2;\n```';
const checks = [];
const composerChoices = ['model-choice', 'agent-mode', 'agent-reasoning'];
const chooseComposerOption = async (page, testId, label) => {
  await page.getByTestId(testId).click();
  await page.getByRole('listbox').getByRole('option', { name: label, exact: true }).click();
};
const assertVisibleMenu = async (page) => {
  const menu = page.getByRole('listbox');
  await menu.waitFor();
  const presentation = await menu.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const sample = document.createElement('span');
    sample.style.backgroundColor = 'var(--surface)';
    document.body.appendChild(sample);
    const surface = getComputedStyle(sample).backgroundColor;
    sample.remove();
    const options = [...element.querySelectorAll('[role="option"]')];
    return {
      themed: style.backgroundColor === surface && parseFloat(style.borderRadius) > 0 && style.boxShadow !== 'none',
      insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      visibleOptions: options.length > 0 && options.every(option => {
        const box = option.getBoundingClientRect();
        return box.left >= rect.left && box.right <= rect.right + 1 && box.top >= rect.top && box.bottom <= rect.bottom + 1
          && option.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      }),
      selectedOptions: options.filter(option => option.getAttribute('aria-selected') === 'true').length,
    };
  });
  assert.deepEqual(presentation, { themed: true, insideViewport: true, visibleOptions: true, selectedOptions: 1 });
};
let desktop;
const wait = async (predicate, timeout=30000) => { const end=Date.now()+timeout; while(Date.now()<end) {if(await predicate())return; await new Promise(resolve=>setTimeout(resolve,100));} throw Error('Acceptance condition timed out.'); };
const env={...process.env,WORKBENCH_DATA_DIR:path.join(runDir,'state')}; delete env.ELECTRON_RUN_AS_NODE; delete env.WORKBENCH_DEV_URL;
try {
  desktop=await electron.launch({args:process.env.WORKBENCH_EXECUTABLE?[]:['.'],executablePath:process.env.WORKBENCH_EXECUTABLE||undefined,env,timeout:30000});
  const page=await desktop.firstWindow(); page.setDefaultTimeout(15000); await page.getByTestId('project-create').first().waitFor();
  // Replace the provider transport in this isolated test process. No real account is contacted.
  await desktop.evaluate(async (_electron, {file,cacheFile,markdown})=>{
    globalThis.__featureRequests=[]; globalThis.__featureRetried=false;
    globalThis.__prefixCacheFixture={ entries:new Map(), calls:[], counterfactual:[] };
    const { createHash }=process.getBuiltinModule('node:crypto');
    const normal=value=>{
      if(Array.isArray(value)) return value.map(normal);
      if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>!['cache_control','prompt_cache_breakpoint'].includes(key)).map(([key,item])=>[key,normal(item)]));
      return value;
    };
    const normalizedMessage=message=>({...normal(message),content:typeof message.content==='string'?[{type:'text',text:message.content}]:normal(message.content)});
    // This fixture models documented cache endpoints and 20-position lookback,
    // not arbitrary matching substrings. Provider tokenization remains simulated.
    const simulateCache=(body,entries,write)=>{
      const header={model:body.model,tools:normal(body.tools??[]),reasoning:normal(body.reasoning??{})};
      const mapped=body.messages.map(normalizedMessage);
      const serialized=index=>JSON.stringify({...header,messages:mapped.slice(0,index+1)});
      const tokens=index=>Math.ceil(serialized(index).length/4);
      const hash=index=>createHash('sha256').update(serialized(index)).digest('hex');
      const endpoints=body.messages.flatMap((message,index)=>Array.isArray(message.content)&&message.content.some(part=>part.cache_control?.type==='ephemeral')?[index]:[]);
      if(!endpoints.length) throw Error('Cache-loop requests must mark their actual stable cache endpoints.');
      let read=0;
      for(const end of endpoints) for(let index=end;index>=Math.max(0,end-19);index--){const entry=entries.get(hash(index));if(entry){read=Math.max(read,entry);break;}}
      const last=Math.max(...endpoints),cacheable=tokens(last),input=tokens(body.messages.length-1);
      const creation=Math.max(0,cacheable-read);
      if(write) for(const end of endpoints) if(tokens(end)>=512) entries.set(hash(end),tokens(end));
      const cost=((input-read-creation)*2+read*0.2+creation*2.5)/1e6;
      return {input,read,write:creation,cost,prefixHash:hash(last),cachedThrough:last};
    };
    globalThis.fetch=async(url,init)=>{
      if(String(url)!=='https://openrouter.ai/api/v1/chat/completions') throw Error('Unexpected fixture API destination.');
      const body=JSON.parse(init.body); globalThis.__featureRequests.push(body);
      const title=body.model==='google/gemini-2.5-flash-lite';
      if(!title && globalThis.__featureHold) await new Promise(resolve=>{globalThis.__featureRelease=resolve;});
      let message;
      if(title) message={content:'Защита версий и проверка API'};
      else {
        const text=item=>typeof item?.content==='string'?item.content:(item?.content??[]).map(part=>part.text??'').join('');
        const userIndex=body.messages.findLastIndex(item=>item.role==='user'&&/^(RETRY|CONTINUE|BACKGROUND|CACHE_LOOP)\b/.test(text(item)));
        if(userIndex<0) throw Error('Only the actual fixture request selects a response; quoted snapshots and continuation instructions are application context.');
        const latest=text(body.messages[userIndex]);
        const results=body.messages.slice(userIndex+1).filter(item=>item.role==='tool');
        const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
        if(latest.startsWith('CACHE_LOOP')) {
          const fixture=globalThis.__prefixCacheFixture,step=fixture.calls.length;
          const snapshotIndex=body.messages.findIndex(item=>item.role==='user'&&text(item).startsWith('Workbench local reference snapshot ('));
          const metrics=simulateCache(body,fixture.entries,false);
          if(snapshotIndex<0||metrics.cachedThrough>=snapshotIndex) throw Error('Volatile reference data must stay after the marked reusable prefix.');
          if(step>=2) {
            const changed={...body,messages:body.messages.filter(item=>item.tool_call_id!=='cache-read-0'&&!item.tool_calls?.some(tool=>tool.id==='cache-read-0'))};
            fixture.counterfactual.push(simulateCache(changed,fixture.entries,false));
          }
          simulateCache(body,fixture.entries,true);
          fixture.calls.push(metrics);
          const sequence=[call('cache-read-0','read_file',{path:cacheFile}),call('cache-read-1','read_file',{path:cacheFile}),call('cache-plan-0','update_plan',{items:[{text:'Проверить стабильный файл',status:'running'},{text:'Подготовить итог',status:'pending'}]}),call('cache-read-2','read_file',{path:cacheFile}),call('cache-plan-1','update_plan',{items:[{text:'Проверить стабильный файл',status:'completed'},{text:'Подготовить итог',status:'running'}]})];
          message=step<sequence.length?{content:step===2||step===4?'Обновляю план.':'Читаю стабильный файл.',tool_calls:[sequence[step]]}:{content:'Стабильный кэш проверен: повторные чтения и план сохранены.'};
          return new Response(JSON.stringify({choices:[{message:{role:'assistant',...message},finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:metrics.input,prompt_tokens_details:{cached_tokens:metrics.read,cache_write_tokens:metrics.write},completion_tokens:20,cost:metrics.cost+20*10/1e6}}),{headers:{'content-type':'application/json'}});
        }
        const prefix=latest.includes('CONTINUE')?'continue-':'first-';
        if(latest.includes('RETRY')&&!globalThis.__featureRetried){globalThis.__featureRetried=true;return new Response('{}',{status:429,headers:{'retry-after':'0'}});}
        if(latest.includes('BACKGROUND')) message=results.length ? {content:'Фоновый процесс запущен.'} : {content:'Запускаю сервер.',tool_calls:[call('background','start_background_command',{command:"printf 'STREAM_READY\\n'; sleep 45",timeoutMs:60000})]};
        else if(!results.length) message={content:'Читаю текущую версию.',tool_calls:[call(`${prefix}read`,'read_file',{path:file})]};
        else if(!results.some(result=>result.tool_call_id===`${prefix}edit`)) message={content:'Сохраняю правку.',tool_calls:[call(`${prefix}edit`,'edit_file',{path:file,oldText:'api = 1',newText:'api = 2'})]};
        else message={content:markdown};
      }
      return new Response(JSON.stringify({choices:[{message:{role:'assistant',...message},finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:title?100:500,completion_tokens:title?12:80,cost:title?0.000015:0.002}}),{headers:{'content-type':'application/json'}});
    };
  },{file,cacheFile,markdown});
  const model=await page.evaluate(async()=>{const state=await window.workbench.bootstrap();const preset=state.models.find(model=>model.id==='openrouter-claude-sonnet-55');return window.workbench.saveModel({...preset,name:'Sonnet fixture'},'fixture-placeholder-not-a-real-key');});
  const project=await page.evaluate(root=>window.workbench.createProject({name:'Полная проверка',folders:[{path:root,access:'write'}],internet:false,commandPolicy:'sandbox',instructions:'',verificationCommand:'/usr/bin/true',verifyAfterRun:true,memory:'Keep public exports stable.'}),projectRoot);
  await page.getByRole('button',{name:'Полная проверка',exact:true}).click();
  await page.getByTestId('chat-input').waitFor();
  const session=(await page.evaluate(()=>window.workbench.bootstrap())).sessions.find(item=>item.projectId===project.id);
  await page.evaluate(({id,modelId})=>window.workbench.updateSession(id,{modelId}),{id:session.id,modelId:model.id});
  await page.reload(); await page.getByTestId('chat-input').waitFor();
  assert.equal(await page.locator('.composer select').count(), 0, 'Composer choices must use the themed menu instead of native macOS selects.');
  for(const testId of composerChoices) {
    const trigger=page.getByTestId(testId);
    assert.equal(await trigger.getAttribute('role'), 'combobox');
    const original=await trigger.getAttribute('data-value');
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await assertVisibleMenu(page);
    await page.screenshot({path:path.join(runDir,`${testId}-menu.png`)});
    await trigger.press('Escape');
    assert.equal(await page.getByRole('listbox').count(), 0);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.getAttribute('data-value'), original);
    assert.equal(await trigger.evaluate(element=>element===document.activeElement), true, 'Escape restores focus to the choice that opened the menu.');
  }
  await page.getByTestId('agent-reasoning').click();
  await page.getByTestId('agent-reasoning').press('Home');
  await page.getByTestId('agent-reasoning').press('ArrowDown');
  await page.getByTestId('agent-reasoning').press('Enter');
  await wait(()=>page.getByTestId('agent-reasoning').getAttribute('data-value').then(value=>value==='low'));
  await page.getByTestId('agent-reasoning').click();
  assert.equal(await page.getByRole('option',{name:'low',exact:true}).getAttribute('aria-selected'),'true');
  await page.locator('.chat-header h1').click();
  assert.equal(await page.getByRole('listbox').count(),0,'Clicking outside dismisses a choice menu.');
  await chooseComposerOption(page,'agent-reasoning','high');
  await wait(()=>page.evaluate(async id=>(await window.workbench.bootstrap()).sessions.find(item=>item.id===id)?.reasoningEffort==='high',session.id));
  checks.push('themed-composer-menus-selected-options','composer-menu-keyboard-enter-escape-outside-click');
  await page.getByTestId('context-pin-open').click(); await page.getByTestId('pin-search').fill('api.ts');
  await page.getByRole('button',{name:/api\.ts/}).last().click(); await page.getByTestId('pin-start').fill('1');await page.getByTestId('pin-end').fill('1');await page.getByTestId('pin-save').click();
  await desktop.evaluate(()=>{globalThis.__featureHold=true;});
  await page.getByTestId('chat-input').fill('RETRY Исправь api.ts, сохрани public export и проверь результат.');await page.getByTestId('chat-send').click();
  await wait(()=>desktop.evaluate(()=>Boolean(globalThis.__featureRelease)));
  for(const testId of composerChoices) {
    assert.equal(await page.getByTestId(testId).isDisabled(),true,'Running a task must lock composer configuration.');
    assert.equal(await page.getByTestId(testId).getAttribute('aria-expanded'),'false');
  }
  assert.equal(await page.getByRole('listbox').count(),0);
  await desktop.evaluate(()=>{globalThis.__featureHold=false;globalThis.__featureRelease();delete globalThis.__featureRelease;});
  checks.push('composer-choice-disabled-during-agent-run');
  await wait(()=>page.evaluate(async id=>{const runs=await window.workbench.listRuns(undefined,id);return runs.some(run=>run.kind==='title'&&run.status==='completed')&&runs.some(run=>run.kind!=='title'&&run.verification?.status==='passed');},session.id));
  assert.equal(await fs.readFile(file,'utf8'),'export const api = 2;\n');
  const runs=await page.evaluate(id=>window.workbench.listRuns(undefined,id),session.id); const run=runs.find(item=>item.kind!=='title');
  assert.equal(run.status,'completed');assert.equal(run.steps,3);assert.equal(run.stepLog[0].retries,1);assert.equal(run.usage.costSource,'api');assert.equal(run.usage.costUsd,0.006);assert.deepEqual(run.changedFiles,[file]);assert.equal(run.verification.exitCode,0);
  const titled=(await page.evaluate(()=>window.workbench.bootstrap())).sessions.find(item=>item.id===session.id);assert.equal(titled.title,'Защита версий и проверка API');assert.equal(titled.titleSource,'automatic');
  const bodies=await desktop.evaluate(()=>globalThis.__featureRequests);
  assert.ok(bodies.some(body=>body.reasoning?.effort==='high'));
  const titleBody=bodies.find(body=>body.model==='google/gemini-2.5-flash-lite');assert.equal(titleBody.max_tokens,128);assert.equal(titleBody.reasoning.enabled,false);assert.equal(titleBody.tools?.length??0,0);assert.equal(JSON.stringify(titleBody).includes('Read before edits.'),false);assert.equal(JSON.stringify(titleBody).includes('fixture-placeholder'),false);
  const firstSystem=bodies.find(body=>body.model===model.model).messages[0].content;
  const contentText=value=>typeof value==='string'?value:(value??[]).map(part=>part.text??'').join('');
  assert.equal(contentText(firstSystem).includes('Pinned file fragment'),false,'Pinned file data stays outside privileged system instructions.');
  const localReference=bodies.find(body=>body.model===model.model).messages.find(message=>message.role==='user'&&contentText(message.content).startsWith('Workbench local reference snapshot ('));
  assert.ok(localReference&&contentText(localReference.content).includes('Pinned file fragment'),'Pinned fragments must appear in the quoted application-data snapshot.');
  checks.push('reasoning-through-ui','pins-through-ui','bounded-transient-retry','task-journal-api-cost','automatic-verification','automatic-light-title-short-context');
  await page.getByTestId('verification-status').filter({hasText:'Проверка пройдена'}).waitFor();
  await page.getByRole('button',{name:'Скрыть файлы',exact:true}).click();
  const activity=page.getByTestId('activity-disclosure');
  assert.equal(await activity.count(),1,'All model steps and tool results belong to one disclosure before the final answer.');
  assert.equal(await activity.evaluate(element=>element.open),false);
  assert.equal(await page.getByTestId('activity-result').first().isVisible(),false);
  assert.equal(await page.getByTestId('assistant-answer').getByRole('heading',{name:'Проверенный результат',exact:true}).isVisible(),true);
  await activity.getByTestId('activity-toggle').click();
  assert.deepEqual(await activity.getByTestId('activity-tool').locator('strong').allTextContents(),['read_file','edit_file','verify_project']);
  assert.equal(await activity.getByTestId('activity-result').first().isVisible(),true);
  await activity.getByTestId('activity-toggle').press('Space');
  assert.equal(await activity.evaluate(element=>element.open),false);
  checks.push('one-accessible-collapsed-activity-with-paired-tool-results-and-final-answer-outside');
  await wait(()=>page.locator('[data-testid="assistant-answer"] .markdown li').count().then(count=>count>=4));
  const layout=await page.evaluate(()=>({root:document.documentElement.scrollWidth<=window.innerWidth,lists:[...document.querySelectorAll('[data-testid="assistant-answer"] .markdown li')].every(item=>getComputedStyle(item).display==='list-item'),content:[...document.querySelectorAll('.message.assistant .message-body')].every(item=>item.scrollWidth<=item.clientWidth+1)}));
  assert.deepEqual(layout,{root:true,lists:true,content:true});await page.locator('.conversation-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});await page.screenshot({path:path.join(runDir,'markdown-fixed.png')});checks.push('screenshot-markdown-lists-code-tables-without-page-overflow');
  await page.getByRole('button',{name:'Показать файлы',exact:true}).click();
  await page.getByTestId('tab-files').click();await page.getByRole('button',{name:'project',exact:false}).filter({has:page.locator('.lucide-folder')}).first().click();
  await page.getByRole('button',{name:/^api\.ts/}).click();await page.getByTestId('file-editor').fill('export const api = 3;\n');
  await fs.writeFile(file,'export const api = 9;\n');await page.getByTestId('file-save').click();await page.getByTestId('file-conflict').waitFor();
  assert.equal(await page.getByTestId('conflict-merged-text').inputValue(),'export const api = 3;\n');assert.equal(await fs.readFile(file,'utf8'),'export const api = 9;\n');
  await page.getByTestId('conflict-reread').click();await page.getByTestId('conflict-merged-text').fill('export const api = 10;\n');await page.getByTestId('conflict-reviewed').click();await page.getByTestId('file-save').click();await wait(async()=>(await fs.readFile(file,'utf8')).includes('api = 10'));checks.push('editor-conflict-keeps-draft-reread-reviewed-merge');
  await page.getByTestId('tab-git').click();await page.getByText('main',{exact:true}).waitFor();await page.getByRole('button',{name:/api\.ts/}).last().click();await page.getByTestId('git-diff').filter({hasText:'+export const api = 10;'}).waitFor();await page.screenshot({path:path.join(runDir,'git.png')});checks.push('actual-git-branch-status-diff');
  await assert.rejects(page.evaluate(({id,checkpoint})=>window.workbench.revertCheckpoint(id,checkpoint),{id:project.id,checkpoint:run.checkpointId}),/conflict|external|changed|после|измен/i);assert.match(await fs.readFile(file,'utf8'),/api = 10/);checks.push('task-rollback-refuses-newer-editor-changes');
  await page.evaluate(async id=>{const state=await window.workbench.bootstrap();const project=state.projects.find(item=>item.id===id);await window.workbench.saveProject({...project,verificationCommand:'/usr/bin/false'});},project.id);
  const failed=await page.evaluate(id=>window.workbench.verifyRun(id),session.id);assert.equal(failed.status,'failed');assert.equal(failed.exitCode,1);assert.equal((await page.evaluate(id=>window.workbench.listRuns(undefined,id),session.id)).find(item=>item.id===run.id).status,'completed');checks.push('model-completion-separate-from-failed-check');
  await fs.writeFile(file,'export const api = 1;\n');await page.evaluate(id=>window.workbench.updateSession(id,{runLimits:{maxSteps:1}}),session.id);
  await page.getByTestId('chat-input').fill('CONTINUE Прочитай api.ts и исправь api = 1 на api = 2.');await page.getByTestId('chat-send').click();await page.getByTestId('run-continue').waitFor();
  const limited=(await page.evaluate(id=>window.workbench.listRuns(undefined,id),session.id)).find(item=>item.kind!=='title');assert.equal(limited.status,'limited');assert.equal(limited.limitReason,'steps');assert.equal(limited.canContinue,true);
  const usersBefore=(await page.evaluate(id=>window.workbench.getMessages(id),session.id)).filter(item=>item.role==='user').length;
  await page.evaluate(id=>window.workbench.updateSession(id,{runLimits:{maxSteps:10}}),session.id);await page.getByTestId('run-continue').click();await wait(()=>page.evaluate(async id=>(await window.workbench.listRuns(undefined,id)).some(item=>item.parentRunId&&item.status==='error'&&item.verification?.status==='failed'),session.id));
  assert.equal((await page.evaluate(id=>window.workbench.getMessages(id),session.id)).filter(item=>item.role==='user').length,usersBefore);assert.match(await fs.readFile(file,'utf8'),/api = 2/);checks.push('visible-step-budget-and-resume-without-duplicate-user');checks.push('resume-preserves-failed-verification-gate');await page.evaluate(async id=>{const state=await window.workbench.bootstrap();const project=state.projects.find(item=>item.id===id);await window.workbench.saveProject({...project,verificationCommand:'/usr/bin/true'});},project.id);
  await page.getByTestId('chat-input').fill('BACKGROUND запусти тестовый фоновый процесс.');await page.getByTestId('chat-send').click();await wait(()=>page.evaluate(async id=>(await window.workbench.listProcesses(id)).some(item=>item.background&&item.status==='running'&&item.output.includes('STREAM_READY')),project.id));
  await page.getByTestId('tab-processes').click();await page.locator('.process-panel .panel-list-item').filter({hasText:'фон'}).first().click();await page.getByTestId('command-output').filter({hasText:'STREAM_READY'}).waitFor();await page.screenshot({path:path.join(runDir,'processes.png')});await page.getByTestId('process-stop').click();await wait(()=>page.evaluate(async id=>(await window.workbench.listProcesses(id)).filter(item=>item.background).every(item=>item.status==='stopped'),project.id));checks.push('managed-background-output-and-stop-through-ui');
  await page.getByTestId('models-open').click();await page.getByTestId('workbench-settings-open').click();await page.getByTestId('full-context-enabled').uncheck();await page.getByTestId('context-budget').fill('32000');await page.getByTestId('parallel-tools-enabled').uncheck();await page.getByTestId('verified-completion-enabled').uncheck();await page.getByTestId('model-compaction-enabled').uncheck();await page.getByTestId('settings-save').click();await page.getByText('Настройки рабочего пространства сохранены',{exact:true}).waitFor();await page.screenshot({path:path.join(runDir,'settings.png')});checks.push('shared-settings-context-target-through-ui');const harnessSettings=await page.evaluate(()=>window.workbench.getSettings());assert.equal(harnessSettings.toolExecution,'sequential');assert.equal(harnessSettings.completionPolicy,'natural');assert.equal(harnessSettings.modelCompaction,false);checks.push('harness-settings-persist-through-ui');await page.getByRole('button',{name:'Закрыть окно'}).click();
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1060,700));await page.screenshot({path:path.join(runDir,'workspace-small.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.composer [role="combobox"],.composer .send-button')].every(element=>{const rect=element.getBoundingClientRect();return rect.left>=0&&rect.right<=window.innerWidth&&rect.bottom<=window.innerHeight;})),true);
  for(const testId of composerChoices) {
    await page.getByTestId(testId).click();
    await assertVisibleMenu(page);
    await page.screenshot({path:path.join(runDir,`${testId}-menu-small.png`)});
    await page.getByTestId(testId).press('Escape');
  }
  checks.push('small-window-without-page-overflow','composer-menu-visible-without-clipping-at-1060x700');
  const cacheSession=await page.evaluate(async({projectId,modelId})=>{
    const state=await window.workbench.bootstrap();
    await window.workbench.saveSettings({...state.settings,contextPolicy:'custom',contextBudgetTokens:32000,adaptiveContext:false,promptCache:{enabled:true,ttl:'5m'}});
    const chat=await window.workbench.createSession(projectId,modelId);
    await window.workbench.updateSession(chat.id,{title:'Prefix cache fixture',titleSource:'manual',reasoningEffort:'high',runLimits:{maxSteps:10}});
    return chat;
  },{projectId:project.id,modelId:model.id});
  await page.reload();
  await page.getByRole('button',{name:'Prefix cache fixture',exact:true}).click();
  await page.getByTestId('chat-input').fill('CACHE_LOOP Повторно прочитай cache.ts, сохраняй план и подготовь итог без изменения файла.');
  await page.getByTestId('chat-send').click();
  await wait(()=>page.evaluate(async id=>(await window.workbench.listRuns(undefined,id)).some(item=>item.kind!=='title'&&item.status==='completed'),cacheSession.id));
  const cacheRun=(await page.evaluate(id=>window.workbench.listRuns(undefined,id),cacheSession.id)).find(item=>item.kind!=='title');
  const cacheSimulation=await desktop.evaluate(()=>{const fixture=globalThis.__prefixCacheFixture;return {calls:fixture.calls,counterfactual:fixture.counterfactual};});
  assert.equal(cacheRun.steps,6);
  assert.equal(cacheSimulation.calls.length,6);
  const sum=key=>cacheSimulation.calls.reduce((total,item)=>total+item[key],0);
  assert.deepEqual({input:cacheRun.usage.inputTokens,read:cacheRun.usage.cacheReadTokens,write:cacheRun.usage.cacheWriteTokens},{input:sum('input'),read:sum('read'),write:sum('write')});
  assert.ok(Math.abs(cacheRun.usage.costUsd-(sum('cost')+6*20*10/1e6))<1e-10);
  assert.ok(sum('read')/sum('input')>0.7,'An append-only six-step loop must reuse most input after warm-up.');
  assert.ok(cacheSimulation.calls.slice(1).every((item,index)=>item.read===cacheSimulation.calls[index].read+cacheSimulation.calls[index].write),'Each next request must find the prior written endpoint, rather than re-cache the whole history.');
  assert.ok(cacheSimulation.counterfactual.some((item,index)=>item.cost>cacheSimulation.calls[index+2].cost+0.001),'Removing an old read group must demonstrably lose a prior cache endpoint and increase the synthetic API bill.');
  assert.equal(new Set(cacheRun.stepLog.map(step=>step.contextCache?.epoch)).size,1);
  assert.equal(cacheRun.stepLog[0].contextCache?.transition,'initial');
  assert.ok(cacheRun.stepLog.slice(1).every(step=>step.contextCache?.transition==='append'&&step.contextCache.historyPrefixPreserved===true&&step.contextCache.removedMessageCount===0));
  assert.equal(cacheRun.plan.length,2);
  checks.push('cache-prefix-append-only-duplicate-reads-and-volatile-plan','cache-simulator-reuses-only-written-endpoints-and-shows-deletion-cost','per-step-API-cache-cost-and-context-epoch-persisted');
  await page.getByTestId('request-cost').last().click();
  await page.getByText('Данные API',{exact:true}).waitFor();
  assert.match(await page.locator('.run-detail-facts').getByTestId('run-cache-read').textContent(),new RegExp(String(sum('read')).replace(/(?=(?:\d{3})+$)/g,'.?')));
  assert.equal(await page.getByTestId('context-cache-trace').count(),6);
  await page.locator('.run-step').last().locator('summary').click();
  await page.getByTestId('context-cache-trace').last().waitFor();
  assert.match(await page.getByTestId('context-cache-trace').last().textContent(),/История дополнена.*состав начала истории сохранён.*счётчики API/s);
  await page.getByTestId('context-cache-trace').last().scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(runDir,'stable-prefix-cache-journal.png')});
  await page.reload();
  const persistedCache=(await page.evaluate(id=>window.workbench.listRuns(undefined,id),cacheSession.id)).find(item=>item.id===cacheRun.id);
  assert.deepEqual(persistedCache.stepLog,cacheRun.stepLog);
  assert.deepEqual(persistedCache.usage,cacheRun.usage);
  checks.push('cache-prefix-trace-and-billing-survive-reload');
  const report={checks,paidRequests:0,runId:run.id,cacheRunId:cacheRun.id,runDir,cacheSimulation:{...cacheSimulation,input:sum('input'),read:sum('read'),write:sum('write'),hitRatio:sum('read')/sum('input'),costUsd:cacheRun.usage.costUsd,epoch:cacheRun.stepLog[0].contextCache?.epoch}};
  await fs.writeFile(path.join(runDir,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks,paidRequests:0,runDir,cacheHitRatio:report.cacheSimulation.hitRatio}));
} catch(error) {if(desktop){const page=await desktop.firstWindow().catch(()=>undefined);await page?.screenshot({path:path.join(runDir,'failure.png')}).catch(()=>{});}throw error;}
finally {await desktop?.close();}
