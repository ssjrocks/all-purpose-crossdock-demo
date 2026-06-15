const API_BASE = "";
const LAST_DRIVER_KEY = "apt-crossdock-last-driver";
const FORKLIFT_OPERATORS = ["Alex", "Ben", "Chris", "Sam"];
const AUTH_TOKEN_KEY = "apt-crossdock-auth-token";
let notificationAudioContext = null;

async function armNotificationAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!notificationAudioContext) notificationAudioContext = new AudioContextClass();
    if (notificationAudioContext.state === "suspended") await notificationAudioContext.resume();
    return notificationAudioContext.state === "running";
  } catch {
    return false;
  }
}

async function playMessageAlert() {
  if (!(await armNotificationAudio())) return;
  [0, 230, 460].forEach((delay, index) => {
    setTimeout(() => {
      const oscillator = notificationAudioContext.createOscillator();
      const gain = notificationAudioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(index === 1 ? 920 : 760, notificationAudioContext.currentTime);
      gain.gain.setValueAtTime(0.0001, notificationAudioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.28, notificationAudioContext.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, notificationAudioContext.currentTime + 0.16);
      oscillator.connect(gain);
      gain.connect(notificationAudioContext.destination);
      oscillator.start();
      oscillator.stop(notificationAudioContext.currentTime + 0.18);
    }, delay);
  });
  if (navigator.vibrate) navigator.vibrate([180, 80, 180]);
}

document.addEventListener("pointerdown", armNotificationAudio, { once: true });
document.addEventListener("keydown", armNotificationAudio, { once: true });

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `arrival-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function requestJson(url, options = {}) {
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

async function login(role, username, password) {
  const result = await requestJson(`${API_BASE}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ role, username, password })
  });
  sessionStorage.setItem(AUTH_TOKEN_KEY, result.token);
  return result.user;
}

async function currentUser() {
  try {
    const result = await requestJson(`${API_BASE}/api/auth/me`);
    return result.user;
  } catch {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    return null;
  }
}

