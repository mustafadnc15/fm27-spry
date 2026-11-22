using System.Collections.Concurrent;

namespace TrueDoF;

/// <summary>An error with a message meant for the user (shown in status.json).</summary>
public sealed class DumpException : Exception
{
    public DumpException(string message) : base(message) { }
}

/// <summary>What the probe needs to know about the objects we found.</summary>
public sealed class ClubContext
{
    public ulong Club, FirstTeam, ManagerPerson, ManagerContract, Competition;
}

/// <summary>
/// Turns the raw scan into the club-scoped dump: find YOU → your club → your teams →
/// your players, plus shortlist and transfer activity. Reads details only for the few
/// dozen players we need, not the whole database.
/// </summary>
public sealed class ClubDumper
{
    private readonly Mem _m;
    private readonly Layout L;
    private readonly ScanResult _scan;
    private readonly Settings _settings;
    private readonly List<string> _diag;

    public ClubDumper(Mem m, Layout layout, ScanResult scan, Settings settings, List<string> diag)
    {
        _m = m; L = layout; _scan = scan; _settings = settings; _diag = diag;
    }

    public ClubContext Build(Dump dump)
    {
        var tmpReader = new PlayerReader(_m, L, DateTime.Today);

        // ---------- 1. Who are you, and which club? ----------
        var candidates = new List<(ulong person, string name, ulong club, string clubName)>();
        foreach (ulong mp in _scan.ManagerPersons)
        {
            string name = tmpReader.Name(mp);
            ulong clubPtr = tmpReader.ContractClub(mp);
            string clubName = tmpReader.ClubName(clubPtr);
            _diag.Add($"Human manager candidate @0x{mp:X}: name={name ?? "?"} club={clubName ?? "?"}");
            if (name != null && clubName != null && !candidates.Any(c => c.club == clubPtr))
                candidates.Add((mp, name, clubPtr, clubName));
        }
        if (_scan.ManagerPersons.Count == 0)
            throw new DumpException("Could not find you (the human manager) in memory. Is a save loaded? " +
                                    "If yes, this FM version may need new offsets (see diagnostics.txt).");
        if (candidates.Count == 0)
            throw new DumpException("Found your manager but not a club. Are you unemployed in this save? " +
                                    "If not, the contract offsets may have moved (see diagnostics.txt).");
        if (candidates.Count > 1)
            dump.Notes.Add($"Several human managers found ({string.Join(", ", candidates.Select(c => $"{c.name}/{c.clubName}"))}); using the first. TrueDoF is meant for single-player saves.");

        var me = candidates[0];
        dump.Meta.Manager = me.name;
        var ctx = new ClubContext { Club = me.club, ManagerPerson = me.person, ManagerContract = _m.Ptr(me.person + (ulong)L.Contract) };
        ulong myTeam = ctx.ManagerContract == 0 ? 0 : _m.Ptr(ctx.ManagerContract + (ulong)L.ConTeam);

        // ---------- 2. Club teams and their player lists ----------
        var teams = ReadTeams(me.club);
        if (teams.Count == 0) throw new DumpException($"Found your club ({me.clubName}) but could not read its teams.");
        ctx.FirstTeam = teams.Any(t => t.ptr == myTeam) ? myTeam
                      : teams.Where(t => t.type == 0).Select(t => t.ptr).DefaultIfEmpty(teams[0].ptr).First();

        // ---------- 3. In-game date (from your next fixture) ----------
        DateTime today = DateTime.Today;
        ulong sched = _m.Ptr(ctx.FirstTeam + (ulong)L.TeamSchedule);
        DateTime? gameDate = null;
        if (sched != 0)
            foreach (int off in new[] { L.ScheduleNextMatch, L.ScheduleNextMatchAlt })
                if (FmDate.ToDate(_m.U32(sched + (ulong)off)) is DateTime d && d.Year is >= 2020 and <= 2100) { gameDate = d; break; }
        if (gameDate is DateTime gd) { today = gd; dump.Meta.GameDate = gd.ToString("yyyy-MM-dd"); }
        else dump.Notes.Add("In-game date not found; ages are computed from today's real date.");
        var reader = new PlayerReader(_m, L, today);

        // ---------- 4. Club info ----------
        var club = dump.Club;
        club.Name = me.clubName;
        club.ShortName = _m.IndirectString(me.club + (ulong)L.ClubShortName);
        int rep = _m.U16(ctx.FirstTeam + (ulong)L.TeamRep);
        club.Reputation = rep is >= 1 and <= 10000 ? rep : null;
        club.League = reader.CompName(ctx.FirstTeam);
        ctx.Competition = _m.Ptr(ctx.FirstTeam + (ulong)L.TeamComp);
        dump.LeagueTable.Competition = club.League;

        // Which of your teams lists each player (lowest team type = highest team wins)
        var listedIn = new Dictionary<uint, int>();
        foreach (var t in teams)
        {
            int trep = _m.U16(t.ptr + (ulong)L.TeamRep);
            club.Teams.Add(new TeamInfo
            {
                TeamType = t.type, TeamLabel = TeamLabel(t.type), League = reader.CompName(t.ptr),
                Reputation = trep is >= 1 and <= 10000 ? trep : null, Players = t.uids.Count,
            });
            foreach (uint uid in t.uids)
                if (!listedIn.TryGetValue(uid, out int old) || t.type < old) listedIn[uid] = t.type;
        }

        // ---------- 5. Everyone under contract with your club (also finds loaned-out players) ----------
        var contracted = new ConcurrentBag<uint>();
        Parallel.ForEach(_scan.Players.Values, pr =>
        {
            try { if (reader.ContractClub(pr.Person) == me.club) contracted.Add(pr.Uid); }
            catch { /* skip this player */ }
        });
        var contractedSet = contracted.ToHashSet();

        var squadUids = listedIn.Keys.Union(contractedSet).Where(_scan.Players.ContainsKey).ToList();
        foreach (uint uid in squadUids)
        {
            var p = SafeRead(reader, _scan.Players[uid]);
            if (p == null) continue;
            if (listedIn.TryGetValue(uid, out int tt)) { p.TeamType = tt; p.Team = TeamLabel(tt); }
            if (!contractedSet.Contains(uid))
                p.OnLoanFrom = p.Club ?? "another club";
            else if (!listedIn.ContainsKey(uid))
                p.Notes.Add("Under contract with you but not in any of your team lists: probably out on loan.");
            dump.Squad.Add(p);
        }
        dump.Squad = dump.Squad.OrderBy(p => p.TeamType ?? 99).ThenByDescending(p => p.Ca).ToList();

        foreach (var p in dump.Squad.Where(p => contractedSet.Contains(p.Uid)))
        {
            club.ContractedPlayers++;
            club.WageBillWeekly += p.Contract?.WageWeekly ?? 0;
        }
        club.WageBillAnnual = club.WageBillWeekly * 52;
        ReadFinances(me.club, club);
        dump.Notes.Add("wageBillWeekly = sum of player contracts (computed by TrueDoF); wageSpendWeekly = FM's own wage total incl. bonuses and staff.");
        if (!club.FinancesMapped) dump.Notes.Add("Club finances could not be read for this club.");
        _diag.Add($"Club {club.Name}: {teams.Count} teams, {listedIn.Count} listed players, {contractedSet.Count} contracted players.");

        // ---------- 6. Shortlist ----------
        var shortlistUids = new Shortlist(_m, reader, _scan, _settings, _diag).Resolve(dump);

        // ---------- 7. Transfer activity ----------
        ReadTransfers(dump, reader, teams.Select(t => t.ptr).ToHashSet(), shortlistUids);

        return ctx;
    }

