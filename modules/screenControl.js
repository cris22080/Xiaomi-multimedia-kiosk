// modules/screenControl.js
// Accende/spegne SOLO il monitor su Windows, lasciando il PC acceso e attivo.
// Per spegnere: WM_SYSCOMMAND / SC_MONITORPOWER
// Per riaccendere: combinazione di mouse movement + SetThreadExecutionState + input simulation

const { spawn } = require("child_process");

let schedulerTimer = null;
let lastState = null; // true = acceso, false = spento, null = sconosciuto

function setScreenPower(on) {
  if (process.platform !== "win32") {
    console.log(`[screenControl] (mock, non Windows) monitor -> ${on ? "ON" : "OFF"}`);
    lastState = on;
    return Promise.resolve();
  }

  if (on) {
    return wakeScreen();
  } else {
    return sleepScreen();
  }
}

function sleepScreen() {
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Native {
  [DllImport("user32.dll")]
  public static extern IntPtr PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
  public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
  public const int WM_SYSCOMMAND = 0x0112;
  public const int SC_MONITORPOWER = 0xF170;
}
"@
[Native]::PostMessage([Native]::HWND_BROADCAST, [Native]::WM_SYSCOMMAND, [IntPtr]::new(0xF170), [IntPtr]::new(2))
Start-Sleep -Milliseconds 100
`.trim();

  return executePS(psScript).then(() => {
    lastState = false;
  });
}

function wakeScreen() {
  // Per riaccendere usa multipli metodi:
  // 1. SetThreadExecutionState per prevenire sleep
  // 2. Simula un click del mouse
  // 3. Invia una keystroke
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Native {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
  public const uint ES_DISPLAY_REQUIRED = 0x00000002;
  public const uint ES_CONTINUOUS = 0x80000000;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
}
"@

# Prevent monitor sleep
[Native]::SetThreadExecutionState([Native]::ES_CONTINUOUS -bor [Native]::ES_DISPLAY_REQUIRED) | Out-Null

# Simulate mouse movement
[Native]::mouse_event([Native]::MOUSEEVENTF_MOVE, 0, 0, 0, [IntPtr]::Zero)

# Small delay
Start-Sleep -Milliseconds 200

# Send SPACE key via keyboard simulation
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys('{SPACE}')

Start-Sleep -Milliseconds 100
`.trim();

  return executePS(psScript).then(() => {
    lastState = true;
  });
}

function executePS(psScript) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stderr = "";
    let stdout = "";
    
    ps.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    
    ps.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ps.on("close", (code) => {
      if (code !== 0) {
        console.error("[screenControl] PowerShell error:", stderr || stdout);
        return reject(new Error(stderr || stdout || `PowerShell exit code ${code}`));
      }
      console.log("[screenControl] operazione completata");
      resolve();
    });

    ps.on("error", (err) => {
      console.error("[screenControl] spawn error:", err.message);
      reject(err);
    });
  });
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isWithinSchedule(onFrom, onTo) {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const from = timeToMinutes(onFrom);
  const to = timeToMinutes(onTo);

  if (from <= to) {
    return nowMin >= from && nowMin < to;
  }
  // fascia che attraversa la mezzanotte (es. 22:00 -> 02:00)
  return nowMin >= from || nowMin < to;
}

function startScheduler(cfg) {
  if (!cfg.enabled) return;

  function tick() {
    const shouldBeOn = isWithinSchedule(cfg.onFrom, cfg.onTo);
    if (shouldBeOn !== lastState) {
      setScreenPower(shouldBeOn).catch(() => {});
    }
  }

  tick();
  schedulerTimer = setInterval(tick, 60 * 1000); // controlla ogni minuto
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
}

module.exports = { setScreenPower, startScheduler, stopScheduler };
