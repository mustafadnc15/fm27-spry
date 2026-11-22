using System.Collections.Concurrent;
using System.Globalization;
using System.Text;

namespace TrueDoF;

/// <summary>
/// Your shortlist, read from %LOCALAPPDATA%\TrueDoF\shortlist.txt (one player per line):
///     Erling Haaland
///     Haaland @ Man City        ← "@ club" narrows it down when names clash
///     uid:12345678              ← exact FM unique ID if you know it
/// Lines starting with # are ignored. Accents and capitals don't matter.
/// </summary>
public sealed class Shortlist
{
    private readonly Mem _m;
    private readonly PlayerReader _reader;
    private readonly ScanResult _scan;
    private readonly Settings _settings;
    private readonly List<string> _diag;

    public Shortlist(Mem m, PlayerReader reader, ScanResult scan, Settings settings, List<string> diag)
    {
        _m = m; _reader = reader; _scan = scan; _settings = settings; _diag = diag;
    }

    public static string FilePath(Settings s) => Path.Combine(s.OutDir, "shortlist.txt");

    public static void EnsureTemplate(Settings s)
    {
        try
        {
            string f = FilePath(s);
            if (File.Exists(f)) return;
            Directory.CreateDirectory(s.OutDir);
            File.WriteAllText(f,
                "# TrueDoF shortlist: one player per line, then press F8 in FM.\n" +
                "# Examples:\n" +
                "#   Erling Haaland\n" +
                "#   Haaland @ Man City\n" +
                "#   uid:12345678\n");
        }
        catch { /* not critical */ }
    }

    public HashSet<uint> Resolve(Dump dump)
    {
        var found = new HashSet<uint>();
        var entries = ReadEntries();
        if (entries.Count == 0) return found;

        // Read names of all players once, but only if at least one entry is a name.
        var wanted = entries.Where(e => e.uid == 0).Select(e => e.name).ToHashSet();
        var byName = new ConcurrentDictionary<string, ConcurrentBag<uint>>();
        if (wanted.Count > 0)
        {
            Parallel.ForEach(_scan.Players.Values, pr =>
            {
                try
                {
                    foreach (string v in Variants(pr.Person))
                        if (wanted.Contains(v)) byName.GetOrAdd(v, _ => new ConcurrentBag<uint>()).Add(pr.Uid);
                }
                catch { }
            });
        }

        foreach (var e in entries)
        {
            List<uint> uids = e.uid != 0
                ? (_scan.Players.ContainsKey(e.uid) ? new List<uint> { e.uid } : new List<uint>())
                : (byName.TryGetValue(e.name, out var bag) ? bag.Distinct().ToList() : new List<uint>());

            var players = uids.Select(u => SafeRead(u)).Where(p => p != null).ToList();
            if (e.club != null)
                players = players.Where(p => p.Club != null && Normalize(p.Club).Contains(e.club)).ToList();
            if (players.Count == 0)
            {
                dump.ShortlistNotFound.Add(new ShortlistMiss { Entry = e.raw, Reason = uids.Count == 0 ? "no player with this name/ID" : "name found, but not at that club" });
                continue;
            }
            players = players.OrderByDescending(p => p.Ca).ToList();
            int max = Math.Max(1, _settings.ShortlistMaxMatches);
            if (players.Count > 1)
                foreach (var p in players)
                    p.Notes.Add($"Shortlist entry '{e.raw}' matched {players.Count} players" +
                                (players.Count > max ? $"; showing the top {max} by CA" : "") + ". Add '@ Club' to pick one.");
            foreach (var p in players.Take(max))
                if (found.Add(p.Uid)) dump.Shortlist.Add(p);
        }
        _diag.Add($"Shortlist: {entries.Count} entries, {dump.Shortlist.Count} players, {dump.ShortlistNotFound.Count} not found.");
        return found;
    }

    private PlayerInfo SafeRead(uint uid)
    {
        try { return _reader.Read(_scan.Players[uid]); }
        catch { return null; }
    }

    private IEnumerable<string> Variants(ulong person) =>
        _reader.NameVariants(person).Select(Normalize).Distinct();

    private List<(string raw, string name, string club, uint uid)> ReadEntries()
    {
        var list = new List<(string, string, string, uint)>();
        string f = FilePath(_settings);
        if (!File.Exists(f)) return list;
        foreach (string line in File.ReadAllLines(f))
        {
            string raw = line.Trim();
            if (raw.Length == 0 || raw.StartsWith("#")) continue;
            if (raw.StartsWith("uid:", StringComparison.OrdinalIgnoreCase) && uint.TryParse(raw.Substring(4).Trim(), out uint uid))
            {
                list.Add((raw, null, null, uid));
                continue;
            }
            string name = raw, club = null;
            int at = raw.IndexOf('@');
            if (at > 0) { name = raw.Substring(0, at); club = Normalize(raw.Substring(at + 1)); }
            name = Normalize(name);
            if (name.Length > 0) list.Add((raw, name, string.IsNullOrEmpty(club) ? null : club, 0));
        }
        return list;
    }

    /// <summary>"Ødegaard" → "odegaard": no accents, lowercase, single spaces.</summary>
    public static string Normalize(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char c in s.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            switch (char.ToLowerInvariant(c))
            {
                case 'ø': sb.Append('o'); break;
                case 'ł': sb.Append('l'); break;
                case 'ß': sb.Append("ss"); break;
                case 'æ': sb.Append("ae"); break;
                case 'đ': sb.Append('d'); break;
                case 'ı': sb.Append('i'); break;
                default: sb.Append(char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : ' '); break;
            }
        }
        return string.Join(" ", sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }
}
