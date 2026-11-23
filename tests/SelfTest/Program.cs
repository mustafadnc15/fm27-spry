using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using TrueDoF;

namespace TrueDoF.SelfTest;

/// <summary>
/// Builds a small fake "FM memory" with the same layout TrueDoF expects (vtables, players,
/// your manager, club, teams, contracts, deals) and runs the real dump code on it.
/// This checks our pointer-chasing logic without needing the game.
/// </summary>
public static class Program
{
    private static int _failures;
    private static readonly Layout L = Layout.FM27;

    public static int Main()
    {
        string outDir = Path.Combine(Path.GetTempPath(), "truedof-selftest-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(outDir);
        Log.InfoSink = s => Console.WriteLine("  [log] " + s);
        Log.WarnSink = s => Console.WriteLine("  [warn] " + s);

        var w = new World();
        File.WriteAllText(Path.Combine(outDir, "shortlist.txt"),
            "\uFEFF# test shortlist\n#Commented Out\nTest Striker\nStriker @ rival\nNobody Here\nuid:" + w.YouthUid + "\n");

        var s = new Settings { Host = "selftest", OutDir = outDir, ProbeEnabled = true, ProbeValues = "balance=12,345,678; points=31",
                                 ProbeInspect = "firstTeam; firstTeam +0x38" };
        Check("dump succeeds", DumpRunner.RunNow(w.Memory, s));

        var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(outDir, "dump-latest.json"))).RootElement;
        var status = JsonDocument.Parse(File.ReadAllText(Path.Combine(outDir, "status.json"))).RootElement;
        Check("status ok", status.GetProperty("state").GetString() == "ok");
        Check("status has game version", status.GetProperty("gameVersion").GetString() == "27.1.0.0");
        Check("version verified", status.GetProperty("versionVerified").GetBoolean());

        var meta = json.GetProperty("meta");
        Check("manager name", meta.GetProperty("manager").GetString() == "Alex Gaffer");
        Check("game date", meta.GetProperty("gameDate").GetString() == "2027-03-14");

        var club = json.GetProperty("club");
        Check("club name", club.GetProperty("name").GetString() == "Testford United");
        Check("league", club.GetProperty("league").GetString() == "Test Premier League");
        Check("reputation", club.GetProperty("reputation").GetInt32() == 6500);
        Check("two teams", club.GetProperty("teams").GetArrayLength() == 2);
        Check("balance (negative allowed)", club.GetProperty("balance").GetInt64() == -1_250_000);
        Check("transfer budget", club.GetProperty("transferBudget").GetInt64() == 40_086);
        Check("wage budget", club.GetProperty("wageBudgetWeekly").GetInt64() == 60_989);
        Check("date-like value rejected", club.GetProperty("wageSpendWeekly").ValueKind == JsonValueKind.Null);
        Check("finances mapped", club.GetProperty("financesMapped").GetBoolean());
        // contracted to us: Ace, Bee, Youth, Away (not the loanee) = 50k + 20k + 1k + 5k
        Check("wage bill weekly", club.GetProperty("wageBillWeekly").GetInt64() == 76_000);
        Check("wage bill annual", club.GetProperty("wageBillAnnual").GetInt64() == 76_000 * 52);

