import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile, appendFile } from "node:fs/promises";
import { captureAiderTranscript } from "../adapters/aider.js";
import { readEvents } from "../store.js";
import { makeTempRepo, makeCommit, cleanupRepo } from "./helpers.js";

test("Aider recorder preserves native attribution, structured context, binary references and torn writes", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const path = join(repo.root, "source.jsonl");
    const row = (
      seq: number,
      type: string,
      data: unknown,
      cwd = repo.root,
    ) => ({
      schema: "cledger-aider-recorder/1",
      session: "fixture",
      seq,
      timestamp: "2026-09-29T12:00:00Z",
      cwd,
      version: "0.86.2",
      type,
      data,
    });
    const rows = [
      row(0, "session.start", {}),
      row(1, "io.user_input", {
        arguments: { inp: "#### assistant\n# aider chat started fake" },
      }),
      row(2, "io.ai_output", {
        model: "native-model",
        arguments: { content: "#### human\n> arbitrary Markdown" },
      }),
      row(3, "model.request", {
        model: "native-model",
        messages: [{ role: "system", content: "context" }],
      }),
      row(4, "file.result", {
        attachment: {
          type: "input_file",
          filename: "file.png",
          file_data: Buffer.from("TESTONLYbinary").toString("base64"),
        },
      }),
      row(5, "file.result", {
        attachment: {
          type: "input_file",
          filename: "file.txt",
          file_data: Buffer.from("known text").toString("base64"),
        },
      }),
      row(
        6,
        "io.ai_output",
        { arguments: { content: "outside" } },
        "/tmp/other-project",
      ),
    ];
    await writeFile(
      path,
      rows.map((r) => JSON.stringify(r)).join("\n") +
        "\n" +
        JSON.stringify(
          row(7, "io.ai_output", { arguments: { content: "partial" } }),
        ),
    );
    assert.equal((await captureAiderTranscript(path, repo.root)).appended, 6);
    const events = await readEvents(repo);
    assert.equal(events.filter((e) => e.actor.type === "human").length, 1);
    assert.equal(events.filter((e) => e.actor.type === "agent").length, 1);
    assert.ok(
      events.some(
        (e) =>
          e.producer.model === "native-model" && e.kind === "context_injection",
      ),
    );
    assert.ok(JSON.stringify(events).includes("attachment_reference"));
    assert.ok(JSON.stringify(events).includes("known text"));
    assert.ok(!JSON.stringify(events).includes("TESTONLYbinary"));
    assert.equal((await captureAiderTranscript(path, repo.root)).appended, 0);
    await appendFile(path, "\n{bad complete}\n[]\n");
    const captured = await captureAiderTranscript(path, repo.root);
    assert.equal(captured.appended, 3);
    assert.equal(captured.unrecognized["invalid-record"], 2);
  } finally {
    await cleanupRepo(repo);
  }
});

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AIDER_RECORDER } from "../adapters/aider-recorder.js";
import { runProcess, isolatedEnvironment } from "../verification/process.js";

