namespace TrueDoF;

/// <summary>Options for one dump. The plugin fills these from the BepInEx config file.</summary>
public sealed class Settings
{
    public const string ToolVersion = "0.1.5";

    public string Host = "plugin";
    public string OutDir = DefaultOutDir();
    public bool ProbeEnabled;
    public string ProbeValues = "";
    public int ProbeDepth = 2;
    public string ProbeInspect = "";
    public int ProbeInspectBytes = 0x800;
    public int ShortlistMaxMatches = 3;

    public static string DefaultOutDir() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TrueDoF");
}

/// <summary>
/// Logging. The host (plugin or CLI) plugs its own output in; we also keep a small
/// truedof.log in the output folder so problems can be reported without BepInEx.
/// </summary>
public static class Log
{
    public static Action<string> InfoSink = Console.WriteLine;
    public static Action<string> WarnSink = Console.WriteLine;
    public static Action<string> ErrorSink = Console.Error.WriteLine;
    public static string FilePath;
    private static readonly object Gate = new();

    public static void Info(string s) { Safe(InfoSink, s); ToFile("INFO ", s); }
    public static void Warn(string s) { Safe(WarnSink, s); ToFile("WARN ", s); }
    public static void Error(string s) { Safe(ErrorSink, s); ToFile("ERROR", s); }

    private static void Safe(Action<string> sink, string s) { try { sink?.Invoke(s); } catch { } }

    private static void ToFile(string level, string s)
    {
        if (FilePath == null) return;
        try
        {
            lock (Gate)
            {
                var fi = new FileInfo(FilePath);
                if (fi.Exists && fi.Length > 1_000_000) fi.Delete();   // keep it small
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {level} {s}{Environment.NewLine}");
            }
        }
        catch { }
    }
}