    private void ReadFinances(ulong clubPtr, ClubInfo club)
    {
        ulong fin = _m.Ptr(clubPtr + (ulong)L.ClubFinance);
        if (fin == 0) { _diag.Add("Finance record pointer is empty."); return; }
        int balance = _m.I32(fin + (ulong)L.FinBalance);
        int transfer = _m.I32(fin + (ulong)L.FinTransferBudget);
        int wage = _m.I32(fin + (ulong)L.FinWageBudget);
        int spend = _m.I32(fin + (ulong)L.FinWageSpend);
        _diag.Add($"Finance record @0x{fin:X}: balance {balance:N0}, transfer budget {transfer:N0}, wage budget {wage:N0}/w, wage spend {spend:N0}/w");
        if (!LooksLikeDate(balance)) club.Balance = balance;
        club.TransferBudget = Budget(transfer);
        club.WageBudgetWeekly = Budget(wage);
        club.WageSpendWeekly = Budget(spend);
        club.FinancesMapped = club.Balance != null || club.TransferBudget != null;
    }

    /// <summary>A budget is 0..1 billion pounds and not an FM date stored in the same spot by smaller finance records.</summary>
    private static long? Budget(int v) => v >= 0 && v < 1_000_000_000 && !LooksLikeDate(v) ? v : null;