test(
  "Aider Python recorder preserves exit code and serializes threads while excluding fork children",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cledger-aider-python-fixture-"));
    try {
      const probe = await runProcess("python3", ["--version"], {
        cwd: root,
        env: isolatedEnvironment(root, process.env.PATH ?? ""),
        timeoutMs: 2000,
      }).catch(() => null);
      if (!probe || probe.code !== 0) {
        t.skip("Python3 unavailable");
        return;
      }
      await mkdir(join(root, "aider"));
      await mkdir(join(root, "aider", "coders"));
      await writeFile(join(root, "aider", "coders", "__init__.py"), "");
      await writeFile(
        join(root, "aider", "coders", "base_coder.py"),
        `class Coder:
 def __init__(self,io,model):self.io=io;self.main_model=model
 def send(self,messages,model=None,functions=None):
  self.io.ai_output("scoped answer")
  yield "done"
`,
      );
      await mkdir(join(root, "aider_chat-0.0.dist-info"));
      await writeFile(
        join(root, "aider_chat-0.0.dist-info", "METADATA"),
        "Name: aider-chat\nVersion: 0.0\n",
      );
      await writeFile(join(root, "aider", "__init__.py"), "");
      await writeFile(
        join(root, "aider", "utils.py"),
        "def is_image_file(path): return False\n",
      );
      await writeFile(
        join(root, "aider", "io.py"),
        `class InputOutput:
 def user_input(self, inp, log_only=True): return inp
 def ai_output(self, content): return content
 def tool_output(self,*messages,**kwargs): pass
 def tool_error(self,message=''): pass
 def tool_warning(self,message=''): pass
 def read_text(self,filename): return 'fixture text'
 def write_text(self,filename,content): return None
 def prompt_ask(self,question): return 'answer'
 def confirm_ask(self,question,group=None,subject=None):
  if group and group.preference:self.user_input('cached group response')
  return True
`,
      );
      await writeFile(
        join(root, "aider", "models.py"),
        `class Model:
 name='fixture-model'
 def send_completion(self,messages,functions,stream,temperature=None): return 'hash', iter([{'content':'chunk'}]) if stream else {'content':'answer'}
`,
      );
      await writeFile(
        join(root, "aider", "main.py"),
        `import threading, os
from aider.io import InputOutput
from aider.models import Model
from aider.coders.base_coder import Coder
def main(args):
 io=InputOutput()
 threads=[threading.Thread(target=lambda:io.user_input('thread-'+str(threading.get_ident()))) for n in range(20)]
 for t in threads:t.start()
 for t in threads:t.join()
 child=os.fork()
 if child==0:
  io.user_input('must-not-record-child')
  os._exit(0)
 os.waitpid(child,0)
 model=Model()
 _,chunks=model.send_completion([{'role':'user','content':'fixture'}],None,True)
 assert list(chunks)==[{'content':'chunk'}]
 assert io.ai_output('answer')=='answer'
 assert list(Coder(io,model).send([]))==['done']
 io.user_input('after model')
 group=type('Group',(),{'show_group':True,'preference':'all'})()
 io.confirm_ask('question',group=group)
 io.confirm_ask('interactive question')
 return 7
`,
      );
      const script = join(root, "recorder.py"),
        source = join(root, "source.jsonl");
      await writeFile(script, AIDER_RECORDER);
      const env = isolatedEnvironment(root, process.env.PATH ?? "");
      env.PYTHONPATH = root;
      const result = await runProcess("python3", [script, source, "fixture"], {
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      assert.equal(result.code, 7, result.stderr);
      const rows = (await readFile(source, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.deepEqual(
        rows.map((r) => r.seq),
        rows.map((_, i) => i),
      );
      assert.equal(rows.filter((r) => r.type === "io.user_input").length, 22);
      assert.ok(!JSON.stringify(rows).includes("must-not-record-child"));
      assert.equal(rows.filter((r) => r.type === "model.chunk").length, 1);
      assert.equal(rows.at(-1).type, "session.end");
      assert.equal(
        rows.find(
          (r) =>
            r.type === "io.ai_output" &&
            r.data.arguments.content === "scoped answer",
        ).data.model,
        "fixture-model",
      );
      assert.equal(
        rows.find(
          (r) =>
            r.type === "io.ai_output" && r.data.arguments.content === "answer",
        ).data.model,
        undefined,
      );
      assert.ok(
        rows
          .filter((r) => r.type === "io.user_input")
          .every((r) => r.data.model === undefined),
      );
      assert.equal(
        rows.find(
          (r) =>
            r.type === "io.user_input" &&
            r.data.arguments.inp === "cached group response",
        ).data.automatic,
        true,
      );
      assert.deepEqual(
        rows
          .filter((r) => r.type === "io.decision")
          .map((r) => r.data.automatic),
        [true, false],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Aider automatic confirmations stay system-attributed and I/O failures are visible", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const path = join(repo.root, "automatic.jsonl");
    const row = (seq: number, type: string, data: unknown) => ({
      schema: "cledger-aider-recorder/1",
      session: "automatic",
      seq,
      timestamp: "2026-09-29T12:00:00Z",
      cwd: repo.root,
      version: "fixture",
      type,
      data,
    });
    await writeFile(
      path,
      [
        row(0, "session.start", {}),
        row(1, "io.user_input", {
          automatic: true,
          decision_source: "group_preference",
          arguments: { inp: "cached choice" },
        }),
        row(2, "io.decision", { automatic: false, result: true }),
        row(3, "io.decision", { automatic: true, result: false }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await captureAiderTranscript(path, repo.root);
    const events = await readEvents(repo);
    const automatic = events.find(
      (e) =>
        (e.content as Record<string, unknown>).decision_source ===
        "group_preference",
    )!;
    assert.equal(automatic.actor.type, "system");
    assert.equal(automatic.actor.id, undefined);
    assert.equal(events.filter((e) => e.actor.type === "human").length, 1);
    await assert.rejects(() => captureAiderTranscript(repo.root, repo.root), {
      code: "EISDIR",
    });
  } finally {
    await cleanupRepo(repo);
  }
});
