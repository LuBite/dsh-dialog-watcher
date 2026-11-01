// DlgProbe.cs - window/process collector and dialog clicker for the
// dsh-dialog-watcher plugin. Loaded by dialog_probe.ps1 via Add-Type.
//
// Source policy: pure ASCII. Every non-ASCII literal (Chinese button names,
// SmartScreen strings) is written as \u escapes so the file survives any
// host codepage. PowerShell 5.1 compiles this with the legacy C# 5 compiler:
// no string interpolation, no ?. ?? nameof, no out-var declarations.
//
// Event protocol (one JSON object per stdout line):
//   {"ev":"ready",...}              daemon started
//   {"ev":"window",...}             blocking-dialog candidate first seen
//   {"ev":"gone","hwnd":...}        previously reported window disappeared
//   {"ev":"clickResult",...}        reply to a click/close stdin command
//   {"ev":"bye"}                    clean exit
// Stdin commands (one JSON object per line, ASCII only):
//   {"cmd":"interval","busy":true|false}
//   {"cmd":"scan"}
//   {"cmd":"click","requestId":"...","hwnd":"0x...","intent":"ok|cancel|run|dontrun","buttonText":"..."}
//   {"cmd":"close","requestId":"...","hwnd":"0x..."}
//   {"cmd":"quit"}
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DlgKit {

// ---------------------------------------------------------------- interop --
internal static class Native {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out FILETIME c, out FILETIME e, out FILETIME k, out FILETIME u);
    // Reading another process PEB is the ONLY way to see its inherited
    // DSH_SESSION_ID. Used sparingly: one bounded pass per interceptor
    // dialog, never per scan tick.
    [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int ret);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    public const uint PROCESS_QUERY_INFORMATION = 0x0400;
    public const uint PROCESS_VM_READ = 0x0010;
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    public const uint GW_OWNER = 4;
    public const int GWL_EXSTYLE = -20;
    public const uint WS_EX_TOOLWINDOW = 0x00000080;
    public const int DWMWA_CLOAKED = 14;
    public const uint BM_CLICK = 0x00F5;
    public const uint WM_CLOSE = 0x0010;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
    [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint lo; public uint hi; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    // --- DPI + hit-testing + GDI capture + synthetic mouse ---
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);

    public const uint SRCCOPY = 0x00CC0020;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;
}

// ------------------------------------------------------------- json utils --
internal static class J {
    // Escape one string for JSON output. Only ASCII control characters and
    // quote/backslash are escaped; other characters (including Chinese) are
    // emitted verbatim - stdout is UTF-8 and the Node host decodes it as such.
    public static string S(string s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.Length + 8);
        for (int i = 0; i < s.Length; i++) {
            char c = s[i];
            switch (c) {
                case '"': b.Append("\\\""); break;
                case '\\': b.Append("\\\\"); break;
                case '\b': b.Append("\\b"); break;
                case '\f': b.Append("\\f"); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else b.Append(c);
                    break;
            }
        }
        return b.ToString();
    }

    // Minimal value extractor for the small controlled command JSON the host
    // writes to stdin (ASCII only). Returns "" when the key is absent.
    public static string Get(string json, string key) {
        if (json == null || key == null) return "";
        string pat = "\"" + key + "\"";
        int k = json.IndexOf(pat, StringComparison.Ordinal);
        if (k < 0) return "";
        int i = json.IndexOf(':', k + pat.Length);
        if (i < 0) return "";
        i++;
        while (i < json.Length && json[i] == ' ') i++;
        if (i >= json.Length) return "";
        if (json[i] == '"') {
            StringBuilder b = new StringBuilder();
            i++;
            while (i < json.Length && json[i] != '"') {
                if (json[i] == '\\' && i + 1 < json.Length) { i++; }
                b.Append(json[i]); i++;
            }
            return b.ToString();
        }
        int e = i;
        while (e < json.Length && ",} \t\r\n".IndexOf(json[e]) < 0) e++;
        return json.Substring(i, e - i);
    }
}

// ------------------------------------------------------- process metadata --
internal class PidInfo {
    public string Exe = "";
    public long CreateMs = -1;
    public long QueriedAt = 0;
}

// A process carrying a DSH_SESSION_ID. Interceptor dialogs (firewall / UAC /
// SmartScreen / AV) belong to the INTERCEPTOR, so their own exe is a useless
// attribution hint. The blocked program - and the command chain that spawned
// it - DO carry the session marker, so they are what identifies the owning
// session.
internal class SessionProc {
    public uint Pid = 0;
    public string Exe = "";
    public long CreateMs = -1;
    public string SessionId = "";
}

// One UIA button: [automationId, name]
internal class UiaInfo {
    public List<string[]> Buttons = new List<string[]>();
    public List<string> Texts = new List<string>();
    public bool SmartScreen = false;
    public string SmartScreenApp = "";
}

// --------------------------------------------------------------- DlgProbe --
public static class Probe {
    // The probe MUST see physical pixels. On a 150%-scaled 3840x2160 panel a
    // DPI-unaware process silently reports a virtualized 2560x1440@96, and
    // every coordinate it handles (GetWindowRect / WindowFromPoint /
    // SetCursorPos) is then off by the scale factor. Measured 2026-11-01 on
    // the reference machine: unaware 2560x1440 LOGPIXELSX=96, aware
    // 3840x2160 LOGPIXELSX=144. This is what makes the clicker
    // resolution/scale independent instead of hard-coding any pixel value.
    static Probe() {
        try { Native.SetProcessDPIAware(); } catch { }
    }

    static readonly object Gate = new object();
    static readonly HashSet<string> Known = new HashSet<string>();   // hwnd keys reported alive
    static readonly Dictionary<uint, PidInfo> PidCache = new Dictionary<uint, PidInfo>();
    static long UiaLastMs = 0;
    static bool Busy = false;
    static int BusyMs = 1500;
    static int IdleMs = 5000;
    static bool Quit = false;

    // Window classes we never report (desktop / taskbar / tray shells).
    static readonly HashSet<string> ClassDeny = new HashSet<string>(StringComparer.Ordinal) {
        "Shell_TrayWnd", "Progman", "WorkerW", "NotifyIconOverflowWindow",
        "MsftIMEShellWnd", "SysListView32", "Shell_SecondaryTrayWnd",
    };

