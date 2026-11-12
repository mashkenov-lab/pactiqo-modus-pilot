using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
using System.Windows.Forms;
using System.Drawing;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.ComponentModel;
class Setup {
 static void RejectReparse(string path){for(string p=Path.GetFullPath(path);!String.IsNullOrEmpty(p);p=Path.GetDirectoryName(p)){if((Directory.Exists(p)||File.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new Exception("Autostart path cannot use a reparse point");}}
 static string Option(string[] args,string name){int i=Array.IndexOf(args,name);if(i<0)return null;if(i+1>=args.Length||args[i+1].StartsWith("--"))throw new Exception("Missing value: "+name);return args[i+1];}
 static bool OwnsAutostart(string file,string exe,string root){
  if(!File.Exists(file))return false;
  Type t=Type.GetTypeFromProgID("WScript.Shell");object shell=Activator.CreateInstance(t),link=t.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{file});Type l=link.GetType();
  string target=Convert.ToString(l.InvokeMember("TargetPath",BindingFlags.GetProperty,null,link,null)),args=Convert.ToString(l.InvokeMember("Arguments",BindingFlags.GetProperty,null,link,null)),working=Convert.ToString(l.InvokeMember("WorkingDirectory",BindingFlags.GetProperty,null,link,null));
  return !String.IsNullOrEmpty(target)&&!String.IsNullOrEmpty(working)&&String.Equals(Path.GetFullPath(target),exe,StringComparison.OrdinalIgnoreCase)&&args=="--background"&&String.Equals(Path.GetFullPath(working),root,StringComparison.OrdinalIgnoreCase);
 }
 static bool AutostartEnabled(string root){try{string exe=Path.GetFullPath(Path.Combine(root,"PACTIQO.exe")),file=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup),"PACTIQO Suite.lnk");RejectReparse(file);return OwnsAutostart(file,exe,Path.GetDirectoryName(exe));}catch{return false;}}
 // The explicit command also works without an embedded installation payload.
 // Tests may redirect only to <configured temp>/modus-autostart-*/Startup.
 static void SetAutostart(string root,bool enabled,string testStartup){
  string targetRoot=Path.GetDirectoryName(Path.GetFullPath(Path.Combine(root,"PACTIQO.exe"))),exe=Path.Combine(targetRoot,"PACTIQO.exe"),startup=Environment.GetFolderPath(Environment.SpecialFolder.Startup);
  if(testStartup!=null){string temp=Environment.GetEnvironmentVariable("MODUS_TEST_TEMP_ROOT"),candidate=Path.GetFullPath(testStartup);if(String.IsNullOrEmpty(temp))throw new Exception("Isolated autostart test root is required");string parent=Path.GetDirectoryName(candidate);if(Path.GetFileName(candidate)!="Startup"||!Path.GetFileName(parent).StartsWith("modus-autostart-",StringComparison.Ordinal)||!String.Equals(Path.GetDirectoryName(parent),Path.GetFullPath(temp).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar),StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid isolated Startup folder");startup=candidate;}
  if(String.IsNullOrEmpty(startup))throw new Exception("Current-user Startup folder is unavailable");
  RejectReparse(startup);RejectReparse(exe);string file=Path.Combine(startup,"PACTIQO Suite.lnk");RejectReparse(file);
  if(File.Exists(file)){
   if(!OwnsAutostart(file,exe,targetRoot))throw new Exception("Existing Startup shortcut belongs to another target; it was preserved");
   if(!enabled)File.Delete(file);return;
  }
  if(enabled){if(!File.Exists(exe))throw new Exception("Installed PACTIQO.exe was not found");Directory.CreateDirectory(startup);Shortcut(file,exe,"--background");}
 }
 static string Q(string s){return "\""+s.Replace("\"","\\\"")+"\"";}
 static string DefaultRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"PACTIQO","ModusSuite");
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool CreateDirectoryW(string path,IntPtr securityAttributes);
 static bool OwnedRoot(string root){
  string full=Path.GetFullPath(root),name=Path.GetFileName(full),parent=Path.GetDirectoryName(full);
  if(!System.Text.RegularExpressions.Regex.IsMatch(name,@"^PACTIQO-SETUP-[a-f0-9]{32}$"))return false;
  string temp=Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
  string volume=Path.GetPathRoot(temp).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
  return String.Equals(parent.TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar),temp,StringComparison.OrdinalIgnoreCase)||String.Equals(parent.TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar),volume,StringComparison.OrdinalIgnoreCase);
 }
 static void DeleteOwned(string root){if(!OwnedRoot(root))throw new Exception("Unsafe extraction cleanup");if(Directory.Exists(root))Directory.Delete(root,true);}
 static string RelativeEntry(ZipArchiveEntry entry){
  string name=entry.FullName;
  if(String.IsNullOrEmpty(name)||name.StartsWith("/")||name.IndexOf('\\')>=0||name.IndexOf(':')>=0)throw new Exception("Unsafe archive path");
  string[] parts=name.Split('/');
  for(int i=0;i<parts.Length;i++)if(parts[i]=="."||parts[i]==".."||(parts[i]==""&&i!=parts.Length-1))throw new Exception("Unsafe archive path");
  return name.Replace('/',Path.DirectorySeparatorChar);
 }
 static bool Fits(ZipArchive zip,string root){
  foreach(var entry in zip.Entries){string relative=RelativeEntry(entry),full=Path.Combine(root,relative);int separator=full.LastIndexOf(Path.DirectorySeparatorChar);if(full.Length>=260||separator>=248)return false;}
  return true;
 }
 static string ExtractAt(ZipArchive zip,string root){
  if(!OwnedRoot(root))throw new Exception("Unsafe extraction directory");
  if(!CreateDirectoryW(root,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error(),"Unable to create a new extraction directory");
  try{
   foreach(var entry in zip.Entries){
    string relative=RelativeEntry(entry),target=Path.GetFullPath(Path.Combine(root,relative));
    if(!target.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Unsafe archive path");
    if(entry.FullName.EndsWith("/")){Directory.CreateDirectory(target);continue;}
    Directory.CreateDirectory(Path.GetDirectoryName(target));
    using(var input=entry.Open())using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write))input.CopyTo(output);
   }
   return root;
  }catch(Exception extractionError){
   try{DeleteOwned(root);}catch(Exception cleanupError){throw new Exception("Extraction failed and its temporary directory could not be removed: "+root,new AggregateException(extractionError,cleanupError));}
   throw;
  }
 }
 static string Extract(){
  string temp=Path.GetFullPath(Path.GetTempPath()),name="PACTIQO-SETUP-"+Guid.NewGuid().ToString("N");
  using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")){
   if(stream==null)throw new Exception("Installation payload is missing");
   using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)){
    string root=Path.Combine(temp,name);
    if(!Fits(zip,root))root=Path.Combine(Path.GetPathRoot(temp),name);
    if(!Fits(zip,root))throw new Exception("Archive paths exceed the supported Windows limit");
    return ExtractAt(zip,root);
   }
  }
 }
 static string Install(string target,int port,bool demo,bool start){string temp=Extract();try{var p=new Process();p.StartInfo=new ProcessStartInfo(Path.Combine(temp,"runtime","node.exe"),Q(Path.Combine(temp,"install-suite.cjs"))+" --root "+Q(Path.GetFullPath(target))+" --port "+port+(demo?"":" --empty")+(start?" --start":""));p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.WindowStyle=ProcessWindowStyle.Hidden;p.StartInfo.RedirectStandardOutput=true;p.StartInfo.RedirectStandardError=true;p.StartInfo.StandardOutputEncoding=System.Text.Encoding.UTF8;p.StartInfo.StandardErrorEncoding=System.Text.Encoding.UTF8;p.Start();string stdout=p.StandardOutput.ReadToEnd(),stderr=p.StandardError.ReadToEnd();p.WaitForExit();if(p.ExitCode!=0)throw new Exception(stderr.Trim());return stdout;}finally{DeleteOwned(temp);}}
 static void Shortcut(string file,string exe,string args){Type t=Type.GetTypeFromProgID("WScript.Shell");object shell=Activator.CreateInstance(t);object link=t.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{file});Type l=link.GetType();l.InvokeMember("TargetPath",BindingFlags.SetProperty,null,link,new object[]{exe});l.InvokeMember("Arguments",BindingFlags.SetProperty,null,link,new object[]{args});l.InvokeMember("WorkingDirectory",BindingFlags.SetProperty,null,link,new object[]{Path.GetDirectoryName(exe)});l.InvokeMember("Save",BindingFlags.InvokeMethod,null,link,null);}
 [STAThread]static int Main(string[] args){if(Array.IndexOf(args,"--autostart")>=0){try{string mode=Option(args,"--autostart");if(mode!="enable"&&mode!="disable")throw new Exception("Use --autostart enable or disable");SetAutostart(Option(args,"--root")??DefaultRoot,mode=="enable",Option(args,"--test-startup"));Console.WriteLine("Autostart "+mode+" completed for the current target");return 0;}catch(Exception ex){Console.Error.WriteLine(ex.Message);return 1;}}if(Array.IndexOf(args,"--silent")>=0){try{int i=Array.IndexOf(args,"--root"),j=Array.IndexOf(args,"--port");string root=i>=0?args[i+1]:DefaultRoot;int port=j>=0?int.Parse(args[j+1]):4389;Install(root,port,Array.IndexOf(args,"--empty")<0,Array.IndexOf(args,"--start")>=0);return 0;}catch(Exception e){string log=Path.Combine(Path.GetTempPath(),"PACTIQO-setup-error.txt");File.WriteAllText(log,e.Message);return 1;}}Application.EnableVisualStyles();var f=new Form{Text="Установка PACTIQO Suite",Width=720,Height=680,StartPosition=FormStartPosition.CenterScreen,Font=new Font("Segoe UI",10),FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false};var panel=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(28)};panel.Controls.Add(new Label{Text="Один комплект. Три компонента.",Width=650,Height=50,Font=new Font("Segoe UI",21,FontStyle.Bold)});panel.Controls.Add(new Label{Text="MODUS / Desk — обращения, CRM и работа отделов.\nАдаптер — подключения и диалоги.\nCodex CLI — обработка под учётной записью клиента.",Width=640,Height=90});panel.Controls.Add(new Label{Text="Папка установки",Width=600,Height=24});var folder=new TextBox{Text=DefaultRoot,Width=640};panel.Controls.Add(folder);var demo=new CheckBox{Text="Добавить 20 учебных ситуаций организаторов",Checked=true,Width=640,Height=32};var start=new CheckBox{Text="Запустить компоненты после установки в фоне",Checked=true,Width=640,Height=32};var auto=new CheckBox{Text="Запускать комплект при входе этого пользователя Windows",Checked=false,Width=640,Height=32};bool autoChanged=false,autoLoading=false;Action loadAuto=()=>{autoLoading=true;auto.Checked=AutostartEnabled(folder.Text);autoLoading=false;autoChanged=false;};auto.CheckedChanged+=(s,e)=>{if(!autoLoading)autoChanged=true;};folder.TextChanged+=(s,e)=>loadAuto();loadAuto();panel.Controls.Add(demo);panel.Controls.Add(start);panel.Controls.Add(auto);var note=new Label{Text="Вход в Codex, Bitrix24 и каналы выполняется отдельно под аккаунтами клиента. Обработка Codex требует сети и доступного лимита аккаунта. Данные сохраняются при обновлении.",Width=640,Height=65};panel.Controls.Add(note);var b=new Button{Text="Установить комплект",Width=640,Height=42};panel.Controls.Add(b);bool installed=false;b.Click+=async(s,e)=>{if(installed){f.Close();return;}b.Enabled=false;folder.Enabled=false;demo.Enabled=false;start.Enabled=false;auto.Enabled=false;string root=folder.Text;bool d=demo.Checked,st=start.Checked,at=auto.Checked;note.Text="Проверяем файлы и устанавливаем компоненты. Это может занять несколько минут.";try{await Task.Run(()=>Install(root,4389,d,st));string exe=Path.Combine(Path.GetFullPath(root),"PACTIQO.exe");Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"PACTIQO MODUS.lnk"),exe,"--open");Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"PACTIQO Управление.lnk"),exe,"--manage");if(autoChanged)SetAutostart(root,at,null);note.Text="Установка проверена. Откройте PACTIQO MODUS с рабочего стола. Для входа Codex и локальных паролей используйте «PACTIQO Управление».";b.Text="Закрыть";b.Enabled=true;installed=true;}catch(Exception ex){note.Text="Установка не завершена: "+ex.Message;b.Enabled=true;folder.Enabled=true;demo.Enabled=true;start.Enabled=true;auto.Enabled=true;}};f.Controls.Add(panel);Application.Run(f);return 0;}
}
