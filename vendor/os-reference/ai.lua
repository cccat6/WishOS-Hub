-- Optional application-side receiver. The system retains processed actions;
-- event delivery is a hint, while periodic reads recover a missed hint.
local M={}
function M.listen(handler,options)
 options=options or {};local pending,listeners,timer={},{},nil
 local function receive(id,step,queued)
  if queued then handler(queued,function() end,{id=id,step=step});return end
  local key=tostring(id)..':'..tostring(step)
  if pending[key] then return end
  local r=notes.call('/services/ai','read_action',{id=id,step=step})
  if not r.ok then return end
  pending[key]=true
  local function done(ok,result)
   if not pending[key] then return end
   local ack=notes.call('/services/ai','acknowledge',{id=id,step=step,ok=ok~=false,result=result})
   if ack.ok or ack.error=='ai_action_not_pending' or ack.error=='ai_request_not_found' then pending[key]=nil end
   return ack
  end
  local ok,result=pcall(handler,r.result.action,done,{id=id,step=step})
  if not ok then done(false)
  elseif result~=false then done(true,type(result)=='table' and result or nil) end
 end
 local function recover()
  local r=notes.call('/services/ai','read',{})
  if not r.ok then return end
  local live={}
  for _,task in ipairs(r.result.tasks) do
   if task.state=='awaiting_application' then
    local key=tostring(task.id)..':'..tostring(task.step);live[key]=true;receive(task.id,task.step)
   end
  end
  for key in pairs(pending) do if not live[key] then pending[key]=nil end end
 end
 listeners[1]=notes.on('/services/ai','application_action',function(e)
  receive(e.data.id,e.data.step,e.data.data and {topic=e.data.topic,data=e.data.data,wait='queued'} or nil)
 end)
 local t=notes.call('/sys/timers','write',{delay_ms=options.recover_ms or 1000,period_ms=options.recover_ms or 1000})
 assert(t.ok,t.error);timer=t.result.id
 listeners[2]=notes.on('/sys/timers','fired',recover,{where={id=timer}})
 recover()
 return {recover=recover,stop=function()
  for _,id in ipairs(listeners) do notes.off(id) end
  notes.call('/sys/timers','remove',{id=timer});pending={}
 end}
end
return M
