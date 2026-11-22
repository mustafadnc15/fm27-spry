namespace TrueDoF;

/// <summary>Reads the full details of one player. Every read is crash-proof; bad values become null.</summary>
public sealed class PlayerReader
{
    private readonly Mem _m;
    private readonly Layout L;
    private readonly DateTime _today;

    public PlayerReader(Mem m, Layout layout, DateTime today) { _m = m; L = layout; _today = today; }

    public PlayerInfo Read(PlayerRef r)
    {
        ulong person = r.Person, block = r.Block;
        var p = new PlayerInfo
        {
            Uid = r.Uid,
            Name = Name(person),
            Ca = _m.U16(block + (ulong)L.Ca),
            Pa = _m.U16(block + (ulong)L.Pa),
            Female = (_m.U8(person + (ulong)L.Gender) & L.FemaleBit) != 0,
            Nationality = Nation(person),
        };

        var dob = FmDate.ToDate(_m.U32(person + (ulong)L.DateOfBirth));
        if (dob is DateTime d)
        {
            p.DateOfBirth = d.ToString("yyyy-MM-dd");
            int age = _today.Year - d.Year - (_today.DayOfYear < d.DayOfYear ? 1 : 0);
            if (age is >= 10 and <= 60) p.Age = age;
        }

        // Attributes (stored x5 → 1..20)
        ulong attrs = block + (ulong)L.Attrs;
        foreach (var (key, group, off) in Layout.PlayerAttributes)
        {
            int v = Attr(attrs + (ulong)off);
            if (v == 0) continue;
            GroupOf(p, group)[key] = v;
        }
        int lf = Attr(attrs + Layout.LeftFoot), rf = Attr(attrs + Layout.RightFoot);
        if (lf > 0 || rf > 0)
            p.PreferredFoot = lf >= 14 && rf >= 14 ? "either" : rf >= lf ? "right" : "left";

        // Personality (raw 1..20)
        for (int i = 0; i < Layout.PersonalityKeys.Length; i++)
        {
            int v = _m.U8(person + (ulong)(L.Personality + i));
            if (v is >= 1 and <= 20) p.Personality[Layout.PersonalityKeys[i]] = v;
        }

        // Positions: 20 = natural, 15..19 = accomplished (like FM's own position display).
        // If nothing is a 20, his best position counts as natural.
        int best = 0;
        for (int i = 0; i < Layout.PositionKeys.Length; i++)
        {
            int v = _m.U8(block + (ulong)(L.Positions + i));
            if (v is >= 1 and <= 20) { p.PositionRatings[Layout.PositionKeys[i]] = v; best = Math.Max(best, v); }
        }
        foreach (var kv in p.PositionRatings.OrderByDescending(kv => kv.Value))
        {
            if (kv.Value == 20 || kv.Value == best) p.NaturalPositions.Add(kv.Key);
            else if (kv.Value >= 15) p.AccomplishedPositions.Add(kv.Key);
        }

        int h = _m.U16(block + (ulong)L.Height);
        if (h is >= 140 and <= 220) p.HeightCm = h;
        p.ValueGbp = Money(_m.U32(block + (ulong)L.Value));
        p.AskingPriceGbp = Money(_m.U32(block + (ulong)L.AskingPrice));
        p.ReputationHome = Rep(_m.U16(block + (ulong)L.HomeRep));
        p.ReputationCurrent = Rep(_m.U16(block + (ulong)L.CurRep));
        p.ReputationWorld = Rep(_m.U16(block + (ulong)L.WorldRep));
        int morale = _m.U8(block + (ulong)L.Morale);
        if (morale is >= 1 and <= 20)
        {
            p.Morale = morale;
            p.MoraleLevel = morale switch { <= 4 => "very poor", <= 7 => "poor", <= 10 => "okay", <= 14 => "good", <= 17 => "very good", _ => "superb" };
        }
        p.ConditionRaw = _m.U16(block + (ulong)L.Condition);

        ulong con = _m.Ptr(person + (ulong)L.Contract);
        if (con != 0)
        {
            byte flags = _m.U8(con + (ulong)L.ConFlags);
            int sq = _m.U8(con + (ulong)L.ConSquadNumber);
            p.Contract = new ContractInfo
            {
                WageWeekly = Money(_m.U32(con + (ulong)L.ConWage)),
                Expires = FmDate.ToIso(_m.U32(con + (ulong)L.ConExpiry)),
                SquadNumber = sq is >= 1 and <= 99 ? sq : null,
                TransferListed = (flags & 0x01) != 0 || (flags & 0x08) != 0,
                LoanListed = (flags & 0x02) != 0,
                NotForSale = (flags & 0x10) != 0,
                ReleaseListed = (flags & 0x20) != 0,
            };
            p.Club = ClubName(ContractClub(person));
        }
        return p;
    }

