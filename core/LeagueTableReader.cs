namespace TrueDoF;

/// <summary>
/// Reads your league table. FM keeps it ready-sorted:
///   your league (team+TeamComp) → +CompActual: the running competition → +ActualStages: its stages
///   → the LEAGUE_STAGE that contains your team → +StageRows: one row per team, in table order.
/// Each row has the team and three records (overall, home, away).
/// Every row is sanity-checked (wins + draws + losses = played, home + away = overall);
/// if anything looks wrong we return "not mapped" rather than wrong numbers.
/// </summary>
public static class LeagueTableReader
{
    private const int MaxRows = 40;

    public static LeagueTableInfo Read(Mem m, Layout L, ScanResult scan, ClubContext ctx, string competition, List<string> diag)
    {
        var info = new LeagueTableInfo { Competition = competition };
        var reader = new PlayerReader(m, L, DateTime.Today);

        ulong actual = m.Ptr(ctx.Competition + (ulong)L.CompActual);
        string actualName = ClassOf(m, scan, actual);
        if (actualName == null || !actualName.Contains("COMP@sicomps"))
        {
            diag.Add($"League table: no running competition behind the league (found {actualName ?? "nothing"}).");
            return info;
        }

        ulong begin = m.Ptr(actual + (ulong)L.ActualStages), end = m.Ptr(actual + (ulong)L.ActualStages + 8);
        int stageCount = begin != 0 && end > begin && end - begin <= 8 * 64 ? (int)((end - begin) / 8) : 0;
        for (int i = 0; i < stageCount; i++)
        {
            ulong stage = m.Ptr(begin + (ulong)(8 * i));
            string name = ClassOf(m, scan, stage);
            if (name == null || !name.EndsWith(L.LeagueStageSuffix, StringComparison.Ordinal)) continue;

            var rows = ReadRows(m, L, reader, stage, ctx.FirstTeam, out string problem);
            if (rows == null) { diag.Add($"League table: stage {i} ({name}) skipped: {problem}"); continue; }

            info.Rows = rows;
            info.Mapped = true;
            info.Note = null;
            var us = rows.First(r => r.IsUs);
            diag.Add($"League table: {rows.Count} teams from stage {i} of {stageCount}; you are {us.Position}. with {us.Points} pts after {us.Played} games.");
            return info;
        }
        diag.Add($"League table: none of the {stageCount} stage(s) is a league stage containing your team.");
        return info;
    }

    private static List<LeagueRow> ReadRows(Mem m, Layout L, PlayerReader reader, ulong stage, ulong ourTeam, out string problem)
    {
        problem = null;
        ulong begin = m.Ptr(stage + (ulong)L.StageRows), end = m.Ptr(stage + (ulong)L.StageRows + 8);
        if (begin == 0 || end <= begin || (end - begin) % 8 != 0 || (end - begin) / 8 > MaxRows) { problem = "no row list"; return null; }

        var rows = new List<LeagueRow>();
        for (ulong p = begin; p < end; p += 8)
        {
            ulong row = m.Ptr(p);
            ulong team = m.Ptr(row + (ulong)L.RowTeam);
            string club = reader.ClubName(m.Ptr(team + (ulong)L.TeamClub));
            if (row == 0 || club == null) { problem = $"row {rows.Count + 1} has no readable team"; return null; }

            var all = Record(m, L, row + (ulong)L.RowOverall);
            var home = Record(m, L, row + (ulong)L.RowHome);
            var away = Record(m, L, row + (ulong)L.RowAway);
            if (!Sane(all) || !Sane(home) || !Sane(away)
                || home.Played + away.Played != all.Played || home.GoalsFor + away.GoalsFor != all.GoalsFor)
            {
                problem = $"row {rows.Count + 1} ({club}) has numbers that don't add up";
                return null;
            }
            rows.Add(new LeagueRow
            {
                Position = rows.Count + 1, Club = club, IsUs = team == ourTeam,
                Played = all.Played, Won = all.Won, Drawn = all.Drawn, Lost = all.Lost,
                GoalsFor = all.GoalsFor, GoalsAgainst = all.GoalsAgainst, GoalDifference = all.GoalsFor - all.GoalsAgainst,
                Points = all.Points, Home = home, Away = away,
            });
        }
        if (rows.Count < 2) { problem = "fewer than 2 rows"; return null; }
        if (!rows.Any(r => r.IsUs)) { problem = "your team is not in it"; return null; }
        return rows;
    }

    private static LeagueRecord Record(Mem m, Layout L, ulong a) => new()
    {
        GoalsFor = m.U16(a + (ulong)L.RecGoalsFor),
        GoalsAgainst = m.U16(a + (ulong)L.RecGoalsAgainst),
        Points = (short)m.U16(a + (ulong)L.RecPoints),
        Played = m.U8(a + (ulong)L.RecPlayed),
        Won = m.U8(a + (ulong)L.RecWon),
        Drawn = m.U8(a + (ulong)L.RecDrawn),
        Lost = m.U8(a + (ulong)L.RecLost),
    };

    /// <summary>Plausible record: results add up, goals and points in range. Points are not checked
    /// against 3/1/0, because deductions and other point rules exist.</summary>
    private static bool Sane(LeagueRecord r) =>
        r.Won + r.Drawn + r.Lost == r.Played && r.Played <= 60 && r.GoalsFor <= 300 && r.GoalsAgainst <= 300
        && r.Points >= -50 && r.Points <= 3 * r.Played + 10;

    private static string ClassOf(Mem m, ScanResult scan, ulong obj) =>
        obj == 0 ? null : scan.VtableNames.GetValueOrDefault(m.Ptr(obj));
}
