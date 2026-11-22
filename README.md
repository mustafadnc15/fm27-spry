# TrueDoF: an AI Director of Football for Football Manager 27

TrueDoF reads the **true** data of your FM27 save (real attributes, CA/PA, hidden
attributes, contracts) straight from the game's memory. An AI "Director of Football" then
reasons from that data instead of scout-report guesswork.

Status: **Phase 1 (game plugin) is built and waiting for in-game testing.** The briefing
builder (Phase 2), the chat app (Phase 3) and the one-click launcher (Phase 4) come next.

Rules TrueDoF follows:

- **Read-only.** It never writes to the game's memory and never touches your save files.
- **Single-player only.**
- **It can't crash FM.** Every memory read can fail harmlessly. Errors go to
  `status.json` and `diagnostics.txt`.
- **One output folder:** `%LOCALAPPDATA%\TrueDoF\` (paste that into the Explorer address
  bar).

---

## Phase 1: install and test the plugin

### 1. Install BepInEx 6 into FM27 (one time)

1. Download the newest **BepInEx 6 "bleeding edge" build** for **Unity IL2CPP, Windows
   x64** from <https://builds.bepinex.dev/projects/bepinex_be>. The file is named like
   `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.7xx+….zip`. FM27 runs on Unity 6, so take a
   recent build.
2. Open your FM27 folder: Steam → right-click Football Manager 27 → Manage → Browse local
   files. It's the folder that contains `fm.exe`.
3. Extract the zip **into that folder**. You should now see `winhttp.dll`,
   `doorstop_config.ini` and a `BepInEx` folder next to `fm.exe`.
4. Start FM27 once and wait. **The first start can take several minutes** while BepInEx
   prepares itself. Once you reach the main menu, quit FM.
5. Check that `BepInEx\LogOutput.log` exists and that there's a `BepInEx\plugins` folder.

> Antivirus software sometimes quarantines `winhttp.dll`. If BepInEx doesn't start,
> check your antivirus quarantine and add an exception for the FM folder.

### 2. Build TrueDoF (one time, and again after each update)

1. Install the **.NET 8 SDK** from <https://dotnet.microsoft.com/download> (the "SDK",
   not just the "Runtime").
2. Open a terminal **in this project folder** and run:

   ```bash
   dotnet build plugin -c Release
   ```

3. If FM27 is in the default Steam folder, the build **copies `TrueDoF.dll` into
   `BepInEx\plugins` automatically**. You'll see `TrueDoF.dll copied to …`. If FM27 is
   somewhere else, either:

   ```bash
   dotnet build plugin -c Release -p:FMDir="D:\Games\Football Manager 27"
   ```

   or copy `plugin\bin\TrueDoF.dll` into `<FM27>\BepInEx\plugins\` yourself.

### 3. Use it

1. Start FM27 and load your save.
2. Wait until FM is idle (not "processing"), then press **F8** on any screen.
3. Within about 5–30 seconds, `%LOCALAPPDATA%\TrueDoF\` will contain:

| File | What it is |
|---|---|
| `status.json` | `"state": "ok"` or `"error"` with a message, plus the timestamp and game version |
| `dump-latest.json` | Your club, squad, shortlist and transfer activity (an example is in `docs/examples/dump-sample.json`) |
| `diagnostics.txt` | Technical details for troubleshooting |
| `shortlist.txt` | **Your shortlist: type player names here**, one per line |
| `truedof.log` | A running log |

**Shortlist:** TrueDoF can't read FM's own shortlist yet, so type your targets into
`shortlist.txt` and press F8 again:

```
Erling Haaland
Haaland @ Man City
uid:12345678
```

Add `@ Club` when two players share a name. Accents and capitals don't matter.

**Changing the hotkey or other options:** edit
`<FM27>\BepInEx\config\com.truedof.plugin.cfg`. That file is created on the first FM
start with the plugin. Changes apply at the next F8, with no FM restart needed.

### Backup: the external reader (if BepInEx won't work)

The same code also ships as a standalone program that reads FM from outside:

```bash
dotnet publish cli -c Release
```

Then, with FM27 running and your save loaded, run `cli\bin\publish\TrueDoF.Cli.exe`. It
writes the same files.

---

## What's in the dump (and what isn't yet)

| Data | Status |
|---|---|
| Club name, league, reputation, teams (first/reserves/youth) | ✅ |
| Squad: name, age, nationality, positions, all attributes, CA, PA | ✅ |
| Hidden: consistency, important matches, injury proneness, dirtiness, versatility | ✅ |
| Personality: ambition, professionalism, pressure, loyalty, temperament, … | ✅ |
| Contract: weekly wage, expiry, squad number, transfer/loan-listed flags | ✅ |
| Value, asking price, reputation, height, preferred foot | ✅ |
| Players on loan to you / loaned out | ✅ (loaned-out players show a note) |
| Wage bill | ✅ computed from player contracts, plus FM's own wage total |
| Transfer activity (completed / agreed deals involving you or your shortlist) | ✅ no fees |
| Morale | ✅ 1–20 plus a word (10 = okay, 13 = good, 20 = superb) |
| Balance, transfer budget, wage budget (weekly) | ✅ |
| League table | ❌ not mapped yet: use the probe |
| FM's own shortlist | ❌ use `shortlist.txt` |

Money is always **pounds (GBP)**. That's how FM stores it internally, whatever currency
you see in the game.

### The probe: helping TrueDoF find the league table

1. In FM, set the currency to pounds (Preferences → Units → Currency).
2. Note your **exact** balance, transfer budget and wage budget from the Finances screen,
   plus your points and goal difference from the league table.
3. Edit `<FM27>\BepInEx\config\com.truedof.plugin.cfg`:

   ```ini
   [Probe]
   ProbeEnabled = true
   ProbeValues = balance=2561896; transferBudget=40086; wageBudget=60989; points=59; goalDiff=43
   ProbeInspect = competition +0xE08 +0x1E8
   ```

   Numbers must be exact. Put `~` in front of one (for example `balance=~2.5M`, written
   as `~2500000`) only if FM shows it rounded.
4. Press F8. `probe.txt` shows where the numbers were found. The full list goes to
   `probe-all.txt`.
5. Play a match, so the numbers change. Update `ProbeValues` and press F8 again. Now
   `probe.txt` lists **CONFIRMED** places, meaning ones that held the old value before and
   the new value now. Those are the real fields.
6. `ProbeInspect` dumps one memory object with labels (team / club / player / text). Each
   `+0x…` is followed as a pointer.

---

## For developers

```
core/      all logic (memory reading, scanning, club dump, shortlist, probe, output)
plugin/    BepInEx entry point (TrueDoF.dll)
cli/       external reader (TrueDoF.Cli.exe)
tests/     self-test with a fake FM memory image (runs on any OS)
docs/      research notes and examples
```

Run the self-test with:

```bash
dotnet run --project tests/SelfTest -c Release
```

The memory layout is documented in `docs/how-fmsuperscout-reads-data.md`, and all offsets
live in `core/Layout.cs`. See `docs/credits.md` for where each offset came from.
