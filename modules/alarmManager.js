const Store = require('electron-store');

const store = new Store({ name: 'alarms', defaults: { alarms: [] } });
let timer = null;
let onTrigger = null;
let activeAlarm = null;
let lastMinuteKey = '';

const motifs = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'calm', label: 'Calma' }
];

function list() {
  return store.get('alarms', []).map(({ lastTriggered, ...alarm }) => alarm);
}

function validateAlarm(input) {
  const time = typeof input.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ? input.time : null;
  if (!time) throw new Error('Orario non valido');
  const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : [];
  if (!days.length) throw new Error('Seleziona almeno un giorno');
  const volume = Math.max(0, Math.min(100, Math.round(Number(input.volume))));
  if (!Number.isFinite(volume)) throw new Error('Volume non valido');
  const motif = motifs.some((item) => item.id === input.motif) ? input.motif : 'aurora';
  return { time, days, volume, motif, enabled: input.enabled !== false };
}

function save(input) {
  const alarm = validateAlarm(input);
  const alarms = store.get('alarms', []);
  if (input.id) {
    const index = alarms.findIndex((item) => item.id === input.id);
    if (index === -1) throw new Error('Sveglia non trovata');
    alarms[index] = { ...alarms[index], ...alarm };
  } else {
    alarms.push({ id: `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...alarm });
  }
  store.set('alarms', alarms);
  return list();
}

function remove(id) {
  store.set('alarms', store.get('alarms', []).filter((alarm) => alarm.id !== id));
  return list();
}

function stop() {
  activeAlarm = null;
  return { success: true };
}

function getActive() {
  return activeAlarm;
}

function tick() {
  if (activeAlarm) return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${time}`;
  if (minuteKey === lastMinuteKey) return;
  lastMinuteKey = minuteKey;
  const alarm = store.get('alarms', []).find((item) => item.enabled && item.time === time && item.days.includes(now.getDay()));
  if (!alarm) return;
  activeAlarm = { ...alarm, triggeredAt: Date.now() };
  if (typeof onTrigger === 'function') onTrigger(activeAlarm);
}

function start(callback) {
  onTrigger = callback;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 1000);
  tick();
}

module.exports = { motifs, list, save, remove, stop, getActive, start };
