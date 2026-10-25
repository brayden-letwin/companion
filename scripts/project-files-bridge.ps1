$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($args.Count -ne 0) { throw 'The project broker accepts JSON on stdin only.' }
$source = @'
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class CompanionProjectFiles {
    const int MaxFile = 250000;
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x00010000, Attr = 0x80;
    const uint DirectoryFlag = 0x02000000, ReparseFlag = 0x00200000;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 40 };
    static string SourceRoot, DataRoot;
    static readonly object Control = new object(), Output = new object();
    static readonly ManualResetEvent CommitGate = new ManualResetEvent(false);
    static string ActiveId;
    static bool Cancelled;
    static int CommitDecision;
    static void CheckCancelled(){lock(Control)if(Cancelled)throw new Fault("request_cancelled","Stopped before committing this project edit.",499);}
    static void CommitBarrier(){
        CheckCancelled();lock(Control){if(Cancelled)throw new Fault("request_cancelled","Stopped before committing this project edit.",499);CommitDecision=0;CommitGate.Reset();}
        lock(Output)Console.WriteLine(Json.Serialize(D("id",ActiveId,"type","commit_ready")));
        if(!CommitGate.WaitOne(30000))throw new Fault("request_cancelled","Project commit was not authorized before its deadline.",499);
        lock(Control){if(Cancelled||CommitDecision!=1)throw new Fault("request_cancelled","Stopped before committing this project edit.",499);}
    }
    public static void Run(){
        var readerJson=new JavaScriptSerializer {MaxJsonLength=2097152,RecursionLimit=40};Thread worker=null;string line;
        while((line=Console.ReadLine())!=null){
            if(Utf8.GetByteCount(line)>2097152)throw new InvalidOperationException("Project input exceeds its private transport limit.");
            Dictionary<string,object> message;try{message=readerJson.Deserialize<Dictionary<string,object>>(line);}catch{throw new InvalidOperationException("Unreadable private project frame.");}
            object actionValue,targetValue;string action=message.TryGetValue("action",out actionValue)?actionValue as string:null;
            if(action=="commit"||action=="cancel"){
                string target=message.TryGetValue("target",out targetValue)?targetValue as string:null;
                lock(Control)if(target!=null&&target==ActiveId){if(action=="cancel")Cancelled=true;CommitDecision=action=="commit"?1:-1;CommitGate.Set();}continue;
            }
            if(worker!=null)worker.Join();
            lock(Control){ActiveId=message.ContainsKey("id")?message["id"] as string:null;Cancelled=false;CommitDecision=0;}
            string captured=line;worker=new Thread(delegate(){string result=Dispatch(captured);lock(Output)Console.WriteLine(result);});worker.Start();
        }
        lock(Control){Cancelled=true;CommitDecision=-1;CommitGate.Set();}
        if(worker!=null)worker.Join();
        CloseAllScans();
    }
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder name,uint length,uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileExW(string before,string after,uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,byte[] value,uint size);
    sealed class Fault : Exception { public string Code; public int Status; public bool Unknown; public Fault(string code,string message,int status=400,bool unknown=false):base(message){Code=code;Status=status;Unknown=unknown;} }
    sealed class Scope : IDisposable {
        public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        public string Root;
        public void Dispose(){ for(int i=Handles.Count-1;i>=0;i--) Handles[i].Dispose(); }
    }
    static Dictionary<string,object> D(params object[] values){var d=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)d.Add((string)values[i],values[i+1]);return d;}
    static string S(IDictionary<string,object> d,string key,bool optional=false){object v;if(!d.TryGetValue(key,out v)||v==null){if(optional)return null;throw new Fault("invalid_project_input","A required project field is missing.");}if(!(v is string)||((string)v).Length>500000)throw new Fault("invalid_project_input","Use bounded project text.");return (string)v;}
    static void Fields(IDictionary<string,object> d,params string[] allowed){foreach(string key in d.Keys)if(Array.IndexOf(allowed,key)<0)throw new Fault("invalid_project_input","Unsupported native project fields.");}
    static string Full(string value){if(String.IsNullOrEmpty(value)||value.Length>2000||value.IndexOf('\0')>=0||!System.Text.RegularExpressions.Regex.IsMatch(value,@"^[A-Za-z]:[\\/]")||value.StartsWith(@"\\"))throw new Fault("project_path_forbidden","Choose a local project folder.",403);string full=Path.GetFullPath(value);return full.Length<=3?full:full.TrimEnd('\\');}
    static bool Same(string a,string b){return String.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
    static bool Under(string child,string parent){return Same(child,parent)||child.StartsWith(parent.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
    static string Extended(string path){return @"\\?\"+path;}
    static string Hash(byte[] value){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(value)).Replace("-","").ToLowerInvariant();}
    static string Id(Info i){return i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8")+":"+i.CreationHigh.ToString("x8")+i.CreationLow.ToString("x8");}
    static string Final(SafeFileHandle h){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)throw new Fault("project_identity_unavailable","The opened path identity could not be verified.",409);string v=b.ToString();if(v.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))throw new Fault("project_path_forbidden","Remote project paths are unavailable.",403);if(v.StartsWith(@"\\?\"))v=v.Substring(4);return Full(v);}
    static Info Get(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new Fault("project_identity_unavailable","The opened file identity could not be verified.",409);return i;}
    static Fault WinError(int code){if(code==2||code==3)return new Fault("project_file_not_found","The selected project file was not found.",404);if(code==32||code==33)return new Fault("project_file_busy","Another program is using this project file. Close it there and try again.",409);if(code==80||code==183)return new Fault("project_file_conflict","The target file already exists.",409);if(code==5)return new Fault("project_access_denied","Windows denied access to the selected project path.",403);return new Fault("project_io_failed","Windows could not finish this project operation.",503);}
    static SafeFileHandle Open(string p,uint access,uint share,uint disposition,bool directory){var h=CreateFileW(Extended(p),access,share,IntPtr.Zero,disposition,ReparseFlag|(directory?DirectoryFlag:0),IntPtr.Zero);if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw WinError(e);}return h;}
    static bool Secret(string part){string p=part.ToLowerInvariant();return p.StartsWith(".")||System.Text.RegularExpressions.Regex.IsMatch(p,@"^(?:credentials?|secrets?|tokens?|passwords?)(?:[._-].*)?$|^id_(?:rsa|ed25519|dsa|ecdsa)(?:\..*)?$|\.(?:pem|key|pfx|p12|kdbx|exe|dll|lnk|url|bat|cmd|ps1)$")||p=="node_modules";}
    static string Relative(string value,bool empty=false){if(value==null||(value.Length==0&&!empty)||value.Length>240||value.IndexOfAny(new char[]{'\\',':','\0','<','>','"','|','?','*','~'})>=0||value.StartsWith("/")||value.EndsWith("/"))throw new Fault("project_path_forbidden","Use a permitted relative project path.",403);if(value.Length==0)return value;foreach(string part in value.Split('/'))if(part.Length==0||Secret(part)||part.EndsWith(".")||part.EndsWith(" ")||System.Text.RegularExpressions.Regex.IsMatch(part,@"[\x00-\x1f\x7f]|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new Fault("project_path_forbidden","Hidden, credential or device paths are not available.",403);return value;}
    static void ProtectedRoot(string root,IDictionary<string,object> f){
        string drive=Path.GetPathRoot(root);if(Same(root,drive)||GetDriveTypeW(drive)==4)throw new Fault("project_root_forbidden","Choose a local project subfolder.",403);
        foreach(string home in new string[]{Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)})if(!String.IsNullOrEmpty(home)&&Under(home,root))throw new Fault("project_root_forbidden","Choose a project folder inside your home, not your whole home.",403);
        var protectedPaths=new List<string>{SourceRoot,DataRoot,Environment.GetFolderPath(Environment.SpecialFolder.Windows),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)};
        object raw;if(f.TryGetValue("protectedRoots",out raw)&&raw!=null){var a=raw as IList;if(a==null||a.Count>40)throw new Fault("invalid_project_input","Use the internal protected roots.");foreach(object p in a){if(!(p is string))throw new Fault("invalid_project_input","Invalid protected root.");protectedPaths.Add(Full((string)p));}}
        foreach(string p in protectedPaths)if(!String.IsNullOrEmpty(p)&&(Under(root,p)||Under(p,root)))throw new Fault("project_root_forbidden","Companion, private runtime and system paths cannot be project folders.",403);
    }
    static Scope Directories(string path,bool privacy){var scope=new Scope();try{string full=Full(path),drive=Path.GetPathRoot(full),current=drive;var pieces=full.Substring(drive.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries);var paths=new List<string>{current};foreach(string piece in pieces){if(privacy&&Secret(piece))throw new Fault("project_path_forbidden","Hidden or credential folders are unavailable.",403);current=Path.Combine(current,piece);paths.Add(current);}foreach(string p in paths){var h=Open(p,Attr,3,3,true);scope.Handles.Add(h);Info i=Get(h);if((i.Attributes&0x400)!=0||(i.Attributes&0x10)==0)throw new Fault("project_path_forbidden","Linked project directories are unavailable.",403);if(privacy&&!Same(p,drive)&&(i.Attributes&6)!=0)throw new Fault("project_path_forbidden","Hidden or system directories are unavailable.",403);if(!Same(Final(h),Full(p)))throw new Fault("project_identity_changed","A project directory changed identity.",409);}scope.Root=Final(scope.Handles[scope.Handles.Count-1]);return scope;}catch{scope.Dispose();throw;}}
    static Scope Root(IDictionary<string,object> f){string root=Full(S(f,"root"));ProtectedRoot(root,f);var scope=Directories(root,true);if(Id(Get(scope.Handles[scope.Handles.Count-1]))!=S(f,"rootIdentity")){scope.Dispose();throw new Fault("project_identity_changed","The chosen project folder was replaced or moved.",409);}return scope;}
    static Scope Parent(Scope root,string relative){string parent=Path.GetDirectoryName(Path.Combine(root.Root,relative.Replace('/','\\')));if(!Under(parent,root.Root))throw new Fault("project_path_forbidden","The path leaves its chosen folder.",403);return Directories(parent,true);}
    static Info Verify(SafeFileHandle h,string target,string root){Info i=Get(h);if((i.Attributes&(0x400|0x10|6))!=0||i.Links!=1)throw new Fault("project_path_forbidden","Linked, hidden, system or nonregular project files are unavailable.",403);string final=Final(h);if(!Under(final,root)||!Same(final,target))throw new Fault("project_identity_changed","The opened target does not match its chosen project path.",409);if(i.SizeHigh!=0||i.SizeLow>MaxFile)throw new Fault("project_file_limit","Keep project text files within 250000 bytes.",413);return i;}
    static byte[] ReadBytes(FileStream stream){if(stream.Length>MaxFile)throw new Fault("project_file_limit","Keep project text files within 250000 bytes.",413);stream.Position=0;byte[] b=new byte[(int)stream.Length];int n=0;while(n<b.Length){int read=stream.Read(b,n,b.Length-n);if(read==0)throw new Fault("project_io_failed","The file read was incomplete.",503);n+=read;}Decode(b);return b;}
    static string Decode(byte[] b){if(Array.IndexOf(b,(byte)0)>=0)throw new Fault("project_text_required","Only UTF-8 text files are supported.",415);try{return Utf8.GetString(b);}catch(DecoderFallbackException){throw new Fault("project_text_required","Only valid UTF-8 text files are supported.",415);}}
    static byte[] Encode(string text){byte[] b;try{b=Utf8.GetBytes(text);}catch(EncoderFallbackException){throw new Fault("project_text_required","Use complete Unicode characters.",400);}if(b.Length>MaxFile||Array.IndexOf(b,(byte)0)>=0)throw new Fault("project_file_limit","Use bounded UTF-8 project text without null bytes.",413);return b;}
    static Dictionary<string,object> Content(byte[] b){string s=Decode(b);int crlf=0,lf=0,cr=0;for(int i=0;i<s.Length;i++){if(s[i]=='\r'){if(i+1<s.Length&&s[i+1]=='\n'){crlf++;i++;}else cr++;}else if(s[i]=='\n')lf++;}int kinds=(crlf>0?1:0)+(lf>0?1:0)+(cr>0?1:0);return D("content",s,"hash",Hash(b),"byteLength",b.Length,"characterLength",s.Length,"readAt",DateTime.UtcNow.ToString("o"),"lineEndings",kinds>1?"mixed":crlf>0?"crlf":lf>0?"lf":cr>0?"cr":"none","bom",b.Length>=3&&b[0]==239&&b[1]==187&&b[2]==191);}
    // Private directory cursors retain verified ancestors and an immutable bounded metadata
    // snapshot. Public list remains unchanged. Every continuation rechecks membership and
    // opened identities; numeric offsets into a live directory are never accepted.
    const int ScanPage = 200, ScanEntries = 20000, ScanBytes = 4*1024*1024, AllScanBytes = 16*1024*1024;
    static readonly object ScanControl = new object();
    static readonly Dictionary<string,DirectoryScan> Scans = new Dictionary<string,DirectoryScan>();
    static long RetainedScanBytes;
    static readonly Timer ScanExpiry = new Timer(delegate(object ignored){lock(ScanControl)ExpireScans();},null,1000,1000);
    sealed class ScanEntry {
        public string Name, Path, Kind, Identity, Version, Issue;
        public long Bytes;
        public bool Matches(ScanEntry other){return Name==other.Name&&Path==other.Path&&Kind==other.Kind&&Identity==other.Identity&&Version==other.Version&&Issue==other.Issue&&Bytes==other.Bytes;}
    }
    sealed class DirectoryScan : IDisposable {
        public string Cursor, Binding, RelativePath, Directory, Identity, Version;
        public Scope RootScope, DirectoryScope;
        public List<ScanEntry> Entries;
        public int Offset;
        public long Bytes;
        public DateTime ExpiresAt;
        public bool InUse, Disposed;
        public void Dispose(){if(Disposed)return;Disposed=true;if(DirectoryScope!=null)DirectoryScope.Dispose();if(RootScope!=null)RootScope.Dispose();}
    }
    static void RemoveScan(DirectoryScan scan){
        if(scan.Cursor!=null&&Scans.ContainsKey(scan.Cursor)&&Object.ReferenceEquals(Scans[scan.Cursor],scan)){Scans.Remove(scan.Cursor);RetainedScanBytes-=scan.Bytes;}
        scan.Cursor=null;scan.Dispose();
    }
    static void ExpireScans(){var expired=new List<DirectoryScan>();foreach(var scan in Scans.Values)if(!scan.InUse&&scan.ExpiresAt<=DateTime.UtcNow)expired.Add(scan);foreach(var scan in expired)RemoveScan(scan);}
    static void CloseAllScans(){lock(ScanControl){foreach(var scan in new List<DirectoryScan>(Scans.Values))RemoveScan(scan);}}
    static string CursorValue(IDictionary<string,object> f){string value=S(f,"cursor");Guid id;if(!Guid.TryParseExact(value,"D",out id))throw new Fault("invalid_project_input","Use a private directory cursor.");return value;}
    static object CloseScan(IDictionary<string,object> f){Fields(f,"cursor");string cursor=CursorValue(f);lock(ScanControl){DirectoryScan scan;if(Scans.TryGetValue(cursor,out scan))RemoveScan(scan);}return D("closed",true);}
    static string ScanBinding(IDictionary<string,object> f,string relative){
        string root=Full(S(f,"root"));ProtectedRoot(root,f);object protectedRoots;f.TryGetValue("protectedRoots",out protectedRoots);
        return Hash(Utf8.GetBytes(Json.Serialize(new object[]{root,S(f,"rootIdentity"),relative,protectedRoots})));
    }
    static void ScanDeadline(System.Diagnostics.Stopwatch elapsed){CheckCancelled();if(elapsed.ElapsedMilliseconds>15000)throw new Fault("project_scan_limit","Directory verification exceeded its bounded scan time.",413);}
    static string DirectoryVersion(DirectoryScan scan){
        var handle=scan.DirectoryScope.Handles[scan.DirectoryScope.Handles.Count-1];Info info=Get(handle);
        if((info.Attributes&(0x400|6))!=0||(info.Attributes&0x10)==0||Id(info)!=scan.Identity||!Same(Final(handle),scan.Directory))throw new Fault("project_directory_changed","The scanned directory changed identity.",409);
        var root=scan.RootScope.Handles[scan.RootScope.Handles.Count-1];if(!Same(Final(root),scan.RootScope.Root))throw new Fault("project_directory_changed","The scanned project changed identity.",409);
        return Id(info)+":"+info.WriteHigh.ToString("x8")+info.WriteLow.ToString("x8");
    }
    static List<ScanEntry> DirectorySnapshot(DirectoryScan scan,System.Diagnostics.Stopwatch elapsed,out long bytes){
        string before=DirectoryVersion(scan);var entries=new List<ScanEntry>();bytes=0;
        foreach(string entry in Directory.EnumerateFileSystemEntries(scan.Directory)){
            ScanDeadline(elapsed);if(entries.Count>=ScanEntries)throw new Fault("project_scan_limit","A directory exceeds the 20000-entry private scan limit.",413);
            string name=Path.GetFileName(entry);var item=new ScanEntry{Name=name,Issue=null};
            try{
                item.Path=Relative((scan.RelativePath.Length>0?scan.RelativePath+"/":"")+name);Utf8.GetBytes(item.Path);
                FileAttributes attr=File.GetAttributes(entry);bool directory=(attr&FileAttributes.Directory)!=0;
                using(var h=Open(entry,Attr,3,3,directory)){
                    Info info=Get(h);if((info.Attributes&(0x400|6))!=0||!directory&&info.Links!=1||((info.Attributes&0x10)!=0)!=directory||!Same(Final(h),Full(entry)))throw new Fault("project_path_forbidden","Unavailable directory entry.",403);
                    item.Kind=directory?"directory":"file";item.Identity=Id(info);item.Bytes=directory?0:(long)info.SizeHigh*4294967296L+info.SizeLow;
                    item.Version=info.Attributes.ToString("x8")+":"+info.WriteHigh.ToString("x8")+info.WriteLow.ToString("x8");
                }
            }catch(Fault error){if(error.Code=="request_cancelled")throw;item.Issue=error.Status==403?"protected":"unavailable";item.Path=null;item.Kind=null;item.Identity=null;item.Version=error.Code;item.Bytes=0;}
            catch(EncoderFallbackException){item.Issue="protected";item.Path=null;}
            catch(IOException){item.Issue="unavailable";item.Path=null;}
            catch(UnauthorizedAccessException){item.Issue="unavailable";item.Path=null;}
            // Conservative managed metadata charge; no file contents are read or retained.
            bytes+=512L+name.Length*2L+(item.Path==null?0:item.Path.Length*2L);
            if(bytes+16384>ScanBytes)throw new Fault("project_scan_limit","Directory metadata exceeds its 4MiB private scan limit.",413);entries.Add(item);
        }
        ScanDeadline(elapsed);if(before!=DirectoryVersion(scan))throw new Fault("project_directory_changed","Directory membership changed during enumeration. Start a new search.",409);
        entries.Sort(delegate(ScanEntry left,ScanEntry right){return StringComparer.Ordinal.Compare(left.Name,right.Name);});
        if(scan.Version!=null&&scan.Version!=before)throw new Fault("project_directory_changed","Directory membership changed between pages. Start a new search.",409);
        scan.Version=before;return entries;
    }
    static void VerifySnapshot(DirectoryScan scan,System.Diagnostics.Stopwatch elapsed){
        long bytes;var observed=DirectorySnapshot(scan,elapsed,out bytes);if(observed.Count!=scan.Entries.Count)throw new Fault("project_directory_changed","Directory membership changed between pages. Start a new search.",409);
        for(int index=0;index<observed.Count;index++){ScanDeadline(elapsed);if(!observed[index].Matches(scan.Entries[index]))throw new Fault("project_directory_changed","Directory entries changed between pages. Start a new search.",409);}
    }
    static object ScanDirectory(IDictionary<string,object> f){
        Fields(f,"root","rootIdentity","path","protectedRoots","cursor");string cursor=S(f,"cursor",true);DirectoryScan scan=null;
        var elapsed=System.Diagnostics.Stopwatch.StartNew();
        try{
            if(cursor!=null){
                cursor=CursorValue(f);lock(ScanControl){ExpireScans();if(!Scans.TryGetValue(cursor,out scan))throw new Fault("project_scan_expired","This private directory scan expired or finished. Start a new search.",409);scan.InUse=true;}
            }
            string relative=Relative(S(f,"path"),true),binding=ScanBinding(f,relative);
            if(scan!=null){
                if(scan.Binding!=binding)throw new Fault("project_scan_conflict","The cursor belongs to another project directory.",409);
                VerifySnapshot(scan,elapsed);
            }else{
                lock(ScanControl){ExpireScans();if(Scans.Count>=8)throw new Fault("project_scan_busy","Eight private directory scans are already retained.",429);}
                scan=new DirectoryScan{Binding=binding,RelativePath=relative,ExpiresAt=DateTime.UtcNow.AddMinutes(10),InUse=true};
                scan.RootScope=Root(f);scan.Directory=relative.Length==0?scan.RootScope.Root:Path.Combine(scan.RootScope.Root,relative.Replace('/','\\'));
                scan.DirectoryScope=Directories(scan.Directory,true);scan.Identity=Id(Get(scan.DirectoryScope.Handles[scan.DirectoryScope.Handles.Count-1]));
                long bytes;scan.Entries=DirectorySnapshot(scan,elapsed,out bytes);scan.Bytes=bytes+16384;VerifySnapshot(scan,elapsed);
                lock(ScanControl)if(RetainedScanBytes+scan.Bytes>AllScanBytes)throw new Fault("project_scan_limit","Private directory scan metadata reached its 16MiB limit.",413);
            }
            ScanDeadline(elapsed);if(scan.ExpiresAt<=DateTime.UtcNow)throw new Fault("project_scan_expired","This private directory scan expired. Start a new search.",409);
            var entries=new List<object>();int count=0,protectedCount=0,unavailable=0;
            while(scan.Offset<scan.Entries.Count&&count<ScanPage){ScanDeadline(elapsed);var item=scan.Entries[scan.Offset++];count++;if(item.Issue=="protected")protectedCount++;else if(item.Issue!=null)unavailable++;else entries.Add(D("name",item.Name,"path",item.Path,"kind",item.Kind,"byteLength",item.Bytes));}
            ScanDeadline(elapsed);if(scan.Version!=DirectoryVersion(scan))throw new Fault("project_directory_changed","Directory membership changed before returning its page.",409);bool more=scan.Offset<scan.Entries.Count;string next=null;
            lock(ScanControl){
                // Consume each cursor exactly once. A lost private ACK cannot advance it again.
                if(scan.Cursor!=null){Scans.Remove(scan.Cursor);RetainedScanBytes-=scan.Bytes;scan.Cursor=null;}
                if(more){next=Guid.NewGuid().ToString("D");scan.Cursor=next;Scans.Add(next,scan);RetainedScanBytes+=scan.Bytes;}else scan.Dispose();
            }
            return D("entries",entries,"scanned",count,"scanLimit",ScanPage,"skipped",D("protected",protectedCount,"unavailable",unavailable),"hasMore",more,"nextCursor",next,"directoryIdentity",scan.Identity);
        }catch{if(scan!=null)lock(ScanControl)RemoveScan(scan);throw;}
        finally{if(scan!=null)lock(ScanControl)scan.InUse=false;}
    }
    static string EditDirectory(IDictionary<string,object> f,string key="editDirectory"){string dir=Full(S(f,key)),id=Path.GetFileName(dir);Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed)||!Same(Path.GetDirectoryName(dir),Path.Combine(DataRoot,"project-files","edits")))throw new Fault("invalid_project_input","Use an owned private edit directory.");if(key=="editDirectory"&&id!=S(f,"operationId"))throw new Fault("invalid_project_input","The edit identity does not match its directory.");return dir;}
    static byte[] PrivateRead(string path,int limit){using(var dirs=Directories(Path.GetDirectoryName(path),false))using(var h=Open(path,Read,1,3,false)){Info i=Get(h);if((i.Attributes&(0x400|0x10))!=0||i.Links!=1||i.SizeHigh!=0||i.SizeLow>limit||!Same(Final(h),Full(path)))throw new Fault("project_journal_invalid","The private edit evidence is invalid.",409);using(var s=new FileStream(h,FileAccess.Read)){if(s.Length>limit)throw new Fault("project_journal_invalid","The private edit evidence is too large.",409);byte[] b=new byte[(int)s.Length];int n=0;while(n<b.Length){int k=s.Read(b,n,b.Length-n);if(k==0)throw new Fault("project_journal_invalid","Private edit evidence is incomplete.",409);n+=k;}return b;}}}
    static Dictionary<string,object> Journal(string dir){try{var d=Json.Deserialize<Dictionary<string,object>>(Utf8.GetString(PrivateRead(Path.Combine(dir,"journal.json"),32000)));if(d==null||Convert.ToInt32(d["version"])!=1||S(d,"id")!=Path.GetFileName(dir))throw new Exception();return d;}catch(Fault){throw;}catch{throw new Fault("project_journal_invalid","The private edit journal is invalid.",409);}}
    static void DurableNew(string path,byte[] bytes){using(var h=Open(path,Write,0,1,false)){Info i=Get(h);if((i.Attributes&(0x400|0x10))!=0||i.Links!=1||!Same(Final(h),Full(path)))throw new Fault("project_journal_invalid","Private edit evidence could not be verified.",409);using(var stream=new FileStream(h,FileAccess.Write)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}}}
    static void SaveJournal(string dir,Dictionary<string,object> j){string tmp=Path.Combine(dir,"journal-"+Guid.NewGuid().ToString("D")+".tmp");DurableNew(tmp,Utf8.GetBytes(Json.Serialize(j)));if(!MoveFileExW(Extended(tmp),Extended(Path.Combine(dir,"journal.json")),9))throw WinError(Marshal.GetLastWin32Error());}
    static void MatchJournal(Dictionary<string,object> j,IDictionary<string,object> f){if(!Same(S(j,"root"),Full(S(f,"root")))||S(j,"rootIdentity")!=S(f,"rootIdentity")||S(j,"path")!=S(f,"path")||S(j,"id")!=S(f,"operationId"))throw new Fault("project_edit_conflict","The edit does not match this project target.",409);}
    static Dictionary<string,object> Result(Dictionary<string,object> j,string status,bool unknown=false){object after=j["afterHash"];return D("id",j["id"],"path",j["path"],"status",status,"beforeHash",j["beforeHash"],"afterHash",after,"bytes",Convert.ToInt32(j["afterBytes"]),"undoAvailable",status=="applied","outcomeUnknown",unknown,"created",j["beforeHash"]==null&&after!=null,"deleted",after==null);}
    static object Recover(IDictionary<string,object> f){string dir=EditDirectory(f);Dictionary<string,object> j;try{j=Journal(dir);}catch(Fault e){if(e.Code=="project_file_not_found")return D("id",S(f,"operationId"),"path",S(f,"path"),"status","interrupted","outcomeUnknown",false,"undoAvailable",false);throw;}MatchJournal(j,f);if(S(j,"stage")=="applied"||S(j,"stage")=="conflict")return j["result"];
        object terminalOnly;if(f.TryGetValue("terminalOnly",out terminalOnly)&&terminalOnly is bool&&(bool)terminalOnly)return Result(j,"recovery_required",true);
        using(var root=Root(f))using(var parent=Parent(root,Relative(S(f,"path")))){string target=Path.Combine(root.Root,S(f,"path").Replace('/','\\'));string observed=null,identity=null;try{using(var h=Open(target,Read,1,3,false)){Verify(h,target,root.Root);identity=Id(Get(h));using(var stream=new FileStream(h,FileAccess.Read))observed=Hash(ReadBytes(stream));}}catch(Fault e){if(e.Code!="project_file_not_found")throw;}
            string before=S(j,"beforeHash",true),after=S(j,"afterHash",true),expectedIdentity=S(j,"afterIdentity",true)??S(j,"createdIdentity",true)??S(j,"beforeIdentity",true);
            if(observed==after&&(after==null||expectedIdentity!=null&&identity==expectedIdentity)){var r=Result(j,"applied");r["reconciled"]=true;return r;}
            if(observed==before&&(before==null||identity==S(j,"beforeIdentity",true)))return Result(j,"interrupted");return Result(j,"recovery_required",true);
        }
    }
    static object Mutate(string action,Dictionary<string,object> f){
        string relative=Relative(S(f,"path")),dir=EditDirectory(f);object expected;if(!f.TryGetValue("expectedHash",out expected)||expected!=null&&(!(expected is string)||!System.Text.RegularExpressions.Regex.IsMatch((string)expected,"^[a-f0-9]{64}$")))throw new Fault("invalid_project_input","Provide the exact expected hash, or null for a new file.");
        string requestHash=Hash(Utf8.GetBytes(Json.Serialize(new object[]{action,S(f,"root"),S(f,"rootIdentity"),relative,expected,S(f,"content",true),S(f,"oldText",true),S(f,"newText",true),S(f,"originalEditDirectory",true)})));
        if(File.Exists(Path.Combine(dir,"journal.json"))){var prior=Journal(dir);MatchJournal(prior,f);if(S(prior,"requestHash")!=requestHash)throw new Fault("project_edit_conflict","The edit identity was used for different input.",409);return Recover(f);}
        Directory.CreateDirectory(dir);using(var privateDirs=Directories(dir,false))using(var root=Root(f))using(var parent=Parent(root,relative)){
            string target=Path.Combine(root.Root,relative.Replace('/','\\'));SafeFileHandle handle=null;FileStream stream=null;Dictionary<string,object> j=null;bool committing=false,created=false,effectsStarted=false;
            try{
                byte[] before=new byte[0],after;string beforeIdentity=null;Dictionary<string,object> original=null;
                if(expected!=null){handle=Open(target,Read|Write|(action=="undo"?Delete:0),0,3,false);Verify(handle,target,root.Root);beforeIdentity=Id(Get(handle));stream=new FileStream(handle,FileAccess.ReadWrite);before=ReadBytes(stream);if(Hash(before)!=(string)expected)throw new Fault("project_file_conflict","The file changed since it was read. Read it again before editing.",409);}
                if(action=="undo"){
                    string originalDir=EditDirectory(f,"originalEditDirectory");original=Journal(originalDir);if(S(original,"stage")!="applied"||!Same(S(original,"root"),root.Root)||S(original,"rootIdentity")!=S(f,"rootIdentity")||S(original,"path")!=relative||S(original,"afterHash",true)!=(string)expected)throw new Fault("project_edit_conflict","This undo does not match the original saved edit.",409);
                    if(expected!=null&&beforeIdentity!=(S(original,"afterIdentity",true)??S(original,"createdIdentity",true)??S(original,"beforeIdentity",true)))throw new Fault("project_identity_changed","The file was replaced after this edit.",409);
                    after=PrivateRead(Path.Combine(originalDir,"before.bin"),MaxFile);if(Hash(after)!=S(original,"beforeBackupHash"))throw new Fault("project_journal_invalid","The original backup failed its integrity check.",409);
                }else if(action=="replace"){
                    string oldText=S(f,"oldText"),newText=S(f,"newText");if(oldText.Length<1||oldText.Length>12000||newText.Length>12000||expected==null)throw new Fault("invalid_project_input","Literal replacement needs an existing hash and bounded text.");string text=Decode(before);int first=text.IndexOf(oldText,StringComparison.Ordinal);if(first<0||text.IndexOf(oldText,first+1,StringComparison.Ordinal)>=0)throw new Fault("project_replace_conflict","Replacement text must occur exactly once, including overlapping matches.",409);after=Encode(text.Substring(0,first)+newText+text.Substring(first+oldText.Length));
                }else{string content=S(f,"content");if(content.Length>24000)throw new Fault("project_file_limit","Keep complete writes within 24000 characters.",413);after=Encode(content);}
                bool delete=action=="undo"&&original["beforeHash"]==null;string afterHash=delete?null:Hash(after);
                j=D("version",1,"id",S(f,"operationId"),"action",action,"root",root.Root,"rootIdentity",S(f,"rootIdentity"),"path",relative,"requestHash",requestHash,"stage","prepared","beforeHash",expected,"afterHash",afterHash,"beforeBytes",before.Length,"afterBytes",delete?0:after.Length,"beforeBackupHash",Hash(before),"afterBackupHash",Hash(after),"beforeIdentity",beforeIdentity,"createdAt",DateTime.UtcNow.ToString("o"));
                DurableNew(Path.Combine(dir,"before.bin"),before);DurableNew(Path.Combine(dir,"after.bin"),after);SaveJournal(dir,j);CommitBarrier();j["stage"]="committing";SaveJournal(dir,j);committing=true;
                if(expected==null){handle=Open(target,Read|Write|Delete,0,1,false);created=true;effectsStarted=true;Verify(handle,target,root.Root);j["createdIdentity"]=Id(Get(handle));SaveJournal(dir,j);stream=new FileStream(handle,FileAccess.ReadWrite);}
                if(delete){if(!SetFileInformationByHandle(handle,4,new byte[]{1},1))throw WinError(Marshal.GetLastWin32Error());effectsStarted=true;stream.Dispose();stream=null;handle=null;}
                else{effectsStarted=true;stream.Position=0;stream.Write(after,0,after.Length);stream.SetLength(after.Length);stream.Flush(true);if(Hash(ReadBytes(stream))!=afterHash)throw new Fault("project_write_unverified","The saved bytes could not be verified.",503,true);j["afterIdentity"]=Id(Get(handle));}
                j["stage"]="applied";j["result"]=Result(j,"applied");SaveJournal(dir,j);return j["result"];
            }catch(Fault e){if(committing){e.Unknown=effectsStarted;if(j!=null){j["stage"]=effectsStarted?"recovery_required":"conflict";j["result"]=Result(j,effectsStarted?"recovery_required":"interrupted",effectsStarted);try{SaveJournal(dir,j);}catch{}}}throw;}
            catch{throw new Fault("project_io_failed","The project edit did not return a verified terminal receipt.",503,committing||created);}
            finally{if(stream!=null)stream.Dispose();else if(handle!=null)handle.Dispose();}
        }
    }
    public static string Dispatch(string line){object id=null;try{var request=Json.Deserialize<Dictionary<string,object>>(line);id=request["id"];string action=(string)request["action"];var f=request["fields"] as Dictionary<string,object>;if(f==null)throw new Fault("invalid_project_input","Use JSON project fields.");
        if(action=="init"){if(SourceRoot!=null)throw new Fault("invalid_project_input","The broker is already initialized.");Fields(f,"sourceRoot","dataDirectory");SourceRoot=Full(S(f,"sourceRoot"));DataRoot=Full(S(f,"dataDirectory"));return Json.Serialize(D("id",id,"value",D("ready",true)));}if(SourceRoot==null)throw new Fault("project_native_unavailable","Initialize the project broker first.",503);
        if(action=="inspectRoot"){Fields(f,"path","protectedRoots");string path=Full(S(f,"path"));ProtectedRoot(path,f);using(var scope=Directories(path,true)){var value=D("canonicalPath",scope.Root,"identity",Id(Get(scope.Handles[scope.Handles.Count-1])),"label",Path.GetFileName(scope.Root));return Json.Serialize(D("id",id,"value",value));}}
        if(action=="closeScan")return Json.Serialize(D("id",id,"value",CloseScan(f)));
        if(action=="scanDirectory")return Json.Serialize(D("id",id,"value",ScanDirectory(f)));
        Fields(f,"root","rootIdentity","path","protectedRoots","operationId","editDirectory","expectedHash","content","oldText","newText","originalEditDirectory","part","terminalOnly");
        object result;
        if(action=="recover")result=Recover(f);
        else if(action=="write"||action=="replace"||action=="undo")result=Mutate(action,f);
        else if(action=="inspect"){string dir=EditDirectory(f),part=S(f,"part");if(part!="before"&&part!="after")throw new Fault("invalid_project_input","Choose before or after backup.");var j=Journal(dir);MatchJournal(j,f);using(var root=Root(f)){byte[] b=PrivateRead(Path.Combine(dir,part+".bin"),MaxFile);if(Hash(b)!=S(j,part+"BackupHash"))throw new Fault("project_journal_invalid","The backup failed its integrity check.",409);var value=Content(b);value["fileExists"]=j[part+"Hash"]!=null;result=value;}}
        else if(action=="read"){using(var root=Root(f)){string rel=Relative(S(f,"path"));using(var parent=Parent(root,rel)){string target=Path.Combine(root.Root,rel.Replace('/','\\'));using(var h=Open(target,Read,1,3,false)){Verify(h,target,root.Root);using(var stream=new FileStream(h,FileAccess.Read))result=Content(ReadBytes(stream));}}}}
        else if(action=="list"){using(var root=Root(f)){string rel=Relative(S(f,"path"),true),directory=rel.Length==0?root.Root:Path.Combine(root.Root,rel.Replace('/','\\'));using(var directoryScope=Directories(directory,true)){var entries=new List<object>();int scanned=0,omitted=0;bool truncated=false;foreach(string entry in Directory.EnumerateFileSystemEntries(directory)){if(scanned>=1000){truncated=true;break;}scanned++;string name=Path.GetFileName(entry);try{string path=Relative((rel.Length>0?rel+"/":"")+name);FileAttributes attr=File.GetAttributes(entry);bool isDir=(attr&FileAttributes.Directory)!=0;using(var h=Open(entry,Attr,3,3,isDir)){Info i=Get(h);if((i.Attributes&(0x400|6))!=0||!isDir&&i.Links!=1||!Same(Final(h),Full(entry)))throw new Fault("project_path_forbidden","Unavailable entry.",403);entries.Add(D("name",name,"path",path,"kind",isDir?"directory":"file","byteLength",isDir?0:(long)i.SizeHigh*4294967296L+i.SizeLow));}}catch(Fault){omitted++;}catch(IOException){omitted++;}}result=D("entries",entries,"scanned",scanned,"scanLimit",1000,"truncated",truncated,"omitted",omitted);}}}
        else throw new Fault("invalid_project_input","That project operation is not available.");return Json.Serialize(D("id",id,"value",result));
    }catch(Fault e){return Json.Serialize(D("id",id,"error",D("code",e.Code,"message",e.Message,"statusCode",e.Status,"outcomeUnknown",e.Unknown)));}catch(Exception){return Json.Serialize(D("id",id,"error",D("code","project_io_failed","message","The project operation could not finish.","statusCode",503)));}}
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Web.Extensions.dll'
[Console]::WriteLine('{"type":"ready"}')
[CompanionProjectFiles]::Run()
