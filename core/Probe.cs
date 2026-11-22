using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace TrueDoF;

/// <summary>
/// Discovery helper for data nobody has mapped yet (club balance, budgets, league table…).
///
/// SEARCH: you type numbers you can see in FM into the config, e.g.
///     ProbeValues = balance=12500000; transferBudget=5000000; points=24; goalDiff=11
/// The probe searches the objects around your club, first team, competition and manager
/// (following pointers up to ProbeDepth hops) for those exact numbers.
///
/// COMPARE: every run is saved to probe-last.json. On the next run (after the numbers
/// changed in FM, e.g. after a match), places that held the old value before and the new
/// value now are listed first as CONFIRMED. Those are almost certainly the real fields.
///
/// INSPECT: ProbeInspect = competition +0xE08 +0x1E8 dumps that object with labels
/// (team / club / player / text) so structures like the league table become readable.
///
/// Read-only like everything else.
/// </summary>
public static class Probe
{
    private const int MaxObjects = 60_000;

    public sealed class Hit { public string Path; public string Type; public double Found; }
    public sealed class TargetRun { public string Name; public double Value; public bool Approx; public List<Hit> Hits = new(); }
    public sealed class Run { public string Time; public List<TargetRun> Targets = new(); }

    /// <summary>Returns (summary text, full hit list text).</summary>
    public static (string summary, string all) Execute(Mem m, Layout L, ClubContext ctx, ScanResult scan, List<MemRegion> regions, Settings s)
    {
        var sb = new StringBuilder();
        var all = new StringBuilder();
        sb.AppendLine($"TrueDoF probe, {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
        sb.AppendLine("Set FM's currency to pounds (Preferences > Units) so money matches.");

        var roots = new (string name, ulong addr)[]
        {
            ("club", ctx.Club), ("firstTeam", ctx.FirstTeam), ("competition", ctx.Competition),
            ("manager", ctx.ManagerPerson), ("managerContract", ctx.ManagerContract),
        };

        var targets = ParseValues(s.ProbeValues);
        if (targets.Count > 0)
        {
            var run = Search(m, roots, regions, targets, s.ProbeDepth);
            string historyFile = Path.Combine(s.OutDir, "probe-last.json");
            Run previous = null;
            try { if (File.Exists(historyFile)) previous = JsonSerializer.Deserialize<Run>(File.ReadAllText(historyFile), DumpRunner.Json); }
            catch { previous = null; }

            sb.AppendLine("Looking for: " + string.Join(", ", targets.Select(t => $"{t.name}={(t.approx ? "~" : "")}{Fmt(t.value)}")));
            sb.AppendLine(previous == null ? "No previous probe to compare with (this is the first run)." : $"Comparing with previous probe from {previous.Time}.");

            foreach (var t in run.Targets)
            {
                sb.AppendLine();
                sb.AppendLine($"=== {t.Name} = {Fmt(t.Value)} : {t.Hits.Count} hit(s) ===");
                var prev = previous?.Targets.FirstOrDefault(p => p.Name == t.Name);
                if (prev != null)
                {
                    var before = prev.Hits.GroupBy(h => h.Path + "|" + h.Type).ToDictionary(g => g.Key, g => g.First());
                    var both = t.Hits.Where(h => before.ContainsKey(h.Path + "|" + h.Type)).ToList();
                    if (prev.Value != t.Value)
                    {
                        var confirmed = both.Where(h => before[h.Path + "|" + h.Type].Found != h.Found).ToList();
                        sb.AppendLine($"  CONFIRMED (was {Fmt(prev.Value)} last time, {Fmt(t.Value)} now): {confirmed.Count}");
                        foreach (var h in confirmed.Take(40)) sb.AppendLine($"    {h.Path}  [{h.Type}]");
                    }
                    else
                    {
                        sb.AppendLine($"  Same value as last time; {both.Count} place(s) matched both times (change it in FM and probe again to confirm):");
                        foreach (var h in both.Take(15)) sb.AppendLine($"    {h.Path}  [{h.Type}]");
                    }
                }
                sb.AppendLine("  Shortest paths this run:");
                foreach (var h in t.Hits.OrderBy(h => h.Path.Length).Take(15)) sb.AppendLine($"    {h.Path}  [{h.Type}] = {Fmt(h.Found)}");

                all.AppendLine($"=== {t.Name} = {Fmt(t.Value)} ===");
                foreach (var h in t.Hits) all.AppendLine($"{h.Path}  [{h.Type}] = {Fmt(h.Found)}");
            }
            try { File.WriteAllText(historyFile, JsonSerializer.Serialize(run, DumpRunner.Json)); } catch { }
        }
        else sb.AppendLine("No ProbeValues set (search skipped).");

        foreach (string path in (s.ProbeInspect ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            sb.AppendLine();
            sb.Append(Inspect(m, L, scan, roots, path.Trim(), s.ProbeInspectBytes));
        }
        return (sb.ToString(), all.ToString());
    }

    // ------------------------------------------------------------------ search

    private static Run Search(Mem m, (string name, ulong addr)[] roots, List<MemRegion> regions,
                              List<(string name, double value, bool approx)> targets, int maxDepth)
    {
        var sorted = regions.OrderBy(r => r.Start).ToArray();
        var run = new Run { Time = DateTime.Now.ToString("s") };
        foreach (var t in targets) run.Targets.Add(new TargetRun { Name = t.name, Value = t.value, Approx = t.approx });

        var visited = new HashSet<ulong>();
        var queue = new Queue<(ulong addr, string path, int depth)>();
        foreach (var r in roots) if (r.addr != 0 && visited.Add(r.addr)) queue.Enqueue((r.addr, r.name, 0));

        int objects = 0;
        while (queue.Count > 0 && objects < MaxObjects)
        {
            var (addr, path, depth) = queue.Dequeue();
            var buf = new byte[depth == 0 ? 0x1000 : 0x400];
            if (!m.Read(addr, buf)) { buf = new byte[0x100]; if (!m.Read(addr, buf)) continue; }
            objects++;
            for (int off = 0; off + 4 <= buf.Length; off += 4)
            {
                var span = buf.AsSpan(off);
                for (int ti = 0; ti < targets.Count; ti++)
                {
                    var (type, found) = Match(span, targets[ti].value, targets[ti].approx);
                    if (type != null) run.Targets[ti].Hits.Add(new Hit { Path = $"{path} +0x{off:X}", Type = type, Found = found });
                }
                if ((off & 7) == 0 && off + 8 <= buf.Length && depth < maxDepth)
                {
                    ulong v = BinaryPrimitives.ReadUInt64LittleEndian(span);
                    if ((v & 7) == 0 && InRegions(sorted, v) && visited.Add(v))
                        queue.Enqueue((v, $"{path} +0x{off:X}", depth + 1));
                }
            }
        }
        return run;
    }

    /// <summary>Exact match by default; "~" in front of a value allows ±2% (for rounded numbers).</summary>
    private static (string type, double found) Match(ReadOnlySpan<byte> d, double target, bool approx)
    {
        double tol = approx ? Math.Abs(target) * 0.02 : 0;
        bool Near(double v) => Math.Abs(v - target) <= tol;
        int i32 = BinaryPrimitives.ReadInt32LittleEndian(d);
        if (Near(i32)) return ("int32", i32);
        if (d.Length >= 8)
        {
            long i64 = BinaryPrimitives.ReadInt64LittleEndian(d);
            if (Near(i64)) return ("int64", i64);
        }
        if (target != 0 && Math.Abs(target) >= 2)
        {
            float f = BinaryPrimitives.ReadSingleLittleEndian(d);
            if (float.IsFinite(f) && Math.Abs(f - target) <= Math.Max(tol, Math.Abs(target) * 1e-6)) return ("float", f);
            if (d.Length >= 8)
            {
                double g = BinaryPrimitives.ReadDoubleLittleEndian(d);
                if (double.IsFinite(g) && Math.Abs(g - target) <= Math.Max(tol, Math.Abs(target) * 1e-9)) return ("double", g);
            }
        }
        if (Math.Abs(target) < 30000)
        {
            short i16 = BinaryPrimitives.ReadInt16LittleEndian(d);
            if (Near(i16)) return ("int16", i16);
        }
        return (null, 0);
    }

    // ------------------------------------------------------------------ inspect

    /// <summary>
    /// Path syntax: root name, then offsets; every offset is followed as a pointer.
    /// "competition +0xE08 +0x1E8" = the object at [[competition + 0xE08] + 0x1E8].
    /// Arrows (→) from probe.txt lines are allowed and ignored.
    /// </summary>
    private static string Inspect(Mem m, Layout L, ScanResult scan, (string name, ulong addr)[] roots, string path, int bytes)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"=== INSPECT {path} ===");
        var parts = path.Replace("→", " ").Replace("->", " ").Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return sb.ToString();
        var root = roots.FirstOrDefault(r => r.name.Equals(parts[0], StringComparison.OrdinalIgnoreCase));
        if (root.addr == 0) { sb.AppendLine($"Unknown root '{parts[0]}'. Use one of: {string.Join(", ", roots.Select(r => r.name))}"); return sb.ToString(); }
        ulong addr = root.addr;
        foreach (string p in parts.Skip(1))
        {
            string hex = p.TrimStart('+');
            if (hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) hex = hex.Substring(2);
            if (!ulong.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out ulong off)) { sb.AppendLine($"Can't read offset '{p}'."); return sb.ToString(); }
            addr = m.Ptr(addr + off);
            if (addr == 0) { sb.AppendLine($"Pointer at {p} is empty/unreadable."); return sb.ToString(); }
        }

