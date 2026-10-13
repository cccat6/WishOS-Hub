import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHardwareMcp } from '../src/hardware-mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('generic discovery and invocation keep real device results and bounded requests', async () => {
  const requests: {path: string; method: string}[] = [];
  const server = createHardwareMcp('http://192.0.2.10', async (_url, init) => {
    const call = JSON.parse(String(init?.body)) as {path:string;method:string}; requests.push(call);
    return new Response(JSON.stringify({ok:call.path !== '/missing',id:'r',boot_id:'b',result:{job_id:7,status:'queued'}}), {status:call.path === '/missing'?409:200});
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({name:'test',version:'1'});
  await client.connect(clientTransport);
  try {
    const list = await client.listTools();assert.deepEqual(list.tools.map(t=>t.name),['hardware_discover','hardware_invoke']);
    const discover = await client.callTool({name:'hardware_discover',arguments:{}});assert.equal(discover.isError,false);assert.equal(requests.length,2);
    const result=await client.callTool({name:'hardware_invoke',arguments:{path:'/dev/display',method:'clear',args:{}}});assert.equal(result.isError,false);
    assert.equal(JSON.parse((result.content as {text:string}[])[0]!.text).result.status,'queued');
    const fail=await client.callTool({name:'hardware_invoke',arguments:{path:'/missing',method:'read',args:{}}});assert.equal(fail.isError,true);
    const before=requests.length;const tooLarge=await client.callTool({name:'hardware_invoke',arguments:{path:'/dev/display',method:'chunk',args:{hex:'a'.repeat(5000)}}});assert.equal(tooLarge.isError,true);assert.equal(requests.length,before);
  } finally {await client.close();await server.close();}
});

test('hardware discovery follows every page without truncating the resource catalog',async()=>{
 const seen:number[]=[];const server=createHardwareMcp('http://127.0.0.1',async(_url,init)=>{const call=JSON.parse(String(init?.body));const cursor=call.args.cursor??0;if(call.path==='/sys/capabilities')seen.push(cursor);return new Response(JSON.stringify({ok:true,boot_id:'same',result:call.path==='/sys/board'?{board:'test'}:{devices:[{path:`/dev/${cursor}`}],more:cursor<8,next_cursor:cursor+4}}));});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);const client=new Client({name:'pages',version:'1'});await client.connect(ct);try{const r=await client.callTool({name:'hardware_discover',arguments:{}});assert.equal(r.isError,false);assert.deepEqual(seen,[0,4,8]);assert.equal((r.content as unknown[]).length,4);}finally{await client.close();await server.close();}
});
