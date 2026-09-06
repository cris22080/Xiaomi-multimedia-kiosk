    const socket = io();
    const statusEl = document.getElementById("status");
    const iptvCategoriesEl = document.getElementById("iptvCategories");
    let feedbackTimer;
    function feedback(message) {
      const toast = document.getElementById('remoteFeedback');
      toast.textContent = message;
      toast.classList.add('visible');
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
    }
    function send(event, payload, volatile = false) {
      if (!socket.connected) { if (!volatile) feedback('Telecomando scollegato. Attendi la riconnessione.'); return false; }
      (volatile ? socket.volatile : socket).emit(event, payload);
      return true;
    }

    let currentVolume = 100;
    let isMuted = false;
    let previousVolume = 50;
    let volumeRequest = Promise.resolve();
    let currentPlayingChannel = null;
    let mouseLargeStep = false;

    socket.on("connect", () => {
      statusEl.textContent = "Connesso allo Xiaomi";
      statusEl.classList.remove("offline");
    });

    socket.on("disconnect", () => {
      statusEl.textContent = "Non connesso";
      statusEl.classList.add("offline");
      stopPointer();
    });

    socket.on("state", (s) => {
      if (!socket.connected) return;
      statusEl.textContent = s.online ? 'Connesso allo Xiaomi' : 'Connesso · senza internet';
      statusEl.classList.remove("offline");
      ['screenOn', 'screenOff'].forEach((id) => {
        const active = id === 'screenOn' ? s.screenOn === true : s.screenOn === false;
        document.getElementById(id).classList.toggle('active', active);
        document.getElementById(id).setAttribute('aria-pressed', active);
      });
      ['cozyOn', 'cozyOff'].forEach((id) => document.getElementById(id).classList.toggle('active', id === 'cozyOn' ? s.cozyActive === true : s.cozyActive === false));
      document.getElementById('screenState').textContent = s.screenOn === true ? 'Acceso' : s.screenOn === false ? 'Spento' : '—';
      document.getElementById('cozyState').textContent = s.cozyActive ? 'Cozy View' : 'Home / altre viste';
      currentPlayingChannel = s.playingChannel?.name || null;
      document.getElementById('currentChannel').textContent = currentPlayingChannel || 'Nessun canale attivo';
      document.querySelectorAll('.channel-btn').forEach((button) => button.classList.toggle('playing', button.dataset.url === s.playingChannel?.url));
    });

    // Load IPTV categories with dropdowns
    fetch("/iptv/config").then(r => r.json()).then(config => {
      if (config && config.categories) {
        iptvCategoriesEl.replaceChildren(...config.categories.map((cat, catIndex) => {
          const category = document.createElement('div'); category.className = 'category';
          const title = document.createElement('button'); title.className = 'category-title';
          const name = document.createElement('span'); name.textContent = cat.name;
          const arrow = document.createElement('span'); arrow.className = 'category-title-arrow'; arrow.textContent = '›';
          title.append(name, arrow); title.setAttribute('aria-expanded', 'false');
          title.onclick = () => toggleCategory(catIndex);
          const content = document.createElement('div'); content.className = 'category-content'; content.id = `category-${catIndex}`;
          title.setAttribute('aria-controls', content.id);
          (cat.channels || []).forEach((channel) => {
            const button = document.createElement('button'); button.className = 'channel-btn'; button.textContent = channel.name;
            button.dataset.url = channel.url;
            button.onclick = () => playChannel(channel.url, channel.name, channel.type || 'hls', button);
            content.append(button);
          });
          category.append(title, content); return category;
        }));

        // Open first category by default
        setTimeout(() => toggleCategory(0), 100);
      }
    }).catch(() => { iptvCategoriesEl.innerHTML = '<div class="empty-state">Canali non disponibili. Ricarica il telecomando.</div>'; });

    window.toggleCategory = (index) => {
      const title = document.querySelectorAll('.category-title')[index];
      const content = document.getElementById(`category-${index}`);
      if (title && content) {
        const isOpen = title.classList.toggle('open');
        title.setAttribute('aria-expanded', isOpen);
        content.classList.toggle('open', isOpen);
      }
    };

    window.playChannel = (url, name, type, btnElement) => {
      if (!send('playIPTV', { url, name, type })) return;
      // Update UI to show playing state
      document.querySelectorAll('.channel-btn').forEach(btn => btn.classList.remove('playing'));
      if (btnElement) btnElement.classList.add('playing');
      currentPlayingChannel = name;

      document.getElementById('currentChannel').textContent = `Apertura di ${name}…`;
    };

    function sendMouseCommand(command) {
      const commands = {
        up: { type: "move", dx: 0, dy: -1 },
        down: { type: "move", dx: 0, dy: 1 },
        left: { type: "move", dx: -1, dy: 0 },
        right: { type: "move", dx: 1, dy: 0 },
        click: { type: "click" },
        scrollUp: { type: "scroll", dy: 1 },
        scrollDown: { type: "scroll", dy: -1 }
      };
      if (command === "large") {
        mouseLargeStep = !mouseLargeStep;
        document.querySelector('[data-mouse="large"]').classList.toggle("active", mouseLargeStep);
        document.querySelector('[data-mouse="large"]').setAttribute('aria-pressed', mouseLargeStep);
        return;
      }
      if (commands[command]) send('remoteMouse', { ...commands[command], large: mouseLargeStep }, command !== 'click');
    }

    let repeatTimer = null;
    let pointer = null;
    function stopPointer() { clearInterval(repeatTimer); repeatTimer = null; pointer = null; }
    window.addEventListener('blur', stopPointer);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPointer(); });
    document.querySelectorAll("[data-mouse]").forEach((button) => {
      const command = button.dataset.mouse;
      const start = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        stopPointer();
        button.setPointerCapture(event.pointerId);
        sendMouseCommand(command);
        if (["up", "down", "left", "right"].includes(command)) {
          repeatTimer = setInterval(() => sendMouseCommand(command), 110);
        }
      };
      const stop = () => {
        if (repeatTimer) clearInterval(repeatTimer);
        repeatTimer = null;
      };
      button.addEventListener("pointerdown", start);
      button.addEventListener("pointerup", stop);
      button.addEventListener("pointercancel", stop);
      button.addEventListener('lostpointercapture', stop);
      button.addEventListener('click', (event) => { if (event.detail === 0) sendMouseCommand(command); });
    });

    const touchpad = document.getElementById('touchpad');
    touchpad.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || pointer) return;
      event.preventDefault(); touchpad.setPointerCapture(event.pointerId);
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, start: Date.now() };
    });
    touchpad.addEventListener('pointermove', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      pointer.distance += Math.abs(dx) + Math.abs(dy);
      pointer.x = event.clientX; pointer.y = event.clientY;
      send('remoteMouse', { type: 'moveRelative', dx: dx * 2.4, dy: dy * 2.4 }, true);
    });
    touchpad.addEventListener('pointerup', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (pointer.distance < 8 && Date.now() - pointer.start < 500) send('remoteMouse', { type: 'click' });
      pointer = null;
    });
    touchpad.addEventListener('pointercancel', stopPointer);
    touchpad.addEventListener('lostpointercapture', stopPointer);
    touchpad.addEventListener('keydown', (event) => {
      const command = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'click', ' ': 'click' }[event.key];
      if (command) { event.preventDefault(); sendMouseCommand(command); }
    });
    touchpad.addEventListener('wheel', (event) => {
      event.preventDefault(); send('remoteMouse', { type: 'scroll', dy: -Math.sign(event.deltaY) }, true);
    }, { passive: false });
    document.querySelectorAll('[data-browser]').forEach((button) => button.onclick = () => send('remoteBrowser', { type: button.dataset.browser }));
    document.querySelectorAll('[data-key]').forEach((button) => button.onclick = () => send('remoteBrowser', { type: 'key', key: button.dataset.key }));
    document.getElementById('closeIPTV').onclick = () => send('closeIPTV');

    document.getElementById("cozyOn").onclick = () => send("toggleCozy", true);
    document.getElementById("cozyOff").onclick = () => send("toggleCozy", false);
    document.getElementById("screenOn").onclick = () => send("screenPower", true);
    document.getElementById("screenOff").onclick = () => send("screenPower", false);

    // Volume Control
    const volumeSlider = document.getElementById("volumeSlider");
    const volumeLabel = document.getElementById("volumeLabel");
    const volumeIcon = document.getElementById("volumeIcon");
    const volumeMuteBtn = document.getElementById("volumeMute");

    // Initialize volume to max (100%)
    async function initVolume() {
      try {
        const response = await fetch("/volume/get");
        const data = await response.json();
        if (data.success) {
          currentVolume = data.volume;
          isMuted = currentVolume === 0;
          if (currentVolume > 0) previousVolume = currentVolume;
          volumeSlider.value = currentVolume;
          volumeLabel.textContent = currentVolume + "%";
          volumeMuteBtn.textContent = isMuted ? 'Riattiva audio' : 'Muto';
          updateVolumeIcon();
        }
      } catch (err) {
        console.error("Errore inizializzazione volume:", err);
        // Default to 100%
        currentVolume = 100;
        volumeSlider.value = 100;
        volumeLabel.textContent = "100%";
        updateVolumeIcon();
        feedback('Volume non disponibile. Nessuna modifica inviata.');
      }
    }

    function updateVolumeIcon() {
      if (isMuted || currentVolume === 0) {
        volumeIcon.textContent = "—";
      } else if (currentVolume < 30) {
        volumeIcon.textContent = "♪";
      } else if (currentVolume < 70) {
        volumeIcon.textContent = "♪";
      } else {
        volumeIcon.textContent = "♪";
      }
    }

    async function setVolume(level) {
      if (level > 0) previousVolume = level;
      try {
        const response = await fetch("/volume/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level })
        });
        const data = await response.json();
        if (data.success) {
          currentVolume = data.volume;
          volumeSlider.value = currentVolume;
          volumeLabel.textContent = currentVolume + "%";
          isMuted = currentVolume === 0;
          volumeMuteBtn.textContent = isMuted ? 'Riattiva audio' : 'Muto';
          updateVolumeIcon();
        } else {
          feedback(data.error || 'Impossibile modificare il volume.');
        }
      } catch (err) {
        console.error("Errore impostazione volume:", err);
        feedback('Xiaomi non raggiungibile. Volume non modificato.');
      }
    }

    volumeSlider.addEventListener("input", (e) => {
      const vol = parseInt(e.target.value);
      volumeLabel.textContent = vol + "%";
      currentVolume = vol;
      isMuted = vol === 0;
      volumeMuteBtn.textContent = isMuted ? 'Riattiva audio' : 'Muto';
      updateVolumeIcon();
    });

    volumeSlider.addEventListener("change", (e) => {
      const requested = parseInt(e.target.value);
      volumeRequest = volumeRequest.then(() => setVolume(requested));
    });

    volumeMuteBtn.onclick = () => {
      if (isMuted) {
        volumeRequest = volumeRequest.then(() => setVolume(previousVolume));
      } else {
        if (currentVolume > 0) previousVolume = currentVolume;
        volumeRequest = volumeRequest.then(() => setVolume(0));
      }
    };

    // Alarm management
    const alarmForm = document.getElementById("alarmForm");
    const alarmList = document.getElementById("alarmList");
    const remoteAlarmStop = document.getElementById("remoteAlarmStop");
    const remoteAlarmOverlay = document.getElementById("remoteAlarmOverlay");
    const remoteAlarmTime = document.getElementById("remoteAlarmTime");
    const remoteAlarmOverlayStop = document.getElementById("remoteAlarmOverlayStop");
    const dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

    function renderAlarms(alarms) {
      alarmList.replaceChildren(...alarms.map((alarm) => {
        const item = document.createElement("div");
        item.className = "alarm-item";
        const time = document.createElement("div");
        time.className = "alarm-item-time";
        time.textContent = alarm.time;
        const meta = document.createElement("div");
        meta.className = "alarm-item-meta";
        meta.textContent = `${alarm.days.sort().map((day) => dayNames[day]).join(" · ")}\n${alarm.motif} · ${alarm.volume}%`;
        const remove = document.createElement("button");
        remove.className = "btn danger";
        remove.textContent = "Elimina";
        remove.addEventListener("click", async () => {
          await fetch(`/alarms/${encodeURIComponent(alarm.id)}`, { method: "DELETE" });
          loadAlarms();
        });
        item.append(time, meta, remove);
        return item;
      }));
      if (!alarms.length) alarmList.innerHTML = '<div class="empty-state">Nessuna sveglia programmata</div>';
    }

    async function loadAlarms() {
      try {
        const data = await fetch("/alarms").then((response) => response.json());
        renderAlarms(data.alarms || []);
      } catch (error) {
        alarmList.innerHTML = '<div class="empty-state">Impossibile caricare le sveglie</div>';
      }
    }

    alarmForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const days = [...alarmForm.querySelectorAll('.alarm-days input:checked')].map((input) => Number(input.value));
      const alarm = {
        time: document.getElementById("alarmTimeInput").value,
        motif: document.getElementById("alarmMotifInput").value,
        volume: Number(document.getElementById("alarmVolumeInput").value),
        days
      };
      const response = await fetch("/alarms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(alarm) });
      const data = await response.json();
      if (!response.ok) return alert(data.error || "Impossibile salvare la sveglia");
      renderAlarms(data.alarms || []);
    });

    async function stopRemoteAlarm() {
      await fetch("/alarms/stop", { method: "POST" });
      remoteAlarmStop.style.display = "none";
      remoteAlarmOverlay.classList.remove("active");
    }
    remoteAlarmStop.addEventListener("click", stopRemoteAlarm);
    remoteAlarmOverlayStop.addEventListener("click", stopRemoteAlarm);

    async function refreshAlarmState() {
      try {
        const state = await fetch("/state").then((response) => response.json());
        const active = state.activeAlarm;
        remoteAlarmStop.style.display = active ? "block" : "none";
        remoteAlarmOverlay.classList.toggle("active", Boolean(active));
        if (active) remoteAlarmTime.textContent = active.time || "--:--";
      } catch (_) {}
    }
    setInterval(refreshAlarmState, 2000);
    refreshAlarmState();

    socket.on("state", (state) => {
      remoteAlarmStop.style.display = state.activeAlarm ? "block" : "none";
    });

    document.getElementById("shutdownApp").onclick = () => {
      if (confirm("Chiudere l'app? Non potrai riaprirla da qui.")) {
        send("shutdownApp");
      }
    };

    // Initialize
    initVolume();
    loadAlarms();
