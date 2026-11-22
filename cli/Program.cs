using System.Diagnostics;

namespace TrueDoF;

/// <summary>
/// TrueDoF.Cli: makes one dump by reading the running fm.exe from outside (read-only).
/// Use it if the BepInEx plugin won't load. Same output files as the plugin.
///
///   TrueDoF.Cli.exe
///   TrueDoF.Cli.exe --probe "balance=12500000; points=24" [--depth 2] [--inspect "competition +0xE08 +0x1E8"]
/// </summary>
public static class Program
{
    public static int Main(string[] args)
    {
        var s = new Settings { Host = "cli" };
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--probe" && i + 1 < args.Length) { s.ProbeEnabled = true; s.ProbeValues = args[++i]; }
            else if (args[i] == "--depth" && i + 1 < args.Length && int.TryParse(args[++i], out int d)) s.ProbeDepth = Math.Clamp(d, 0, 4);
            else if (args[i] == "--out" && i + 1 < args.Length) s.OutDir = args[++i];
            else if (args[i] == "--inspect" && i + 1 < args.Length) { s.ProbeEnabled = true; s.ProbeInspect = args[++i]; }
        }

        if (!OperatingSystem.IsWindows()) { Console.WriteLine("TrueDoF.Cli only works on Windows, next to a running FM27."); return 2; }

        var fm = Process.GetProcessesByName("fm").OrderByDescending(p => { try { return p.StartTime; } catch { return DateTime.MinValue; } }).FirstOrDefault();
        if (fm == null) { Console.WriteLine("Football Manager (fm.exe) is not running. Start FM, load your save, and run this again."); return 1; }

        Console.WriteLine($"Reading fm.exe (pid {fm.Id})… this takes 5-20 seconds.");
        using var mem = WindowsMemory.OpenExternal(fm);
        bool ok = DumpRunner.RunNow(mem, s);
        Console.WriteLine(ok ? $"Done. Files are in {s.OutDir}" : $"Failed. See {Path.Combine(s.OutDir, "status.json")} and diagnostics.txt");
        return ok ? 0 : 1;
    }
}
