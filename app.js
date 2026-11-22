const STORAGE_KEY = "habit_agent_v1_state";
const DEFAULT_RULES = `- Keep at least 15 minutes free between scheduled events.
- Do not schedule heavy focus tasks before 8:00 AM or after 10:00 PM.
- Prefer short reading or light habits in the evening or between blocks.
- Never overlap with existing busy calendar events.`;

let state = loadState();
let gcalToken = null;
let tokenClient = null;
let tokenClientForId = "";
let isLocked = Boolean(state.pinHash);

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return {
    tasks: [],
    rules: DEFAULT_RULES,
    geminiKey: "",
    gcalClientId: "",
    pinHash: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
    dailyCompletions: {}
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function hashPin(pin) {
  const data = new TextEncoder().encode("habit_agent_pin:" + pin);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function applyLockUI() {
  const lockScreen = document.getElementById("lockScreen");
  const appHeader = document.getElementById("appHeader");
  const appMain = document.getElementById("appMain");
  const appNav = document.getElementById("appNav");

  if (state.pinHash && isLocked) {
    lockScreen.classList.remove("hidden");
    appHeader.classList.add("hidden");
    appMain.classList.add("hidden");
    appNav.classList.add("hidden");
    document.getElementById("pinInput").value = "";
    document.getElementById("lockError").textContent = "";
    setTimeout(() => document.getElementById("pinInput").focus(), 50);
  } else {
    lockScreen.classList.add("hidden");
    appHeader.classList.remove("hidden");
    appMain.classList.remove("hidden");
    appNav.classList.remove("hidden");
  }
  updatePinStatusLabel();
}

function updatePinStatusLabel() {
  const el = document.getElementById("pinStatusText");
  el.textContent = state.pinHash
    ? "PIN lock: Active (auto-locks when switching apps)"
    : "PIN lock: Off";
}

document.getElementById("unlockBtn").addEventListener("click", async () => {
  const pin = document.getElementById("pinInput").value.trim();
  const errEl = document.getElementById("lockError");
  if (!pin) {
    errEl.textContent = "Please enter your PIN.";
    return;
  }
  const digest = await hashPin(pin);
  if (digest === state.pinHash) {
    isLocked = false;
    errEl.textContent = "";
    applyLockUI();
  } else {
    errEl.textContent = "Incorrect PIN.";
  }
});

document.getElementById("pinInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("unlockBtn").click();
});

document.getElementById("lockNowBtn").addEventListener("click", () => {
  if (!state.pinHash) {
    alert("Set a PIN in the 'Rules & Keys' tab first.");
    return;
  }
  isLocked = true;
  applyLockUI();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.pinHash) {
    isLocked = true;
    applyLockUI();
  }
});

document.getElementById("savePinBtn").addEventListener("click", async () => {
  const pin = document.getElementById("newPinInput").value.trim();
  if (!/^\d{4,8}$/.test(pin)) {
    alert("Enter a 4 to 8 digit numeric PIN.");
    return;
  }
  state.pinHash = await hashPin(pin);
  isLocked = false;
  saveState();
  document.getElementById("newPinInput").value = "";
  updatePinStatusLabel();
  alert("PIN saved. It will lock automatically when you leave the app or tap Lock.");
});

document.getElementById("clearPinBtn").addEventListener("click", () => {
  state.pinHash = "";
  isLocked = false;
  saveState();
  updatePinStatusLabel();
  alert("PIN lock disabled.");
});

function logStatus(msg) {
  document.getElementById("agentLog").textContent = msg;
}

// Navigation tabs
document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "tab-stats") renderStats();
  });
});

// Add task
document.getElementById("addTaskBtn").addEventListener("click", () => {
  const input = document.getElementById("taskInput");
  const title = input.value.trim();
  if (!title) return;
  const durationMins = Math.max(5, Number(document.getElementById("taskMins").value) || 30);
  const area = document.getElementById("taskArea").value.trim() || "general";

  state.tasks.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    title,
    durationMins,
    area,
    done: false,
    scheduledSlot: null,
    createdAt: new Date().toISOString()
  });
  input.value = "";
  saveState();
  renderTasks();
});

function toggleTask(id) {
  const t = state.tasks.find((item) => item.id === id);
  if (!t) return;
  t.done = !t.done;
  const key = todayStr(0);
  const cur = state.dailyCompletions[key] || 0;
  state.dailyCompletions[key] = Math.max(0, cur + (t.done ? 1 : -1));
  saveState();
  renderTasks();
  renderStats();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((item) => item.id !== id);
  saveState();
  renderTasks();
}

