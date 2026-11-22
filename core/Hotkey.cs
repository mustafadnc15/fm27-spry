namespace TrueDoF;

/// <summary>
/// Watches the keyboard for the dump hotkey (default F8) on a small background thread,
/// using Windows' GetAsyncKeyState. It only reacts while FM's window is in front, so
/// pressing F8 in another app does nothing.
///
/// Why not Unity's input system? It needs Unity objects from the game, and the reference
/// project found its Unity hook sometimes never ran. Asking Windows directly is simpler
/// and touches nothing in the game.
/// </summary>
public sealed class HotkeyWatcher
{
    private readonly Func<string> _keyName;
    private readonly Action _onPress;
    private readonly bool _requireForeground;

    public HotkeyWatcher(Func<string> keyName, Action onPress, bool requireForeground = true)
    {
        _keyName = keyName; _onPress = onPress; _requireForeground = requireForeground;
    }

    public void Start()
    {
        new Thread(Loop) { IsBackground = true, Name = "TrueDoF-hotkey" }.Start();
    }

    private void Loop()
    {
        bool wasDown = false;
        string lastName = null;
        Hotkey key = null;
        while (true)
        {
            try
            {
                Thread.Sleep(30);
                string name = _keyName();
                if (name != lastName)
                {
                    lastName = name;
                    key = Hotkey.Parse(name);
                    if (key == null) Log.Warn($"Hotkey '{name}' not understood; use e.g. F8, Ctrl+F8, Shift+D.");
                    else Log.Info($"Hotkey: {name}");
                }
                if (key == null) continue;
                bool down = key.IsDown();
                if (down && !wasDown && (!_requireForeground || OwnWindowInFront()))
                    _onPress();
                wasDown = down;
            }
            catch (Exception e)
            {
                Log.Warn("Hotkey watcher: " + e.Message);
                Thread.Sleep(1000);
            }
        }
    }

    private static bool OwnWindowInFront()
    {
        nint w = Native.GetForegroundWindow();
        if (w == 0) return false;
        Native.GetWindowThreadProcessId(w, out uint pid);
        return pid == (uint)Environment.ProcessId;
    }
}

/// <summary>A key plus optional Ctrl/Shift/Alt, parsed from text like "Ctrl+F8".</summary>
public sealed class Hotkey
{
    public int VirtualKey;
    public bool Ctrl, Shift, Alt;

    public bool IsDown() =>
        Pressed(VirtualKey)
        && (!Ctrl || Pressed(0x11)) && (!Shift || Pressed(0x10)) && (!Alt || Pressed(0x12));

    private static bool Pressed(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;

    public static Hotkey Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var k = new Hotkey();
        foreach (string raw in text.Split('+'))
        {
            string p = raw.Trim().ToUpperInvariant();
            switch (p)
            {
                case "CTRL": case "CONTROL": k.Ctrl = true; continue;
                case "SHIFT": k.Shift = true; continue;
                case "ALT": k.Alt = true; continue;
            }
            int vk = KeyCode(p);
            if (vk == 0) return null;
            k.VirtualKey = vk;
        }
        return k.VirtualKey == 0 ? null : k;
    }

    private static int KeyCode(string p)
    {
        if (p.Length >= 2 && p[0] == 'F' && int.TryParse(p.Substring(1), out int f) && f is >= 1 and <= 24) return 0x70 + f - 1;
        if (p.Length == 1 && p[0] is >= 'A' and <= 'Z') return p[0];
        if (p.Length == 1 && p[0] is >= '0' and <= '9') return p[0];
        return p switch
        {
            "INSERT" => 0x2D, "DELETE" => 0x2E, "HOME" => 0x24, "END" => 0x23,
            "PAGEUP" => 0x21, "PAGEDOWN" => 0x22, "PAUSE" => 0x13, "SCROLLLOCK" => 0x91,
            _ => 0,
        };
    }
}

/// <summary>
/// Second trigger, for the Phase 3 web app: if a file "request.flag" appears in the output
/// folder, start a dump and delete it. Old flags (more than 2 minutes) are thrown away so a
/// stale request can't fire while FM is still starting.
/// </summary>
public sealed class RequestFlagWatcher
{
    private readonly Func<string> _outDir;
    private readonly Action _onRequest;

    public RequestFlagWatcher(Func<string> outDir, Action onRequest) { _outDir = outDir; _onRequest = onRequest; }

    public void Start() => new Thread(Loop) { IsBackground = true, Name = "TrueDoF-request" }.Start();

    private void Loop()
    {
        while (true)
        {
            Thread.Sleep(1000);
            try
            {
                string f = Path.Combine(_outDir(), "request.flag");
                if (!File.Exists(f)) continue;
                bool fresh = (DateTime.UtcNow - File.GetLastWriteTimeUtc(f)).TotalMinutes < 2;
                File.Delete(f);
                if (fresh) _onRequest();
            }
            catch { /* try again next second */ }
        }
    }
}