        var squad = json.GetProperty("squad").EnumerateArray().ToList();
        Check("squad size 5", squad.Count == 5);
        var ace = squad.FirstOrDefault(p => p.GetProperty("name").GetString() == "Ace Player");
        Check("ace found (direct list entry)", ace.ValueKind == JsonValueKind.Object);
        if (ace.ValueKind == JsonValueKind.Object)
        {
            Check("ace CA/PA", ace.GetProperty("ca").GetInt32() == 155 && ace.GetProperty("pa").GetInt32() == 170);
            Check("ace age 26 on game date", ace.GetProperty("age").GetInt32() == 26);
            Check("ace pace 18", ace.GetProperty("physical").GetProperty("pace").GetInt32() == 18);
            Check("ace finishing 17", ace.GetProperty("technical").GetProperty("finishing").GetInt32() == 17);
            Check("ace consistency 15 (hidden)", ace.GetProperty("hidden").GetProperty("consistency").GetInt32() == 15);
            Check("ace ambition 12 (personality)", ace.GetProperty("personality").GetProperty("ambition").GetInt32() == 12);
            Check("ace natural ST", ace.GetProperty("naturalPositions")[0].GetString() == "ST");
            Check("ace accomplished AMC", ace.GetProperty("accomplishedPositions").EnumerateArray().Any(x => x.GetString() == "AMC"));
            Check("ace contract", ace.GetProperty("contract").GetProperty("wageWeekly").GetInt64() == 50_000
                                  && ace.GetProperty("contract").GetProperty("expires").GetString() == "2029-06-30"
                                  && ace.GetProperty("contract").GetProperty("transferListed").GetBoolean()
                                  && ace.GetProperty("contract").GetProperty("squadStatus").GetString() == "regular starter (code 3)"
                                  && ace.GetProperty("contract").GetProperty("squadStatusGroup").GetString() == "regular starter");
            Check("ace nationality", ace.GetProperty("nationality").GetString() == "Testland");
            Check("ace first team", ace.GetProperty("team").GetString() == "first team");
            Check("ace morale 7 = Slightly Poor", ace.GetProperty("morale").GetInt32() == 7 && ace.GetProperty("moraleLevel").GetString() == "Slightly Poor");
        }
        Check("bee found (indirect list entry)", squad.Any(p => p.GetProperty("name").GetString() == "Bee Keeper"));
        var loanee = squad.FirstOrDefault(p => p.GetProperty("name").GetString() == "Lou Nee");
        Check("loanee marked onLoanFrom Rival FC", loanee.ValueKind == JsonValueKind.Object && loanee.GetProperty("onLoanFrom").GetString() == "Rival FC");
        var youth = squad.FirstOrDefault(p => p.GetProperty("name").GetString() == "Young Gun");
        Check("youth in youth team", youth.ValueKind == JsonValueKind.Object && youth.GetProperty("team").GetString() == "youth");
        var away = squad.FirstOrDefault(p => p.GetProperty("name").GetString() == "Far Away");
        Check("out-on-loan player: loan club read", away.ValueKind == JsonValueKind.Object && away.GetProperty("onLoanAt").GetString() == "Rival FC"
              && away.GetProperty("loanEnds").GetString() == "2027-06-30" && away.GetProperty("notes")[0].GetString().Contains("Out on loan at Rival FC"));

        var shortlist = json.GetProperty("shortlist").EnumerateArray().Select(p => p.GetProperty("name").GetString()).ToList();
        Check("shortlist has Test Striker", shortlist.Contains("Test Striker"));
        Check("shortlist '@ rival' adds the other Striker", shortlist.Contains("Other Striker"));
        Check("shortlist uid entry", shortlist.Contains("Young Gun"));
        Check("shortlist no duplicates", shortlist.Count == shortlist.Distinct().Count());
        var slStatus = json.GetProperty("shortlistStatus").GetString();
        Check("shortlist status counts lines", slStatus.Contains("4 player line(s)"));
        Check("shortlist status warns about # lines", slStatus.Contains("IGNORED") && slStatus.Contains("#Commented Out"));
        Check("shortlist miss reported", json.GetProperty("shortlistNotFound").EnumerateArray().Any(m => m.GetProperty("entry").GetString() == "Nobody Here"));

        var transfers = json.GetProperty("transfers").EnumerateArray().ToList();
        Check("3 relevant transfers (in, out, shortlist; unrelated deals ignored)", transfers.Count == 3);
        Check("shortlist player's move included", transfers.Any(t => t.GetProperty("player").GetString() == "Other Striker" && t.GetProperty("involves").GetString() == "shortlist"));
        Check("future deal = arranged", transfers.Any(t => t.GetProperty("player").GetString() == "Test Striker" && t.GetProperty("status").GetString() == "arranged" && t.GetProperty("involves").GetString() == "incoming"));
        var tsJson = json.GetProperty("shortlist").EnumerateArray().First(p => p.GetProperty("name").GetString() == "Test Striker");
        Check("arranged transfer is not 'transfer-listed'", !tsJson.GetProperty("contract").GetProperty("transferListed").GetBoolean()
              && tsJson.GetProperty("notes").EnumerateArray().Any(n => n.GetString().Contains("Trn")));
        Check("outgoing completed", transfers.Any(t => t.GetProperty("player").GetString() == "Ace Player" && t.GetProperty("status").GetString() == "completed" && t.GetProperty("to").GetString() == "Rival FC"));

