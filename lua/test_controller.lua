-- Anna: offline checks, no GT/Discord/network calls.
local dir = (debug.getinfo(1, 'S').source:sub(2):match('(.*/)') or './')
local bridge = dofile(dir .. 'controller.lua')
local json = dofile(dir .. 'json.lua')
local path = os.tmpname(); os.remove(path)
local calls, posts, poll, failReport = 0, {}, nil, false
local cfg = {api_url='http://127.0.0.1:8080', api_token='local-test-token-only',
    journal_path=path, module_dir=dir,
    addbot={addAndVerifyBot=function()
        calls=calls+1; return {}, 'ONLINE'
    end}}
cfg.request=function(method, endpoint, body)
    if method == 'POST' then
        posts[#posts+1]=body
        return {error=0,status=failReport and 503 or 200}
    end
    return poll or {error=0,status=204}
end
local function job(id, action)
    return {error=0,status=200,body=json.encode({job_id=id,bot_id='bot_1',
        action=action or 'addbot',account={name='TEST',password='mock-only'}})}
end
local c=bridge.new(cfg)
assert(select(2,c.step())=='IDLE')
poll=job('j1'); assert(c.step()); assert(calls==1 and posts[#posts].status=='success')
assert(c.step()); assert(calls==1) -- duplicate delivery
c=bridge.new(cfg); assert(c.step()); assert(calls==1) -- restart dedupe
failReport=true; poll=job('j2'); assert(not c.step()); assert(calls==2)
assert(not c.step()); assert(calls==2) -- retry reports only
failReport=false; poll=nil; assert(c.step()); assert(calls==2)
poll=job('bad','run_arbitrary_lua'); assert(c.step()); assert(calls==2)
assert(posts[#posts].error=='INVALID_JOB')
poll={error=0,status=200,body='not json'}; assert(not c.step())
poll={error=1,status=0}; assert(not c.step()); assert(calls==2)
local f=assert(io.open(path,'rb')); local raw=f:read('*a'); f:close()
assert(not raw:find('mock-only',1,true))
-- Simulate process dying after journal claim, before result.
f=assert(io.open(path,'wb')); f:write(json.encode({version=1,jobs={crashed={status='executing',reported=false}}})); f:close()
c=bridge.new(cfg); poll=nil; assert(c.step()); assert(calls==2)
assert(posts[#posts].status=='stalled' and posts[#posts].error=='RESTART_UNCERTAIN')
-- Corruption must fail closed.
f=assert(io.open(path,'wb')); f:write('broken'); f:close()
assert(not pcall(bridge.new,cfg)); os.remove(path)
-- Exercise actual HttpClient adapter/header/body construction with a local mock.
Method={get=1,post=2}
local httpCalls=0
HttpClient={new=function() return {setMethod=function(self,m) self.method=m end,
    request=function(self)
        httpCalls=httpCalls+1
        assert(self.headers.Authorization=='Bearer '..cfg.api_token)
        assert(self.timeout==10)
        if self.method==1 then return job('adapter') end
        assert(self.url:match('/api/jobs/adapter/status$'))
        assert(self.content:find('"error":null',1,true))
        assert(json.decode(self.content).status=='success')
        return {error=0,status=200}
    end} end}
cfg.request=nil; c=bridge.new(cfg); assert(c.step()); assert(httpCalls==2 and calls==3)
os.remove(path); os.remove(path..'.tmp')
print('controller: idle, execution, duplicate/restart, report retry, invalid action/JSON, network failure, secret-free journal, crash recovery, corruption, HTTP adapter: PASS')
