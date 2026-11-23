namespace TrueDoF.Overlay;

/// <summary>
/// TrueDoF Overlay: talk to your Director without leaving FM.
///
/// What it does:
///  * shows the Director chat (http://localhost:8766/?compact=1) in a small window that stays on top of FM;
///  * F9 (anywhere, also inside FM) shows or hides it; it turns see-through when you click back into FM;
///  * starts the chat app (node server/server.js) if it isn't running, and stops it again on exit;
///  * remembers where you put it and how big it was.
///
/// It never touches FM: it's a normal separate window. FM must not use *exclusive* fullscreen for any window
/// to appear over it (see TROUBLESHOOTING.md).
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // One overlay at a time: a second start just exits (the first one is toggled with F9).
        using var single = new Mutex(true, @"Local\TrueDoF-Overlay", out bool first);
        if (!first) return 0;

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += (_, e) => Log.Error("UI error: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Fatal: " + e.ExceptionObject);

        try
        {
            Application.Run(new OverlayForm(args.Contains("--hidden")));
            return 0;
        }
        catch (Exception e)
        {
            Log.Error("Overlay crashed: " + e);
            MessageBox.Show("TrueDoF Overlay stopped: " + e.Message + "\n\nDetails are in overlay.log in the TrueDoF folder.", "TrueDoF");
            return 1;
        }
    }
}

/// <summary>overlay.log in %LOCALAPPDATA%\TrueDoF (never throws).</summary>
public static class Log
{
    public static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TrueDoF");
    private static readonly object Gate = new();

    public static void Info(string s) => Write("INFO", s);
    public static void Error(string s) => Write("ERROR", s);

    private static void Write(string level, string s)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Dir);
                File.AppendAllText(Path.Combine(Dir, "overlay.log"), $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {level} {s}{Environment.NewLine}");
            }
        }
        catch { /* logging must never break the overlay */ }
    }
}
