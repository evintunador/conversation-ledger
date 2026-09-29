import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateSchedule, shellQuote } from "../verification/schedule.js";
import { runProcess } from "../verification/process.js";

// Persistent-path validation is intentional; test fixtures live in the writable
// checkout and are removed in finally rather than pretending /tmp is durable.
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".schedule test ' & $ %-"));
  const repo = join(root,"repository ' & $ %"), output = join(root,"review ' & $ %");
  await mkdir(join(repo,"dist","verification"),{recursive:true});
  await writeFile(join(repo,"package.json"),'{"type":"module"}');
  return {root,repo,output,options:{outputDirectory:output,repository:repo,runtimeDirectory:join(root,"runtimes ' & $ %"),binaryOverrides:{},selected:["qwen-code"]}};
}

test("scheduler creates review-only artifacts with literal paths and valid launchd/shell syntax", async () => {
  const f=await fixture();
  try {
    const result=await generateSchedule(f.options);
    assert.equal(result.installed,false); assert.equal(result.enabled,false);
    assert.equal((await readdir(f.output)).length,6);
    assert.equal(result.config.autoMerge,false);
    const plist=join(f.output,"org.conversation-ledger.verification.plist");
    const parsed=spawnSync("python3",["-c","import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))",plist],{encoding:"utf8"});
    assert.equal(parsed.status,0,parsed.stderr);
    const value=JSON.parse(parsed.stdout);
    assert.deepEqual(value.ProgramArguments,[process.execPath,join(f.output,"run-verification.mjs")]);
    assert.equal(value.WorkingDirectory,f.repo);
    assert.deepEqual(value.StartCalendarInterval,{Hour:12,Minute:0});
    if(process.platform==="darwin") {
      const lint=spawnSync("/usr/bin/plutil",["-lint",plist],{encoding:"utf8"});
      assert.equal(lint.status,0,lint.stdout+lint.stderr);
    }
    const instructions=await readFile(join(f.output,"ACTIVATION.md"),"utf8");
    const scripts=[...instructions.matchAll(/```sh\n([\s\S]*?)```/g)].map(match=>match[1]).join("\n");
    const syntax=spawnSync("/bin/sh",["-n"],{input:scripts,encoding:"utf8"});
    assert.equal(syntax.status,0,syntax.stderr);
    const shellValue="a ' quoted $HOME `literal` path";
    assert.equal(spawnSync("/bin/sh",["-c","printf '%s' "+shellQuote(shellValue)],{encoding:"utf8"}).stdout,shellValue);
    const unit=await readFile(join(f.output,"org.conversation-ledger.verification.service"),"utf8");
    assert.match(unit,/WorkingDirectory="[^\n]*\$ %%"/);
    assert.match(unit,/ExecStart=.*\$\$ %%\/run-verification\.mjs"/);
    const timer=await readFile(join(f.output,"org.conversation-ledger.verification.timer"),"utf8");
    assert.match(timer,/OnCalendar=daily/); assert.match(timer,/Persistent=true/);
    await assert.rejects(generateSchedule(f.options),/must be empty/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test("generated runner strips credentials, preserves argv, and still checks interactive mode after a headless failure", async () => {
  const f=await fixture();
  try {
    const record=join(f.repo,"received.jsonl");
    await writeFile(join(f.repo,"dist","verification","campaign.js"), `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()})+'\\n');\nprocess.exitCode=process.argv.includes('headless')?7:0;\n`);
    const override=join(f.root,"manual runtime ' $ %","goose");
    await generateSchedule({...f.options,selected:["qwen-code","goose"],binaryOverrides:{goose:override}});
    const result=await runProcess(process.execPath,[join(f.output,"run-verification.mjs")],{cwd:f.root,timeoutMs:5000,
      env:{...process.env,OPENAI_API_KEY:"TESTONLY-must-not-leak",ANTHROPIC_AUTH_TOKEN:"TESTONLY-must-not-leak",AWS_SECRET_ACCESS_KEY:"TESTONLY-must-not-leak",CLEDGER_VERIFY_GOOSE_BINARY:"/tmp/incorrect",NODE_OPTIONS:"--no-warnings"}});
    assert.equal(result.code,1,result.stderr); assert.equal(result.timedOut,false);
    const rows=(await readFile(record,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(rows.length,2);
    for(const [index,row] of rows.entries()) {
      const mode=index===0?"headless":"interactive";
      assert.deepEqual(row.args,["--state-dir",join(f.output,"state"),"--runtime-dir",f.options.runtimeDirectory,"--only","qwen-code,goose","--mode",mode,"--upstream",...(index===0?["--verify-updates"]:[])]);
      assert.equal(row.cwd,f.repo); assert.equal(row.env.CLEDGER_VERIFY_GOOSE_BINARY,override);
      assert.equal(row.env.OPENAI_API_KEY,undefined); assert.equal(row.env.ANTHROPIC_AUTH_TOKEN,undefined);
      assert.equal(row.env.AWS_SECRET_ACCESS_KEY,undefined); assert.equal(row.env.NODE_OPTIONS,undefined);
      assert.equal(row.env.HOME,join(f.output,"runner-home"));
      assert.equal(row.env.GIT_CONFIG_GLOBAL,"/dev/null");
    }
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test("scheduler refuses temporary runtimes including symlinked ancestors, relative paths and missing manual overrides before writing", async () => {
  const f=await fixture();
  try {
    await assert.rejects(generateSchedule({...f.options,runtimeDirectory:join(tmpdir(),"cledger-proof")}),/persistent/);
    const alias=join(f.root,"temporary-alias"); await symlink(tmpdir(),alias);
    await assert.rejects(generateSchedule({...f.options,runtimeDirectory:join(alias,"not-created")}),/persistent/);
    await assert.rejects(generateSchedule({...f.options,binaryOverrides:{"qwen-code":"/tmp/proof/qwen"}}),/persistent/);
    await assert.rejects(generateSchedule({...f.options,runtimeDirectory:"relative"}),/absolute/);
    await assert.rejects(generateSchedule({...f.options,selected:["goose"]}),/manual runtime overrides required/);
    await assert.rejects(generateSchedule({...f.options,binaryOverrides:{unknown:"/usr/bin/true"}}),/Unknown binary override/);
    await assert.rejects(readdir(f.output),{code:"ENOENT"});
  } finally {await rm(f.root,{recursive:true,force:true});}
});