    /// <summary>person → contract → team → club pointer (0 if any step is missing).</summary>
    public ulong ContractClub(ulong person)
    {
        ulong con = _m.Ptr(person + (ulong)L.Contract);
        if (con == 0) return 0;
        ulong team = _m.Ptr(con + (ulong)L.ConTeam);
        return team == 0 ? 0 : _m.Ptr(team + (ulong)L.TeamClub);
    }

    public string Name(ulong person)
    {
        string common = _m.NestedString(person + (ulong)L.CommonName);
        if (common != null) return common;
        string first = _m.NestedString(person + (ulong)L.FirstName);
        string second = _m.NestedString(person + (ulong)L.SecondName);
        string full = string.Join(" ", new[] { first, second }.Where(s => s != null));
        return full.Length == 0 ? null : full;
    }

    /// <summary>All name variants for shortlist matching: common name, "first second", and surname alone.</summary>
    public IEnumerable<string> NameVariants(ulong person)
    {
        string common = _m.NestedString(person + (ulong)L.CommonName);
        string first = _m.NestedString(person + (ulong)L.FirstName);
        string second = _m.NestedString(person + (ulong)L.SecondName);
        if (common != null) yield return common;
        if (first != null || second != null) yield return string.Join(" ", new[] { first, second }.Where(s => s != null));
        if (second != null) yield return second;
    }

    public string ClubName(ulong club)
    {
        if (club == 0) return null;
        string n = _m.IndirectString(club + (ulong)L.ClubName) ?? _m.IndirectString(club + (ulong)L.ClubShortName);
        return Plausible(n) ? n : null;
    }

    public string CompName(ulong team)
    {
        foreach (int off in new[] { L.TeamComp, L.TeamCompAlt })
        {
            ulong comp = _m.Ptr(team + (ulong)off);
            if (comp == 0) continue;
            string s = _m.IndirectString(comp + (ulong)L.CompName);
            if (!Plausible(s)) s = _m.IndirectString(comp + (ulong)L.CompShortName);
            if (Plausible(s)) return s;
        }
        return null;
    }

    private string Nation(ulong person)
    {
        ulong n = _m.Ptr(person + (ulong)L.Nation);
        if (n == 0) return null;
        string s = _m.IndirectString(n + (ulong)L.NationShortName) ?? _m.IndirectString(n + (ulong)L.NationName);
        return Plausible(s) ? s : null;
    }

    private int Attr(ulong addr)
    {
        int raw = _m.U8(addr);
        return Math.Clamp((int)Math.Round(raw / 5.0, MidpointRounding.AwayFromZero), 0, 20);
    }

    private static Dictionary<string, int> GroupOf(PlayerInfo p, string g) => g switch
    {
        "technical" => p.Technical,
        "mental" => p.Mental,
        "physical" => p.Physical,
        "goalkeeping" => p.Goalkeeping,
        _ => p.Hidden,
    };

    // FM uses 0xFFFFFFFF (and 300,000,000 for values) as "not set".
    private static long? Money(uint v) => v == 0xFFFFFFFF || v == 300_000_000u ? null : v;
    private static int? Rep(int v) => v is >= 1 and <= 10000 ? v : null;

    /// <summary>Real names have letters and sensible length (filters out garbage reads).</summary>
    public static bool Plausible(string s) =>
        !string.IsNullOrEmpty(s) && s.Length is >= 2 and <= 64 && s.Any(char.IsLetter);
}

/// <summary>FM's date format: year in the high 16 bits, day-of-year (1..366) in the low 9 bits.</summary>
public static class FmDate
{
    public static DateTime? ToDate(uint raw)
    {
        int year = (int)(raw >> 16), doy = (int)(raw & 0x1FF);
        if (year is < 1900 or > 2100 || doy < 1 || doy > (DateTime.IsLeapYear(year) ? 366 : 365)) return null;
        return new DateTime(year, 1, 1).AddDays(doy - 1);
    }

    public static string ToIso(uint raw) => ToDate(raw) is DateTime d && d.Year >= 2000 ? d.ToString("yyyy-MM-dd") : null;

    public static uint FromDate(DateTime d) => ((uint)d.Year << 16) | (uint)d.DayOfYear;
}
