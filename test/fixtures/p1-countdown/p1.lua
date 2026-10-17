-- Ordinary test-application behavior. No native GPIO or special kernel hook.
local P={}
local cfg,subscription,active,captured,seen,nextPoll
local function call(path,method,args)
 local r=notes.call(path,method,args or {})
 return r.ok and r.result or nil,r.error
end
local function read(file)
 local stat=call('/fs','stat',{file=file});if not stat then return nil end
 local size=tonumber(stat.size);if not size or size<1 or size>1024 then return nil end
 local r=call('/fs','read',{file=file,offset='0',length=size});if not r then return nil end
 return notes.decode(notes.unhex(r.hex))
end
local function reply(data)
 local text=notes.encode(data);if #text>1024 then return end
 call('/fs','write',{file=cfg.reply_file,text=text,truncate=true})
end
local function context()
 local r=call('/sys/apps','context');return r and r.current
end
function P.start()
 cfg=read(notes.resolve('p1-config.json'));if not cfg then return end
 subscription=notes.on('/services/ai','application_action',function(e)
  if not active or e.data.id~=active then return end
  local r=call('/services/ai','read_action',{id=active,step=e.data.step});if not r then return end
  local a=r.action;local d=a and a.data;local now=context()
  local valid=a and a.topic=='p1_candidate' and type(d)=='table' and type(d.prepare_job_id)=='string'
   and d.application_id==cfg.application_id and d.base_inventory_sha256==captured.inventory_sha256
   and now and now.application_id==captured.application_id and now.instance_id==captured.instance_id
   and now.manifest==captured.manifest and now.inventory_sha256==captured.inventory_sha256
  local result=valid and {prepare_job_id=d.prepare_job_id,application_id=cfg.application_id,
   base_inventory_sha256=captured.inventory_sha256,instance_id=captured.instance_id,
   catalog_revision=captured.catalog_revision} or {error='p1_candidate_identity_rejected'}
  local acknowledged=call('/services/ai','acknowledge',{id=active,step=e.data.step,ok=not not valid,result=result})
  if acknowledged then active=nil end
 end)
 nextPoll=0
end
function P.tick(ready,now,action)
 if not cfg or not ready or now<(nextPoll or 0) then return end
 nextPoll=now+500
 local request=read(cfg.request_file)
 if not request or type(request.request_id)~='string' or request.request_id==seen then return end
 seen=request.request_id
 local consumed=call('/fs','write',{file=cfg.request_file,text='{}',truncate=true})
 if not consumed then reply({request_id=seen,error='mailbox_consume_failed'});return end
 if request.operation=='action' then
  if request.action~='toggle' and request.action~='reset' then return end
  action(request.action);reply({request_id=seen,action=request.action,accepted=true});return
 end
 if request.operation~='edit' then return end
 if active then reply({request_id=seen,error='edit_already_pending',task_id=active});return end
 local session=request.session
 if type(session)~='table' or type(session.session_id)~='string' or type(session.runtime_id)~='string'
  or type(session.session_scope)~='string' then reply({request_id=seen,error='session_reference_required'});return end
 captured=context()
 if not captured or captured.application_id~=cfg.application_id or not captured.inventory_sha256
  or not captured.view then reply({request_id=seen,error='current_context_required'});return end
 local prompt='这是隔离的P1应用修改验收。只修改系统context.current所指应用，保持application_id。'
  ..'请读取WishOS applications/packages指导和当前包，只做只读发现及stage_resource/prepare_package，'
  ..'不要deploy/update、不要写设备、不要直接调用任何变更方法。生成完整新不可变候选包，'
  ..'保留p1.lua及p1-config.json字节和所有功能。只调整当前倒计时页面的时间数字字号和必要排版，'
  ..'保持320x240可读、不裁切、继承系统字体；减号用ASCII。修改请求：'..tostring(request.text or '时间数字大一点')
  ..'。完成完整目标预检后，只返回wishos-result/2的一个application动作，recipient=origin，wait=processed，'
  ..'topic=p1_candidate，data={prepare_job_id:已完成prepare_package任务ID,application_id:当前ID,'
  ..'base_inventory_sha256:系统current.inventory_sha256}。禁止顶层files、sequence和system动作；'
  ..'候选文件仍在服务器，待单独确认安装。不得触碰其他应用、系统设置、音频、相机、电源或外部服务。'
 local r,error=call('/services/ai','submit',{request_id=seen,timeout_ms=request.timeout_ms or 900000,
  input={kind='text',text=prompt,runtime_id=session.runtime_id,session_id=session.session_id,
   session_scope=session.session_scope,intent={effect='application_update',target_context='current'}}})
 if not r then reply({request_id=seen,error=error or 'submit_failed'});return end
 active=r.id
 reply({request_id=seen,task_id=active,remote_request_id=r.request_id,application_id=cfg.application_id,
  instance_id=captured.instance_id,base_inventory_sha256=captured.inventory_sha256,
  catalog_revision=captured.catalog_revision})
end
function P.stop()
 if subscription then notes.off(subscription);subscription=nil end
 -- The OS owns accepted AI work. Removing this VM never cancels/replays it.
end
return P