        string probe = File.ReadAllText(Path.Combine(outDir, "probe.txt"));
        Check("probe finds balance path", probe.Contains("club +0x1A0 +0x40  [int32]"));
        Check("probe finds points", probe.Contains("competition +0x30  [int32]"));
        Check("inspect labels club pointer", probe.Contains("club: Testford United"));
        Check("inspect labels player pointer", probe.Contains("player: Ace Player"));
        Check("full hit list written", File.Exists(Path.Combine(outDir, "probe-all.txt")));

        // Second probe after the balance "changed in the game": the real field is CONFIRMED.
        w.SetBalance(13_000_000);
        s.ProbeValues = "balance=13000000; points=31";
        Check("second dump succeeds", DumpRunner.RunNow(w.Memory, s));
        probe = File.ReadAllText(Path.Combine(outDir, "probe.txt"));
        int conf = probe.IndexOf("CONFIRMED", StringComparison.Ordinal);
        Check("probe compare confirms balance field", conf > 0 && probe.IndexOf("club +0x1A0 +0x40  [int32]", conf, StringComparison.Ordinal) > conf);
        Check("probe notes unchanged value", probe.Contains("Same value as last time"));
        Check("diagnostics written", File.ReadAllText(Path.Combine(outDir, "diagnostics.txt")).Contains("0x0288"));

        // ---- Player database export (players-db.json)
        var db = JsonDocument.Parse(File.ReadAllText(Path.Combine(outDir, "players-db.json"))).RootElement;
        var dbPlayers = db.GetProperty("players").EnumerateArray().ToList();
        Check("database has every player", dbPlayers.Count == 8);
        var dbTs = dbPlayers.First(p => p.GetProperty("n").GetString() == "Test Striker");
        Check("database row: club, league, CA/PA", dbTs.GetProperty("c").GetString() == "Rival FC" && dbTs.GetProperty("lg").GetString() == "Test Premier League"
              && dbTs.GetProperty("ca").GetInt32() == 160 && dbTs.GetProperty("pa").GetInt32() == 165);
        int attrCount = db.GetProperty("meta").GetProperty("attrKeys").GetArrayLength();
        Check("database row: attribute arrays", dbTs.GetProperty("at").GetArrayLength() == attrCount && attrCount == 47
              && dbTs.GetProperty("pr").GetArrayLength() == 15 && dbTs.GetProperty("hd").GetArrayLength() == 5 && dbTs.GetProperty("ps").GetArrayLength() == 8);
        var keys = db.GetProperty("meta").GetProperty("attrKeys").EnumerateArray().Select(k => k.GetString()).ToList();
        Check("database row: pace 18", dbTs.GetProperty("at")[keys.IndexOf("pace")].GetInt32() == 18);
        Check("database row: loan club", dbPlayers.First(p => p.GetProperty("n").GetString() == "Far Away").GetProperty("la").GetString() == "Rival FC");
        Check("status counts database players", JsonDocument.Parse(File.ReadAllText(Path.Combine(outDir, "status.json"))).RootElement.GetProperty("databasePlayers").GetInt32() == 8);

        // ---- Failure case: FM still starting (no game_plugin.dll) must keep the old dump ----
        string before = File.ReadAllText(Path.Combine(outDir, "dump-latest.json"));
        w.Memory.HideGamePlugin = true;
        Check("dump fails without game_plugin", !DumpRunner.RunNow(w.Memory, s));
        var st2 = JsonDocument.Parse(File.ReadAllText(Path.Combine(outDir, "status.json"))).RootElement;
        Check("status error", st2.GetProperty("state").GetString() == "error");
        Check("old dump kept", File.ReadAllText(Path.Combine(outDir, "dump-latest.json")) == before);

