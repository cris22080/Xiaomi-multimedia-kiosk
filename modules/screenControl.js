// modules/screenControl.js
// Su alcuni tablet Xiaomi SC_MONITORPOWER attiva Modern Standby e spegne la rete.
// Manteniamo quindi il display logicamente acceso, impostiamo la luminosità a 0
// e usiamo l'overlay nero del renderer. Quando l'app torna visibile la
// luminosità viene sempre impostata al 100%.

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
$brightness = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1
if ($brightness) {
  Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]0 } | Out-Null }
}
`.trim();

  return executePS(psScript).then(() => {
    lastState = false;
  });
}

function wakeScreen() {
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

Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]100 } | Out-Null }

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
      resolve(stdout.trim());
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

function startScheduler(cfg, onStateChange) {
  if (!cfg.enabled) return;

  function tick() {
    const shouldBeOn = isWithinSchedule(cfg.onFrom, cfg.onTo);
    if (shouldBeOn !== lastState) {
      setScreenPower(shouldBeOn).then(() => {
        if (typeof onStateChange === "function") onStateChange(shouldBeOn);
      }).catch(() => {});
    }
  }

  tick();
  schedulerTimer = setInterval(tick, 60 * 1000); // controlla ogni minuto
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
}

module.exports = { setScreenPower, startScheduler, stopScheduler };