function renderTasks() {
  const list = document.getElementById("taskList");
  if (!state.tasks.length) {
    list.innerHTML = `<div class="sub">No tasks yet. Add something above to start tracking.</div>`;
    return;
  }
  list.innerHTML = state.tasks
    .map(
      (t) => `
      <div class="task-item">
        <input type="checkbox" ${t.done ? "checked" : ""} onchange="toggleTask('${t.id}')" />
        <div style="flex: 1;">
          <div class="task-title ${t.done ? "done" : ""}">${escapeHtml(t.title)}</div>
          <div class="meta">
            <span class="pill">${escapeHtml(t.area)}</span>
            <span>${t.durationMins}m</span>
            ${t.scheduledSlot ? `<span class="pill ok">${escapeHtml(t.scheduledSlot)}</span>` : ""}
          </div>
        </div>
        <button class="danger" onclick="deleteTask('${t.id}')">Remove</button>
      </div>`
    )
    .join("");
}

function renderStats() {
  const total = Object.values(state.dailyCompletions).reduce((a, b) => a + b, 0);
  document.getElementById("totalDone").textContent = total;

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const count = state.dailyCompletions[todayStr(-i)] || 0;
    if (count > 0) streak++;
    else if (i > 0) break;
  }
  document.getElementById("streakDays").textContent = `${streak}d`;

  const bars = document.getElementById("weekBars");
  const rows = [];
  let maxVal = 1;
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = todayStr(-i);
    const val = state.dailyCompletions[d] || 0;
    if (val > maxVal) maxVal = val;
    last7.push({ d, val });
  }
  for (const item of last7) {
    const pct = Math.round((item.val / maxVal) * 100);
    rows.push(`
      <div class="bar-row">
        <span style="width: 78px; color: var(--muted);">${item.d.slice(5)}</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${pct}%;"></div></div>
        <span style="width: 24px; text-align: right;">${item.val}</span>
      </div>`);
  }
  bars.innerHTML = rows.join("");
}

async function callGemini(promptText, jsonMode = false) {
  if (!state.geminiKey) {
    throw new Error("Add your Gemini API key in the 'Rules & Keys' tab first.");
  }
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(state.geminiKey)}`;
  const body = {
    contents: [{ parts: [{ text: promptText }] }]
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: "application/json" };
  }
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Gemini API error: " + err);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Save & refine rules
document.getElementById("saveRulesBtn").addEventListener("click", () => {
  state.rules = document.getElementById("rulesInput").value;
  saveState();
  logStatus("Saved updated AI scheduling instructions.");
  alert("Instructions saved.");
});

document.getElementById("refineRulesBtn").addEventListener("click", async () => {
  const feedback = document.getElementById("feedbackInput").value.trim();
  const currentRules = document.getElementById("rulesInput").value;
  if (!feedback) {
    alert("Type what you want to change or fix in the feedback field first.");
    return;
  }
  const btn = document.getElementById("refineRulesBtn");
  btn.disabled = true;
  try {
    const prompt = `You are helping a user maintain concise, non-contradictory personal calendar scheduling rules.
Current rules:
${currentRules}

User feedback / adjustment:
${feedback}

Return ONLY the updated plain-text bulleted rules (starting each line with "- "). Preserve prior rules unless the user overrides or adjusts them.`;
    const updated = (await callGemini(prompt, false)).trim();
    if (updated) {
      document.getElementById("rulesInput").value = updated;
      state.rules = updated;
      document.getElementById("feedbackInput").value = "";
      saveState();
      logStatus("Refined scheduling rules with AI and saved them.");
      alert("Rules updated with AI.");
    }
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("saveKeysBtn").addEventListener("click", () => {
  state.geminiKey = document.getElementById("geminiKeyInput").value.trim();
  state.gcalClientId = document.getElementById("gcalClientIdInput").value.trim();
  state.timezone = document.getElementById("tzInput").value.trim() || state.timezone;
  saveState();
  tokenClient = null;
  tokenClientForId = "";
  alert("Saved keys and settings on this device.");
});

// Google Calendar OAuth (browser-only)
function ensureGoogleTokenClient() {
  if (!state.gcalClientId) {
    alert("Add your Google OAuth Client ID in the 'Rules & Keys' tab first.");
    return null;
  }
  if (!window.google?.accounts?.oauth2) {
    alert("Google Sign-In library is still loading. Wait 2 seconds and tap GCal again.");
    return null;
  }
  if (!tokenClient || tokenClientForId !== state.gcalClientId) {
    tokenClientForId = state.gcalClientId;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: state.gcalClientId,
      scope: "https://www.googleapis.com/auth/calendar.events",
      callback: (resp) => {
        if (resp.error) {
          logStatus("Google Calendar auth error: " + resp.error);
          return;
        }
        gcalToken = resp.access_token;
        document.getElementById("calStatus").textContent = "Calendar: Connected";
        logStatus("Connected to Google Calendar.");
      }
    });
  }
  return tokenClient;
}

document.getElementById("connectCalBtn").addEventListener("click", () => {
  const client = ensureGoogleTokenClient();
  if (client) client.requestAccessToken({ prompt: "" });
});

async function fetchUpcomingEvents() {
  if (!gcalToken) return [];
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", now.toISOString());
  url.searchParams.set("timeMax", later.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${gcalToken}` }
  });
  if (!res.ok) throw new Error("Failed to read Google Calendar events");
  const data = await res.json();
  return (data.items || []).map((ev) => ({
    summary: ev.summary || "Busy",
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date
  }));
}

