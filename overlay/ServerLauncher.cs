using System.Diagnostics;

namespace TrueDoF.Overlay;

/// <summary>
/// Makes sure the Director chat app (node server/server.js) is running. If it already runs (e.g. you started
/// it with npm start), it is used as is and left alone on exit. If the overlay started it, the overlay stops it.
/// </summary>
public sealed class ServerLauncher : IDisposable
{
    private Process _server;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    public int Port { get; }
    public string Root { get; }
    public string Url => $"http://localhost:{Port}/";

    public ServerLauncher()
    {
        Root = FindRoot();
        Port = ReadPort(Root);
    }

    /// <summary>The TrueDoF folder: the one with server\server.js, found from where the overlay runs.</summary>
    private static string FindRoot()
    {
        string env = Environment.GetEnvironmentVariable("TRUEDOF_ROOT");
        if (!string.IsNullOrEmpty(env) && File.Exists(Path.Combine(env, "server", "server.js"))) return env;
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "server", "server.js"))) return dir.FullName;
        return null;
    }

    /// <summary>PORT from the project's .env, else 8766 (the same rule the chat app uses).</summary>
    private static int ReadPort(string root)
    {
        if (int.TryParse(Environment.GetEnvironmentVariable("PORT"), out int p) && p > 0) return p;
        try
        {
            string env = root == null ? null : Path.Combine(root, ".env");
            if (env != null && File.Exists(env))
                foreach (string line in File.ReadAllLines(env))
                {
                    var t = line.Trim();
                    if (t.StartsWith("PORT=", StringComparison.Ordinal) && int.TryParse(t[5..].Trim().Trim('"', '\''), out p) && p > 0) return p;
                }
        }
        catch { /* default below */ }
        return 8766;
    }

    public async Task<bool> IsUpAsync()
    {
        try
        {
            using var r = await Http.GetAsync($"http://localhost:{Port}/api/state");
            return r.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    /// <summary>Running already, or started now. Returns null on success, else a message for the user.</summary>
    public async Task<string> EnsureRunningAsync()
    {
        if (await IsUpAsync()) { Log.Info($"Chat app already running on port {Port}."); return null; }
        if (Root == null) return "Could not find the TrueDoF folder (with server\\server.js). Run the overlay from inside the TrueDoF folder.";

        try
        {
            var psi = new ProcessStartInfo("node", "server/server.js")
            {
                WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            };
            _server = Process.Start(psi);
            string logFile = Path.Combine(Log.Dir, "server.log");
            _server.OutputDataReceived += (_, e) => Append(logFile, e.Data);
            _server.ErrorDataReceived += (_, e) => Append(logFile, e.Data);
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            Log.Info($"Started the chat app (pid {_server.Id}) in {Root}.");
        }
        catch (Exception e)
        {
            Log.Error("Could not start node: " + e.Message);
            return "Could not start the chat app. Is Node.js installed? (https://nodejs.org, LTS version). Then try again.";
        }

        for (int i = 0; i < 40; i++)   // up to ~20 seconds
        {
            if (await IsUpAsync()) return null;
            if (_server.HasExited) return $"The chat app stopped right away (exit code {_server.ExitCode}). See server.log in the TrueDoF folder.";
            await Task.Delay(500);
        }
        return "The chat app did not answer within 20 seconds. See server.log in the TrueDoF folder.";
    }

    private static void Append(string file, string line)
    {
        if (line == null) return;
        try { File.AppendAllText(file, line + Environment.NewLine); } catch { }
    }

    public void Dispose()
    {
        try
        {
            if (_server != null && !_server.HasExited)
            {
                _server.Kill(entireProcessTree: true);
                Log.Info("Stopped the chat app.");
            }
        }
        catch (Exception e) { Log.Error("Stopping the chat app: " + e.Message); }
    }
}