        // ---- Small helpers ----
        Check("hotkey parse Ctrl+F8", Hotkey.Parse("Ctrl+F8") is { Ctrl: true, VirtualKey: 0x77 });
        Check("hotkey parse rubbish", Hotkey.Parse("Banana") == null);
        Check("morale words", PlayerReader.MoraleWord(17) == "Excellent" && PlayerReader.MoraleWord(19) == "Exceptional" && PlayerReader.MoraleWord(4) == "between Very Poor and Quite Poor");
        Check("club match 'man city'", Shortlist.ClubMatches("Manchester City", Shortlist.Normalize("Man City")));
        Check("club match 'real'", Shortlist.ClubMatches("Real Madrid C.F.", "real"));
        Check("club no false match", !Shortlist.ClubMatches("Manchester United", Shortlist.Normalize("Man City")));
        Check("normalize accents", Shortlist.Normalize("Martin Ødegaard ") == "martin odegaard");
        Check("probe value parse", Probe.ParseValues("balance=12,500,000; points=~24").Count == 2 && Probe.ParseValues("x=~5")[0].approx);

        Console.WriteLine(_failures == 0 ? "\nALL SELF-TESTS PASSED" : $"\n{_failures} SELF-TEST(S) FAILED");
        Console.WriteLine($"Sample output kept in {outDir}");
        return _failures == 0 ? 0 : 1;
    }

    private static void Check(string name, bool ok)
    {
        Console.WriteLine($"{(ok ? "PASS" : "FAIL")}  {name}");
        if (!ok) _failures++;
    }

    // =====================================================================================
    // Fake FM world
    // =====================================================================================
    private sealed class World
    {
        public readonly FakeMemory Memory = new();
        public uint YouthUid;
        private uint _nextUid = 1000;
        private readonly Segment _gp, _heap, _heap2;
        private ulong _vtPlayer, _vtStaff, _vtHuman, _vtDecoy;
        private ulong _nation, _fin;
        public void SetBalance(long v) => _heap.W64(_fin + 0x40, (ulong)v);

        public World()
        {
            _gp = Memory.AddModule("game_plugin.dll", 0x7FF6_0000_0000, 0x20000, "27.1.0.0", 27, 1);
            Memory.AddModule("GameAssembly.dll", 0x7FF7_0000_0000, 0x1000, "1.0.0.0", 1, 0);
            _heap = Memory.AddHeap(0x2000_0000, 4 * 1024 * 1024);
            _heap2 = Memory.AddHeap(0x3000_0000, 1 * 1024 * 1024);

            _vtPlayer = MakeVtable(0, L.PlayerClass);
            _vtStaff = MakeVtable(1, L.StaffClass);
            _vtHuman = MakeVtable(2, L.HumanManagerClass);
            _vtDecoy = MakeVtable(3, 0x50);

            _nation = _heap.Alloc(0x40);
            _heap.W64(_nation + 0x20, Text("Testland"));

            var gameDate = new DateTime(2027, 3, 14);
            ulong comp = _heap.Alloc(0x80);
            _heap.W64(comp + (ulong)L.CompName, Text("Test Premier League"));
            _heap.W32(comp + 0x30, 31);  // "points" somewhere, for the probe

            var (us, usTeams) = MakeClub("Testford United", "Testford", new[] { 0, 10 }, comp, gameDate, 6500);
            var (rival, rivalTeams) = MakeClub("Rival FC", "Rival", new[] { 0 }, comp, gameDate, 5000);
            ulong other = MakeClub("Third Club", "Third", new[] { 0 }, comp, gameDate, 3000).teams[0];

            // Real finance record at club+0x150
            ulong finance = _heap.Alloc(0x900);
            _heap.W32(finance + (ulong)L.FinBalance, unchecked((uint)-1_250_000));     // in debt
            _heap.W32(finance + (ulong)L.FinTransferBudget, 40_086);
            _heap.W32(finance + (ulong)L.FinWageBudget, 60_989);
            _heap.W32(finance + (ulong)L.FinWageSpend, FmDate.FromDate(new DateTime(2027, 1, 1)));   // a date: must be rejected
            _heap.W64(us + (ulong)L.ClubFinance, finance);

            // Finance value hidden one pointer away from the club, for the probe test
            ulong fin = _fin = _heap.Alloc(0x80);
            _heap.W64(fin + 0x40, 12_345_678);
            _heap.W64(us + 0x1A0, fin);

            // Manager (you)
            ulong mgr = MakePerson(_vtHuman, L.HumanManagerClass, "Alex", "Gaffer", null, new DateTime(1980, 1, 1), usTeams[0], 10_000, 0x0, out _);
            _heap.W64(usTeams[0] + (ulong)L.TeamManager, mgr);

            // Players
            ulong ace = MakePlayer("Ace", "Player", new DateTime(2000, 5, 1), 155, 170, usTeams[0], 50_000, 0x01, "ST", "AMC", out _);
            ulong bee = MakePlayer("Bee", "Keeper", new DateTime(1995, 1, 1), 140, 145, usTeams[0], 20_000, 0, "GK", null, out _);
            ulong lou = MakePlayer("Lou", "Nee", new DateTime(2004, 1, 1), 120, 160, rivalTeams[0], 8_000, 0, "DC", null, out _);
            ulong yg = MakePlayer("Young", "Gun", new DateTime(2010, 2, 1), 70, 165, usTeams[0], 1_000, 0, "MC", null, out YouthUid);
            ulong far = MakePlayer("Far", "Away", new DateTime(2003, 1, 1), 100, 130, usTeams[0], 5_000, 0, "DL", null, out _);
            ulong loanCon = _heap.Alloc(0x80);
            _heap.W64(loanCon + (ulong)L.ConTeam, rivalTeams[0]);
            _heap.W32(loanCon + (ulong)L.ConExpiry, FmDate.FromDate(new DateTime(2027, 6, 30)));
            ulong loanRec = _heap.Alloc(0x20);
            _heap.W64(loanRec, loanCon);
            _heap.W64(far + (ulong)L.LoanRecord, loanRec);
            ulong ts = MakePlayer("Test", "Striker", new DateTime(1999, 1, 1), 160, 165, rivalTeams[0], 70_000, 0x01, "ST", null, out _);
            ulong os = MakePlayer("Other", "Striker", new DateTime(1998, 1, 1), 110, 115, rivalTeams[0], 9_000, 0, "ST", null, out _);
            MakePlayer("Random", "Bloke", new DateTime(1990, 1, 1), 90, 90, other, 2_000, 0, "MR", null, out _);

            // Team lists: Ace direct, Bee via a small wrapper record, loanee listed with us, youth in youth team
            SetPlayers(usTeams[0], ace, Wrapper(bee), lou);
            SetPlayers(usTeams[1], yg);
            SetPlayers(rivalTeams[0], ts, os, lou);

            // Deals
            Deal(ts, usTeams[0], rivalTeams[0], new DateTime(2027, 7, 1), 0x13);
            Deal(ace, rivalTeams[0], usTeams[0], new DateTime(2027, 1, 10), 0x14);
            Deal(os, other, rivalTeams[0], new DateTime(2027, 1, 5), 0x14);  // not about us → ignored

            // Noise: values pointing into game_plugin that are not vtables, and a staff-class object
            for (int i = 0; i < 200; i++) _heap.W64(_heap.Alloc(16), _gp.Base + (ulong)(i * 8 + 0x8000));
            ulong decoy = _heap.Alloc(0x40); _heap.W64(decoy, _vtDecoy); _heap.W32(decoy + 0x0C, 5);
            ulong staff = _heap.Alloc(0x200) + 0x100; _heap.W64(staff, _vtStaff); _heap.W32(staff + 0x0C, 6);
        }

        private ulong MakeVtable(int i, int classOffset)
        {
            ulong col = _gp.Base + 0x1000 + (ulong)(i * 0x20);
            _gp.W32(col + 4, (uint)classOffset);
            ulong vt = _gp.Base + 0x4000 + (ulong)(i * 0x100);
            _gp.W64(vt - 8, col);
            return vt;
        }

        private ulong Text(string s)
        {
            var bytes = Encoding.UTF8.GetBytes(s);
            ulong p = _heap.Alloc(bytes.Length + 8);
            _heap.Write(p + 4, bytes);
            return p;
        }

        private ulong Nested(string s)
        {
            ulong outer = _heap.Alloc(8);
            _heap.W64(outer, Text(s));
            return outer;
        }

        private (ulong club, ulong[] teams) MakeClub(string name, string shortName, int[] types, ulong comp, DateTime nextMatch, int rep)
        {
            ulong club = _heap.Alloc(0x200);
            _heap.W64(club + (ulong)L.ClubName, Text(name));
            _heap.W64(club + (ulong)L.ClubShortName, Text(shortName));
            var teams = new ulong[types.Length];
            ulong vec = _heap.Alloc(8 * types.Length);
            for (int i = 0; i < types.Length; i++)
            {
                ulong t = teams[i] = _heap.Alloc(0x100);
                _heap.W8(t + (ulong)L.TeamType, (byte)types[i]);
                _heap.W64(t + (ulong)L.TeamClub, club);
                _heap.W16(t + (ulong)L.TeamRep, (ushort)(rep - i * 1000));
                _heap.W64(t + (ulong)L.TeamComp, comp);
                ulong sched = _heap.Alloc(0x100);
                _heap.W32(sched + (ulong)L.ScheduleNextMatch, FmDate.FromDate(nextMatch));
                _heap.W64(t + (ulong)L.TeamSchedule, sched);
                _heap.W64(vec + (ulong)(8 * i), t);
            }
            _heap.W64(club + (ulong)L.ClubTeamsBegin, vec);
            _heap.W64(club + (ulong)L.ClubTeamsEnd, vec + (ulong)(8 * types.Length));
            return (club, teams);
        }

        private ulong MakePerson(ulong vt, int classOffset, string first, string second, string common, DateTime dob,
                                 ulong team, uint wage, byte flags, out uint uid)
        {
            ulong block = _heap.Alloc(classOffset + 0x100);
            ulong p = block + (ulong)classOffset;
            uid = _nextUid++;
            _heap.W64(p, vt);
            _heap.W32(p + (ulong)L.Uid, uid);
            _heap.W64(p + (ulong)L.FirstName, Nested(first));
            _heap.W64(p + (ulong)L.SecondName, Nested(second));
            if (common != null) _heap.W64(p + (ulong)L.CommonName, Nested(common));
            _heap.W64(p + (ulong)L.Nation, _nation);
            _heap.W32(p + (ulong)L.DateOfBirth, FmDate.FromDate(dob));
            byte[] personality = { 14, 12, 10, 11, 16, 13, 9, 5 };
            _heap.Write(p + (ulong)L.Personality, personality);
            ulong con = _heap.Alloc(0x80);
            _heap.W32(con + (ulong)L.ConWage, wage);
            _heap.W32(con + (ulong)L.ConExpiry, FmDate.FromDate(new DateTime(2029, 6, 30)));
            _heap.W8(con + (ulong)L.ConSquadNumber, 9);
            _heap.W8(con + (ulong)L.ConFlags, flags);
            _heap.W8(con + (ulong)L.ConSquadStatus, 3);
            _heap.W64(con + (ulong)L.ConTeam, team);
            _heap.W64(p + (ulong)L.Contract, con);
            return p;
        }

        private ulong MakePlayer(string first, string second, DateTime dob, int ca, int pa, ulong team, uint wage, byte flags,
                                 string natural, string accomplished, out uint uid)
        {
            ulong p = MakePerson(_vtPlayer, L.PlayerClass, first, second, null, dob, team, wage, flags, out uid);
            ulong block = p - (ulong)L.PlayerClass;
            _heap.W16(block + (ulong)L.Ca, (ushort)ca);
            _heap.W16(block + (ulong)L.Pa, (ushort)pa);
            _heap.W16(block + (ulong)L.Height, 185);
            _heap.W32(block + (ulong)L.Value, 25_000_000);
            _heap.W32(block + (ulong)L.AskingPrice, 0xFFFFFFFF);
            _heap.W16(block + (ulong)L.CurRep, 4000);
            _heap.W8(block + (ulong)L.Morale, 7);
            foreach (var (key, _, off) in Layout.PlayerAttributes)
            {
                int v = key switch { "pace" => 18, "finishing" => 17, "consistency" => 15, _ => 10 };
                _heap.W8(block + (ulong)(L.Attrs + off), (byte)(v * 5));
            }
            _heap.W8(block + (ulong)(L.Attrs + Layout.RightFoot), 90);
            _heap.W8(block + (ulong)(L.Attrs + Layout.LeftFoot), 40);
            for (int i = 0; i < Layout.PositionKeys.Length; i++)
            {
                string k = Layout.PositionKeys[i];
                byte v = k == natural ? (byte)20 : k == accomplished ? (byte)16 : (byte)1;
                _heap.W8(block + (ulong)(L.Positions + i), v);
            }
            return p;
        }

        private ulong Wrapper(ulong person)
        {
            ulong w = _heap.Alloc(0x40);
            _heap.W64(w + 0x10, person);
            return w;
        }

        private void SetPlayers(ulong team, params ulong[] entries)
        {
            ulong vec = _heap2.Alloc(8 * entries.Length);
            for (int i = 0; i < entries.Length; i++) _heap2.W64(vec + (ulong)(8 * i), entries[i]);
            _heap.W64(team + (ulong)L.TeamPlayersBegin, vec);
            _heap.W64(team + (ulong)L.TeamPlayersEnd, vec + (ulong)(8 * entries.Length));
        }

        private void Deal(ulong person, ulong toTeam, ulong fromTeam, DateTime date, byte status)
        {
            ulong d = _heap2.Alloc(0xC8);
            _heap2.W64(d + (ulong)L.DealPerson, person);
            _heap2.W64(d + (ulong)L.DealToTeam, toTeam);
            _heap2.W64(d + (ulong)L.DealFromTeam, fromTeam);
            _heap2.W32(d + (ulong)L.DealMarker1, L.DealMarker1Value);
            _heap2.W32(d + (ulong)L.DealMarker2, L.DealMarker2Value);
            _heap2.W32(d + (ulong)L.DealDate, FmDate.FromDate(date));
            _heap2.W8(d + (ulong)L.DealStatus, status);
        }
    }

    // =====================================================================================
    // Fake memory implementation
    // =====================================================================================
    private sealed class Segment
    {
        public ulong Base;
        public byte[] Data;
        private ulong _next;
        public Segment(ulong b, int size) { Base = b; Data = new byte[size]; _next = b + 0x100; }
        public ulong End => Base + (ulong)Data.Length;

        public ulong Alloc(int size)
        {
            ulong p = (_next + 15) & ~15UL;
            _next = p + (ulong)size;
            if (_next > End) throw new InvalidOperationException("fake heap full");
            return p;
        }

        private Span<byte> At(ulong a, int n) => Data.AsSpan((int)(a - Base), n);
        public void W8(ulong a, byte v) => At(a, 1)[0] = v;
        public void W16(ulong a, ushort v) => BinaryPrimitives.WriteUInt16LittleEndian(At(a, 2), v);
        public void W32(ulong a, uint v) => BinaryPrimitives.WriteUInt32LittleEndian(At(a, 4), v);
        public void W64(ulong a, ulong v) => BinaryPrimitives.WriteUInt64LittleEndian(At(a, 8), v);
        public void Write(ulong a, byte[] b) => b.CopyTo(At(a, b.Length));
    }

    private sealed class FakeMemory : IMemory
    {
        private readonly List<Segment> _segments = new();
        private readonly List<Segment> _heaps = new();
        private readonly Dictionary<string, ModuleInfo> _modules = new(StringComparer.OrdinalIgnoreCase);
        public bool HideGamePlugin;
        public bool IsOwnProcess => false;

        public Segment AddModule(string name, ulong b, int size, string version, int major, int minor)
        {
            var s = new Segment(b, size);
            _segments.Add(s);
            _modules[name] = new ModuleInfo { Name = name, Base = b, Size = (ulong)size, FileVersion = version, Major = major, Minor = minor };
            return s;
        }

        public Segment AddHeap(ulong b, int size)
        {
            var s = new Segment(b, size);
            _segments.Add(s);
            _heaps.Add(s);
            return s;
        }

        public bool Read(ulong address, Span<byte> dest)
        {
            foreach (var s in _segments)
            {
                if (address < s.Base || address >= s.End) continue;
                if ((ulong)dest.Length > s.End - address) return false;
                s.Data.AsSpan((int)(address - s.Base), dest.Length).CopyTo(dest);
                return true;
            }
            return false;
        }

        public List<MemRegion> HeapRegions() => _heaps.Select(h => new MemRegion(h.Base, (ulong)h.Data.Length)).ToList();

        public ModuleInfo FindModule(string name) =>
            HideGamePlugin && name.Equals("game_plugin.dll", StringComparison.OrdinalIgnoreCase) ? null
            : _modules.TryGetValue(name, out var m) ? m : null;
    }
}
