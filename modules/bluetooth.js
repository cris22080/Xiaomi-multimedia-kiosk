// Gestione dei dispositivi Bluetooth associati su Windows.
// Le operazioni vengono eseguite direttamente tramite PnP: non viene aperta
// la schermata di Windows e quindi non occorre confermare sul PC.

const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

const SYSTEM_DEVICE_PATTERN = /^(Microsoft Bluetooth|Intel\(R\) Wireless Bluetooth|Bluetooth Device \(RFCOMM Protocol TDI\)|Bluetooth LE Generic Attribute|Generic Bluetooth|Servizio|Enumeratore|Profilo|Trasporto|Gateway|Accesso|Rete|Identificazione|Attributo|Informazioni|Object|NAP|PSE|AVRCP)$/i;

function validateInstanceId(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId.trim() || instanceId.length > 512 || /[\r\n]/.test(instanceId)) {
    throw new Error('Identificativo del dispositivo Bluetooth non valido');
  }
  return instanceId.trim();
}

function instanceIdExpression(instanceId) {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(instanceId, 'utf8').toString('base64')}'))`;
}

async function runPowerShell(script) {
  return execFilePromise('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
}

/** Restituisce solo i dispositivi associati principali, non i profili BLE/servizi. */
async function getBluetoothDevices() {
  try {
    const { stdout } = await runPowerShell(`
      Get-PnpDevice -Class Bluetooth | Select-Object FriendlyName,Name,InstanceId,Status |
        ConvertTo-Json -Compress
    `);
    const entries = stdout.trim() ? JSON.parse(stdout) : [];
    const devices = Array.isArray(entries) ? entries : [entries];
    const seen = new Set();

    return devices
      .map((device) => ({
        name: String(device.FriendlyName || device.Name || '').trim(),
        instanceId: String(device.InstanceId || '').trim(),
        status: String(device.Status || 'Unknown')
      }))
      // BTHENUM\\DEV_ identifica la periferica associata. Le voci BTHLE e
      // BTHENUM\\{GUID} sono servizi/profili e non si possono amministrare.
      .filter((device) => /^BTHENUM\\DEV_/i.test(device.instanceId))
      .filter((device) => device.name && !SYSTEM_DEVICE_PATTERN.test(device.name))
      .filter((device) => {
        if (seen.has(device.instanceId)) return false;
        seen.add(device.instanceId);
        return true;
      });
  } catch (error) {
    console.error('[Bluetooth] Errore nel recupero dispositivi:', error.message);
    return [];
  }
}

async function setDeviceEnabled(instanceId, enabled) {
  const id = validateInstanceId(instanceId);
  const command = enabled ? 'Enable-PnpDevice' : 'Disable-PnpDevice';
  const action = enabled ? 'attivazione' : 'disattivazione';

  try {
    await runPowerShell(`
      $id = ${instanceIdExpression(id)}
      $device = Get-PnpDevice -InstanceId $id -ErrorAction Stop
      ${command} -InstanceId $device.InstanceId -Confirm:$false -ErrorAction Stop
    `);
    return {
      success: true,
      message: enabled
        ? 'Dispositivo attivato. Se è acceso e già associato, Windows lo riconnette senza richieste sul PC.'
        : 'Dispositivo disattivato dal telecomando.'
    };
  } catch (error) {
    console.error(`[Bluetooth] Errore ${action}:`, error.message);
    return { success: false, message: `Impossibile completare l'${action}: ${error.message}` };
  }
}

function connectBluetoothDevice(instanceId) {
  return setDeviceEnabled(instanceId, true);
}

function disconnectBluetoothDevice(instanceId) {
  return setDeviceEnabled(instanceId, false);
}

async function removeBluetoothDevice(instanceId) {
  try {
    const id = validateInstanceId(instanceId);
    const addressMatch = id.match(/(?:BTHENUM|BTHLE)\\DEV_([0-9A-F]{12})/i);
    if (!addressMatch) throw new Error('Impossibile ricavare l’indirizzo Bluetooth del dispositivo');
    const address = addressMatch[1];
    await runPowerShell(`
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct BLUETOOTH_ADDRESS { public UInt64 ullLong; }
public static class BluetoothNative {
  [DllImport("BluetoothAPIs.dll", SetLastError=true)]
  public static extern UInt32 BluetoothRemoveDevice(ref BLUETOOTH_ADDRESS address);
}
'@
      $address = New-Object BLUETOOTH_ADDRESS
      $address.ullLong = [Convert]::ToUInt64('${address}', 16)
      $result = [BluetoothNative]::BluetoothRemoveDevice([ref]$address)
      if ($result -ne 0) { throw "BluetoothRemoveDevice ha restituito $result" }
    `);
    return { success: true, message: 'Dispositivo rimosso con successo' };
  } catch (error) {
    console.error('[Bluetooth] Errore rimozione:', error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Reimposta l'associazione di una periferica visibile e la associa tramite le
 * API Bluetooth di Windows, senza aprire Impostazioni.
 */
async function pairBluetoothDevice(deviceName) {
  if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 100 || /[\r\n]/.test(deviceName)) {
    return { success: false, message: 'Nome del dispositivo Bluetooth non valido.' };
  }

  const encodedName = Buffer.from(deviceName.trim(), 'utf8').toString('base64');
  try {
    // Rimuove l'eventuale associazione PnP esistente con l'API Bluetooth nativa.
    const existing = await getBluetoothDevices();
    const previous = existing.find((device) => device.name.toLowerCase() === deviceName.trim().toLowerCase());
    if (previous) {
      const removed = await removeBluetoothDevice(previous.instanceId);
      if (!removed.success) return removed;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    const { stdout } = await runPowerShell(`
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
      function Await($winRtTask, $resultType) {
        $resultTypeName = $resultType.ToString().Trim('[', ']')
        $asTask = $asTaskGeneric.MakeGenericMethod([type]$resultTypeName)
        $netTask = $asTask.Invoke($null, @($winRtTask))
        $netTask.Wait()
        return $netTask.Result
      }
      [Windows.Devices.Bluetooth.BluetoothDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
      [Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime] | Out-Null
      $wanted = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))

      $unpairedSelector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($false)
      $available = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($unpairedSelector) | Await -resultType [Windows.Devices.Enumeration.DeviceInformationCollection]
      $device = $available | Where-Object { $_.Name -like "*$wanted*" } | Select-Object -First 1
      if (-not $device) { 'NotFound'; exit 0 }
      if (-not $device.Pairing.CanPair) { 'CannotPair'; exit 0 }
      ($device.Pairing.PairAsync() | Await -resultType [Windows.Devices.Enumeration.DevicePairingResult]).Status.ToString()
    `);
    const status = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (status === 'Paired' || status === 'AlreadyPaired') {
      return { success: true, message: `${deviceName} associato. Attendi alcuni secondi: l'uscita audio comparirà automaticamente.` };
    }
    if (status === 'NotFound') {
      return { success: false, message: `${deviceName} non è stato trovato. Verifica che resti in modalità pairing e riprova.` };
    }
    return { success: false, message: `Associazione non completata (${status || 'stato sconosciuto'}).` };
  } catch (error) {
    console.error('[Bluetooth] Errore associazione:', error.message);
    return { success: false, message: `Associazione non riuscita: ${error.message}` };
  }
}

module.exports = {
  getBluetoothDevices,
  connectBluetoothDevice,
  disconnectBluetoothDevice,
  removeBluetoothDevice,
  pairBluetoothDevice
};
