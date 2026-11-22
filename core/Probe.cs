using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace TrueDoF;

/// <summary>
/// Discovery helper for data nobody has mapped yet (club balance, budgets, league points…).
///
/// You type numbers you can SEE in FM into the config, e.g.
///     ProbeValues = balance=12500000; transferBudget=5000000; points=24; goalDiff=11
/// and the probe searches the objects around your club, first team, competition and
/// manager (following pointers up to ProbeDepth levels) for those numbers, stored as any
/// common number type. Hits go to probe.txt as "paths", for example
///     club +0x1A0 → +0x40  [int64] = 12,480,000
/// A path that hits in TWO probes with DIFFERENT values (e.g. before and after a match) is
/// almost certainly the real field, and becomes a new entry in Layout.cs.
/// Read-only like everything else.
/// </summary>
public static class Probe
{
    private const int MaxObjects = 60_000;

    public static string Run(Mem m, ClubContext ctx, List<MemRegion> regions, Settings s)
    {
        var targets = ParseValues(s.ProbeValues);
        var sb = new StringBuilder();
        sb.AppendLine($"TrueDoF probe — {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
        sb.AppendLine("Tip: set FM's currency to pounds (Preferences > Units) so money matches; weekly wages stay weekly.");
        if (targets.Count == 0)
        {
            sb.AppendLine("No ProbeValues set. Example: ProbeValues = balance=12500000; transferBudget=5000000; points=24");
            return sb.ToString();
        }
        sb.AppendLine("Looking for: " + string.Join(", ", targets.Select(t => $"{t.name}={t.value.ToString("N0", CultureInfo.InvariantCulture)}")));
        sb.AppendLine($"Depth: {s.ProbeDepth}");
        sb.AppendLine();

        var sorted = regions.OrderBy(r => r.Start).ToArray();
        bool IsHeap(ulong v)
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

        var roots = new (string name, ulong addr)[]
        {
            ("club", ctx.Club), ("firstTeam", ctx.FirstTeam), ("competition", ctx.Competition),
            ("manager", ctx.ManagerPerson), ("managerContract", ctx.ManagerContract),
        };
        var hits = targets.ToDictionary(t => t.name, _ => new List<(int depth, string path)>());
        var visited = new HashSet<ulong>();
        var queue = new Queue<(ulong addr, string path, int depth)>();
        foreach (var r in roots) if (r.addr != 0 && visited.Add(r.addr)) queue.Enqueue((r.addr, r.name, 0));

        int objects = 0;
        while (queue.Count > 0 && objects < MaxObjects)
        {
            var (addr, path, depth) = queue.Dequeue();
            int window = depth == 0 ? 0x1000 : 0x400;
            var buf = new byte[window];
            if (!m.Read(addr, buf)) { buf = new byte[0x100]; if (!m.Read(addr, buf)) continue; }
            objects++;
            for (int off = 0; off + 4 <= buf.Length; off += 4)
            {
                var span = buf.AsSpan(off);
                foreach (var t in targets)
                {
                    string type = Match(span, t.value);
                    if (type != null) hits[t.name].Add((depth, $"{path} +0x{off:X}  [{type}]"));
                }
                if ((off & 7) == 0 && off + 8 <= buf.Length && depth < s.ProbeDepth)
                {
                    ulong v = BinaryPrimitives.ReadUInt64LittleEndian(span);
                    if ((v & 7) == 0 && IsHeap(v) && visited.Add(v))
                        queue.Enqueue((v, $"{path} +0x{off:X} →", depth + 1));
                }
            }
        }

        sb.AppendLine($"Objects searched: {objects:N0}");
        foreach (var t in targets)
        {
            var list = hits[t.name].OrderBy(h => h.depth).ThenBy(h => h.path.Length).ToList();
            sb.AppendLine();
            sb.AppendLine($"=== {t.name} = {t.value.ToString("N0", CultureInfo.InvariantCulture)} : {list.Count} hit(s) ===");
            foreach (var h in list.Take(60)) sb.AppendLine("  " + h.path);
            if (list.Count > 60) sb.AppendLine($"  … and {list.Count - 60} more");
        }
        return sb.ToString();
    }

    /// <summary>Does the data here equal the target in some common number format?</summary>
    private static string Match(ReadOnlySpan<byte> d, double target)
    {
        double tol = Math.Abs(target) >= 1000 ? Math.Abs(target) * 0.02 : 0.0;   // money: ±2%, small numbers: exact
        bool Near(double v) => Math.Abs(v - target) <= tol;
        if (Near(BinaryPrimitives.ReadInt32LittleEndian(d))) return "int32";
        if (d.Length >= 8 && Near(BinaryPrimitives.ReadInt64LittleEndian(d)) && BinaryPrimitives.ReadInt32LittleEndian(d.Slice(4)) is 0 or -1) return "int64";
        if (target != 0)
        {
            float f = BinaryPrimitives.ReadSingleLittleEndian(d);
            if (float.IsFinite(f) && Math.Abs(f - target) <= Math.Max(tol, 0.01)) return "float";
            if (d.Length >= 8)
            {
                double g = BinaryPrimitives.ReadDoubleLittleEndian(d);
                if (double.IsFinite(g) && Math.Abs(g - target) <= Math.Max(tol, 0.01)) return "double";
            }
            if (Math.Abs(target) < 30000 && Near(BinaryPrimitives.ReadInt16LittleEndian(d)) && target >= 50) return "int16";
        }
        return null;
    }

    public static List<(string name, double value)> ParseValues(string text)
    {
        var list = new List<(string, double)>();
        if (string.IsNullOrWhiteSpace(text)) return list;
        foreach (string part in text.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (kv.Length != 2) continue;
            // "12,500,000" and "12 500 000" both work; use a dot for decimals.
            string num = kv[1].Trim().Replace("_", "").Replace(" ", "").Replace(",", "");
            if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out double v))
                list.Add((kv[0].Trim(), v));
        }
        return list;
    }
}
