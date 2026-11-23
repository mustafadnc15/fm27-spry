using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace TrueDoF;

/// <summary>
/// Runs one complete dump and writes the files. Guarantees:
///  * only one dump at a time (also across plugin + CLI, via a named mutex);
///  * any error is caught, written to status.json + diagnostics.txt, and never reaches FM;
///  * a failed dump never overwrites the last good dump-latest.json.
/// </summary>
public static class DumpRunner
{
    private static int _busy;

    public static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        IncludeFields = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,   // keep "Ødegaard" readable
    };

    /// <summary>Start a dump on a background thread. Returns false if one is already running.</summary>
    public static bool TryStartInBackground(string trigger, Func<IMemory> open, Func<Settings> settings)
    {
        if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return false;
        var t = new Thread(() =>
        {
            try
            {
                Log.Info($"Dump requested ({trigger}).");
                var s = settings();
                var memory = open();
                try { RunCore(memory, s); }
                finally { (memory as IDisposable)?.Dispose(); }
            }
            catch (Exception e) { Log.Error("Dump thread failed: " + e); }
            finally { Interlocked.Exchange(ref _busy, 0); }
        }) { IsBackground = true, Name = "TrueDoF-dump" };
        t.Start();
        return true;
    }

    /// <summary>Run a dump on the calling thread (CLI and self-test). True = success.</summary>
    public static bool RunNow(IMemory memory, Settings s)
    {
        if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return false;
        try { return RunCore(memory, s); }
        finally { Interlocked.Exchange(ref _busy, 0); }
    }

    private static bool RunCore(IMemory memory, Settings s)
    {
        Directory.CreateDirectory(s.OutDir);
        Log.FilePath = Path.Combine(s.OutDir, "truedof.log");

        Mutex gate = null;
        try
        {
            try
            {
                gate = new Mutex(false, @"Local\TrueDoF-dump");
                bool owned;
                try { owned = gate.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                if (!owned) { gate.Dispose(); gate = null; Log.Info("Another TrueDoF dump is running; skipped."); return false; }
            }
            catch (Exception e) when (e is PlatformNotSupportedException || e is UnauthorizedAccessException || e is IOException)
            {
                gate = null;   // no cross-process lock available; the in-process flag still protects us
            }
            return DumpOnce(memory, s);
        }
        finally
        {
            try { gate?.ReleaseMutex(); } catch { }
            gate?.Dispose();
        }
    }

    private static bool DumpOnce(IMemory memory, Settings s)
    {
        var sw = Stopwatch.StartNew();
        var diag = new List<string>();
        var status = new Status { State = "running", Host = s.Host };
        var dump = new Dump();
        dump.Meta.ToolVersion = Settings.ToolVersion;
        dump.Meta.Host = s.Host;
        dump.Meta.GeneratedAt = DateTime.Now.ToString("s");
        WriteStatus(s, status);
        ScanResult scan = null;
        Layout layout = Layout.FM27;
        bool ok = false;

        try
        {
            var mem = new Mem(memory);
            var gp = memory.FindModule("game_plugin.dll");
            var ga = memory.FindModule("GameAssembly.dll");
            if (gp == null)
                throw new DumpException("FM's game database (game_plugin.dll) isn't loaded yet. Load your save, then press the hotkey again.");

            (layout, bool verified) = Layout.For(gp.Major, gp.Minor);
            status.GameVersion = dump.Meta.GameVersion = gp.FileVersion;
            status.Layout = dump.Meta.Layout = layout.Name;
            status.VersionVerified = dump.Meta.VersionVerified = verified;
            diag.Add($"game_plugin.dll {gp.FileVersion ?? "?"} @0x{gp.Base:X} (size 0x{gp.Size:X}); GameAssembly.dll {(ga == null ? "not found" : $"@0x{ga.Base:X}")}");
            diag.Add($"Layout {layout.Name}, verified for this version: {(verified ? "yes" : "NO - data may be wrong")}");
            if (!verified)
                dump.Notes.Add($"This FM version ({gp.FileVersion}) is not verified. If numbers look wrong, see TROUBLESHOOTING.md.");

            var regions = memory.HeapRegions();
            diag.Add($"Heap regions: {regions.Count}, {regions.Sum(r => (double)r.Size) / (1024 * 1024):N0} MB");
            long lastProgress = 0;
            scan = HeapScanner.Scan(mem, layout, gp, ga, regions, frac =>
            {
                long now = sw.ElapsedMilliseconds;
                if (now - Interlocked.Read(ref lastProgress) < 500) return;
                Interlocked.Exchange(ref lastProgress, now);
                status.Progress = Math.Round(frac * 0.9, 3);
                WriteStatus(s, status);
            });
            diag.Add($"Scan: {scan.Players.Count:N0} players, {scan.ManagerPersons.Count} human-manager objects, {scan.Deals.Count:N0} deal records, " +
                     $"{scan.Candidates:N0} candidates, {scan.UnreadableFraction:P1} unreadable, {scan.RegionErrors} region errors {(scan.FirstRegionError ?? "")}");
            diag.Add($"Scan time: {sw.ElapsedMilliseconds} ms");
            dump.Meta.PlayersInDatabase = scan.Players.Count;

            if (scan.UnreadableFraction > 0.10)
                throw new DumpException($"{scan.UnreadableFraction:P0} of FM's memory could not be read (FM busy or low on RAM). " +
                                        "Wait until FM is idle (not processing), then try again.");
            if (scan.Players.Count == 0)
                throw new DumpException("No players found in memory. Is your save fully loaded? If yes, this FM version may need new offsets.");

            var ctx = new ClubDumper(mem, layout, scan, s, diag).Build(dump);

            // Your tactic, from the match engine's selections. Optional: a failure never spoils the dump.
            try { dump.Tactic = TacticReader.Read(mem, layout, scan, dump, diag); }
            catch (Exception e) { diag.Add("Tactic reading failed: " + e.Message); }
            if (dump.Tactic == null) dump.Notes.Add("Your tactic could not be read from memory (tactic.txt still works).");

            WriteAtomic(Path.Combine(s.OutDir, "dump-latest.json"), JsonSerializer.Serialize(dump, Json));

            if (s.ExportDatabase)
            {
                // The whole player database for the Director's search tools. A failure here never spoils the dump.
                try
                {
                    status.Progress = 0.95; WriteStatus(s, status);
                    var today = DateTime.TryParse(dump.Meta.GameDate, out var gd) ? gd : DateTime.Today;
                    bool female = dump.Squad.Count(p => p.Female) * 2 > dump.Squad.Count;
                    status.DatabasePlayers = DatabaseExport.Write(mem, layout, scan, today, female, Path.Combine(s.OutDir, "players-db.json"), diag);
                }
                catch (Exception e) { diag.Add("Player database export failed: " + e.Message); }
            }

            if (s.ProbeEnabled)
            {
                try
                {
                    var (summary, allHits) = Probe.Execute(mem, layout, ctx, scan, regions, s);
                    WriteAtomic(Path.Combine(s.OutDir, "probe.txt"), summary);
                    WriteAtomic(Path.Combine(s.OutDir, "probe-all.txt"), allHits);
                    diag.Add("Probe written to probe.txt (full hit list in probe-all.txt)");
                }
                catch (Exception e) { diag.Add("Probe failed: " + e.Message); }
            }

            status.State = "ok";
            status.Message = $"Dumped {dump.Club.Name}: {dump.Squad.Count} squad players, {dump.Shortlist.Count} shortlist players, {dump.Transfers.Count} transfers.";
            status.Club = dump.Club.Name;
            status.SquadCount = dump.Squad.Count;
            status.ShortlistCount = dump.Shortlist.Count;
            status.TransferCount = dump.Transfers.Count;
            ok = true;
            Log.Info(status.Message + $" ({sw.ElapsedMilliseconds} ms)");
        }
        catch (DumpException e)
        {
            status.State = "error";
            status.Message = e.Message;
            Log.Warn("Dump failed: " + e.Message);
        }
        catch (Exception e)
        {
            status.State = "error";
            status.Message = "Unexpected error: " + e.Message + " (details in diagnostics.txt). Your previous dump was kept.";
            diag.Add("EXCEPTION: " + e);
            Log.Error("Dump crashed safely: " + e);
        }

        status.DurationMs = sw.ElapsedMilliseconds;
        status.Progress = 1;
        status.Timestamp = DateTime.Now.ToString("s");
        WriteStatus(s, status);
        WriteDiagnostics(s, status, layout, scan, diag, dump);
        return ok;
    }

    // ---------------- files ----------------

    public sealed class Status
    {
        public string State;          // running / ok / error
        public string Timestamp = DateTime.Now.ToString("s");
        public string Message;
        public string GameVersion;
        public string Layout;
        public bool VersionVerified;
        public string ToolVersion = Settings.ToolVersion;
        public string Host;
        public string Club;
        public int SquadCount, ShortlistCount, TransferCount, DatabasePlayers;
        public long DurationMs;
        public double Progress;
    }

    private static readonly object StatusGate = new();

    private static void WriteStatus(Settings s, Status st)
    {
        try
        {
            lock (StatusGate) WriteAtomic(Path.Combine(s.OutDir, "status.json"), JsonSerializer.Serialize(st, Json));
        }
        catch { }
    }

    /// <summary>Write to .tmp, then swap in. Readers never see a half-written file.</summary>
    public static void WriteAtomic(string path, string content) => WriteAtomicBytes(path, new UTF8Encoding(false).GetBytes(content));

    public static void WriteAtomicBytes(string path, byte[] content)
    {
        string tmp = path + ".tmp";
        File.WriteAllBytes(tmp, content);
        for (int i = 1; ; i++)
        {
            try { File.Move(tmp, path, true); return; }
            catch (Exception e) when ((e is IOException || e is UnauthorizedAccessException) && i < 10)
            {
                Thread.Sleep(200 * i);   // file briefly locked (antivirus, the briefing script reading it…)
            }
        }
    }

    private static void WriteDiagnostics(Settings s, Status st, Layout layout, ScanResult scan, List<string> diag, Dump dump)
    {
        try
        {
            var sb = new StringBuilder();
            sb.AppendLine($"TrueDoF {Settings.ToolVersion} ({s.Host}) diagnostics, {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            sb.AppendLine($"Result: {st.State}: {st.Message}");
            sb.AppendLine();
            foreach (var line in diag) sb.AppendLine(line);

            if (scan != null)
            {
                sb.AppendLine();
                sb.AppendLine($"Class offsets seen (with a valid ID). Expected for {layout.Name}: player 0x{layout.PlayerClass:X}, " +
                              $"player+staff 0x{layout.PlayerStaffClass:X}, staff 0x{layout.StaffClass:X}, human manager 0x{layout.HumanManagerClass:X}.");
                sb.AppendLine("After an FM patch: staff = biggest peak, players = 2nd, player+staff ≈ 5-10% of players, human manager = 1-2 hits.");
                foreach (var kv in scan.ClassHistogram.OrderByDescending(kv => kv.Value).Take(30))
                    sb.AppendLine($"  0x{kv.Key:X4}  {kv.Value,10:N0}");

                // C++ class names (from the game's run-time type information): after a patch, a class we rely on
                // should still show up here under the same name, even when its offsets moved.
                sb.AppendLine();
                sb.AppendLine($"Most common C++ classes on the heap ({scan.VtableNames.Count:N0} named vtables). " +
                              $"Your tactic is read from {layout.SelectionClass} ({scan.Selections.Count} found).");
                foreach (var kv in scan.VtableCounts.OrderByDescending(kv => kv.Value).Take(40))
                    sb.AppendLine($"  {kv.Value,10:N0}  {scan.VtableNames.GetValueOrDefault(kv.Key) ?? "?"}");
            }
            if (dump.Squad.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("Sample squad players (compare with FM's squad screen):");
                foreach (var p in dump.Squad.Take(8))
                    sb.AppendLine($"  {p.Name} | age {p.Age} | CA {p.Ca} PA {p.Pa} | {string.Join("/", p.NaturalPositions)} | " +
                                  $"wage £{p.Contract?.WageWeekly:N0}/w until {p.Contract?.Expires} | morale {p.Morale} ({p.MoraleLevel})");
            }
            WriteAtomic(Path.Combine(s.OutDir, "diagnostics.txt"), sb.ToString());
        }
        catch { }
    }
}
