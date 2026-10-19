-- Optional application-side receiver. The system retains processed actions;
-- event delivery is a hint, while periodic reads recover a missed hint.
local M={}
-- Opt into the system's protected voice entry for this foreground activation.
-- The application owns recording policy and request contents, using the normal
-- mic/AI APIs. The OS routes begin/release to the same VM and releases the claim
-- with that VM. Default voice applications can use this same ordinary helper.
function M.voice_input(begin_input,end_input)
 assert(type(begin_input)=='function' and type(end_input)=='function','voice callbacks required')
 local current;local listeners={}
 local function begin(id)
  if not id or id==current then return end
  local status=notes.call('/sys/apps','read')
  if not status.ok or not status.result.voice_input_held or status.result.voice_request_id~=id then return end
  current=id;begin_input({request_id=id})
 end
 listeners[1]=notes.on('/sys/apps','voice_requested',function(e) begin(e.data.request_id) end)
 listeners[2]=notes.on('/sys/navigation','voice_released',function(e)
  if current and current==e.data.request_id then local id=current;current=nil;end_input({request_id=id}) end
 end)
 local registered=notes.call('/sys/apps','voice_input',{enabled=true});assert(registered.ok,registered.error)
 local status=notes.call('/sys/apps','read')
 if status.ok then local state=status.result;local args=state.arguments or {}
  if state.voice_input_held and args.record and args.voice_request_id==state.voice_request_id then begin(state.voice_request_id) end
 end
 return {stop=function()
  for _,listener in ipairs(listeners) do notes.off(listener) end
  notes.call('/sys/apps','voice_input',{enabled=false});current=nil
 end}
end
function M.listen(handler,options)
 options=options or {};local pending,listeners,timer={},{},nil
 local function acknowledge(key)
  local item=pending[key]
  if not item or not item.reply then return end
  local ack=notes.call('/services/ai','acknowledge',item.reply)
  if ack.ok or ack.error=='ai_action_not_pending' or ack.error=='ai_request_not_found' then pending[key]=nil end
  return ack
 end
 local function receive(id,step,queued)
  if queued then handler(queued,function() end,{id=id,step=step});return end
  local key=tostring(id)..':'..tostring(step)
  if pending[key] then acknowledge(key);return end
  local r=notes.call('/services/ai','read_action',{id=id,step=step})
  if not r.ok then return end
  pending[key]={}
  local function done(ok,result)
   local item=pending[key];if not item then return end
   if not item.reply then item.reply={id=id,step=step,ok=ok~=false,result=result} end
   return acknowledge(key)
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
