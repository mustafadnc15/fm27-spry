namespace TrueDoF;

// The shape of dump-latest.json. Plain classes with public fields; System.Text.Json turns
// them into camelCase JSON. Money is always GBP (FM stores pounds internally).
// null = "unknown / not readable / not mapped yet".

public sealed class Dump
{
    public DumpMeta Meta = new();
    public ClubInfo Club = new();
    public List<PlayerInfo> Squad = new();
    public LeagueTableInfo LeagueTable = new();
    public List<PlayerInfo> Shortlist = new();
    public List<ShortlistMiss> ShortlistNotFound = new();
    public string ShortlistStatus;    // what TrueDoF found in shortlist.txt (helps when it's empty)
    public List<TransferInfo> Transfers = new();
    public TacticInfo Tactic;         // your tactic as FM's match engine holds it; null = not found
    public List<string> Notes = new();
}

/// <summary>Your tactic, read from FM's memory (see TacticReader). Roles use FM's abbreviations.</summary>
public sealed class TacticInfo
{
    public string Source = "memory";
    public string StyleTag;           // e.g. "GEGE" (null = not readable)
    public string Style;              // e.g. "Gegenpress" when the tag is known
    public List<TacticSlotInfo> Slots = new();   // the eleven, in FM's formation order
    public List<string> Substitutes = new();
    public int Copies;                // how many selections agree on this tactic
    public int OtherTactics;          // different tactics FM also holds for your team
    public string Note;
}

public sealed class TacticSlotInfo
{
    public int Slot;
    public string InPossessionRole;   // FM abbreviation, e.g. "BCB"; null = role code not known yet
    public int InPossessionBit;       // raw role bit (shown when the role isn't known yet)
    public string OutOfPossessionRole;
    public int OutOfPossessionBit;
    public string InPossessionMask, OutOfPossessionMask;   // raw masks, for diagnostics
    public uint? PlayerUid;           // who you picked for this slot
    public string Player;
}

public sealed class DumpMeta
{
    public string Tool = "TrueDoF";
    public string ToolVersion;
    public string Host;              // "plugin" (inside FM) or "cli" (external)
    public string GeneratedAt;       // real-world time
    public string GameDate;          // in-game date (≈ your next fixture date)
    public string GameVersion;       // game_plugin.dll version
    public string Layout;            // which offset table was used
    public bool VersionVerified;     // false = offsets not verified for this FM patch
    public string Currency = "GBP";
    public string Manager;
    public int PlayersInDatabase;
}

public sealed class ClubInfo
{
    public string Name;
    public string ShortName;
    public string League;
    public int? Reputation;           // first-team reputation, ~0..10000
    // Finances straight from FM (null = could not be read / did not look sane).
    public long? Balance;
    public long? TransferBudget;
    public long? WageBudgetWeekly;
    public long? WageSpendWeekly;     // FM's own "current wage total (incl. bonuses)"
    public bool FinancesMapped;
    // Computed by TrueDoF from player contracts (staff wages not included).
    public long WageBillWeekly;
    public long WageBillAnnual;
    public int ContractedPlayers;
    public List<TeamInfo> Teams = new();
}

public sealed class TeamInfo
{
    public int TeamType;          // 0 = first team, low numbers = reserves/B, 10+ = youth
    public string TeamLabel;
    public string League;
    public int? Reputation;
    public int Players;
}

public sealed class PlayerInfo
{
    public uint Uid;
    public string Name;
    public int? Age;
    public string DateOfBirth;
    public string Nationality;
    public bool Female;
    public string Club;            // club holding the contract
    public string OnLoanFrom;      // set when he plays for you but is owned elsewhere
    public string OnLoanAt;        // set when he is out on loan (club he plays for now)
    public string LoanEnds;        // yyyy-mm-dd
    public string Team;            // which of your teams lists him (first team / reserves / youth)
    public int? TeamType;
    public int Ca, Pa;
    public List<string> NaturalPositions = new();
    public List<string> AccomplishedPositions = new();
    public Dictionary<string, int> PositionRatings = new();   // 1..20 per position
    public Dictionary<string, int> Technical = new();
    public Dictionary<string, int> Mental = new();
    public Dictionary<string, int> Physical = new();
    public Dictionary<string, int> Goalkeeping = new();
    public Dictionary<string, int> Hidden = new();            // consistency, important matches, ...
    public Dictionary<string, int> Personality = new();       // ambition, professionalism, ...
    public string PreferredFoot;
    public int? HeightCm;
    public ContractInfo Contract;
    public long? ValueGbp;
    public long? AskingPriceGbp;
    public int? ReputationCurrent, ReputationHome, ReputationWorld;
    public int? Morale;           // 1..20 (10 = Okay, 13 = Good, 20 = Perfect)
    public string MoraleLevel;    // FM's own word, e.g. "Good", "Excellent", "Perfect"
    public int? ConditionRaw;     // UNVERIFIED offset: raw value
    public List<string> Notes = new();
}

public sealed class ContractInfo
{
    public long? WageWeekly;
    public string Expires;        // yyyy-mm-dd
    public int? SquadNumber;
    public bool TransferListed, LoanListed;
    public int ListingFlagsRaw;   // raw listing byte (bit 0 transfer listed, bit 1 loan listed; other bits being checked)
    public int? SquadStatusCode;
    public string SquadStatus;        // FM's own name if known (e.g. "Star Player"), else the group + code
    public string SquadStatusGroup;   // key player / regular starter / fringe / prospect / surplus / not needed
}

public sealed class LeagueTableInfo
{
    public bool Mapped = false;
    public string Competition;
    public string Note = "The league table could not be read (details in diagnostics.txt).";
    public List<LeagueRow> Rows = new();
}

public sealed class LeagueRow
{
    public int Position, Played, Won, Drawn, Lost, GoalsFor, GoalsAgainst, GoalDifference, Points;
    public string Club;
    public bool IsUs;
    public LeagueRecord Home, Away;
}

public sealed class LeagueRecord
{
    public int Played, Won, Drawn, Lost, GoalsFor, GoalsAgainst, Points;
}

public sealed class ShortlistMiss
{
    public string Entry;
    public string Reason;
}

public sealed class TransferInfo
{
    public uint PlayerUid;
    public string Player;
    public string From;
    public string To;
    public string Status;         // arranged (future move) / completed / agreed / rejected / other(0xNN)
    public int StatusCode;        // FM's raw status byte
    public string Date;           // date the move takes effect
    public string Involves;       // "incoming", "outgoing", "shortlist"
}
