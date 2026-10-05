/** Executed by the user's selected Aider Python environment; never modifies it. */
export const AIDER_RECORDER = String.raw`
import os, sys, json, uuid, threading, datetime, inspect, functools, base64
from importlib.metadata import version
path, session = sys.argv[1:3]
args = sys.argv[3:]
sys.argv = ["aider", *args]
lock = threading.RLock()
seq = 0
origin_pid = os.getpid()
local = threading.local()
failed = False

def safe(value):
    if value is None or isinstance(value, (str, int, float, bool)): return value
    if isinstance(value, dict): return {str(k): safe(v) for k,v in value.items()}
    if isinstance(value, (list, tuple)): return [safe(v) for v in value]
    if hasattr(value, 'model_dump'): return safe(value.model_dump())
    return {'unsupported_python_type': type(value).__name__}

def emit(kind, data):
    global seq, failed
    # A forked subprocess is not the parent's conversation and must not share its lock/sequence.
    if os.getpid() != origin_pid: return
    try:
        with lock:
            row = dict(schema='cledger-aider-recorder/1', session=session, seq=seq,
                timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(), cwd=os.getcwd(),
                version=version('aider-chat'), type=kind, data=safe(data))
            seq += 1
            encoded = (json.dumps(row, ensure_ascii=False)+'\n').encode('utf-8')
            fd = os.open(path, os.O_WRONLY|os.O_APPEND|os.O_CREAT, 0o600)
            try:
                view = memoryview(encoded)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
            finally: os.close(fd)
    except Exception:
        if not failed: print('cledger: Aider recorder write failed; capture incomplete', file=sys.stderr)
        failed = True

def bind(method, self, args, kwargs):
    return inspect.signature(method).bind(self, *args, **kwargs).arguments

from aider.io import InputOutput
from aider.models import Model
from aider.coders.base_coder import Coder
from aider.main import main
required = {InputOutput: ['user_input','ai_output','tool_output','tool_error','tool_warning','read_text','write_text','prompt_ask','confirm_ask'], Model: ['send_completion'], Coder: ['send']}
for cls, names in required.items():
    for name in names:
        if not callable(getattr(cls, name, None)):
            emit('recorder.unsupported', {'method': cls.__name__+'.'+name})
            raise SystemExit('cledger: unsupported Aider API; refusing incomplete capture')

expected = {InputOutput.user_input:['inp'], InputOutput.ai_output:['content'], InputOutput.read_text:['filename'], InputOutput.write_text:['filename','content'], Model.send_completion:['messages','functions','stream'], Coder.send:['messages','model']}
for method, parameters in expected.items():
    if not all(p in inspect.signature(method).parameters for p in parameters):
        emit('recorder.unsupported', {'method':method.__qualname__, 'reason':'signature changed'})
        raise SystemExit('cledger: unsupported Aider API signature; refusing incomplete capture')

for name in required[InputOutput]:
    def install(name):
        original = getattr(InputOutput, name)
        @functools.wraps(original)
        def wrapper(self, *args, **kwargs):
            values = bind(original, self, args, kwargs)
            values.pop('self', None)
            call_id = str(uuid.uuid4())
            if name in ['read_text','write_text']:
                emit('file.operation', {'method': name, 'call_id':call_id, 'path':str(values.get('filename')), 'dry_run':bool(getattr(self,'dry_run',False))})
            prior_decision = getattr(local,'decision',None)
            decision_source = None
            if name in ['prompt_ask','confirm_ask']:
                group = values.get('group')
                if name == 'confirm_ask' and (values.get('question'),values.get('subject')) in getattr(self,'never_prompts',set()): decision_source = 'never_prompt'
                elif getattr(self,'yes',None) is not None: decision_source = 'yes_setting'
                elif name == 'confirm_ask' and group and getattr(group,'show_group',False) and getattr(group,'preference',None): decision_source = 'group_preference'
                else: decision_source = 'interactive'
                local.decision = (self, decision_source)
            try: result = original(self, *args, **kwargs)
            except BaseException as error:
                emit('method.error', {'method':name,'call_id':call_id,'error_type':type(error).__name__})
                raise
            finally:
                if decision_source is not None: local.decision = prior_decision
            data = {'method':name, 'call_id':call_id}
            scoped_model = getattr(local,'assistant_model',None)
            if name == 'ai_output' and scoped_model and scoped_model[0] is self: data['model'] = scoped_model[1]
            if name == 'user_input' and prior_decision and prior_decision[0] is self:
                data['automatic'] = prior_decision[1] != 'interactive'
                data['decision_source'] = prior_decision[1]
            if name in ['read_text','write_text']:
                content = result if name == 'read_text' else values.get('content')
                data.update(path=str(values.get('filename')), dry_run=bool(getattr(self,'dry_run',False)), returned_none=result is None)
                if isinstance(content, str):
                    filename = str(values.get('filename'))
                    # Images are returned as base64 by native read_text; all other strings are text.
                    from aider.utils import is_image_file
                    payload = content if is_image_file(filename) and name == 'read_text' else base64.b64encode(content.encode('utf-8')).decode('ascii')
                    data['attachment'] = {'type':'input_file','filename':filename,'file_data':payload}
                emit('file.result',data)
            elif name in ['prompt_ask','confirm_ask']:
                data.update(arguments=values, result=result, automatic=decision_source != 'interactive', decision_source=decision_source)
                emit('io.decision',data)
            else:
                data['arguments'] = values
                emit('io.'+name,data)
            return result
        setattr(InputOutput,name,wrapper)
    install(name)

original_coder_send = Coder.send
@functools.wraps(original_coder_send)
def coder_send(self, *args, **kwargs):
    values = bind(original_coder_send,self,args,kwargs)
    model = values.get('model') or self.main_model
    previous = getattr(local,'assistant_model',None)
    local.assistant_model = (self.io,model.name)
    try: return (yield from original_coder_send(self,*args,**kwargs))
    finally: local.assistant_model = previous
Coder.send = coder_send

original_send = Model.send_completion
@functools.wraps(original_send)
def send(self, *args, **kwargs):
    values = bind(original_send, self, args, kwargs)
    call_id = str(uuid.uuid4())
    emit('model.request', {'call_id':call_id,'model':self.name,'messages':values.get('messages'), 'functions':values.get('functions'), 'stream':values.get('stream'), 'temperature':values.get('temperature')})
    try: digest, response = original_send(self,*args,**kwargs)
    except BaseException as error:
        emit('model.error',{'call_id':call_id,'model':self.name,'error_type':type(error).__name__})
        raise
    if values.get('stream'):
        def chunks():
            try:
                for chunk in response:
                    emit('model.chunk',{'call_id':call_id,'model':self.name,'response':chunk})
                    yield chunk
            finally: emit('model.end',{'call_id':call_id,'model':self.name})
        return digest, chunks()
    emit('model.response',{'call_id':call_id,'model':self.name,'response':response})
    return digest,response
Model.send_completion = send
emit('session.start', {'capabilities':['native-io','model-requests','model-responses','file-operations','decisions'], 'unavailable':['unwrapped-sessions','native-subagent-parentage','opaque-provider-internals']})
try:
    code = main(args)
    raise SystemExit(code)
finally:
    emit('session.end', {'recorder_failed':failed})
`;
