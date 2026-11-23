using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TrueDoF.Overlay;

/// <summary>The overlay window: the chat page in a WebView2, kept on top, toggled with F9.</summary>
public sealed class OverlayForm : Form
{
    private const int HotkeyId = 0x7D0F;
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_NOREPEAT = 0x4000;
    private const uint VK_F9 = 0x78;

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label _status = new()
    {
        Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 11f),
        Text = "Starting your Director…", Padding = new Padding(24),
    };
    private readonly ServerLauncher _server = new();
    private readonly bool _startHidden;
    private readonly OverlaySettings _settings = OverlaySettings.Load();
    private bool _hotkey;

    public OverlayForm(bool startHidden)
    {
        _startHidden = startHidden;
        Text = "TrueDoF Director  (F9 shows / hides)";
        TopMost = true;
        ShowInTaskbar = true;
        MinimumSize = new Size(340, 380);
        StartPosition = FormStartPosition.Manual;
        Bounds = _settings.Bounds();
        BackColor = Color.FromArgb(24, 26, 31);
        _status.ForeColor = Color.Gainsboro;
        Controls.Add(_web);
        Controls.Add(_status);

        // See-through while you work in FM, solid while you type here.
        Activated += (_, _) => Opacity = 1.0;
        Deactivate += (_, _) => Opacity = Math.Clamp(_settings.UnfocusedOpacity, 0.3, 1.0);
        ResizeEnd += (_, _) => _settings.Remember(this);
        Move += (_, _) => { if (WindowState == FormWindowState.Normal) _settings.Remember(this); };
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _hotkey = RegisterHotKey(Handle, HotkeyId, MOD_NOREPEAT, VK_F9);
        if (!_hotkey)
        {
            Log.Error("F9 could not be registered (another program uses it).");
            Text = "TrueDoF Director  (F9 is taken by another program)";
        }
        if (_startHidden) Hide();
        await StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            string problem = await _server.EnsureRunningAsync();
            if (problem != null) { ShowProblem(problem); return; }

            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Log.Dir, "overlay-webview"));
            await _web.EnsureCoreWebView2Async(env);
            _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            // Links to other sites (e.g. nodejs.org in a message) open in your normal browser, not in the overlay.
            _web.CoreWebView2.NewWindowRequested += (_, a) => { a.Handled = true; OpenInBrowser(a.Uri); };
            _web.CoreWebView2.NavigationStarting += (_, a) =>
            {
                if (!a.Uri.StartsWith(_server.Url, StringComparison.OrdinalIgnoreCase)) { a.Cancel = true; OpenInBrowser(a.Uri); }
            };
            _web.CoreWebView2.Navigate(_server.Url + "?compact=1");
            _status.Visible = false;
            _web.Visible = true;
            Log.Info("Overlay ready.");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowProblem("Microsoft Edge WebView2 Runtime is missing. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start the overlay again.");
        }
        catch (Exception ex)
        {
            Log.Error("Start failed: " + ex);
            ShowProblem("Could not start: " + ex.Message);
        }
    }

    private void ShowProblem(string message)
    {
        Log.Error(message);
        _status.Text = message;
        _status.Visible = true;
        _web.Visible = false;
        if (!Visible) Show();
    }

    private static void OpenInBrowser(string uri)
    {
        try
        {
            if (Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.ToString()) { UseShellExecute = true });
        }
        catch { }
    }

    /// <summary>F9: show and focus the overlay; if it already has focus, hide it.</summary>
    private void Toggle()
    {
        if (Visible && WindowState != FormWindowState.Minimized && ContainsFocus)
        {
            Hide();
            return;
        }
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        TopMost = true;
        Activate();
        SetForegroundWindow(Handle);   // allowed: we just received our own hotkey
        if (_web.Visible && _web.CoreWebView2 != null)
        {
            _web.Focus();
            _ = _web.CoreWebView2.ExecuteScriptAsync("document.getElementById('input') && document.getElementById('input').focus()");
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && (int)m.WParam == HotkeyId) { Toggle(); return; }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _settings.Remember(this);
        _settings.Save();
        if (_hotkey) UnregisterHotKey(Handle, HotkeyId);
        _server.Dispose();
        base.OnFormClosing(e);
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
}

/// <summary>Where the overlay was and how big (overlay.json in the TrueDoF folder).</summary>
public sealed class OverlaySettings
{
    public int X { get; set; } = -1;
    public int Y { get; set; } = -1;
    public int Width { get; set; } = 460;
    public int Height { get; set; } = 720;
    public double UnfocusedOpacity { get; set; } = 0.85;

    private static string File => Path.Combine(Log.Dir, "overlay.json");

    public static OverlaySettings Load()
    {
        try { if (System.IO.File.Exists(File)) return JsonSerializer.Deserialize<OverlaySettings>(System.IO.File.ReadAllText(File)) ?? new(); }
        catch (Exception e) { Log.Error("overlay.json unreadable, using defaults: " + e.Message); }
        return new OverlaySettings();
    }

    public void Save()
    {
        try { Directory.CreateDirectory(Log.Dir); System.IO.File.WriteAllText(File, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true })); }
        catch (Exception e) { Log.Error("Could not save overlay.json: " + e.Message); }
    }

    public void Remember(Form f)
    {
        if (f.WindowState != FormWindowState.Normal) return;
        X = f.Left; Y = f.Top; Width = f.Width; Height = f.Height;
    }

    /// <summary>The saved place, if it is still on a screen; otherwise the right edge of the main screen.</summary>
    public Rectangle Bounds()
    {
        var r = new Rectangle(X, Y, Math.Max(340, Width), Math.Max(380, Height));
        if (X >= -10000 && Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r) && X != -1)) return r;
        var wa = Screen.PrimaryScreen.WorkingArea;
        return new Rectangle(wa.Right - r.Width - 16, wa.Top + 60, r.Width, Math.Min(r.Height, wa.Height - 80));
    }
}
