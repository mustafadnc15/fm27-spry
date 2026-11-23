using BepInEx;
using BepInEx.Configuration;
using BepInEx.Unity.IL2CPP;

namespace TrueDoF;

/// <summary>
/// The BepInEx entry point. BepInEx calls Load() once while FM starts. We only:
///   1. read our settings from BepInEx\config\com.truedof.plugin.cfg,
///   2. start a tiny thread that watches for the hotkey (default F8),
///   3. start a tiny thread that watches for request.flag (used by the Phase 3 web app).
/// The dump itself runs on its own background thread and only COPIES bytes out of FM's
/// memory; it never calls into the game, so it can't disturb or freeze it.
/// </summary>
[BepInPlugin(Id, "TrueDoF", Settings.ToolVersion)]
public class Plugin : BasePlugin
{
    public const string Id = "com.truedof.plugin";

    private ConfigEntry<string> _hotkey;
    private ConfigEntry<bool> _probeEnabled;
    private ConfigEntry<string> _probeValues;
    private ConfigEntry<int> _probeDepth;
    private ConfigEntry<int> _shortlistMax;
    private ConfigEntry<bool> _exportDb;
    private ConfigEntry<string> _probeInspect;
    private ConfigEntry<int> _probeInspectBytes;

    public override void Load()
    {
        try
        {
            TrueDoF.Log.InfoSink = s => base.Log.LogInfo(s);
            TrueDoF.Log.WarnSink = s => base.Log.LogWarning(s);
            TrueDoF.Log.ErrorSink = s => base.Log.LogError(s);

            _hotkey = Config.Bind("General", "DumpHotkey", "F8",
                "Key that writes the dump while FM is in front. Examples: F8, Ctrl+F8, Shift+D.");
            _shortlistMax = Config.Bind("General", "ShortlistMaxMatchesPerName", 3,
                "If a shortlist name matches several players, include at most this many (highest CA first).");
            _exportDb = Config.Bind("General", "ExportPlayerDatabase", true,
                "Also write players-db.json (every player in your loaded leagues) so the Director chat can search it. Adds a few seconds to F8.");
            _probeEnabled = Config.Bind("Probe", "ProbeEnabled", false,
                "Discovery mode: also write probe.txt, searching for the numbers in ProbeValues.");
            _probeValues = Config.Bind("Probe", "ProbeValues", "",
                "Numbers you can see in FM, e.g.: balance=12500000; transferBudget=5000000; wageBudget=350000; points=24; goalDiff=11  (exact match; put ~ before a number to allow +-2%)");
            _probeInspect = Config.Bind("Probe", "ProbeInspect", "",
                "Objects to dump with labels, separated by ';'. Every offset is followed as a pointer, e.g.: competition +0xE08 +0x1E8");
            _probeInspectBytes = Config.Bind("Probe", "ProbeInspectBytes", 2048,
                "How many bytes of each inspected object to show (64..16384).");
            _probeDepth = Config.Bind("Probe", "ProbeDepth", 2,
                "How many pointer hops to follow from your club/team/competition (2 is a good start, 3 is slow).");

            var settings = CurrentSettings();
            Directory.CreateDirectory(settings.OutDir);
            TrueDoF.Log.FilePath = Path.Combine(settings.OutDir, "truedof.log");
            Shortlist.EnsureTemplate(settings);

            new HotkeyWatcher(() => _hotkey.Value, () => StartDump("hotkey")).Start();
            new RequestFlagWatcher(() => Settings.DefaultOutDir(), () => StartDump("request.flag")).Start();

            TrueDoF.Log.Info($"TrueDoF {Settings.ToolVersion} loaded. Load a save, then press {_hotkey.Value} in FM. Output: {settings.OutDir}");
        }
        catch (Exception e)
        {
            // Never let our plugin take FM down, not even at start-up.
            base.Log.LogError("TrueDoF failed to start (FM is unaffected): " + e);
        }
    }

    private void StartDump(string trigger)
    {
        bool started = DumpRunner.TryStartInBackground(trigger, () => WindowsMemory.ForCurrentProcess(), CurrentSettings);
        if (!started) TrueDoF.Log.Info("A dump is already running; ignored.");
    }

    /// <summary>Re-read the .cfg before every dump, so probe edits work without restarting FM.</summary>
    private Settings CurrentSettings()
    {
        try { Config.Reload(); } catch { }
        return new Settings
        {
            Host = "plugin",
            ProbeEnabled = _probeEnabled.Value,
            ProbeValues = _probeValues.Value,
            ProbeDepth = Math.Clamp(_probeDepth.Value, 0, 4),
            ProbeInspect = _probeInspect.Value,
            ProbeInspectBytes = _probeInspectBytes.Value,
            ShortlistMaxMatches = Math.Clamp(_shortlistMax.Value, 1, 10),
            ExportDatabase = _exportDb.Value,
        };
    }
}
