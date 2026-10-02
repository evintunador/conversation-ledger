import { registerVerificationCleanup } from "./process.js";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node:child_process";

export interface PtyAction {
  waitFor: string;
  /** Delay the action until an external hook has written this file. */
  waitForPath?: string;
  send: string;
  delayMs?: number;
  paste?: boolean;
}
export interface PtyResult {
  code: number;
  timedOut: boolean;
  actionsCompleted: number;
  output: string;
}

// Python owns the terminal session and kills its entire process group on every exit.
// No shell interpolation, inherited stdin, or user terminal is involved.
const DRIVER = String.raw`
import os,sys,json,pty,select,time,signal,re,fcntl,termios,struct
config=json.loads(sys.stdin.read())
pid,fd=pty.fork()
if pid==0:
 os.chdir(config['cwd'])
 os.execvpe(config['command'],config['args'],config['env'])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,160,0,0))
signal.signal(signal.SIGTERM,lambda *_: sys.exit(143))
output=''; pending=''; queries=''; index=0; code=1; expired=False
end=time.monotonic()+config['timeoutMs']/1000
def write_transcript():
 if not config.get('transcriptPath'): return
 try:
  trace_fd=os.open(config['transcriptPath'],os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
  with os.fdopen(trace_fd,'w',encoding='utf-8') as trace: trace.write(output)
 except OSError as error:
  raise RuntimeError('PTY transcript write failed: '+str(error)) from None
try:
 write_transcript()
 while True:
  if time.monotonic()>=end: expired=True; break
  ready,_,_=select.select([fd],[],[],0.05)
  if ready:
   try: chunk=os.read(fd,65536)
   except OSError: chunk=b''
   if chunk:
    text=chunk.decode('utf-8',errors='replace'); output=(output+text)[-200000:]; pending=(pending+text)[-200000:]
    write_transcript()
    # Reply to bounded terminal discovery queries, including split reads.
    # No keyboard enhancements are advertised; actions remain ordinary UTF-8.
    queries=(queries+text)[-65536:]
    pattern=r'\x1b\[(?:6n|\?u|c)|\x1b\](?:10|11);\?(?:\x07|\x1b\\)'
    consumed=0
    for match in (re.finditer(pattern,queries) if config.get('answerTerminalQueries',True) else []):
     query=match.group()
     if query=='\x1b[6n': reply='\x1b[1;1R'
     elif query=='\x1b[?u': reply='\x1b[?0u'
     elif query=='\x1b[c': reply='\x1b[?1;2c'
     elif query.startswith('\x1b]10;'): reply='\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
     else: reply='\x1b]11;rgb:0000/0000/0000\x1b\\'
     os.write(fd,reply.encode()); consumed=match.end()
    queries=queries[consumed:][-64:]
  plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',pending)
  if config.get('stopWhen') and re.search(config['stopWhen'],plain): break
  if index<len(config['actions']):
   action=config['actions'][index]
   if re.search(action['waitFor'],plain) and (not action.get('waitForPath') or os.path.isfile(action['waitForPath'])):
     time.sleep(min(max(action.get('delayMs',0),0),1000)/1000)
     sent=action['send']
     # Ink-based CLIs treat a text+Enter burst as paste, leaving it unsubmitted.
     if len(sent)>1 and sent.endswith('\r'):
      payload=sent[:-1]
      if action.get('paste'): payload='\x1b[200~'+payload+'\x1b[201~'
      os.write(fd,payload.encode()); time.sleep(0.15); os.write(fd,b'\r')
     else: os.write(fd,sent.encode())
     index+=1; pending=''
  done,status=os.waitpid(pid,os.WNOHANG)
  if done: code=os.waitstatus_to_exitcode(status); break
finally:
 try: os.killpg(pid,signal.SIGKILL)
 except OSError: pass
 try: os.waitpid(pid,0)
 except ChildProcessError: pass
 os.close(fd)
print(json.dumps(dict(code=code,timedOut=expired,actionsCompleted=index,output=output)))
`;

export async function runPty(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    actions: PtyAction[];
    python?: string;
    answerTerminalQueries?: boolean;
    /** Stop promptly at a known prerequisite screen; keep output for classification. */
    stopWhen?: string;
    /** Opt-in live raw terminal trace, overwritten with the latest 200,000 characters. */
    transcriptPath?: string;
  },
): Promise<PtyResult> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("PTY verification requires macOS or Linux");
  return new Promise((resolve, reject) => {
    const child = spawn(options.python ?? "python3", ["-c", DRIVER], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Python handles TERM with finally cleanup of its separate PTY group.
    const unregister = registerVerificationCleanup(() => child.kill("SIGTERM"));
    let output = "",
      error = "";
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      options.timeoutMs + 5000,
    );
    child.stdout.on("data", (data) => {
      output = (output + String(data)).slice(-1_000_000);
    });
    child.stderr.on("data", (data) => {
      error = (error + String(data)).slice(-2000);
    });
    child.on("error", (err) => {
      unregister();
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      unregister();
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(`PTY helper failed (${code}): ${error}`));
      try {
        resolve(JSON.parse(output) as PtyResult);
      } catch {
        reject(new Error("PTY helper returned invalid result"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({ command, args: [command, ...args], ...options }),
    );
  });
}

export function terminalTail(output: string): string {
  return stripVTControlCharacters(output).split(/[\r\n]/).map(line => line.trim()).filter(Boolean).join("\n").slice(-3000);
}
