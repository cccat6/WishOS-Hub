-- Runtime gesture composition. Physical debounce and edge timestamps come from
-- the input driver; meanings, combinations and their timing are application data.
local M={}
local function captured(event)
 if event.event=='press' or event.event=='release' then return event.data.edge_at_ms end
 return event.data.captured_at_ms
end
local function elapsed(now,before) return (now-before)%4294967296 end
local function in_window(value,min,max,jitter)
 return (not min or value+jitter>=min) and (not max or value<=max+jitter)
end
function M.watch(source,patterns,callback)
 local snapshot=notes.call(source,'read',{});assert(snapshot.ok,snapshot.error)
 local keys={}
 for name,state in pairs(snapshot.result.buttons) do
  keys[name]={index=state.index,down=state.pressed,at=state.pressed_at_ms,known=state.pressed}
 end
 local progress,pending={},{}
 local function cancel(id)
  local p=pending[id]
  if p then notes.off(p.listener);notes.call('/sys/timers','remove',{id=p.timer});pending[id]=nil end
 end
 local function matches(rule,event)
  local data=event.data;local now=captured(event);local jitter=rule.jitter_ms or 0
  if rule.event and rule.event~=event.event then return false end
  if rule.button and rule.button~=data.button then return false end
  if rule.count and rule.count~=data.count then return false end
  if not in_window(data.held_ms or 0,rule.min_hold_ms,rule.max_hold_ms,jitter) then return false end
  for name,requirement in pairs(rule.with or {}) do
   local key=keys[name];if not key then return false end
   if requirement.down~=nil and key.down~=requirement.down then return false end
   if requirement.min_hold_ms or requirement.max_hold_ms then
    if not key.down or not key.known or not in_window(elapsed(now,key.at),requirement.min_hold_ms,requirement.max_hold_ms,jitter) then return false end
   end
  end
  if rule.chord then
   local youngest,oldest=nil,0
   for _,name in ipairs(rule.chord.buttons) do
    local key=keys[name];if not key or not key.down or not key.known then return false end
    local age=elapsed(now,key.at);oldest=math.max(oldest,age);youngest=youngest and math.min(youngest,age) or age
   end
   if not youngest or oldest-youngest>(rule.chord.window_ms or 75)+jitter then return false end
  end
  return true
 end
 local function fire(pattern,event)
  for _,id in ipairs(pattern.cancel_pending or {}) do cancel(id) end
  if (pattern.defer_ms or 0)>0 then
   cancel(pattern.id)
   local t=notes.call('/sys/timers','write',{delay_ms=pattern.defer_ms});assert(t.ok,t.error)
   local timer=t.result.id
   local listener=notes.on('/sys/timers','fired',function()
    pending[pattern.id]=nil;callback(pattern.id,event)
   end,{once=true,where={id=timer}})
   pending[pattern.id]={timer=timer,listener=listener};return pattern.consume==true
  end
  return callback(pattern.id,event)==true or pattern.consume==true
 end
 local listener=notes.on(source,{'press','release','long_press','repeat','click'},function(event)
  local data=event.data;local now=captured(event)
  for _,key in pairs(keys) do local down=(data.pressed_mask&(1<<key.index))~=0;if down and not key.down then key.known=false end;key.down=down end
  local key=keys[data.button]
  if key then key.at=data.pressed_at_ms;key.known=true end
  local consumed=false
  for i,pattern in ipairs(patterns) do
   assert(type(pattern.id)=='string','pattern id required')
   local steps=pattern.steps or {pattern};local p=progress[i] or {step=1,at=now};progress[i]=p
   local rule=steps[p.step]
   if p.step>1 and rule.within_ms and elapsed(now,p.at)>rule.within_ms+(rule.jitter_ms or 0) then p.step=1;rule=steps[1] end
   if matches(rule,event) and (p.step==1 or in_window(elapsed(now,p.at),rule.after_ms,rule.within_ms,rule.jitter_ms or 0)) then
    if p.step==#steps then p.step=1;consumed=fire(pattern,event) or consumed
    else p.step=p.step+1;p.at=now end
   elseif pattern.reset_on_other then p.step=1 end
  end
  return consumed
 end)
 return {stop=function()
  notes.off(listener)
  for id in pairs(pending) do cancel(id) end
 end}
end
return M