        bytes = Math.Clamp(bytes, 0x40, 0x4000);
        var buf = new byte[bytes];
        if (!m.Read(addr, buf)) { sb.AppendLine("Object not readable."); return sb.ToString(); }
        var reader = new PlayerReader(m, L, DateTime.Today);
        sb.AppendLine("offset   raw (8 bytes)        int32 lo     int32 hi   label");
        for (int off = 0; off + 8 <= bytes; off += 8)
        {
            ulong v = BinaryPrimitives.ReadUInt64LittleEndian(buf.AsSpan(off));
            int lo = BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(off)), hi = BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(off + 4));
            sb.AppendLine($"+0x{off:X4}  {v:X16}  {lo,11}  {hi,11}   {Label(m, L, scan, reader, v)}");
        }
        return sb.ToString();
    }

    private static string Label(Mem m, Layout L, ScanResult scan, PlayerReader reader, ulong v)
    {
        if (v < 0x10000 || (v & 7) != 0) return "";
        if (scan.AddrToUid.TryGetValue(v, out uint uid) && scan.Players.TryGetValue(uid, out var pr))
            return "player: " + (reader.Name(pr.Person) ?? uid.ToString());
        // A team: its club's team list contains it.
        ulong club = m.Ptr(v + (ulong)L.TeamClub);
        string clubName = reader.ClubName(club);
        if (clubName != null && VectorContains(m, club + (ulong)L.ClubTeamsBegin, club + (ulong)L.ClubTeamsEnd, v))
            return $"team: {clubName} (type {m.U8(v + (ulong)L.TeamType)})";
        // A club: has a name and a valid team list.
        string asClub = reader.ClubName(v);
        if (asClub != null && m.Ptr(v + (ulong)L.ClubTeamsEnd) > m.Ptr(v + (ulong)L.ClubTeamsBegin))
            return "club: " + asClub;
        string text = m.CString(v + 4, 64);
        if (text != null && text.Length >= 3 && text.Count(char.IsLetter) >= 3) return $"text: \"{text}\"";
        return "";
    }

    private static bool VectorContains(Mem m, ulong beginField, ulong endField, ulong value)
    {
        ulong b = m.Ptr(beginField), e = m.Ptr(endField);
        if (b == 0 || e <= b || (e - b) / 8 > 64) return false;
        for (ulong a = b; a < e; a += 8) if (m.Ptr(a) == value) return true;
        return false;
    }

    // ------------------------------------------------------------------ helpers

    private static bool InRegions(MemRegion[] sorted, ulong v)
    {
        int lo = 0, hi = sorted.Length - 1;
        while (lo <= hi)
        {
            int mid = (lo + hi) / 2;
            if (v < sorted[mid].Start) hi = mid - 1;
            else if (v >= sorted[mid].End) lo = mid + 1;
            else return true;
        }
        return false;
    }

    private static string Fmt(double v) => v.ToString(v == Math.Floor(v) ? "N0" : "N2", CultureInfo.InvariantCulture);

    public static List<(string name, double value, bool approx)> ParseValues(string text)
    {
        var list = new List<(string, double, bool)>();
        if (string.IsNullOrWhiteSpace(text)) return list;
        foreach (string part in text.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (kv.Length != 2) continue;
            // "12,500,000" and "12 500 000" both work; use a dot for decimals; "~" = approximate.
            string num = kv[1].Trim().Replace("_", "").Replace(" ", "").Replace(",", "");
            bool approx = num.StartsWith("~");
            if (approx) num = num.Substring(1);
            if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out double v))
                list.Add((kv[0].Trim(), v, approx));
        }
        return list;
    }
}