async function createCalendarEvent(item) {
  if (!gcalToken) return;
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gcalToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: item.title,
      description: `Scheduled by HabitAgent (${item.area})`,
      start: { dateTime: item.startIso, timeZone: state.timezone },
      end: { dateTime: item.endIso, timeZone: state.timezone }
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error("Calendar insert failed: " + errText);
  }
}

// Gemini auto-scheduler
document.getElementById("scheduleBtn").addEventListener("click", async () => {
  const pending = state.tasks.filter((t) => !t.done && !t.scheduledSlot);
  if (!pending.length) {
    logStatus("No unscheduled pending tasks to place.");
    return;
  }
  if (!state.geminiKey) {
    alert("Add your Gemini API key in the 'Rules & Keys' tab first.");
    return;
  }

  const btn = document.getElementById("scheduleBtn");
  btn.disabled = true;
  logStatus("Reading calendar and asking Gemini for open slots...");

  try {
    const existingEvents = await fetchUpcomingEvents();
    const nowIso = new Date().toISOString();

    const prompt = `You are a personal calendar scheduling assistant.
Current time (ISO): ${nowIso}
User time zone: ${state.timezone}

User scheduling preferences & rules:
${state.rules}

Existing upcoming calendar events (do not overlap):
${JSON.stringify(existingEvents, null, 2)}

Tasks to schedule:
${JSON.stringify(
  pending.map((t) => ({ id: t.id, title: t.title, durationMins: t.durationMins, area: t.area })),
  null,
  2
)}

Return ONLY a valid JSON array of objects with keys:
- "id": matching task id
- "title": string
- "area": string
- "startIso": ISO-8601 timestamp with offset for ${state.timezone}
- "endIso": ISO-8601 timestamp with offset for ${state.timezone}
- "label": short human-readable slot label like "Mon 7:30 PM"`;

    const text = await callGemini(prompt, true);
    const placements = JSON.parse(text || "[]");

    let placedCount = 0;
    for (const p of placements) {
      const task = state.tasks.find((t) => t.id === p.id);
      if (!task) continue;
      if (gcalToken && p.startIso && p.endIso) {
        await createCalendarEvent({
          title: p.title || task.title,
          area: p.area || task.area,
          startIso: p.startIso,
          endIso: p.endIso
        });
      }
      task.scheduledSlot = p.label || (p.startIso ? p.startIso.slice(0, 16).replace("T", " ") : "Scheduled");
      placedCount++;
    }

    saveState();
    renderTasks();
    logStatus(
      `Scheduled ${placedCount} task(s)${gcalToken ? " onto Google Calendar" : " locally (connect Google Calendar to push events)"}.`
    );
  } catch (err) {
    logStatus(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
});

// Backup / Restore JSON
document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `habit-agent-backup-${todayStr(0)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importTriggerBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const parsed = JSON.parse(await file.text());
  state = { ...state, ...parsed };
  isLocked = Boolean(state.pinHash);
  saveState();
  hydrateInputs();
  renderTasks();
  renderStats();
  applyLockUI();
  alert("Imported backup.");
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hydrateInputs() {
  document.getElementById("rulesInput").value = state.rules || DEFAULT_RULES;
  document.getElementById("geminiKeyInput").value = state.geminiKey || "";
  document.getElementById("gcalClientIdInput").value = state.gcalClientId || "";
  document.getElementById("tzInput").value = state.timezone || "Asia/Kolkata";
  updatePinStatusLabel();
}

hydrateInputs();
renderTasks();
renderStats();
applyLockUI();
