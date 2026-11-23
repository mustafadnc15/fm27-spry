using System.Collections.Concurrent;
using System.Text.Json;

namespace TrueDoF;

/// <summary>
/// Writes players-db.json: every player the scan found (all loaded leagues), in a compact form,
/// so the Director chat can search the database ("find me an affordable left-back",
/// "alternatives to X"). Same read-only memory reads as the squad dump; it just covers everyone.
///
/// Compact format, to keep the file small (tens of MB for ~50k players):
///   meta.attrKeys / hiddenKeys / personalityKeys / positionKeys give the order of the arrays.
///   Each player: id, n(ame), a(ge), nat, c(lub), lg (league), la (on loan at), ca, pa,
///   pos (natural), acc (accomplished), pr (15 position ratings), at (attributes), hd (hidden),
///   ps (personality), v (value), ask (asking price), w (weekly wage), x (contract end),
///   tl/ll (transfer/loan listed), ss (squad status group), rep, ft (foot), h (height), mo (morale).
/// </summary>
public static class DatabaseExport
{
    public static int Write(Mem m, Layout L, ScanResult scan, DateTime today, bool female, string path, List<string> diag)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var reader = new PlayerReader(m, L, today);
        var leagueOfTeam = new ConcurrentDictionary<ulong, string>();
        var refs = scan.Players.Values.ToArray();
        var rows = new (PlayerInfo p, string league)[refs.Length];

        Parallel.For(0, refs.Length, i =>
        {
            try
            {
                var p = reader.Read(refs[i]);
                if (p.Female != female || p.Name == null) return;   // same database (men's/women's) as your club
                ulong team = reader.ContractTeam(refs[i].Person);
                string league = team == 0 ? null : leagueOfTeam.GetOrAdd(team, t => reader.CompName(t));
                rows[i] = (p, league);
            }
            catch { /* skip unreadable player */ }
        });

        var attrKeys = Layout.PlayerAttributes.Where(a => a.group != "hidden").Select(a => a.key).ToArray();
        var attrGroups = Layout.PlayerAttributes.Where(a => a.group != "hidden").Select(a => a.group).ToArray();
        var hiddenKeys = Layout.PlayerAttributes.Where(a => a.group == "hidden").Select(a => a.key).ToArray();

        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WriteStartObject("meta");
            w.WriteString("generatedAt", DateTime.Now.ToString("s"));
            w.WriteString("gameDate", today.ToString("yyyy-MM-dd"));
            w.WriteString("currency", "GBP");
            WriteStrings(w, "attrKeys", attrKeys);
            WriteStrings(w, "attrGroups", attrGroups);
            WriteStrings(w, "hiddenKeys", hiddenKeys);
            WriteStrings(w, "personalityKeys", Layout.PersonalityKeys);
            WriteStrings(w, "positionKeys", Layout.PositionKeys);
            w.WriteEndObject();

            w.WriteStartArray("players");
            int count = 0;
            foreach (var (p, league) in rows)
            {
                if (p == null) continue;
                count++;
                w.WriteStartObject();
                w.WriteNumber("id", p.Uid);
                w.WriteString("n", p.Name);
                if (p.Age != null) w.WriteNumber("a", p.Age.Value);
                if (p.Nationality != null) w.WriteString("nat", p.Nationality);
                if (p.Club != null) w.WriteString("c", p.Club);
                if (league != null) w.WriteString("lg", league);
                if (p.OnLoanAt != null) w.WriteString("la", p.OnLoanAt);
                w.WriteNumber("ca", p.Ca);
                w.WriteNumber("pa", p.Pa);
                w.WriteString("pos", string.Join("/", p.NaturalPositions));
                if (p.AccomplishedPositions.Count > 0) w.WriteString("acc", string.Join("/", p.AccomplishedPositions));
                WriteInts(w, "pr", Layout.PositionKeys.Select(k => p.PositionRatings.GetValueOrDefault(k)));
                WriteInts(w, "at", attrKeys.Select((k, i) => Group(p, attrGroups[i]).GetValueOrDefault(k)));
                WriteInts(w, "hd", hiddenKeys.Select(k => p.Hidden.GetValueOrDefault(k)));
                WriteInts(w, "ps", Layout.PersonalityKeys.Select(k => p.Personality.GetValueOrDefault(k)));
                if (p.ValueGbp != null) w.WriteNumber("v", p.ValueGbp.Value);
                if (p.AskingPriceGbp != null) w.WriteNumber("ask", p.AskingPriceGbp.Value);
                if (p.Contract != null)
                {
                    if (p.Contract.WageWeekly != null) w.WriteNumber("w", p.Contract.WageWeekly.Value);
                    if (p.Contract.Expires != null) w.WriteString("x", p.Contract.Expires);
                    if (p.Contract.TransferListed) w.WriteNumber("tl", 1);
                    if (p.Contract.LoanListed) w.WriteNumber("ll", 1);
                    if (p.Contract.SquadStatusGroup != null) w.WriteString("ss", p.Contract.SquadStatusGroup);
                }
                if (p.ReputationCurrent != null) w.WriteNumber("rep", p.ReputationCurrent.Value);
                if (p.PreferredFoot != null) w.WriteString("ft", p.PreferredFoot);
                if (p.HeightCm != null) w.WriteNumber("h", p.HeightCm.Value);
                if (p.Morale != null) w.WriteNumber("mo", p.Morale.Value);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
            w.Flush();
            diag.Add($"Player database: {count:N0} players written to {Path.GetFileName(path)} ({ms.Length / 1024 / 1024.0:N1} MB, {sw.ElapsedMilliseconds} ms).");
            DumpRunner.WriteAtomicBytes(path, ms.ToArray());
            return count;
        }
    }

    private static Dictionary<string, int> Group(PlayerInfo p, string g) => g switch
    {
        "technical" => p.Technical,
        "mental" => p.Mental,
        "physical" => p.Physical,
        _ => p.Goalkeeping,
    };

    private static void WriteStrings(Utf8JsonWriter w, string name, IEnumerable<string> items)
    {
        w.WriteStartArray(name);
        foreach (var s in items) w.WriteStringValue(s);
        w.WriteEndArray();
    }

    private static void WriteInts(Utf8JsonWriter w, string name, IEnumerable<int> items)
    {
        w.WriteStartArray(name);
        foreach (var v in items) w.WriteNumberValue(v);
        w.WriteEndArray();
    }
}