    private static bool LooksLikeDate(int v)
    {
        int year = (int)((uint)v >> 16), doy = v & 0x1FF;
        return year is >= 1900 and <= 2100 && doy is >= 1 and <= 366;
    }

    private PlayerInfo SafeRead(PlayerReader reader, PlayerRef r)
    {
        try { return reader.Read(r); }
        catch (Exception e) { _diag.Add($"Could not read player {r.Uid}: {e.Message}"); return null; }
    }

    private List<(ulong ptr, int type, List<uint> uids)> ReadTeams(ulong club)
    {
        var result = new List<(ulong, int, List<uint>)>();
        foreach (ulong team in ReadPtrVector(club + (ulong)L.ClubTeamsBegin, club + (ulong)L.ClubTeamsEnd, 64))
        {
            var uids = new List<uint>();
            foreach (ulong entry in ReadPtrVector(team + (ulong)L.TeamPlayersBegin, team + (ulong)L.TeamPlayersEnd, 200))
            {
                uint uid = ResolveEntry(entry);
                if (uid != 0 && !uids.Contains(uid)) uids.Add(uid);
            }
            result.Add((team, _m.U8(team + (ulong)L.TeamType), uids));
        }
        return result;
    }

    /// <summary>
    /// A team-list entry is either the player himself or a small record that points to him.
    /// We check the entry, then the first 0x80 bytes of it, against the addresses we know.
    /// </summary>
    private uint ResolveEntry(ulong entry)
    {
        if (_scan.AddrToUid.TryGetValue(entry, out uint uid)) return uid;
        for (int off = 0; off <= 0x80; off += 8)
        {
            ulong q = _m.Ptr(entry + (ulong)off);
            if (q != 0 && _scan.AddrToUid.TryGetValue(q, out uid)) return uid;
        }
        return 0;
    }

    /// <summary>Reads a C++ std::vector of pointers given its begin/end fields.</summary>
    private List<ulong> ReadPtrVector(ulong beginField, ulong endField, int maxCount)
    {
        var list = new List<ulong>();
        ulong b = _m.Ptr(beginField), e = _m.Ptr(endField);
        if (b == 0 || e <= b || (e - b) % 8 != 0 || (e - b) / 8 > (ulong)maxCount) return list;
        for (ulong a = b; a < e; a += 8)
        {
            ulong v = _m.Ptr(a);
            if (v != 0) list.Add(v);
        }
        return list;
    }

    private void ReadTransfers(Dump dump, PlayerReader reader, HashSet<ulong> ourTeams, HashSet<uint> shortlist)
    {
        var teamName = new Dictionary<ulong, string>();
        string NameOfTeam(ulong t)
        {
            if (!teamName.TryGetValue(t, out var n)) teamName[t] = n = reader.ClubName(_m.Ptr(t + (ulong)L.TeamClub));
            return n;
        }
        var seen = new HashSet<(uint, string, string, string)>();
        int relevant = 0;
        foreach (var d in _scan.Deals)
        {
            if (!_scan.AddrToUid.TryGetValue(d.Person, out uint uid)) continue;
            bool incoming = ourTeams.Contains(d.ToTeam), outgoing = ourTeams.Contains(d.FromTeam), sl = shortlist.Contains(uid);
            if (!incoming && !outgoing && !sl) continue;
            relevant++;
            string to = NameOfTeam(d.ToTeam), from = NameOfTeam(d.FromTeam);
            if (to == null || from == null || to == from) continue;   // renewals / internal moves
            string status = d.Status switch { 0x14 => "completed", 0x13 => "agreed", 0x0F => "rejected", _ => $"other(0x{d.Status:X2})" };
            if (!seen.Add((uid, to, from, status))) continue;
            dump.Transfers.Add(new TransferInfo
            {
                PlayerUid = uid,
                Player = _scan.Players.TryGetValue(uid, out var pr) ? reader.Name(pr.Person) : null,
                From = from, To = to, Status = status,
                Date = FmDate.ToIso(d.Date),
                Involves = incoming ? "incoming" : outgoing ? "outgoing" : "shortlist",
            });
        }
        dump.Transfers = dump.Transfers.OrderByDescending(t => t.Date ?? "").Take(60).ToList();
        _diag.Add($"Deal records: {_scan.Deals.Count} found, {relevant} involve you or your shortlist, {dump.Transfers.Count} written.");
        dump.Notes.Add("Transfer fees are not included (FM's fee field is unreliable). 'other' statuses are offers/negotiations whose code is not decoded yet.");
    }

    public static string TeamLabel(int type) => type switch
    {
        0 => "first team",
        >= 10 => "youth",
        _ => "reserves/B team",
    };
}
