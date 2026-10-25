$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($args.Count -ne 0) { throw 'The folder picker accepts no paths or commands.' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class CompanionProjectFolderPicker {
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    public static DialogResult Show(FolderBrowserDialog picker) {
        using (var owner = new Form()) {
            owner.Text = "Companion \u2014 Choose project folder";
            owner.ShowInTaskbar = true;
            owner.FormBorderStyle = FormBorderStyle.FixedDialog;
            owner.StartPosition = FormStartPosition.CenterScreen;
            owner.ClientSize = new Size(480, 138);
            owner.MaximizeBox = false;
            owner.MinimizeBox = false;
            owner.BackColor = Color.White;
            var explanation = new Label();
            explanation.Text = "Choose a project folder in the dialog. Companion and connected AI tools can read and save requested text edits there. Cancel to leave access unchanged.";
            explanation.Location = new Point(20, 20);
            explanation.Size = new Size(440, 94);
            explanation.ForeColor = Color.Black;
            owner.Controls.Add(explanation);
            DialogResult result = DialogResult.Cancel;
            Exception failure = null;
            owner.Shown += delegate {
                owner.BeginInvoke(new Action(delegate {
                    if (owner.IsDisposed) return;
                    try { result = picker.ShowDialog(owner); }
                    catch (Exception error) { failure = error; }
                    finally { owner.Close(); }
                }));
            };
            // A console-hidden Node launch sets STARTUPINFO's first show state to
            // SW_HIDE. Consume it before explicitly showing our own chooser UI.
            ShowWindow(owner.Handle, 0);
            ShowWindow(owner.Handle, 0);
            owner.Show();
            ShowWindow(owner.Handle, 1);
            owner.Activate();
            Application.Run(owner);
            if (failure != null) throw failure;
            return result;
        }
    }
}
'@
$picker = [System.Windows.Forms.FolderBrowserDialog]::new()
try {
    $picker.Description = 'Choose a project folder. Companion and connected AI tools may read text files and save requested reversible edits here.'
    $picker.ShowNewFolderButton = $false
    $picker.RootFolder = [Environment+SpecialFolder]::MyComputer
    if ([CompanionProjectFolderPicker]::Show($picker) -eq [System.Windows.Forms.DialogResult]::OK) {
        @{ path = $picker.SelectedPath } | ConvertTo-Json -Compress
    } else { '{"cancelled":true}' }
} finally { $picker.Dispose() }
