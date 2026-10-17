-- Ordinary app; no capability calls during module evaluation.
local H=notes.require('help.lua')
local DEFAULT,MAX=300000,5999000
local remaining,deadline,now=DEFAULT,nil,0
local view,activation,layout,shown,job
local ready,pending,stopped,leaving,blocked=false,false,false,false,false
local completeKey,displayToken,touchToken,timer
local listeners={}
local down,pressed=true,nil
local pages={{'触摸开始暂停，重置为5分钟','帮助翻页；系统入口不改绑定'}}
local page=1
local problem,touchProblem='',''
local touchPending,stream=false,false
local nextTouch=0
local pump
local function call(path,method,args)
 local r=notes.call(path,method,args or {})
 if r.ok then return r.result end
 return nil,r.error
end
local function on(path,event,fn) listeners[#listeners+1]=notes.on(path,event,fn) end
local function describe(path) return call('/sys/capabilities','describe',{path=path}) or {} end
local function has(c,method) return notes.find(','..(c.methods or '')..',',','..method..',')~=nil end
local function settle()
 local r=call('/sys/clock','read')
 if not r or type(r.monotonic_ms)~='number' or r.monotonic_ms<now then
  deadline=nil;problem='时钟异常，已暂停';return nil
 end
 now=r.monotonic_ms
 if problem=='时钟异常，已暂停' then problem='' end
 if deadline then remaining=math.max(0,deadline-now);if remaining==0 then deadline=nil end end
 return now
end
local function model()
 local s=math.ceil(remaining/1000);local p=pages[page]
 return {digits=string.format('%02d:%02d',math.floor(s/60),s%60),
 status=problem~='' and problem or (touchProblem~='' and touchProblem or (remaining==0 and '时间到' or (deadline and '进行中' or '已暂停'))),
 toggleText=deadline and '暂停' or '开始',helpButton=blocked and '重试' or '帮助',help1=p[1],help2=p[2]}
end
local function failed(error)
 blocked=true;completeKey=nil;pressed=nil;problem='显示停止，请显式重试'
 print('display stopped: '..tostring(error or 'unknown_error'))
end
pump=function()
 if stopped or leaving or pending or blocked then return end
 local values=model();local key=notes.encode(values)
 if key==completeKey then return end
 local method,args
 if view then method='update';args={view_id=view,values=values}
 else method='open';args={path=notes.resolve('ui.json'),history='replace',values=values} end
 pending=true
 local r,token=notes.request('/sys/ui',method,args,function(e)
  pending=false;displayToken=nil
  if stopped or leaving then return end
  if e.event=='completed' then ready=true;shown=e.data.view_revision;completeKey=key;pump()
  else failed(e.data.error or (e.data.completion and e.data.completion.error)) end
 end)
 if r.ok then
  displayToken=token;job=r.result.job_id
  if not view then view=r.result.view_id;activation=r.result.activation;layout=r.result.revision end
 else pending=false;failed(r.error) end
end
local function context(d)
 if not ready or stopped or leaving then return false end
 if d.presentation_id and d.presentation_id~=view then return false end
 if d.presentation_activation and d.presentation_activation~=activation then return false end
 if d.presentation_revision and d.presentation_revision<layout then return false end
 return true
end
local function systemEntry(method)
 if not has(describe('/sys/apps'),method) then problem='系统入口不可用';pump();return end
 leaving=true;pressed=nil
 local r=notes.request('/sys/apps',method,{},function(e)
  if e.event~='launched' then leaving=false;problem='系统入口失败';completeKey=nil;pump() end
 end)
 if not r.ok then leaving=false;problem='系统入口失败';completeKey=nil;pump() end
end
local function act(id)
 if id=='home' then systemEntry('home');return end
 if id=='voice' then systemEntry('voice');return end
 if blocked then
  if id=='help' then blocked=false;problem='';completeKey=nil;pump() end
  return
 end
 local t=settle()
 if id=='toggle' then
  if deadline then deadline=nil
  elseif t then if remaining==0 then remaining=DEFAULT end;deadline=t+remaining end
 elseif id=='reset' then remaining=DEFAULT;deadline=nil
 elseif id=='minus' then
  remaining=math.max(0,remaining-300000)
  if deadline then deadline=remaining>0 and (t+remaining) or nil end
 elseif id=='plus' then remaining=math.min(MAX,remaining+300000);if deadline then deadline=t+remaining end
 elseif id=='help' then page=page%#pages+1 end
 pump()
end
local function hit(p)
 if not p then return nil end
 local r=call('/sys/ui','hit_test',{view_id=view,x=p.x,y=p.y})
 if not r or r.revision<layout then return nil end
 for _,id in ipairs(r.ids or {}) do
  if id=='home' or id=='voice' or id=='help' or id=='minus' or id=='plus' or id=='toggle' or id=='reset' then return id end
 end
end
local function sample(e)
 local d=e.data
 if type(d.count)~='number' then pressed=nil;down=true;return end
 touchProblem=''
 if not context(d) then pressed=nil;down=d.count~=0;return end
 if d.count==1 then
  local id=hit(d.contacts and d.contacts[1])
  if not down and id then pressed={id=id,activation=activation}
  elseif pressed and pressed.id~=id then pressed=nil end
  down=true
 elseif d.count>1 then pressed=nil;down=true
 else
  local p=pressed;pressed=nil;down=false
  if p and p.activation==activation then act(p.id) end
 end
end
function on_start()
 remaining=DEFAULT;deadline=nil;settle()
 local nav=call('/sys/navigation','read');local b=call('/dev/buttons','read')
 pages=H.pages(nav,b and b.buttons or {});page=1
 local touch=describe('/dev/touch');local input=touch.input_stream
 if input and input.method and input.event then
  on('/dev/touch',input.event,sample)
  local r=call('/dev/touch',input.method,{enabled=true});stream=r~=nil
 end
 on('/dev/touch',{'failed','input_overflow'},function()
  down=true;pressed=nil;touchProblem='触摸中断，请重新轻触'
 end)
 on('/sys/timers','fired',function(e)
  if stopped or e.data.id~=timer then return end
  settle()
  if not stream and not touchPending and has(touch,'measure') and now>=nextTouch then
   touchPending=true;nextTouch=now+100
   local r,token=notes.request('/dev/touch','measure',{},function(event)
    touchPending=false;touchToken=nil
    if stopped then return end
    if event.event=='completed' then sample(event)
    else down=true;pressed=nil;touchProblem='触摸暂不可用' end
   end)
   if r.ok then touchToken=token else touchPending=false;touchProblem='触摸请求失败';nextTouch=now+1000 end
  end
  pump()
 end)
 local r,e=call('/sys/timers','write',{delay_ms=100,period_ms=100});assert(r,e);timer=r.id
 if not stream and not has(touch,'measure') then touchProblem='未发现触摸输入合同' end
 pump()
end
function on_stop()
 stopped=true;ready=false;pressed=nil;deadline=nil
 if timer then call('/sys/timers','remove',{id=timer}) end
 if displayToken then notes.off(displayToken) end
 if touchToken then notes.off(touchToken) end
 for _,token in ipairs(listeners) do notes.off(token) end
 listeners={}
 -- OS owner cleanup releases views/streams; admitted display work is not interrupted.
end
