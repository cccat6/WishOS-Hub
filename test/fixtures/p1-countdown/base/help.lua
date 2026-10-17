local H={}
local function names(buttons,mask)
 local out={}
 for name,b in pairs(buttons or {}) do
  if type(b.index)=='number' and ((mask or 0)&(1<<b.index))~=0 then out[#out+1]=name end
 end
 table.sort(out);return #out>0 and table.concat(out,'+') or '系统按键'
end
function H.pages(nav,buttons)
 local entries={'触摸: -5分 / +5分 / 开始暂停 / 重置','重置或重开: 05:00 暂停','本机离线计时，时间到停止','帮助键翻页；渲染失败后显式重试','桌面/语音按钮使用系统入口'}
 if nav then
  if (nav.home_buttons or 0)~=0 then
   local n=names(buttons,nav.home_buttons)
   if (nav.home_clicks or 0)>0 then entries[#entries+1]='Home: '..n..'连按'..tostring(nav.home_clicks)..'次'
   elseif nav.home_hold_ms then entries[#entries+1]='Home: '..n..'长按'..tostring(nav.home_hold_ms)..'ms' end
  end
  if (nav.voice_buttons or 0)~=0 and nav.voice_hold_ms then entries[#entries+1]='语音: '..names(buttons,nav.voice_buttons)..'长按'..tostring(nav.voice_hold_ms)..'ms' end
 else entries[#entries+1]='未读系统按键配置，使用屏幕入口' end
 local lines={}
 for _,entry in ipairs(entries) do
  local chars={}
  for _,cp in utf8.codes(entry) do
   chars[#chars+1]=utf8.char(cp)
   if #chars==18 then lines[#lines+1]=table.concat(chars);chars={} end
  end
  if #chars>0 then lines[#lines+1]=table.concat(chars) end
 end
 local pages={}
 for i=1,#lines,2 do pages[#pages+1]={lines[i],lines[i+1] or ''} end
 return pages
end
return H
