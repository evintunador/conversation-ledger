/** Generate review artifacts only. This module never installs or enables a scheduler. */
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_NPM_RUNTIMES } from "./runtimes.js";

const MANUAL = ["mistral-vibe", "goose", "droid", "aider", "openhands", "crush", "open-interpreter"];
const IMPLEMENTED = [...PINNED_NPM_RUNTIMES.map(item => item.cli), ...MANUAL];
const LABEL = "org.conversation-ledger.verification";
export interface ScheduleOptions {
  outputDirectory: string;
  repository: string;
  runtimeDirectory: string;
  binaryOverrides: Record<string, string>;
  nodeBinary?: string;
  selected?: string[];
  pathDirectories?: string[];
}
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function absolute(value: string, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw Error(`${name} must be an absolute path without control characters`);
  return resolve(value);
}
async function persistent(value: string, name: string): Promise<string> {
  const path = absolute(value, name);
  // Resolve existing ancestors too: a not-yet-created directory under a symlink
  // to /tmp must not accidentally become a disposable scheduled runtime.
  let parent = path, suffix: string[] = [];
  while (true) {
    try { parent = await realpath(parent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(parent.slice(next.length).replace(/^\//, "")); parent = next;
    }
  }
  const canonical = join(parent, ...suffix);
  if (/^\/(?:private\/)?(?:tmp|var\/(?:tmp|folders))(?:\/|$)/.test(canonical)) throw Error(`${name} must be persistent, not a temporary proof/runtime path`);
  return path;
}
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function unit(value: string, executable = false): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return '"' + (executable ? escaped.replaceAll("$", () => "$$") : escaped) + '"';
}

// Standalone Node script: no shell parsing and no inherited provider credentials,
// NODE_OPTIONS, user PATH, or user config. Each campaign uses further isolated HOME.
const RUNNER = `import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(directory, 'schedule.json'), 'utf8'));
const home = join(directory, 'runner-home');
await Promise.all(['', 'tmp', 'config', 'data', 'cache', 'state'].map(part => mkdir(join(home, part), {recursive:true,mode:0o700})));
const env = {HOME:home, PATH:config.pathDirectories.join(':'), TMPDIR:join(home,'tmp'),
 XDG_CONFIG_HOME:join(home,'config'), XDG_DATA_HOME:join(home,'data'), XDG_CACHE_HOME:join(home,'cache'), XDG_STATE_HOME:join(home,'state'),
 GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', CI:'1', NO_COLOR:'1', TERM:'dumb', BROWSER:'/usr/bin/true'};
for (const [id, binary] of Object.entries(config.binaryOverrides)) env['CLEDGER_VERIFY_'+id.replaceAll('-','_').toUpperCase()+'_BINARY']=binary;
let interrupted = false, current;
const terminate = () => { interrupted=true; const pid=current?.pid; if(pid) {
 try {process.kill(-pid,'SIGTERM')} catch{}
 const deadline=setTimeout(()=>{try {process.kill(-pid,'SIGKILL')} catch{}},5000); deadline.unref();
} };
process.on('SIGTERM',terminate); process.on('SIGINT',terminate);
let failed = false;
for (const mode of ['headless','interactive']) {
 if(interrupted) break;
 const args=[join(config.repository,'dist','verification','campaign.js'),'--state-dir',join(directory,'state'),'--runtime-dir',config.runtimeDirectory,'--only',config.selected.join(','),'--mode',mode,'--upstream'];
 if(mode==='headless') args.push('--verify-updates');
 const code = await new Promise(resolve => {
  const child=spawn(config.nodeBinary,args,{cwd:config.repository,env,stdio:'inherit',detached:true}); current=child;
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},3*60*60*1000);
  child.once('error',()=>{clearTimeout(timer); resolve(1)});
  child.once('close',code=>{clearTimeout(timer);current=undefined;resolve(code??1)});
 });
 if(code!==0) failed=true;
}
process.exitCode=interrupted?130:failed?1:0;
`;

export async function generateSchedule(options: ScheduleOptions) {
  const output = absolute(options.outputDirectory, "outputDirectory");
  const repository = await persistent(options.repository, "repository");
  const runtimeDirectory = await persistent(options.runtimeDirectory, "runtimeDirectory");
  const nodeBinary = await persistent(options.nodeBinary ?? process.execPath, "nodeBinary");
  if (!options.binaryOverrides || typeof options.binaryOverrides !== "object" || Array.isArray(options.binaryOverrides)) throw Error("Explicit binary-overrides JSON object is required (use {} when selecting only npm runtimes)");
  const selected = options.selected ?? IMPLEMENTED;
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !IMPLEMENTED.includes(id))) throw Error("--only must contain distinct implemented CLI IDs");
  const binaryOverrides: Record<string,string> = {};
  for (const [id, path] of Object.entries(options.binaryOverrides)) {
    if (!IMPLEMENTED.includes(id)) throw Error(`Unknown binary override: ${id}`);
    binaryOverrides[id] = await persistent(path, `binary override ${id}`);
  }
  const missing = selected.filter(id => MANUAL.includes(id) && !binaryOverrides[id]);
  if (missing.length) throw Error(`Persistent manual runtime overrides required for: ${missing.join(", ")}`);
  const pathDirectories = [...new Set([dirname(nodeBinary), ...Object.values(binaryOverrides).map(dirname),
    ...(options.pathDirectories ?? []), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])];
  for (const path of pathDirectories) {
    await persistent(path, "PATH directory");
    if (path.includes(":")) throw Error("PATH directories must not contain ':'");
  }
  try { if ((await readdir(output)).length) throw Error("Output directory must be empty; choose a new review directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(output, {recursive:true,mode:0o700});
  const runner = join(output, "run-verification.mjs"), plist = join(output, `${LABEL}.plist`);
  const config = {schema:"cledger-schedule/1", repository, runtimeDirectory, nodeBinary, binaryOverrides, selected, pathDirectories,
    intervalDays:14, trigger:"daily", autoMerge:false, paidInferenceEnabled:false, runtimeProvisioningVerified:false};
  const plistText = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(nodeBinary)}</string><string>${xml(runner)}</string></array>
<key>WorkingDirectory</key><string>${xml(repository)}</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(output,"scheduler.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(output,"scheduler.stderr.log"))}</string>
<key>Nice</key><integer>10</integer>
</dict></plist>\n`;
  const service = `[Unit]\nDescription=Conversation Ledger scripted native verification (review only)\n\n[Service]\nType=oneshot\nWorkingDirectory=${unit(repository)}\nExecStart=${unit(nodeBinary,true)} ${unit(runner,true)}\nTimeoutStartSec=7h\nKillMode=control-group\nUMask=0077\n`;
  const timer = `[Unit]\nDescription=Daily trigger for 14-day Conversation Ledger checks\n\n[Timer]\nOnCalendar=daily\nPersistent=true\nRandomizedDelaySec=30m\nUnit=${LABEL}.service\n\n[Install]\nWantedBy=timers.target\n`;
  const instructions = `# Review before enabling\n\nNothing has been installed or enabled. Runtime presence and versions have not been verified by this generator; the planned paths may not exist yet. Review schedule.json, the runner, and the scheduler files. They contain absolute paths and are not relocatable without regeneration. Keep this directory permanently if activated.\n\nBoth modes run sequentially; a headless failure does not suppress interactive checks. Daily triggers consult separate headless and interactive 14-elapsed-day state. Failures consume that mode's attempt rather than retrying daily. State and timestamped reports remain under this directory's state/. A running.lock blocks overlapping campaigns; inspect before removing a stale lock.\n\nInference is scripted, with no paid-provider path or inherited credentials. Headless checks observe releases and verify npm update candidates; interactive checks observe releases and verify pinned runtimes. Candidate proposals remain review artifacts. Nothing commits, opens a PR, merges, updates baseline pins, or upgrades manual runtimes automatically. Review proposal.json and candidate-results.json before applying runtimes.proposed.ts.\n\nProvision the npm runtime directory first with the built verification/runtimes.js command. Provision non-npm CLIs separately at the reviewed binary override paths (Aider's override is its virtualenv Python). Also provide Python3, git, npm, and the CLI-specific prerequisites such as SQLite for Crush. Inspect PATH directories in schedule.json; none are inherited. Build this checkout and its annals dependency before activation.\n\nManual invocation (runs due checks, may download public npm candidates):\n\n\`\`\`sh\n${shellQuote(nodeBinary)} ${shellQuote(runner)}\n\`\`\`\n\nmacOS activation, after review:\n\n\`\`\`sh\nmkdir -p "$HOME/Library/LaunchAgents"\ncp ${shellQuote(plist)} "$HOME/Library/LaunchAgents/${LABEL}.plist"\nlaunchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${LABEL}.plist"\n\`\`\`\n\nTo disable: \`launchctl bootout "gui/$(id -u)/${LABEL}"\`. Launchd starts once when loaded and daily at noon, coalescing missed sleep-time triggers. Inspect scheduler.stdout.log and scheduler.stderr.log; arrange retention for these logs and timestamped reports.\n\nLinux user-systemd activation, after review:\n\n\`\`\`sh\nmkdir -p "$HOME/.config/systemd/user"\ncp ${shellQuote(join(output,LABEL+".service"))} ${shellQuote(join(output,LABEL+".timer"))} "$HOME/.config/systemd/user/"\nsystemctl --user daemon-reload\nsystemctl --user enable --now ${LABEL}.timer\n\`\`\`\n\nTo disable: \`systemctl --user disable --now ${LABEL}.timer\`. Inspect \`journalctl --user -u ${LABEL}.service\`. User services normally require an active user manager; lingering is an explicit administrator choice.\n\nA hosted runner can invoke the same script with persistent state/runtime paths; regenerate artifacts for that machine. These files do not claim Linux native verification has occurred.\n`;
  for (const [name,body] of Object.entries({"schedule.json":JSON.stringify(config,null,2)+"\n", "run-verification.mjs":RUNNER,
    [LABEL+".plist"]:plistText,[LABEL+".service"]:service,[LABEL+".timer"]:timer,"ACTIVATION.md":instructions})) {
    await writeFile(join(output,name),body,{mode:0o600,flag:"wx"});
  }
  return {outputDirectory:output, installed:false, enabled:false, config, artifacts:await readdir(output)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2) {
    const key=args[i]!, value=args[i+1];
    if(!["--output-dir","--repository","--runtime-dir","--binary-overrides","--node","--only","--path-directories"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw Error(`Invalid or duplicate schedule option: ${key}`);
    values.set(key,value);
  }
  for(const key of ["--output-dir","--repository","--runtime-dir","--binary-overrides"]) if(!values.has(key)) throw Error(`Required: ${key}`);
  const overrides=JSON.parse(await readFile(absolute(values.get("--binary-overrides")!,"binary-overrides file"),"utf8"));
  const result=await generateSchedule({outputDirectory:values.get("--output-dir")!,repository:values.get("--repository")!,runtimeDirectory:values.get("--runtime-dir")!,binaryOverrides:overrides,
    ...(values.has("--node")?{nodeBinary:values.get("--node")!}:{}), ...(values.has("--only")?{selected:values.get("--only")!.split(",")}:{ }),
    ...(values.has("--path-directories")?{pathDirectories:JSON.parse(values.get("--path-directories")!)}:{})});
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
}
