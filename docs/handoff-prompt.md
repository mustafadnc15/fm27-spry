# Handoff prompt for the local Claude Code session

Paste everything below the line into Claude Code, started in the TrueDoF project folder on
the Windows PC that runs FM27.

---

You're continuing work on **TrueDoF**, my AI "Director of Football" for Football Manager 27.
The code is in this folder, on git branch `claude/friendly-mayer-9hjyt3`. Run
`git pull origin claude/friendly-mayer-9hjyt3` first.

## How I work (please follow this)

- I'm a "vibecoder": I can run commands and test in-game, but I often don't understand the
  code. Explain every key decision in plain language, keep the code simple, and after each
  step tell me exactly what to test in-game. Then stop and wait for my results.
- Hard rules:
  - **Read-only:** never write to game memory and never modify saves.
  - **Single-player only.**
  - **Fail safely:** wrap all game-data access in try/catch, log to `diagnostics.txt`, and
    never crash FM.
  - **Threading:** no game code is ever called. Memory is copied with ReadProcessMemory on a
    background thread, and file and network work happens off FM's main thread.
  - **Output folder:** `%LOCALAPPDATA%\TrueDoF\`.
- Commit to the branch above with clear messages, and keep the tests green:
  - `dotnet run --project tests/SelfTest -c Release` (plugin logic against a fake memory
    image, any OS);
  - `npm test` (briefing, database tools, and the chat app against a fake Anthropic API).
- Unlike the previous (cloud) session, you run on my actual PC. You can build the plugin,
  run `cli\bin\publish\TrueDoF.Cli.exe` against the running game, and read
  `%LOCALAPPDATA%\TrueDoF\*` yourself. Use that to verify things instead of guessing, but ask
  me before anything that needs me to click in FM.

## My setup

- FM27 version 27.1, **Xbox Game Pass**, installed at
  `D:\XboxGames\Football Manager 27\Content`. BepInEx 6 IL2CPP is installed there and the
  plugin works. Build and deploy with:

  ```
  dotnet build plugin -c Release -p:FMDir="D:\XboxGames\Football Manager 27\Content"
  ```

- Windows is in Turkish (command output is in Turkish).
- Save: Eskişehirspor (Trendyol 1. Lig), in-game date about March 2029.
- I play with **attribute masking OFF**, so the Director's default view is "What I see in FM":
  exact attributes, no CA/PA/hidden attributes.
- Model: **Claude Sonnet 5.5** (`claude-sonnet-5-5`) through the Anthropic API. The key is in
  `.env`, which is never committed.

## What exists and works (verified by me in-game)

Read `README.md` and `docs/how-fmsuperscout-reads-data.md` first.

- `core/` + `plugin/`: a BepInEx 6 IL2CPP plugin (`TrueDoF.dll`), with `cli/` as an external
  backup reader.
  - **F8** (or a `request.flag` file) scans FM's heap with ReadProcessMemory. It recognises
    objects by MSVC RTTI class offset (the int at `[vtable-8]+4`).
  - It writes:
    - `dump-latest.json`: club, squad, shortlist, transfers, finances, morale, loans, squad
      status;
    - `players-db.json`: every player in the loaded leagues;
    - `status.json`, `diagnostics.txt`, `probe.txt`.
  - All offsets live in `core/Layout.cs`. They came from FMSuperScout (MIT) and from the
    GPL-3.0 editors FMLibreEditor, FM OpenEditor, fm-editor and Football-Manager-27-Editor.
    We only use their documented **facts (offsets)**, never their code; see
    `docs/credits.md`.
- `briefing/`: turns the dump into a compact briefing (best XI, depth, weak spots,
  contracts, wages, youth, shortlist verdict inputs).
  - `ratings.js` holds TrueDoF's **position ratings**: a weighted average of each position's
    key attributes, 1-20.
  - `realism.js` holds the three Director views: `fmView` (attributes only), everything, and
    `perceive` (scouted ranges).
- `server/`: the Director chat at http://localhost:8766 (`npm start`).
  - It uses the Anthropic SDK pinned at 1.6.0, streaming, adaptive thinking, prompt caching
    and `fallbacks: "default"`.
  - The Director has four tools that run against `players-db.json`: `search_players`,
    `find_similar_players`, `get_player_profile` and `add_to_shortlist`.
  - There's a settings dialog (view mode, effort, club philosophy).
- Not done yet:
  - the league table;
  - FM's own shortlist (saved `.fmf` shortlists are encrypted, and nobody has found the
    shortlist in memory);
  - Phase 4 (one-click `.bat` launcher, README for non-technical users, TROUBLESHOOTING.md
    including "it broke after an FM patch").

## Task 1: the Director should know my tactic

My tactic is a 4-3-3-0 strikerless system, "ZaZ - Ace of Diamonds 2.0". It wants very high
**pace and acceleration** in nearly every role. The Director should judge players **by the
roles in my tactic** (not generic positions), and weight what the tactic needs.

What the previous session found:

- **Tactic `.fmf` files can't be parsed.** My exported tactic (1,070 bytes) is the SI
  resource container: an `afe.` data region (entropy 7.69 bits/byte, i.e. encrypted with a
  random per-file nonce) plus a readable zstd-compressed index after the `fmf.` tag at the
  end. FMSuperScout's `docs/fmf-format.md` reached the same conclusion for shortlists.
  Don't spend time on decrypting it.
- **Reading the active tactic from memory is feasible.** FMLibreEditor (GPL-3.0, facts
  only) documents it in `docs/recon/fm27-tactics-and-value.md` and in the `[selection]`,
  `[tactic]` and `[tactics]` sections of `profiles/fm27/layout.toml`. Clone it read-only
  into the git-ignored `reference/` folder:

  ```
  git clone --depth 1 https://github.com/tozmoz/FMLibreEditor reference/fmlibreeditor
  ```

  Key facts (Windows, also confirmed on Game Pass):
  - The match engine's selections are objects of class
    `simatch::PREPARED_TACTICS_CREATOR_ARRAY`.
    - Slots at `+0x28`: 26 × u32 person ids, the starting eleven in formation order, then
      the subs. `0xFFFFFFFF` = empty.
    - A player's person id is the u32 at `player +0x290`.
    - `+0x08` is a list whose first entry points at the **tactic block**.
  - Tactic block:
    - style tag at `+0x100`: a u32 read as reversed text, e.g. `CONT`, `TIKI`, `DIRE`,
      `GEGE`, `VERT`;
    - 11 in-possession slot entries at `+0x148`, `0x48` bytes each, with a **u64 role mask
      at `+0x10`** of each entry;
    - 11 out-of-possession slot entries at `+0x468`, same layout.
  - Each role mask has one of bits 21/22/23 set, plus one bit naming the role. Bit →
    role tables (in possession and out of possession) are in the recon doc. For example:
    - in possession: 1 = CB, 7 = W, 9 = AM, 17 = AP, 27 = IF, 45 = WFD, 46 = BBP;
    - out of possession: 1 = SK, 15 = DM, 38 = W, 42 = CFD.
    - A few bits are still unnamed. Show them as "unknown role (bit N)".
  - The game writes the block when the manager **leaves the tactics screen**. Older blocks
    can stay in memory, so pick the selection whose slots hold *my* club's player ids.
    FMLibre also maps a per-manager tactics tree (`[tactics]`: team tactics `+0x1010` list
    of blocks, `+0x1028` index of the one in use). That one is reached through a pointer
    from the game's build profile, which needs a version-specific address; avoid it if the
    class-name route works.
  - **How to find the selection objects without version-specific addresses:** our scanner
    only knows the class *offset* at `[vtable-8]+4`. Extend `core/HeapScanner.cs` to also
    resolve the MSVC RTTI **class name**:
    - `[vtable-8]` is the CompleteObjectLocator. On x64 its `+0x0C` is an image-relative RVA
      to the TypeDescriptor, whose name string starts at `+0x10`, e.g.
      `.?AVPREPARED_TACTICS_CREATOR_ARRAY@simatch@@`.
    - Cache the name per vtable (there are few distinct vtables).
    - Collect objects whose class name matches and whose slots contain our squad's person
      ids.
    - Keep everything read-only and crash-safe, and add the class names seen to
      `diagnostics.txt`.

Suggested plan (explain it to me, then do it step by step):

1. **Manual fallback first** (works immediately, no memory reading). A `tactic.txt` in
   `%LOCALAPPDATA%\TrueDoF\` where I write the formation, the 11 roles with duties, the
   style, and optional **priority attributes** (e.g. `pace, acceleration`). Show it in the
   briefing and the chat settings.
2. **Role-based ratings.**
   - Add FM27's role → key/preferable attributes to `briefing/ratings.js`. FM26/27 replaced
     the old roles with in-possession and out-of-possession roles (IF, WFD, TCF, OCF, PW,
     BBP and so on). **Research the current FM27 role list and each role's highlighted
     attributes** (official SI guides, FM-Arena, FM Scout, Passion4FM), and tell me your
     sources.
   - Rate a player for a slot from that role's attributes (key ×2, preferable ×1). Apply
     the tactic's priority attributes as an extra weight.
   - Build the best XI **for my tactic's slots** instead of the four generic formations.
     Give `search_players` / `find_similar_players` a `tactic_slot` or `role` parameter so
     "find me an IF for my tactic" works.
   - Update the Director's system prompt to explain the tactic, and that pace and
     acceleration matter most for it.
3. **Read the tactic from memory** (the class-name route above). Fill the same structure as
   `tactic.txt` automatically on each F8, with `tactic.txt` still overriding it. I'll help
   verify by changing a role in FM, leaving the tactics screen, pressing F8 and comparing.
   Search the web for whether "ZaZ - Ace of Diamonds 2.0" has a published description (roles
   and duties), to pre-fill or cross-check.

## Task 2: an interface that works in-game

I want to talk to the Director without alt-tabbing out of FM.

Previous session's recommendation (decide with me before building):

- **An overlay window, not a UI inside FM.**
  - Build a small Windows app (`overlay/`, C# .NET 8, WinForms or WPF, with **WebView2**)
    that shows the existing chat at `http://localhost:8766` in a compact layout (e.g.
    `/?compact=1`).
  - It should be always-on-top, resizable and semi-transparent when not focused, and shown
    or hidden with a global hotkey (`RegisterHotKey`, e.g. **F9**; F8 is the dump key).
  - Give it a "Refresh from FM" button and a quick-question box.
  - It starts the Node server if it isn't running, and remembers its position and size.
- FM must run in **windowed or borderless** mode for any overlay to show on top. Check how
  FM27 Game Pass handles this and tell me the exact setting.
- Why not a UI inside FM?
  - FM's interface is SI's own UI framework.
  - Drawing into it through BepInEx/IL2CPP needs Unity interop, which this project
    deliberately avoids.
  - FMSuperScout found that injected MonoBehaviours sometimes never tick.
  - It's fragile across patches.
  - Mention it as an option, but recommend the overlay.

## After both tasks

Do Phase 4:
- a one-click `.bat` launcher (start the server, open the overlay or browser, check for
  `.env`, Node and the plugin);
- README sections for non-technical users;
- `TROUBLESHOOTING.md`, including "it broke after an FM patch". Base that section on
  `diagnostics.txt`, the class-offset histogram, `Layout.cs`, the probe, and re-checking
  the open-source editors' offset files.

Start by reading the repo and summarising your plan for Task 1 in plain language. Then wait
for my OK.
