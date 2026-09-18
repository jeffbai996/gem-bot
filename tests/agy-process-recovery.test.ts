import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Real spawn/stdout/exit/transcript path, with only the provider executable replaced.
test('network exit pins the exact session and resumes without repeating its mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gem-process-recovery-'))
  const cli = join(dir, 'agy')
  process.env.GEMMA_AGY_BIN = cli
  process.env.GEMMA_AGY_BRAIN_DIR = join(dir, 'brain')
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.GEMMA_AGY_BRAIN_DIR;
const mode = process.env.GEM_TEST_MODE;
fs.appendFileSync(path.join(path.dirname(root),'attempts'),'attempt\\n');
const id = '00000000-0000-4000-8000-000000000001';
const transcript = path.join(root,id,'.system_generated/logs/transcript_full.jsonl');
const row = (step_index,source,type,content,tool_calls=[]) => JSON.stringify({step_index,source,type,content,tool_calls,status:'DONE'})+'\\n';
fs.mkdirSync(path.dirname(transcript),{recursive:true});
if (!args.includes('--conversation')) {
 fs.appendFileSync(path.join(root,'mutations'),'write-once\\n');
 fs.writeFileSync(transcript,row(0,'USER','USER_INPUT',(mode === 'unmatched' ? 'a different turn' : args[args.indexOf('-p')+1]))+row(1,'MODEL','PLANNER_RESPONSE','',[{name:'run_command',args:{CommandLine:'fixture-write'}}])+row(2,'MODEL','GENERIC','The command exited with code 0.\\nOutput:\\nFixture written.'));
 const other=path.join(root,'00000000-0000-4000-8000-000000000002','.system_generated/logs/transcript_full.jsonl');
 fs.mkdirSync(path.dirname(other),{recursive:true});fs.writeFileSync(other,row(0,'USER','USER_INPUT','some other channel'));
 console.error('error: There was a network issue connecting to the server, please try again.');process.exit(1);
}
if(args[args.indexOf('--conversation')+1]!==id)process.exit(9);
if(mode==='persistent'){console.error('network issue connecting to the server');process.exit(1);}
fs.appendFileSync(transcript,row(3,'USER','USER_INPUT',args[args.indexOf('-p')+1])+row(4,'MODEL','PLANNER_RESPONSE','Completed and verified the fixture.'));
console.log(JSON.stringify({conversation_id:id,status:'SUCCESS'}));
`, {mode:0o755})
  try {
    const {respondViaAgy,runAgy} = await import('../src/agy-chat.ts')
    const events: unknown[] = []
    const result = await respondViaAgy({systemPrompt:'Test',history:[],userMessageText:'fix it',userName:'Tester',onEvent:e=>events.push(e)}, text=>({reply:text,thinking:null,react:null}), (prompt,event,before,fp,dirs,signal,id)=>runAgy(prompt,event,before,fp,dirs,signal,id,async()=>null))
    assert.equal(result.parsed.reply, 'Completed and verified the fixture.')
    assert.equal(readFileSync(join(dir,'brain','mutations'),'utf8'),'write-once\n')
    assert.equal(result.meta.toolCalls.length,1)
    assert.match(result.meta.toolCalls[0].resultPreview,/Fixture written/)
    assert.ok(events.some((e:any)=>e.type==='agy_progress' && /resuming/.test(e.detail)))
    const input = {systemPrompt:'Test',history:[],userMessageText:'fix it',userName:'Tester'}
    const runner: typeof runAgy = (prompt,event,before,fp,dirs,signal,id) => runAgy(prompt,event,before,fp,dirs,signal,id,async()=>null)
    // No marker match: do not resume a sibling channel's more recent session.
    process.env.GEM_TEST_MODE = 'unmatched'
    writeFileSync(join(dir,'attempts'),'')
    await assert.rejects(respondViaAgy(input,text=>({reply:text,thinking:null,react:null}),runner),/network issue/)
    assert.equal(readFileSync(join(dir,'attempts'),'utf8').trim().split('\n').length,1)
    // A persistently unavailable provider stops after exactly two continuations.
    process.env.GEM_TEST_MODE = 'persistent'
    writeFileSync(join(dir,'attempts'),'')
    await assert.rejects(respondViaAgy(input,text=>({reply:text,thinking:null,react:null}),runner),/network issue/)
    assert.equal(readFileSync(join(dir,'attempts'),'utf8').trim().split('\n').length,3)
    // A stop arriving during recovery prevents the next process from spawning.
    delete process.env.GEM_TEST_MODE
    writeFileSync(join(dir,'attempts'),'')
    const controller = new AbortController()
    await assert.rejects(respondViaAgy({...input,signal:controller.signal,onEvent:e=>{
      if(e.type==='agy_progress')controller.abort()
    }},text=>({reply:text,thinking:null,react:null}),runner),{name:'AbortError'})
    assert.equal(readFileSync(join(dir,'attempts'),'utf8').trim().split('\n').length,1)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