async function logout() {
  try {
    await requestJson(`${API_BASE}/api/auth/logout`, { method: "POST", body: "{}" });
  } finally {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

async function heartbeat() {
  return requestJson(`${API_BASE}/api/auth/heartbeat`, { method: "POST", body: "{}" });
}

async function loadStatistics() {
  return requestJson(`${API_BASE}/api/statistics`);
}

async function changePassword(password) {
  const result = await requestJson(`${API_BASE}/api/auth/change-password`, {
    method: "POST",
    body: JSON.stringify({ password })
  });
  return result.user;
}

async function confirmManagerPassword(password) {
  return requestJson(`${API_BASE}/api/auth/confirm-manager`, {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

async function clearQueue(password) {
  return requestJson(`${API_BASE}/api/admin/clear-queue`, {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

async function loadArrivals() {
  return requestJson(`${API_BASE}/api/arrivals`);
}

async function saveArrivals(arrivals) {
  return requestJson(`${API_BASE}/api/arrivals`, {
    method: "PUT",
    body: JSON.stringify(arrivals)
  });
}

function formatTime(value) {
  if (!value) return "Not called yet";
  return new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function cleanPhone(phone) {
  return phone.replace(/[^\d+]/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function addArrival(arrival) {
  const item = {
    id: createId(),
    status: "waiting",
    arrivedAt: new Date().toISOString(),
    calledAt: null,
    ...arrival
  };

  await requestJson(`${API_BASE}/api/arrivals`, {
    method: "POST",
    body: JSON.stringify(item)
  });

  localStorage.setItem(LAST_DRIVER_KEY, item.id);
  window.dispatchEvent(new Event("apt-crossdock-updated"));
  return item;
}

async function updateArrival(id, updates) {
  return requestJson(`${API_BASE}/api/arrivals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
}

async function setArrivalStatus(id, status, updates = {}) {
  return updateArrival(id, { status, ...updates });
}

async function assignForkliftOperator(id, operatorName, actedBy = "") {
  return updateArrival(id, { forkliftOperator: operatorName, actedBy });
}

async function removeArrival(id, actedBy = "Manager") {
  return requestJson(`${API_BASE}/api/arrivals/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ actedBy })
  });
}

async function loadTasks() {
  return requestJson(`${API_BASE}/api/tasks`);
}

async function createTask(task) {
  const item = {
    id: createId(),
    status: "open",
    suggestedOperator: "",
    activeOperator: "",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...task
  };
  return requestJson(`${API_BASE}/api/tasks`, {
    method: "POST",
    body: JSON.stringify(item)
  });
}

async function updateTask(id, updates) {
  return requestJson(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
}

async function removeTask(id) {
  return requestJson(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

async function loadMessages() {
  return requestJson(`${API_BASE}/api/messages`);
}

async function loadHistory() {
  return requestJson(`${API_BASE}/api/history`);
}

async function sendMessage(message) {
  const item = {
    id: createId(),
    createdAt: new Date().toISOString(),
    acknowledgedAt: null,
    ...message
  };
  return requestJson(`${API_BASE}/api/messages`, {
    method: "POST",
    body: JSON.stringify(item)
  });
}

async function acknowledgeMessage(id, acknowledgedBy) {
  return requestJson(`${API_BASE}/api/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy
    })
  });
}

async function removeMessage(id) {
  return requestJson(`${API_BASE}/api/messages/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

async function loadLocalDrivers() {
  return requestJson(`${API_BASE}/api/local-drivers`);
}

async function createLocalDriver(driver) {
  return requestJson(`${API_BASE}/api/local-drivers`, {
    method: "POST",
    body: JSON.stringify(driver)
  });
}

async function updateLocalDriver(driverNumber, updates) {
  return requestJson(`${API_BASE}/api/local-drivers/${encodeURIComponent(driverNumber)}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
}

async function removeLocalDriver(driverNumber) {
  return requestJson(`${API_BASE}/api/local-drivers/${encodeURIComponent(driverNumber)}`, {
    method: "DELETE"
  });
}

async function refreshForkliftOperators() {
  const operators = await requestJson(`${API_BASE}/api/forklift-operators`);
  FORKLIFT_OPERATORS.splice(0, FORKLIFT_OPERATORS.length, ...operators.map((operator) => operator.name));
  return FORKLIFT_OPERATORS;
}

async function createForkliftOperator(name) {
  return requestJson(`${API_BASE}/api/forklift-operators`, {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

async function updateForkliftOperator(currentName, name) {
  return requestJson(`${API_BASE}/api/forklift-operators/${encodeURIComponent(currentName)}`, {
    method: "PATCH",
    body: JSON.stringify({ name })
  });
}

async function resetForkliftOperatorPassword(name) {
  return requestJson(`${API_BASE}/api/forklift-operators/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ resetPassword: true })
  });
}

async function removeForkliftOperator(name) {
  return requestJson(`${API_BASE}/api/forklift-operators/${encodeURIComponent(name)}`, {
    method: "DELETE"
  });
}

async function seedDemoArrivals() {
  const now = Date.now();
  const arrivals = await loadArrivals();
  await saveArrivals([
    {
      id: createId(),
      type: "outside",
      label: "Petbarn",
      movementType: "Inbound",
      dropoffCount: 18,
      pickupCount: 0,
      vehicleType: "Semi trailer",
      palletCapacity: "",
      rego: "NSW456",
      vehicleDescription: "Blue curtains",
      driverName: "Jim Peterson",
      phone: "0400 111 222",
      status: "waiting",
      forkliftOperator: "",
      arrivedAt: new Date(now - 22 * 60000).toISOString(),
      calledAt: null
    },
    {
      id: createId(),
      type: "local",
      label: "Driver 104",
      driverName: "Driver 104",
      rego: "APT104",
      vehicleType: "Rigid",
      actionsRequired: "Dropping off 4 pallets and reloading for Capalaba",
      phone: "0400 000 104",
      status: "waiting",
      forkliftOperator: "",
      arrivedAt: new Date(now - 9 * 60000).toISOString(),
      calledAt: null
    },
    {
      id: createId(),
      type: "outside",
      label: "VT",
      movementType: "Inbound + Pickup",
      dropoffCount: 6,
      pickupCount: 10,
      vehicleType: "Rigid",
      palletCapacity: "12",
      rego: "VIC882",
      vehicleDescription: "Jim Peterson TPT",
      driverName: "Sam Turner",
      phone: "0412 333 444",
      status: "working",
      forkliftOperator: "Alex",
      arrivedAt: new Date(now - 36 * 60000).toISOString(),
      calledAt: new Date(now - 4 * 60000).toISOString()
    },
    ...arrivals
  ]);
}

function sortArrivals(arrivals) {
  return [...arrivals].sort(
    (a, b) => new Date(a.arrivedAt).getTime() - new Date(b.arrivedAt).getTime()
  );
}

window.aptCrossdock = {
  addArrival,
  acknowledgeMessage,
  assignForkliftOperator,
  cleanPhone,
  clearQueue,
  changePassword,
  confirmManagerPassword,
  createForkliftOperator,
  createLocalDriver,
  createTask,
  escapeHtml,
  forkliftOperators: FORKLIFT_OPERATORS,
  formatTime,
  heartbeat,
  currentUser,
  loadArrivals,
  loadHistory,
  loadLocalDrivers,
  loadMessages,
  loadStatistics,
  loadTasks,
  login,
  logout,
  playMessageAlert,
  removeArrival,
  removeForkliftOperator,
  removeLocalDriver,
  removeMessage,
  removeTask,
  resetForkliftOperatorPassword,
  refreshForkliftOperators,
  saveArrivals,
  sendMessage,
  seedDemoArrivals,
  setArrivalStatus,
  sortArrivals,
  updateArrival,
  updateTask,
  updateForkliftOperator,
  updateLocalDriver
};
