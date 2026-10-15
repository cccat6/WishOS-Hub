/* Compile-only adapter for stock Lua 5.4.8. Application chunks are never called. */
#include "lua.h"
#include "lauxlib.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static char last_error[512];
static size_t last_peak;
typedef struct { size_t used, peak, limit; } Budget;
static void *bounded_alloc(void *context, void *pointer, size_t previous, size_t next) {
  Budget *b=(Budget*)context;
  if(!pointer)previous=0;
  if(!next){free(pointer);b->used-=previous;return NULL;}
  if(next>b->limit-b->used+previous)return NULL;
  void *out=realloc(pointer,next);
  if(!out)return NULL;
  b->used=b->used-previous+next;
  if(b->used>b->peak)b->peak=b->used;
  return out;
}
int wishos_lua_check(const char *source, size_t size, const char *name, size_t limit) {
  Budget budget={0,0,limit};last_error[0]=0;last_peak=0;
  lua_State *L=lua_newstate(bounded_alloc,&budget);
  if(!L){strcpy(last_error,"Lua compiler memory limit");return LUA_ERRMEM;}
  int status=luaL_loadbufferx(L,source,size,name,"t");
  if(status){const char *message=lua_tostring(L,-1);if(message){strncpy(last_error,message,sizeof(last_error)-1);last_error[sizeof(last_error)-1]=0;}}
  last_peak=budget.peak;lua_close(L);return status;
}
const char *wishos_lua_error(void){return last_error;}
size_t wishos_lua_peak(void){return last_peak;}
int wishos_lua_version(void){return LUA_VERSION_RELEASE_NUM;}
const char *wishos_lua_version_string(void){return LUA_RELEASE;}

int wishos_lua_depth_limit(void){return LUAI_MAXCCALLS;}
