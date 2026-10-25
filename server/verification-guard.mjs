/** Cached trusted CJS preload. Layered verification restrictions, not an OS sandbox. */
export const VERIFICATION_GUARD_SOURCE = String.raw`'use strict';
// Initialize inherited pipe handles before denying new Socket constructors.
void process.stdout;void process.stderr;void process.stdin;
const {syncBuiltinESMExports}=require('node:module');
const define=Object.defineProperty,getDescriptor=Object.getOwnPropertyDescriptor;
const apply=Reflect.apply,keys=Object.keys,freeze=Object.freeze,createObject=Object.create;
const NativeError=Error,NativeTypeError=TypeError,NativeString=String;
const includes=Function.prototype.call.bind(Array.prototype.includes),some=Function.prototype.call.bind(Array.prototype.some);
const stringIncludes=Function.prototype.call.bind(String.prototype.includes),split=Function.prototype.call.bind(String.prototype.split),slice=Function.prototype.call.bind(String.prototype.slice);
const matches=Function.prototype.call.bind(RegExp.prototype.test);
const isArray=Array.isArray,isFinite=Number.isFinite,isSafeInteger=Number.isSafeInteger,platform=process.platform;
function denied(){const error=new NativeError('Network access is disabled during candidate verification.');error.code='ERR_COMPANION_VERIFY_NETWORK';throw error;}
function block(object,key,value=denied){const descriptor=getDescriptor(object,key);if(!descriptor||descriptor.configurable){define(object,key,{value,writable:false,configurable:false,enumerable:descriptor?.enumerable??true});}else if(descriptor.writable){define(object,key,{value,writable:false});}else if(descriptor.value!==value){throw new NativeError('A required verification restriction could not be installed.');}}
for(const name of ['fetch','WebSocket','EventSource'])block(globalThis,name);
const modules=['net','tls','http','https','http2','dgram','dns','dns/promises','_http_agent','_http_client','_http_server','_tls_wrap'].map(name=>{try{return require('node:'+name);}catch{return null;}}).filter(Boolean);
for(const module of modules){
for(const [key,value]of Object.entries(module)){
if(typeof value!=='function')continue;
if(value.prototype){for(const method of Object.getOwnPropertyNames(value.prototype)){if(method==='constructor')continue;const descriptor=getDescriptor(value.prototype,method);if(typeof descriptor?.value==='function'&&(/^(?:connect|listen|send|bind|resolve|lookup|query|createConnection|addMembership|_start|onSocket)/.test(method)))block(value.prototype,method);}}
block(module,key);
}
if(module.promises){for(const [key,value]of Object.entries(module.promises))if(typeof value==='function')block(module.promises,key);}
}
// Node's filesystem grants do not gate SQLite's native VFS. Every file-backed
// database/backup therefore requires read+write access to its canonical file AND
// parent directory, including readonly opens (native sidecars are not trusted).
// Candidate source stays readonly; :memory: and writable scratch remain usable.
// Capture admission functions before candidate code can replace public exports.
const sqlite=require('node:sqlite'),fs=require('node:fs'),path=require('node:path');
const {fileURLToPath,URL:NativeURL}=require('node:url');
if(typeof process.permission?.has!=='function'||typeof sqlite.DatabaseSync?.prototype?.setAuthorizer!=='function')throw new NativeError('This Node runtime cannot enforce the SQLite verification policy.');
const permissionHas=process.permission.has.bind(process.permission);
const resolvePath=path.resolve,dirname=path.dirname,join=path.join,basename=path.basename,toNamespacedPath=path.toNamespacedPath;
const realpath=fs.realpathSync,bufferIsBuffer=Buffer.isBuffer,bufferFrom=Buffer.from;
const bufferText=Buffer.prototype.toString,bufferEquals=Buffer.prototype.equals,lower=String.prototype.toLowerCase;
const urlHref=getDescriptor(NativeURL.prototype,'href').get;
const urlProperties=Object.fromEntries(['protocol','hostname','search','hash','pathname'].map(key=>[key,getDescriptor(NativeURL.prototype,key).get]));
const NativeDatabase=sqlite.DatabaseSync,nativePrototype=NativeDatabase.prototype;
const nativeOpen=nativePrototype.open,nativeExec=nativePrototype.exec,nativeAuthorizer=nativePrototype.setAuthorizer;
const nativeDeserialize=nativePrototype.deserialize,nativeDefensive=nativePrototype.enableDefensive,nativeBackup=sqlite.backup;
const isOpenGetter=getDescriptor(nativePrototype,'isOpen')?.get;
const OK=sqlite.constants.SQLITE_OK,DENY=sqlite.constants.SQLITE_DENY,ATTACH=sqlite.constants.SQLITE_ATTACH,PRAGMA=sqlite.constants.SQLITE_PRAGMA,FUNCTION=sqlite.constants.SQLITE_FUNCTION;
if([OK,DENY,ATTACH,PRAGMA,FUNCTION].some(value=>typeof value!=='number')||typeof nativeOpen!=='function'||typeof nativeExec!=='function'||typeof nativeAuthorizer!=='function'||typeof nativeBackup!=='function')throw new NativeError('Required SQLite verification controls are unavailable.');
const records=new WeakMap(),getRecord=WeakMap.prototype.get.bind(records),setRecord=WeakMap.prototype.set.bind(records);
const optionKeys=freeze(['open','readOnly','enableForeignKeyConstraints','enableDoubleQuotedStringLiterals','allowExtension','timeout','readBigInts','returnArrays','allowBareNamedParameters','allowUnknownNamedParameters','defensive']);
const boolOptions=freeze(['open','readOnly','enableForeignKeyConstraints','enableDoubleQuotedStringLiterals','allowExtension','readBigInts','returnArrays','allowBareNamedParameters','allowUnknownNamedParameters','defensive']);
const forbiddenPragmas=freeze(['temp_store','temp_store_directory','data_store_directory','writable_schema']);
const forbiddenFunctions=freeze(['load_extension','readfile','writefile','pragma_temp_store_directory','pragma_data_store_directory']);
function sqliteDenied(){const error=new NativeError('This SQLite filesystem or control operation is disabled during verification.');error.code='ERR_COMPANION_VERIFY_SQLITE';throw error;}
function scalarPath(value){
  let name;
  if(typeof value==='string')name=value;
  else if(bufferIsBuffer(value)){const bytes=bufferFrom(value);name=apply(bufferText,bytes,['utf8']);if(!apply(bufferEquals,bufferFrom(name),[bytes]))return sqliteDenied();}
  else if(value!==null&&typeof value==='object'){
    let href;try{href=apply(urlHref,value,[]);}catch{return sqliteDenied();}
    const url=new NativeURL(href);for(const key of keys(urlProperties))define(url,key,{value:apply(urlProperties[key],url,[]),configurable:false,writable:false});if(url.protocol!=='file:'||url.hostname&&url.hostname!=='localhost'||url.search||url.hash)return sqliteDenied();name=fileURLToPath(url);
  }else return sqliteDenied();
  if(!name||stringIncludes(name,'\0')||name.length>32760)return sqliteDenied();
  if(name===':memory:')return name;
  if(platform==='win32'){
    if(matches(/^\\\\\?\\[A-Za-z]:\\/,name))name=slice(name,4);
    if(matches(/^\\\\|^\/\/|^[A-Za-z]:(?![\\/])/,name))return sqliteDenied();
    if(stringIncludes(slice(name,matches(/^[A-Za-z]:/,name)?2:0),':'))return sqliteDenied();
    for(const part of split(name,/[\\/]/))if(matches(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i,part))return sqliteDenied();
  }else if(stringIncludes(name,':')||matches(/^\/\//,name))return sqliteDenied();
  return resolvePath(name);
}
function admittedPath(value,{memory=false}={}){
  const original=scalarPath(value);if(original===':memory:'){if(memory)return original;return sqliteDenied();}
  const permitted=file=>permissionHas('fs.read',file)&&permissionHas('fs.write',file)&&permissionHas('fs.read',dirname(file))&&permissionHas('fs.write',dirname(file));
  if(!permitted(original))return sqliteDenied();
  let file=original,parts=[];
  for(;;){try{file=realpath(file);break;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')return sqliteDenied();const parent=dirname(file);if(parent===file)return sqliteDenied();parts.unshift(basename(file));file=parent;}}
  for(const part of parts)file=join(file,part);
  file=scalarPath(file);if(!permitted(file))return sqliteDenied();return file;
}
function constructorOptions(value){
  if(value===undefined)value=createObject(null);if(value===null||typeof value!=='object'||isArray(value))return sqliteDenied();
  for(const key of keys(value))if(!includes(optionKeys,key))return sqliteDenied();
  const copy=createObject(null);for(const key of optionKeys){const item=value[key];if(item!==undefined){if(includes(boolOptions,key)&&typeof item!=='boolean'||key==='timeout'&&(!isFinite(item)||item<0))return sqliteDenied();copy[key]=item;}}
  copy.allowExtension=false;copy.defensive=true;return freeze(copy);
}
function authorizer(action,arg1,arg2){
  if(action===ATTACH)return DENY;
  if(action===PRAGMA&&arg2!==null&&arg2!==undefined&&includes(forbiddenPragmas,apply(lower,NativeString(arg1),[])))return DENY;
  if(action===FUNCTION&&includes(forbiddenFunctions,apply(lower,NativeString(arg2??arg1),[])))return DENY;
  return OK;
}
function install(db){
  apply(nativeExec,db,['PRAGMA temp_store=MEMORY']);
  apply(nativeAuthorizer,db,[authorizer]);
}
function openGuarded(){const record=getRecord(this);if(!record)return sqliteDenied();admittedPath(record.path,{memory:true});const result=apply(nativeOpen,this,[]);install(this);return result;}
function GuardedDatabaseSync(filename,options){
  if(!new.target)throw new NativeTypeError('Use new DatabaseSync().');
  // Freeze both inputs before options getters or native code can reuse them.
  const filenameCopy=scalarPath(filename),copy=constructorOptions(options),safePath=admittedPath(filenameCopy,{memory:true}),open=copy.open!==false;
  const db=new NativeDatabase(platform==='win32'&&safePath!==':memory:'?toNamespacedPath(safePath):safePath,copy);setRecord(db,{path:safePath,readOnly:copy.readOnly===true});
  if(open)install(db);return db;
}
define(GuardedDatabaseSync,'prototype',{value:nativePrototype,writable:false,configurable:false});
block(nativePrototype,'constructor',GuardedDatabaseSync);
block(nativePrototype,'open',openGuarded);
block(nativePrototype,'setAuthorizer',sqliteDenied);
block(nativePrototype,'loadExtension',sqliteDenied);
block(nativePrototype,'enableLoadExtension',function(value){if(value!==false)return sqliteDenied();});
if(typeof nativeDefensive==='function')block(nativePrototype,'enableDefensive',function(value){if(value!==true||!getRecord(this))return sqliteDenied();return apply(nativeDefensive,this,[true]);});
// Deserialization can reset connection policy and is unused by verifier checks.
if(typeof nativeDeserialize==='function')block(nativePrototype,'deserialize',sqliteDenied);
function guardedBackup(source,destination,options){
  const record=getRecord(source);if(!record)return sqliteDenied();admittedPath(record.path,{memory:true});
  const name=scalarPath(destination),copy=createObject(null);if(options!==undefined){if(options===null||typeof options!=='object'||some(keys(options),key=>!includes(['source','target','rate','progress'],key)))return sqliteDenied();for(const key of ['source','target','rate','progress']){const value=options[key];if(value!==undefined)copy[key]=value;}}
  if(copy.source!==undefined&&copy.source!=='main'||copy.target!==undefined&&copy.target!=='main'||copy.rate!==undefined&&(!isSafeInteger(copy.rate)||copy.rate<1)||copy.progress!==undefined&&typeof copy.progress!=='function')return sqliteDenied();
  const safePath=admittedPath(name);return apply(nativeBackup,sqlite,[source,platform==='win32'?toNamespacedPath(safePath):safePath,freeze(copy)]);
}
block(sqlite,'DatabaseSync',GuardedDatabaseSync);block(sqlite,'backup',guardedBackup);freeze(GuardedDatabaseSync);
// The nonconfigurable public entries and native-prototype replacements also
// cover getBuiltinModule(), borrowed methods and .constructor escape routes.
syncBuiltinESMExports();
`;