    // UWP/XAML host processes that are known-good desktop surfaces, never
    // blocking dialogs (Settings, input experience, search, start, toasts).
    static readonly HashSet<string> UwpHostDeny = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "systemsettings.exe", "textinputhost.exe", "shellexperiencehost.exe",
        "searchhost.exe", "startmenuexperiencehost.exe", "applicationframehost.exe",
        "runtimebroker.exe", "searchapp.exe", "windowsinternal.composableshell.experiences.textinput.inputapp.exe",
    };

    static long NowMs() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000L; }

    static string Text(IntPtr h) {
        int n = Native.GetWindowTextLengthW(h);
        if (n <= 0) return "";
        StringBuilder sb = new StringBuilder(n + 2);
        Native.GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string Cls(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        Native.GetClassNameW(h, sb, 256);
        return sb.ToString();
    }

    static string Hkey(IntPtr h) { return "0x" + h.ToInt64().ToString("X", CultureInfo.InvariantCulture); }

    static string BaseName(string path) {
        if (string.IsNullOrEmpty(path)) return "";
        int i = path.LastIndexOf('\\');
        int j = path.LastIndexOf('/');
        int k = i > j ? i : j;
        return k >= 0 ? path.Substring(k + 1) : path;
    }

    // pid -> exe path + creation time. Queried once per pid, cached for 30 min
    // (pid reuse protection). Uses only PROCESS_QUERY_LIMITED_INFORMATION: no
    // cross-process memory reads, works without elevation (verified).
    static PidInfo Pid(uint pid) {
        lock (PidCache) {
            PidInfo info;
            if (PidCache.TryGetValue(pid, out info) && NowMs() - info.QueriedAt < 1800000L) return info;
            info = new PidInfo(); info.QueriedAt = NowMs();
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h != IntPtr.Zero) {
                try {
                    uint size = 1024;
                    StringBuilder sb = new StringBuilder(1024);
                    if (Native.QueryFullProcessImageNameW(h, 0, sb, ref size)) info.Exe = sb.ToString();
                    Native.FILETIME c, e, k, u;
                    if (Native.GetProcessTimes(h, out c, out e, out k, out u)) {
                        long ft = ((long)c.hi << 32) | (uint)c.lo;
                        info.CreateMs = ft / 10000L - 11644473600000L;
                    }
                } finally { Native.CloseHandle(h); }
            }
            PidCache[pid] = info;
            return info;
        }
    }

    // ------------------------------------------------- interceptor support --
    // Dialogs that BELONG to a security component rather than to the program
    // being blocked. Their own exe is useless as an attribution hint; what
    // identifies the session is the blocked program (and the command chain
    // that spawned it), which carry DSH_SESSION_ID.
    static readonly HashSet<string> InterceptorExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        // Windows
        "pickerhost.exe", "consent.exe", "smartscreen.exe", "securityhealthsystray.exe",
        // Huorong
        "hipstray.exe", "hipsmain.exe", "hipsdaemon.exe", "wsctrl.exe", "usysdiag.exe",
        // 360
        "360tray.exe", "360safe.exe", "zhudongfangyu.exe", "qhsafe.exe", "qhsafetray.exe",
        // Tencent PC Manager
        "qqpctray.exe", "qqpcmgr.exe", "qqpcrtp.exe", "qmdl.exe",
        // Kingsoft
        "kxetray.exe", "kxe.exe", "kislive.exe", "knbmain.exe",
        // Kaspersky / Defender / Symantec / McAfee
        "avp.exe", "avpui.exe", "msmpeng.exe", "mpdefendercoreservice.exe",
        "ccsvchst.exe", "rtvscan.exe", "mfeectl.exe", "mcshield.exe",
    };

    static bool IsInterceptor(string cls, string exeBase, bool smartScreen) {
        if (smartScreen) return true;
        if (IsShellDialogClass(cls)) return true;
        if (cls != null && cls.StartsWith("Credential", StringComparison.Ordinal)) return true;
        return InterceptorExes.Contains(exeBase ?? "");
    }

    /*
     * Read DSH_SESSION_ID out of another process environment block.
     * x64: PEB.ProcessParameters @ +0x20; Environment is a plain PWSTR inside
     * RTL_USER_PROCESS_PARAMETERS, so it is located by scanning the first
     * 0x100 bytes for a pointer whose target parses as an environment block.
     * WOW64 (32-bit) targets are not handled -> returns null (degrade).
     * Returns null on ANY failure; callers must treat null as unknown.
     */
    static string ReadEnvSessionId(uint pid) {
        IntPtr h = IntPtr.Zero;
        try {
            h = Native.OpenProcess(Native.PROCESS_QUERY_INFORMATION | Native.PROCESS_VM_READ, false, pid);
            if (h == IntPtr.Zero) return null;
            Native.PROCESS_BASIC_INFORMATION pbi = new Native.PROCESS_BASIC_INFORMATION();
            int ret;
            if (Native.NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(Native.PROCESS_BASIC_INFORMATION)), out ret) != 0) return null;
            if (pbi.PebBaseAddress == IntPtr.Zero) return null;
            IntPtr rd;
            byte[] ptr = new byte[8];
            if (!Native.ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), ptr, 8, out rd)) return null;
            long pp = BitConverter.ToInt64(ptr, 0);
            if (pp <= 0x10000) return null;
            byte[] head = new byte[0x100];
            if (!Native.ReadProcessMemory(h, (IntPtr)pp, head, head.Length, out rd)) return null;
            for (int off = 0x20; off + 8 <= head.Length; off += 8) {
                long cand = BitConverter.ToInt64(head, off);
                if (cand <= 0x10000 || cand > 0x7FFFFFFFFFFF) continue;
                byte[] probe = new byte[96];
                if (!Native.ReadProcessMemory(h, (IntPtr)cand, probe, 96, out rd)) continue;
                string s0 = Encoding.Unicode.GetString(probe);
                int z = s0.IndexOf((char)0);
                if (z >= 0) s0 = s0.Substring(0, z);
                if (s0.Length < 20 || s0.IndexOf((char)61) < 2) continue;
                List<byte> acc = new List<byte>();
                IntPtr cur = (IntPtr)cand;
                while (acc.Count < 262144) {
                    byte[] c = new byte[512];
                    if (!Native.ReadProcessMemory(h, cur, c, 512, out rd)) break;
                    acc.AddRange(c);
                    int n = acc.Count;
                    if (n >= 4 && acc[n - 1] == 0 && acc[n - 2] == 0 && acc[n - 3] == 0 && acc[n - 4] == 0) break;
                    cur = (IntPtr)(cur.ToInt64() + 512);
                }
                if (acc.Count == 0) return null;
                string all = Encoding.Unicode.GetString(acc.ToArray());
                int idx = all.IndexOf("DSH_SESSION_ID=", StringComparison.Ordinal);
                if (idx < 0) return null;
                string rest = all.Substring(idx + 15);
                int e2 = rest.IndexOf((char)0);
                if (e2 >= 0) rest = rest.Substring(0, e2);
                return rest.Trim();
            }
            return null;
        } catch {
            return null;
        } finally {
            if (h != IntPtr.Zero) { try { Native.CloseHandle(h); } catch { } }
        }
    }

    /*
     * Every process carrying a DSH_SESSION_ID. Bounded (64 pids examined,
     * 20 kept) because this cross-reads each PEB; it runs once per
     * interceptor dialog, never per scan tick.
     */
    static List<SessionProc> ScanSessionProcs() {
        List<SessionProc> found = new List<SessionProc>();
        System.Diagnostics.Process[] all = null;
        try { all = System.Diagnostics.Process.GetProcesses(); } catch { return found; }
        int budget = 64;
        foreach (System.Diagnostics.Process p in all) {
            if (budget-- <= 0) break;
            uint pid = 0;
            try { pid = (uint)p.Id; } catch { continue; }
            if (pid == 0) continue;
            string sid = ReadEnvSessionId(pid);
            if (string.IsNullOrEmpty(sid)) continue;
            PidInfo pi = Pid(pid);
            SessionProc sp = new SessionProc();
            sp.Pid = pid;
            sp.Exe = BaseName(pi.Exe);
            sp.CreateMs = pi.CreateMs;
            sp.SessionId = sid;
            found.Add(sp);
            if (found.Count >= 20) break;
        }
        try { foreach (System.Diagnostics.Process p in all) p.Dispose(); } catch { }
        return found;
    }

    static void Out(string line) {
        try { Console.WriteLine(line); } catch (ObjectDisposedException) { Quit = true; }
    }

    // ---------------------------------------------------------- UIA layer --
    // UIA deep scan of one window: buttons (automationId+name), SmartScreen
    // markers, and the SmartScreen "App:" field. Returns null when UIA cannot
    // attach. Bounded to 400 elements per call.
    static UiaInfo UiaInspect(IntPtr h) {
        System.Windows.Automation.AutomationElement el = null;
        try {
            // NativeWindowHandle MUST be Int32 - Int64 throws ArgumentException.
            System.Windows.Automation.PropertyCondition cond = new System.Windows.Automation.PropertyCondition(
                System.Windows.Automation.AutomationElement.NativeWindowHandleProperty, (int)h.ToInt64());
            el = System.Windows.Automation.AutomationElement.RootElement.FindFirst(
                System.Windows.Automation.TreeScope.Children, cond);
        } catch { el = null; }
        if (el == null) return null;
        UiaInfo res = new UiaInfo();
        try {
            System.Windows.Automation.AutomationElementCollection all =
                el.FindAll(System.Windows.Automation.TreeScope.Descendants,
                           System.Windows.Automation.Condition.TrueCondition);
            int n = 0;
            foreach (System.Windows.Automation.AutomationElement e in all) {
                if (++n > 400) break;
                try {
                    string name = e.Current.Name == null ? "" : e.Current.Name;
                    string aid = e.Current.AutomationId == null ? "" : e.Current.AutomationId;
                    System.Windows.Automation.ControlType ct = e.Current.ControlType;
                    if (ct == System.Windows.Automation.ControlType.Button) {
                        res.Buttons.Add(new string[] { aid, name });
                    }
                    if (aid == "moreBtn" || aid == "runBtn" || aid == "dontRunBtn") res.SmartScreen = true;
                    if (name.IndexOf("Windows Defender SmartScreen", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Windows \u4FDD\u62A4\u4E86\u4F60\u7684\u7535\u8111", StringComparison.Ordinal) >= 0) {
                        res.SmartScreen = true;
                    }
                    if (res.SmartScreenApp.Length == 0) {
                        string app = ExtractAppField(name);
                        if (app.Length > 0) res.SmartScreenApp = app;
                    }
                } catch { }
            }
        } catch { return res; }
        return res;
    }

    // UIA by explicit handle. Needed for the Shell consent card: it is absent
    // from the UIA desktop tree (RootElement.FindFirst by NativeWindowHandle
    // finds nothing for its process), so the only way to ask is FromHandle on
    // the card hwnd recovered by hit-testing. Returns null when UIA cannot
    // attach. Bounded to 300 elements.
    static UiaInfo UiaInspectFromHandle(IntPtr h) {
        System.Windows.Automation.AutomationElement el = null;
        try { el = System.Windows.Automation.AutomationElement.FromHandle(h); } catch { return null; }
        if (el == null) return null;
        UiaInfo res = new UiaInfo();
        try {
            System.Windows.Automation.AutomationElementCollection all =
                el.FindAll(System.Windows.Automation.TreeScope.Subtree,
                           System.Windows.Automation.Condition.TrueCondition);
            int n = 0;
            foreach (System.Windows.Automation.AutomationElement e in all) {
                if (++n > 300) break;
                try {
                    string name = e.Current.Name == null ? "" : e.Current.Name;
                    string aid = e.Current.AutomationId == null ? "" : e.Current.AutomationId;
                    if (e.Current.ControlType == System.Windows.Automation.ControlType.Button) {
                        res.Buttons.Add(new string[] { aid, name });
                    } else if (name.Trim().Length >= 2 && res.Texts.Count < 40) {
                        res.Texts.Add(name);
                    }
                } catch { }
            }
        } catch { return res; }
        return res;
    }

    // SmartScreen shows "App: <name>" (EN) or a localized line starting with
    // the localized word for "App" followed by ':' or a fullwidth colon.
    static string ExtractAppField(string name) {
        if (string.IsNullOrEmpty(name) || name.Length > 200) return "";
        if (name.StartsWith("App:", StringComparison.OrdinalIgnoreCase)) return name.Substring(4).Trim();
        if (name.StartsWith("Application:", StringComparison.OrdinalIgnoreCase)) return name.Substring(12).Trim();
        // \u5E94\u7528 = "App" (zh-CN label on the SmartScreen surface)
        if (name.StartsWith("\u5E94\u7528:", StringComparison.Ordinal)) return name.Substring(3).Trim();
        if (name.StartsWith("\u5E94\u7528\uFF1A", StringComparison.Ordinal)) return name.Substring(3).Trim();
        return "";
    }

    // ------------------------------------------------------ child controls --
    class ChildScan {
        public List<string> Body = new List<string>();
        public List<string> Buttons = new List<string>(); // "hwndHex|ctrlId|text|class"
        public int StaticCount;
    }

    static ChildScan ScanChildren(IntPtr h) {
        ChildScan s = new ChildScan();
        Native.EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
            try {
                string cls = Cls(c);
                string t = Text(c);
                if (cls.IndexOf("Button", StringComparison.OrdinalIgnoreCase) >= 0) {
                    s.Buttons.Add(Hkey(c) + "|" + Native.GetDlgCtrlID(c) + "|" + J.S(t) + "|" + J.S(cls));
                } else if (t.Length >= 4 && s.Body.Count < 6) {
                    string flat = t.Replace("\r", " ").Replace("\n", " ");
                    if (flat.Trim().Length >= 4) { s.Body.Add(flat); s.StaticCount++; }
                }
            } catch { }
            return true;
        }, IntPtr.Zero);
        return s;
    }

    // ------------------------------------------------- shell consent card --
    // Recovered geometry for a Shell_SystemDialog* window. The anchored window
    // is the 0x0 proxy; where the real card actually sits is found by asking
    // WindowFromPoint who owns a grid of screen points. The visible card
    // answers as cls=[Shell_SystemDialog] and everything else as the
    // cls=[Shell_SystemDim] backdrop, so the card box falls out of the
    // bounding box of the "card" answers.
    class ShellCard {
        public Native.RECT Rect;              // physical pixels, whole card
        public bool BoundsOk;
        public IntPtr CardHwnd = IntPtr.Zero; // the real card window, if seen
        public List<int[]> Buttons = new List<int[]>();  // [left,right] absolute x
        public int BandTop;                   // absolute y of the button row
        public int BandBottom;
    }

    // Measured on the reference machine: button surface luma 248..253, card
    // surface 243. A fixed 'near white' threshold would break under a dark
    // theme, where the card is dark and its buttons only slightly lighter,
    // so the split is derived per capture from the card's own median luma
    // (see ShellButtonThreshold). 6 is the contrast step that separates the
    // two surfaces on the reference machine; when a theme leaves less
    // contrast than that, no buttons are reported and nothing is clicked.
    const double ShellButtonContrast = 5.0;

    static double PixelLuma(uint colorRef) {
        // GDI GetPixel returns COLORREF 0x00BBGGRR (red in the low byte).
        int r = (int)(colorRef & 0xFF);
        int g = (int)((colorRef >> 8) & 0xFF);
        int b = (int)((colorRef >> 16) & 0xFF);
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // Distance from a known-inside point to the card edge along one axis.
    // Bisects the hit-test answer, so it works at any scale factor without
    // assuming any pixel size.
    static int RefineEdge(IntPtr cardHwnd, int xIn, int yIn, int dx, int dy, int limit) {
        if (limit <= 0) return 0;
        int lo = 0, hi = limit;
        Native.POINT p;
        while (hi - lo > 1) {
            int mid = (lo + hi) / 2;
            p.X = xIn + dx * mid;
            p.Y = yIn + dy * mid;
            IntPtr hit = Native.WindowFromPoint(p);
            if (hit == cardHwnd) lo = mid; else hi = mid;
        }
        return lo;
    }

    static ShellCard ProbeShellCard(IntPtr h, Native.RECT windowRect) {
        ShellCard card = new ShellCard();
        card.Rect = windowRect;
        int w = windowRect.R - windowRect.L;
        int ht = windowRect.B - windowRect.T;
        if (w >= 100 && ht >= 50) {
            card.BoundsOk = true;   // anchored window already reports real bounds
        } else {
            int ox = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int oy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int sw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int sh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (sw <= 0 || sh <= 0) return card;
            // Step scales with the display so this works on any resolution;
            // ~45px at 2160p, ~25px at 1080p.
            int step = Math.Max(16, Math.Min(sw, sh) / 48);
            Dictionary<IntPtr, bool> memo = new Dictionary<IntPtr, bool>();
            int minX = int.MaxValue, maxX = int.MinValue, minY = int.MaxValue, maxY = int.MinValue;
            for (int y = oy + step / 2; y < oy + sh; y += step) {
                for (int x = ox + step / 2; x < ox + sw; x += step) {
                    Native.POINT p;
                    p.X = x; p.Y = y;
                    IntPtr hit = Native.WindowFromPoint(p);
                    if (hit == IntPtr.Zero) continue;
                    bool isCard;
                    if (!memo.TryGetValue(hit, out isCard)) {
                        string hc = Cls(hit);
                        isCard = IsShellDialogClass(hc) && hc != "Shell_SystemDialogProxy";
                        memo[hit] = isCard;
                    }
                    if (!isCard) continue;
                    // Keep the real card's hwnd: it is the only handle that
                    // might expose the card text through UIA.
                    if (card.CardHwnd == IntPtr.Zero) card.CardHwnd = hit;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            if (maxX < minX || maxY < minY) return card;
            // Samples sit at cell centres, so the true edge is within one step.
            card.Rect.L = Math.Max(ox, minX - step);
            card.Rect.T = Math.Max(oy, minY - step);
            card.Rect.R = Math.Min(ox + sw, maxX + step);
            card.Rect.B = Math.Min(oy + sh, maxY + step);
            // Hit-test sampling is quantised by the step, so the coarse box
            // carries a strip of dim backdrop along every edge. Refine each
            // edge by bisection from the known-inside centre; without this the
            // backdrop strip swamps the button/background split later on.
            if (card.CardHwnd != IntPtr.Zero) {
                int cxIn = (minX + maxX) / 2;
                int cyIn = (minY + maxY) / 2;
                card.Rect.L = cxIn - RefineEdge(card.CardHwnd, cxIn, cyIn, -1, 0, cxIn - ox);
                card.Rect.R = cxIn + RefineEdge(card.CardHwnd, cxIn, cyIn, 1, 0, ox + sw - cxIn);
                card.Rect.T = cyIn - RefineEdge(card.CardHwnd, cxIn, cyIn, 0, -1, cyIn - oy);
                card.Rect.B = cyIn + RefineEdge(card.CardHwnd, cxIn, cyIn, 0, 1, oy + sh - cyIn);
            }
            card.BoundsOk = true;
        }
        DetectShellButtons(card);
        return card;
    }

    // Derive the button/background split from the capture itself: the median
    // luma of the whole card is the surface colour (buttons cover far less
    // than half of it), and buttons sit ShellButtonContrast steps brighter
    // on both light and dark themes. Returns 0 when the contrast is too
    // small to separate the surfaces, so the caller reports no buttons
    // instead of clicking at a guess.
    // Split the card's button row from its own surface colour.
    //
    // Whole-card statistics do NOT work: the upper two thirds of this card is
    // plain white, so the global median (251) sits ABOVE the buttons and the
    // real surface/button step (243 vs 250) is invisible.
    //
    // Otsu on the bottom strip does not work either: the button labels are a
    // dark minority that Otsu latches onto (T=86, splitting glyphs from
    // everything else) instead of splitting surface from button.
    //
    // What does work is two percentiles over the bottom quarter, where the
    // three populations are: surface (margins + the gap between buttons, the
    // largest non-button share), button fill (the brightest), and glyphs (a
    // ~10% dark minority that the 20th percentile steps over). The midpoint
    // then lands between surface and button, on light and dark themes alike,
    // and scales with the display because nothing here is an absolute pixel
    // value.
    // The card body and the strip that carries the buttons are two different
    // surfaces, and WHICH ONE IS LIGHTER DEPENDS ON THE THEME:
    //   light: body 255, button-row strip 243, buttons 250
    //   dark : body  43, button-row strip  32, buttons  45
    // A global threshold therefore cannot work, and the buttons are too close
    // to the card body to separate by brightness alone. What is stable in both
    // themes is the button-row strip: it is the surface under and around the
    // buttons. Sampling the card's left/right margins inside the bottom band
    // yields that colour directly - those columns can never be a button.
    static double ShellSurfaceLuma(IntPtr mem, int cw, int ch) {
        int y0 = ch * 80 / 100;
        int y1 = ch * 96 / 100;
        if (y1 <= y0 + 2) { y0 = ch * 3 / 4; y1 = ch - 2; }
        List<int> vals = new List<int>();
        for (int y = y0; y < y1; y++) {
            for (int x = 2; x <= 12 && x < cw; x++) vals.Add((int)PixelLuma(Native.GetPixel(mem, x, y)));
            for (int x = cw - 12; x <= cw - 2; x++) {
                if (x >= 0 && x < cw) vals.Add((int)PixelLuma(Native.GetPixel(mem, x, y)));
            }
        }
        if (vals.Count < 16) return -1.0;
        vals.Sort();
        return (double)vals[vals.Count / 2];
    }

    static void DetectShellButtons(ShellCard card) {
        if (!card.BoundsOk) return;
        int cw = card.Rect.R - card.Rect.L;
        int ch = card.Rect.B - card.Rect.T;
        if (cw < 80 || ch < 60 || cw > 4096 || ch > 4096) return;
        IntPtr screen = Native.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return;
        IntPtr mem = IntPtr.Zero, bmp = IntPtr.Zero, oldObj = IntPtr.Zero;
        try {
            mem = Native.CreateCompatibleDC(screen);
            if (mem == IntPtr.Zero) return;
            bmp = Native.CreateCompatibleBitmap(screen, cw, ch);
            if (bmp == IntPtr.Zero) return;
            oldObj = Native.SelectObject(mem, bmp);
            if (!Native.BitBlt(mem, 0, 0, cw, ch, screen, card.Rect.L, card.Rect.T, Native.SRCCOPY)) return;
            double surf = ShellSurfaceLuma(mem, cw, ch);
            if (surf < 0) return;
            double btnLuma = surf + ShellButtonContrast;
            if (btnLuma > 254.0) btnLuma = 254.0;
            // Search only the bottom band: the card body above it is a
            // different surface and would poison the band detection (a 1px
            // border line at the very bottom does the same, hence 96%).
            int searchTop = ch * 80 / 100;
            int searchBot = ch * 96 / 100;
            if (searchBot <= searchTop + 2) { searchTop = ch * 3 / 4; searchBot = ch - 1; }
            int bandTop = -1, bandBot = -1, bestLen = 0, runTop = -1;
            for (int y = searchTop; y <= searchBot; y++) {
                int n = 0, den = 0;
                for (int x = 6; x < cw - 6; x += 2) {
                    den++;
                    if (PixelLuma(Native.GetPixel(mem, x, y)) >= btnLuma) n++;
                }
                bool on = den > 0 && (double)n / den >= 0.20;
                if (on) {
                    if (runTop < 0) runTop = y;
                } else if (runTop >= 0) {
                    if (y - runTop > bestLen) { bestLen = y - runTop; bandTop = runTop; bandBot = y - 1; }
                    runTop = -1;
                }
            }
            if (runTop >= 0 && searchBot - runTop + 1 > bestLen) { bandTop = runTop; bandBot = searchBot; }
            if (bandTop < 0 || bandBot < bandTop) return;
            int bandH = bandBot - bandTop + 1;
            // Column projection over the whole band: a single scan line can
            // run straight through the label and split one button in two.
            List<int[]> segs = new List<int[]>();
            int segStart = -1;
            int minWhite = (int)Math.Ceiling(bandH * 0.35);
            for (int x = 0; x < cw; x++) {
                int wcount = 0;
                for (int y = bandTop; y <= bandBot; y++) {
                    if (PixelLuma(Native.GetPixel(mem, x, y)) >= btnLuma) wcount++;
                }
                bool on = wcount >= minWhite;
                if (on) {
                    if (segStart < 0) segStart = x;
                } else {
                    if (segStart >= 0) {
                        if (x - segStart >= 30) segs.Add(new int[] { card.Rect.L + segStart, card.Rect.L + x - 1 });
                        segStart = -1;
                    }
                }
            }
            if (segStart >= 0 && cw - segStart >= 30) segs.Add(new int[] { card.Rect.L + segStart, card.Rect.R });
            card.Buttons = segs;
            card.BandTop = card.Rect.T + bandTop;
            card.BandBottom = card.Rect.T + bandBot;
        } finally {
            if (oldObj != IntPtr.Zero) Native.SelectObject(mem, oldObj);
            if (bmp != IntPtr.Zero) Native.DeleteObject(bmp);
            if (mem != IntPtr.Zero) Native.DeleteDC(mem);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    static string ShellButtonLabel(int index, int total) {
        string name = "按钮#" + index.ToString(CultureInfo.InvariantCulture);
        if (total > 1) name += index < total ? "(左)" : "(右)";
        return name;
    }

    static ChildScan ShellCardScan(ShellCard card) {
        ChildScan s = new ChildScan();
        if (!card.BoundsOk) return s;
        int cy = (card.BandTop + card.BandBottom) / 2;
        for (int i = 0; i < card.Buttons.Count; i++) {
            int[] seg = card.Buttons[i];
            int cx = (seg[0] + seg[1]) / 2;
            s.Buttons.Add("0x0|" + (i + 1).ToString(CultureInfo.InvariantCulture)
                + "|" + J.S(ShellButtonLabel(i + 1, card.Buttons.Count))
                + "|PixelButton"
                + "|" + (cx - card.Rect.L).ToString(CultureInfo.InvariantCulture)
                + "," + (cy - card.Rect.T).ToString(CultureInfo.InvariantCulture));
        }
        return s;
    }

    // Windows 11 "system consent" cards (Windows Security Center, firewall
    // ask, ...) are hosted by C:\Windows\System32\PickerHost.Exe. Their
    // top-level window is an empty 0x0 proxy:
    //     cls=[Shell_SystemDialogProxy] size=0x0
    // The visible card (cls=[Shell_SystemDialog]) and its full-screen dim
    // backdrop (cls=[Shell_SystemDim]) are NOT returned by EnumWindows or
    // EnumThreadWindows at all - verified repeatedly on 2026-11-01 - so the
    // proxy is the only detectable anchor. Everything else (card bounds,
    // buttons) has to be recovered by hit-testing and pixels; see
    // ProbeShellCard below.
    static bool IsShellDialogClass(string cls) {
        return cls != null && cls.StartsWith("Shell_SystemDialog", StringComparison.Ordinal);
    }

    static bool ClassIsCandidate(string cls) {
        if (cls == "#32770") return true;
        if (cls.StartsWith("Credential", StringComparison.Ordinal)) return true;
        if (cls.IndexOf("TaskDialog", StringComparison.Ordinal) >= 0) return true;
        if (cls == "ApplicationFrameWindow") return true;
        if (cls.StartsWith("Windows.UI.Core.CoreWindow", StringComparison.Ordinal)) return true;
        if (IsShellDialogClass(cls)) return true;
        return false;
    }

    // ----------------------------------------------------------- scanning --
    // One enumeration pass. Every hwnd passing the base filters enters "seen"
    // (so gone-detection is stable); only real candidates emit window events.
    static void ScanTick() {
        HashSet<string> seen = new HashSet<string>();
        long now = NowMs();
        Native.EnumWindows(delegate(IntPtr h, IntPtr l) {
            try { Collect(h, seen, now); } catch { }
            return true;
        }, IntPtr.Zero);
        List<string> gone = null;
        lock (Known) {
            foreach (string k in Known) if (!seen.Contains(k)) { if (gone == null) gone = new List<string>(); gone.Add(k); }
        }
        if (gone != null) {
            foreach (string k in gone) {
                lock (Known) Known.Remove(k);
                Out("{\"ev\":\"gone\",\"hwnd\":\"" + k + "\",\"ts\":" + NowMs().ToString(CultureInfo.InvariantCulture) + "}");
            }
        }
    }

    static void Collect(IntPtr h, HashSet<string> seen, long now) {
        if (!Native.IsWindowVisible(h)) return;
        int ex = Native.GetWindowLongW(h, Native.GWL_EXSTYLE);
        if ((ex & Native.WS_EX_TOOLWINDOW) != 0) return;
        int cloaked;
        if (Native.DwmGetWindowAttribute(h, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return;
        string cls = Cls(h);
        if (ClassDeny.Contains(cls)) return;
        if (!ClassIsCandidate(cls)) return;
        bool shellDlg = IsShellDialogClass(cls);
        Native.RECT r;
        Native.GetWindowRect(h, out r);
        int w = r.R - r.L, ht = r.B - r.T;
        // Shell consent cards expose a 0x0 proxy and their real card window is
        // not enumerable at all, so bounds are recovered by hit-testing after
        // this gate and the minimum-size rule must not apply to them.
        if (!shellDlg && (w < 100 || ht < 50)) return;

        string key = Hkey(h);
        seen.Add(key);
        lock (Known) if (Known.Contains(key)) return; // already reported, unchanged
        if (Quit) return;

        uint pid = 0;
        Native.GetWindowThreadProcessId(h, out pid);
        PidInfo pi = Pid(pid);
        string exe = pi.Exe;
        string exeBase = BaseName(exe).ToLowerInvariant();
        string title = Text(h);

        if (shellDlg) {
            // No Win32 children and no UIA presence in the desktop tree, so
            // bounds and buttons come from hit-testing + pixels. The card text
            // is only obtainable, if at all, through UIA FromHandle on the real
            // card hwnd recovered during hit-testing.
            ShellCard card = ProbeShellCard(h, r);
            UiaInfo cu = null;
            if (card.CardHwnd != IntPtr.Zero) {
                try { cu = UiaInspectFromHandle(card.CardHwnd); } catch { cu = null; }
            }
            ChildScan scan = ShellCardScan(card);
            if (cu != null) {
                for (int i = 0; i < cu.Texts.Count && scan.Body.Count < 6; i++) {
                    string flat = cu.Texts[i].Replace((char)13, ' ').Replace((char)10, ' ').Trim();
                    if (flat.Length >= 4) scan.Body.Add(flat);
                }
            }
            EmitWindow(h, key, cls, title, pid, pi, card.BoundsOk ? card.Rect : r, now, scan, cu);
            return;
        }

        bool isUwpLike = cls == "ApplicationFrameWindow" || cls.StartsWith("Windows.UI.Core.CoreWindow", StringComparison.Ordinal);
        bool isCredential = cls.StartsWith("Credential", StringComparison.Ordinal);
        bool isTaskDialog = cls.IndexOf("TaskDialog", StringComparison.Ordinal) >= 0;

        UiaInfo uia = null;
        if (isUwpLike) {
            // Known-good UWP hosts (Settings / IME / search / toasts): never report.
            if (UwpHostDeny.Contains(exeBase)) return;
            // Any other UWP host is only interesting when it IS SmartScreen
            // (SmartScreen is hosted by explorer.exe with an empty top title).
            if (now - UiaLastMs < 500 && UiaLastMs != 0) {
                // UIA deep scans stay >=500ms apart; skip this pass, retry next tick.
                return;
            }
            UiaLastMs = now;
            uia = UiaInspect(h);
            if (uia == null || !uia.SmartScreen) return;
        } else {
            // Traditional dialog: cheap child scan first.
            ChildScan pre = ScanChildren(h);
            bool highRisk = isCredential || isTaskDialog;
            if (!highRisk && pre.Buttons.Count == 0) {
                // No Win32 buttons: try UIA once for XAML-hosted dialogs; if UIA
                // finds no buttons either, this is not a blocking dialog.
                if (now - UiaLastMs < 500 && UiaLastMs != 0) return;
                UiaLastMs = now;
                uia = UiaInspect(h);
                if (uia == null || uia.Buttons.Count == 0) return;
            }
            EmitWindow(h, key, cls, title, pid, pi, r, now, pre, uia);
            return;
        }
        EmitWindow(h, key, cls, title, pid, pi, r, now, ScanChildren(h), uia);
    }

    static string Classify(string cls, string title, List<string> body, string exeBase, bool smartScreen) {
        if (smartScreen) return "smartscreen";
        // Windows Security Center consent cards (firewall ask, ...).
        if (IsShellDialogClass(cls)) return "system-consent";
        if (cls.StartsWith("Credential", StringComparison.Ordinal)) return "credential";
        if (cls.IndexOf("TaskDialog", StringComparison.Ordinal) >= 0) return "system-modal";
        // installer-wizard: installer words in title/body/exe
        if (MatchesInstall(title) || MatchesInstall(exeBase)) return "installer-wizard";
        foreach (string b in body) if (MatchesInstall(b)) return "installer-wizard";
        return "app-error";
    }

    // "install"/"setup" plus the Chinese word for install (\u5B89\u88C5).
    static bool MatchesInstall(string s) {
        if (string.IsNullOrEmpty(s)) return false;
        string lower = s.ToLowerInvariant();
        if (lower.Contains("install") || lower.Contains("setup") || lower.Contains("installer")) return true;
        if (s.IndexOf("\u5B89\u88C5", StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    static void EmitWindow(IntPtr h, string key, string cls, string title, uint pid, PidInfo pi,
                           Native.RECT r, long now, ChildScan scan, UiaInfo uia) {
        IntPtr owner = Native.GetWindow(h, Native.GW_OWNER);
        uint ownerPid = 0;
        string ownerExe = "";
        if (owner != IntPtr.Zero) {
            Native.GetWindowThreadProcessId(owner, out ownerPid);
            if (ownerPid != 0) ownerExe = Pid(ownerPid).Exe;
        }
        IntPtr fg = Native.GetForegroundWindow();
        bool foreground = fg == h;
        bool smart = uia != null && uia.SmartScreen;
        string exeBase = BaseName(pi.Exe).ToLowerInvariant();
        string kind = Classify(cls, title, scan.Body, exeBase, smart);

        StringBuilder sb = new StringBuilder(1024);
        sb.Append("{\"ev\":\"window\",\"hwnd\":\"").Append(key).Append('"');
        sb.Append(",\"cls\":\"").Append(J.S(cls)).Append('"');
        sb.Append(",\"title\":\"").Append(J.S(title)).Append('"');
        sb.Append(",\"pid\":").Append(pid.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"exe\":\"").Append(J.S(pi.Exe)).Append('"');
        sb.Append(",\"procCreateMs\":").Append(pi.CreateMs >= 0 ? pi.CreateMs.ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"ownerHwnd\":\"").Append(owner == IntPtr.Zero ? "0x0" : Hkey(owner)).Append('"');
        sb.Append(",\"ownerPid\":").Append(ownerPid.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"ownerExe\":\"").Append(J.S(ownerExe)).Append('"');
        sb.Append(",\"rect\":[").Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R).Append(',').Append(r.B).Append(']');
        sb.Append(",\"foreground\":").Append(foreground ? "true" : "false");
        sb.Append(",\"firstSeenMs\":").Append(now.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"kind\":\"").Append(kind).Append('"');
        sb.Append(",\"smartScreen\":").Append(smart ? "true" : "false");
        sb.Append(",\"smartScreenApp\":\"").Append(J.S(uia == null ? "" : uia.SmartScreenApp)).Append('"');
        // Interceptors (firewall / UAC / SmartScreen / AV) own the window, so
        // their exe says nothing about WHO caused it. The blocked program and
        // the command chain that spawned it carry DSH_SESSION_ID; list them so
        // the host can attribute by session.
        if (IsInterceptor(cls, exeBase, smart)) {
            sb.Append(",\"interceptor\":true");
            List<SessionProc> sp = ScanSessionProcs();
            if (sp.Count > 0) {
                sb.Append(",\"sessionProcs\":[");
                for (int si = 0; si < sp.Count; si++) {
                    if (si > 0) sb.Append(',');
                    sb.Append("{\"pid\":").Append(sp[si].Pid.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"exe\":\"").Append(J.S(sp[si].Exe)).Append('"');
                    sb.Append(",\"createMs\":").Append(sp[si].CreateMs.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"sessionId\":\"").Append(J.S(sp[si].SessionId)).Append('"');
                    sb.Append('}');
                }
                sb.Append(']');
            }
        }
        sb.Append(",\"body\":[");
        for (int i = 0; i < scan.Body.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(J.S(scan.Body[i])).Append('"'); }
        sb.Append("],\"buttons\":[");
        for (int i = 0; i < scan.Buttons.Count; i++) { if (i > 0) sb.Append(','); sb.Append('{').Append(ButtonJson(scan.Buttons[i])).Append('}'); }
        sb.Append("],\"uiaButtons\":[");
        if (uia != null) {
            for (int i = 0; i < uia.Buttons.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append("{\"automationId\":\"").Append(J.S(uia.Buttons[i][0]))
                  .Append("\",\"name\":\"").Append(J.S(uia.Buttons[i][1])).Append("\"}");
            }
        }
        sb.Append("]}");
        Out(sb.ToString());
        lock (Known) Known.Add(key);
    }

    // child button entry "hwndHex|ctrlId|text|class[|pixelX,pixelY]" -> json
    // fields. The optional 5th part marks a pixel-derived button on a Shell
    // consent card, where no hwnd exists and the offset inside the card is the
    // only addressable identity.
    static string ButtonJson(string entry) {
        string[] parts = entry.Split(new char[] { '|' }, 5);
        string hwnd = parts.Length > 0 ? parts[0] : "0x0";
        string ctrl = parts.Length > 1 ? parts[1] : "0";
        string text = parts.Length > 2 ? parts[2] : "";
        string cls = parts.Length > 3 ? parts[3] : "Button";
        string json = "\"hwnd\":\"" + hwnd + "\",\"ctrlId\":" + ctrl + ",\"text\":\"" + text + "\",\"cls\":\"" + cls + "\"";
        if (parts.Length > 4 && parts[4].Length > 0) json += ",\"pixel\":\"" + parts[4] + "\"";
        return json;
    }

    // ------------------------------------------------------------- clicker --
    // intent -> candidate button labels. C#-side only: Chinese labels are \u
    // escapes so the ASCII-only ps1 and the host never carry Chinese.
    static readonly Dictionary<string, string[]> Intents = CreateIntents();

    static Dictionary<string, string[]> CreateIntents() {
        Dictionary<string, string[]> d = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
        d["ok"] = new string[] { "\u786E\u5B9A", "OK", "Yes", "\u662F", "\u7EE7\u7EED", "Continue" };
        d["cancel"] = new string[] { "\u53D6\u6D88", "Cancel", "No", "\u5426", "\u5173\u95ED", "Close" };
        d["run"] = new string[] { "\u4ECD\u8981\u8FD0\u884C", "Run anyway", "Run", "\u5141\u8BB8", "Allow" };
        d["dontrun"] = new string[] { "\u4E0D\u8FD0\u884C", "Don't run", "Do not run", "Don't Run" };
        return d;
    }

    static bool NameMatches(string name, string intent, string buttonText) {
        string clean = name == null ? "" : name.Replace("&", "").Trim();
        if (clean.Length == 0) return false;
        if (!string.IsNullOrEmpty(buttonText)) return string.Equals(clean, buttonText, StringComparison.Ordinal);
        string[] cands;
        if (!Intents.TryGetValue(intent == null ? "" : intent, out cands)) return false;
        foreach (string c in cands) if (string.Equals(clean, c, StringComparison.Ordinal)) return true;
        return false;
    }

    // Foreground sampling that can be trusted (second-acceptance 2.4): the
    // old single-shot sample saw transient 0x0 values and window-teardown
    // shifts, so fgStable could not distinguish "our click stole focus"
    // from "the clicked window was destroyed". Three samples 100ms apart
    // with 0x0 ignored give a settled value on each side of the click.
    static string FgStable() {
        string last = "0x0";
        for (int i = 0; i < 3; i++) {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg != IntPtr.Zero) last = Hkey(fg);
            if (i < 2) Thread.Sleep(100);
        }
        return last;
    }

    // Shell consent cards expose no readable button text (XAML surface with
    // no UIA and no Win32 child), so buttons are addressed by position. In
    // every Windows locale the affirmative/primary action sits left-most and
    // the dismissive one right-most, which is what the intents mean.
    static int PickShellButton(int total, string intent) {
        if (total <= 0) return -1;
        string it = intent == null ? "" : intent.ToLowerInvariant();
        if (it == "cancel" || it == "dontrun" || it == "close" || it == "no") return total - 1;
        if (it == "ok" || it == "run" || it == "yes" || it == "allow") return 0;
        return -1;
    }

    // Real mouse click at a physical-pixel point. Refuses unless the point
    // still resolves back to a Shell_System* window, so a geometry change
    // between probing and clicking can never land the click elsewhere.
    static bool ClickAtPoint(int x, int y) {
        Native.POINT probe;
        probe.X = x; probe.Y = y;
        IntPtr hit = Native.WindowFromPoint(probe);
        if (hit == IntPtr.Zero) return false;
        if (!IsShellDialogClass(Cls(hit))) return false;
        if (!Native.SetCursorPos(x, y)) return false;
        Thread.Sleep(120);
        Native.POINT actual;
        if (!Native.GetCursorPos(out actual)) return false;
        if (actual.X != x || actual.Y != y) return false;
        Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        Thread.Sleep(80);
        Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
        return true;
    }

    // Click a button on a dialog without activating it.
    // Order (verified by experiments B / click-smartscreen.ps1):
    //   1. UIA InvokePattern, then LegacyIAccessiblePattern (SmartScreen/XAML)
    //   2. Win32 PostMessage(BM_CLICK) on the matching child Button (#32770;
    //      traditional Win32 buttons appear as ControlType.Pane in UIA and
    //      have no Invoke pattern, so the Win32 fallback is mandatory)
    // Returns a clickResult JSON line. Never calls SetForegroundWindow.
    public static string Click(IntPtr h, string intent, string buttonText, string requestId) {
        string fgBefore = FgStable();
        string via = "";
        string clickedText = "";
        if (string.IsNullOrEmpty(buttonText) && !Intents.ContainsKey(intent == null ? "" : intent)) {
            return ClickResult(requestId, h, false, "bad-intent", "", fgBefore, fgBefore, false);
        }
        // --- path 1: UIA ---
        try {
            System.Windows.Automation.PropertyCondition cond = new System.Windows.Automation.PropertyCondition(
                System.Windows.Automation.AutomationElement.NativeWindowHandleProperty, (int)h.ToInt64());
            System.Windows.Automation.AutomationElement el = System.Windows.Automation.AutomationElement.RootElement.FindFirst(
                System.Windows.Automation.TreeScope.Children, cond);
            if (el != null) {
                System.Windows.Automation.AutomationElementCollection all =
                    el.FindAll(System.Windows.Automation.TreeScope.Descendants,
                               System.Windows.Automation.Condition.TrueCondition);
                int n = 0;
                foreach (System.Windows.Automation.AutomationElement e in all) {
                    if (++n > 400) break;
                    try {
                        if (e.Current.ControlType != System.Windows.Automation.ControlType.Button) continue;
                        string name = e.Current.Name == null ? "" : e.Current.Name;
                        if (!NameMatches(name, intent, buttonText)) continue;
                        object pat;
                        if (e.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern, out pat)) {
                            ((System.Windows.Automation.InvokePattern)pat).Invoke();
                            via = "uia-invoke"; clickedText = name; break;
                        }
                        // LegacyIAccessiblePattern is missing from some .NET
                        // Framework reference profiles, so find it by pattern
                        // name and call DoDefaultAction via reflection instead
                        // of a compile-time type reference.
                        try {
                            foreach (System.Windows.Automation.AutomationPattern p in e.GetSupportedPatterns()) {
                                string pn = p.ProgrammaticName == null ? "" : p.ProgrammaticName;
                                if (pn.IndexOf("LegacyIAccessible", StringComparison.Ordinal) < 0) continue;
                                object leg = e.GetCurrentPattern(p);
                                System.Reflection.MethodInfo mi = leg == null ? null : leg.GetType().GetMethod("DoDefaultAction", Type.EmptyTypes);
                                if (mi != null) {
                                    mi.Invoke(leg, null);
                                    via = "uia-legacy"; clickedText = name;
                                }
                                break;
                            }
                        } catch { }
                        if (via.Length > 0) break;
                    } catch { }
                }
            }
        } catch { }
        // --- path 2: Win32 BM_CLICK on the matching child button ---
        if (via.Length == 0) {
            IntPtr found = IntPtr.Zero;
            string foundText = "";
            Native.EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
                try {
                    string cls = Cls(c);
                    if (cls.IndexOf("Button", StringComparison.OrdinalIgnoreCase) < 0) return true;
                    string t = Text(c);
                    if (!NameMatches(t, intent, buttonText)) return true;
                    found = c; foundText = t;
                    return false;
                } catch { return true; }
            }, IntPtr.Zero);
            if (found != IntPtr.Zero) {
                Native.PostMessageW(found, Native.BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                via = "win32-bmclick"; clickedText = foundText;
            }
        }
        // --- path 3: Shell system consent card (pixel-driven) ---
        // This card is drawn by XAML into a window that EnumWindows cannot
        // even see, and UIA reports its bounds as Infinity, so neither UIA nor
        // BM_CLICK can reach it. Instead: hit-test for the card box, GDI-
        // capture that box, find the near-white button rects, and send a real
        // mouse click at the centre of the intended one. Verified working on
        // the reference machine on 2026-11-01 (dialog closed, host exited).
        if (via.Length == 0 && IsShellDialogClass(Cls(h))) {
            Native.RECT wr;
            Native.GetWindowRect(h, out wr);
            ShellCard card = ProbeShellCard(h, wr);
            if (card.BoundsOk && card.Buttons.Count > 0) {
                int idx = PickShellButton(card.Buttons.Count, intent);
                if (idx >= 0 && idx < card.Buttons.Count) {
                    int[] seg = card.Buttons[idx];
                    int cx = (seg[0] + seg[1]) / 2;
                    int cy = (card.BandTop + card.BandBottom) / 2;
                    if (ClickAtPoint(cx, cy)) {
                        via = "pixel-mouse";
                        clickedText = ShellButtonLabel(idx + 1, card.Buttons.Count);
                    }
                }
            }
        }
        if (via.Length == 0) {
            return ClickResult(requestId, h, false, "button-not-found", "", fgBefore, fgBefore, false);
        }
        // Let the dialog process the click, then sample the aftermath with
        // the same settled-sampling as before the click.
        for (int slept = 0; slept < 600; slept += 50) {
            Thread.Sleep(50);
            if (!Native.IsWindow(h) || !Native.IsWindowVisible(h)) break;
        }
        bool gone = !Native.IsWindow(h) || !Native.IsWindowVisible(h);
        string fgAfter = FgStable();
        return ClickResult(requestId, h, true, via, clickedText, fgBefore, fgAfter, gone);
    }

    static string ClickResult(string requestId, IntPtr h, bool ok, string via, string button,
                              string fgBefore, string fgAfter, bool gone) {
        StringBuilder sb = new StringBuilder(256);
        sb.Append("{\"ev\":\"clickResult\"");
        if (!string.IsNullOrEmpty(requestId)) sb.Append(",\"requestId\":\"").Append(J.S(requestId)).Append('"');
        sb.Append(",\"hwnd\":\"").Append(Hkey(h)).Append('"');
        sb.Append(",\"ok\":").Append(ok ? "true" : "false");
        sb.Append(",\"via\":\"").Append(J.S(via)).Append('"');
        sb.Append(",\"button\":\"").Append(J.S(button)).Append('"');
        sb.Append(",\"fgBefore\":\"").Append(fgBefore).Append('"');
        sb.Append(",\"fgAfter\":\"").Append(fgAfter).Append('"');
        sb.Append(",\"windowGone\":").Append(gone ? "true" : "false");
        // A settled value of 0x0 means "no foreground right now" (teardown
        // gap); only a real, matching pair counts as stable.
        bool stable = fgBefore != "0x0" && fgBefore == fgAfter;
        sb.Append(",\"fgStable\":").Append(stable ? "true" : "false");
        sb.Append(",\"ts\":").Append(NowMs().ToString(CultureInfo.InvariantCulture)).Append('}');
        return sb.ToString();
    }

    // ---------------------------------------------------------- commands --
    // Handle one stdin command line. Returns "quit" when the daemon must stop.
    static string HandleCommand(string line) {
        string cmd = J.Get(line, "cmd");
        if (cmd == "quit") return "quit";
        if (cmd == "interval") { Busy = J.Get(line, "busy") == "true"; return ""; }
        if (cmd == "scan") { ScanTick(); return ""; }
        if (cmd == "click") {
            string hwndS = J.Get(line, "hwnd");
            long hv;
            string requestId = J.Get(line, "requestId");
            if (!TryParseHex(hwndS, out hv)) { Out(ClickResult(requestId, IntPtr.Zero, false, "bad-hwnd", "", "", "", false)); return ""; }
            string intent = J.Get(line, "intent");
            string buttonText = J.Get(line, "buttonText");
            Out(Click(new IntPtr(hv), intent, buttonText, requestId));
            return "";
        }
        if (cmd == "close") {
            string hwndS = J.Get(line, "hwnd");
            long hv;
            string requestId = J.Get(line, "requestId");
            if (!TryParseHex(hwndS, out hv)) { Out(ClickResult(requestId, IntPtr.Zero, false, "bad-hwnd", "", "", "", false)); return ""; }
            IntPtr h = new IntPtr(hv);
            string fgBefore = FgStable();
            Native.PostMessageW(h, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            for (int slept = 0; slept < 600; slept += 50) {
                Thread.Sleep(50);
                if (!Native.IsWindow(h) || !Native.IsWindowVisible(h)) break;
            }
            bool gone = !Native.IsWindow(h) || !Native.IsWindowVisible(h);
            string fgAfter = FgStable();
            Out(ClickResult(requestId, h, true, "win32-wmclose", "", fgBefore, fgAfter, gone));
            return "";
        }
        return "";
    }

    static bool TryParseHex(string s, out long v) {
        v = 0;
        if (string.IsNullOrEmpty(s)) return false;
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        return long.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
    }

    // ------------------------------------------------------------ entrypoints --
    // One-shot mode: executes a single command and exits (used by tests and
    // diagnostics). `once` is either "scan", "scan-all", or a JSON command
    // line like {"cmd":"click","hwnd":"0x...","intent":"ok"}.
    public static void Once(string once) {
        if (once == null) once = "";
        once = once.Trim();
        if (once.StartsWith("{", StringComparison.Ordinal)) {
            Out(HandleCommand(once));
            return;
        }
        if (once == "scan-all") { ScanAll(); return; }
        ScanTick();
        // In one-shot mode Known starts empty, so ScanTick emits every
        // candidate exactly once - which is what a single scan should print.
    }

    // Full visible-top-level-window listing for diagnostics and T-1:
    // every window (not only dialog candidates) with pid/exe/createMs.
    static void ScanAll() {
        List<string> lines = new List<string>();
        Native.EnumWindows(delegate(IntPtr h, IntPtr l) {
            try {
                if (!Native.IsWindowVisible(h)) return true;
                string cls = Cls(h);
                if (ClassDeny.Contains(cls)) return true;
                uint pid = 0;
                Native.GetWindowThreadProcessId(h, out pid);
                PidInfo pi = Pid(pid);
                Native.RECT r;
                Native.GetWindowRect(h, out r);
                StringBuilder sb = new StringBuilder(256);
                sb.Append("{\"ev\":\"window-all\",\"hwnd\":\"").Append(Hkey(h)).Append('"');
                sb.Append(",\"cls\":\"").Append(J.S(cls)).Append('"');
                sb.Append(",\"title\":\"").Append(J.S(Text(h))).Append('"');
                sb.Append(",\"pid\":").Append(pid.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"exe\":\"").Append(J.S(pi.Exe)).Append('"');
                sb.Append(",\"procCreateMs\":").Append(pi.CreateMs >= 0 ? pi.CreateMs.ToString(CultureInfo.InvariantCulture) : "null");
                sb.Append(",\"rect\":[").Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R).Append(',').Append(r.B).Append(']');
                sb.Append('}');
                lines.Add(sb.ToString());
            } catch { }
            return true;
        }, IntPtr.Zero);
        foreach (string line in lines) Out(line);
    }

    // Resident loop: scans on a busy/idle cadence, processes stdin commands,
    // exits cleanly on {"cmd":"quit"} or stdin EOF (probe toggle off).
    public static void Daemon(int busyMs, int idleMs) {
        BusyMs = busyMs > 100 ? busyMs : 1500;
        IdleMs = idleMs > 100 ? idleMs : 5000;
        Queue<string> inbox = new Queue<string>();
        Exception readerError = null;
        // Set only by the reader thread at true EOF (or after a quit line).
        // An empty queue is NOT EOF: the host regularly has nothing to say
        // between scans, and treating that as EOF would kill the daemon
        // right after its first command batch.
        bool readerDone = false;
        Thread reader = new Thread(delegate() {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    lock (Gate) inbox.Enqueue(line);
                    if (line == "{\"cmd\":\"quit\"}") { lock (Gate) readerDone = true; return; }
                }
                lock (Gate) { inbox.Enqueue(null); readerDone = true; } // EOF
            } catch (Exception ex) {
                readerError = ex;
                lock (Gate) { inbox.Enqueue(null); readerDone = true; }
            }
        });
        reader.IsBackground = true;
        reader.Start();
        Out("{\"ev\":\"ready\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
            + ",\"busyMs\":" + BusyMs.ToString(CultureInfo.InvariantCulture)
            + ",\"idleMs\":" + IdleMs.ToString(CultureInfo.InvariantCulture) + "}");
        while (!Quit) {
            // Drain stdin. An empty queue with a live reader just means "no
            // commands right now" - keep scanning; only a real EOF sentinel
            // (or a quit command) ends the daemon.
            while (true) {
                string item;
                bool eof;
                lock (Gate) {
                    item = inbox.Count > 0 ? inbox.Dequeue() : null;
                    eof = readerDone && inbox.Count == 0;
                }
                if (item == null) {
                    if (eof) Quit = true;
                    break;
                }
                if (item.Length == 0) continue;
                if (HandleCommand(item) == "quit") { Quit = true; break; }
            }
            if (Quit) break;
            long t0 = NowMs();
            try { ScanTick(); } catch { }
            int interval = Busy ? BusyMs : IdleMs;
            int wait = interval - (int)(NowMs() - t0);
            if (wait < 50) wait = 50;
            // Sleep in slices so stdin commands are served promptly.
            for (int slept = 0; slept < wait && !Quit; slept += 60) {
                Thread.Sleep(60);
                lock (Gate) if (inbox.Count > 0) break;
            }
        }
        Out("{\"ev\":\"bye\"}");
        try { Console.Out.Flush(); } catch { }
    }
}

}
