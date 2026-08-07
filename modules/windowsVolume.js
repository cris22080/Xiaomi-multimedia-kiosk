const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const audioApi = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, Guid context);
  int SetMasterVolumeLevelScalar(float level, Guid context);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public static class CozyDeskAudio {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    var iid = typeof(IAudioEndpointVolume).GUID;
    object endpoint;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
    return (IAudioEndpointVolume)endpoint;
  }

  public static int Get() {
    float level;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out level));
    return (int)Math.Round(level * 100);
  }

  public static void Set(int level) {
    var scalar = Math.Max(0, Math.Min(100, level)) / 100f;
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(scalar, Guid.Empty));
  }
}
'@
`;

async function run(command) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `${audioApi}\n${command}`
  ], { windowsHide: true });
  return stdout.trim();
}

async function get() {
  try {
    const volume = Number(await run("[CozyDeskAudio]::Get()"));
    if (!Number.isFinite(volume)) throw new Error("Livello audio non valido");
    return { success: true, volume };
  } catch (error) {
    console.error("[Volume] Errore lettura volume:", error.message);
    return { success: false, error: error.message, volume: 100 };
  }
}

async function set(level) {
  const volume = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  try {
    await run(`[CozyDeskAudio]::Set(${volume})`);
    return { success: true, volume };
  } catch (error) {
    console.error("[Volume] Errore impostazione volume:", error.message);
    return { success: false, error: error.message, volume };
  }
}

module.exports = { get, set };
