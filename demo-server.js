const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "arrivals.txt");
const TASKS_FILE = path.join(ROOT, "tasks.txt");
const MESSAGES_FILE = path.join(ROOT, "messages.txt");
const HISTORY_FILE = path.join(ROOT, "history.txt");
const LOCAL_DRIVERS_FILE = path.join(ROOT, "local-drivers.txt");
const FORKLIFT_OPERATORS_FILE = path.join(ROOT, "forklift-operators.txt");
const OPERATOR_SESSIONS_FILE = path.join(ROOT, "operator-sessions.txt");
const DEFAULT_FORKLIFT_OPERATORS = ["Alex", "Ben", "Chris", "Sam"].map(createDefaultOperator);
const sessions = new Map();
const DEFAULT_LOCAL_DRIVERS = [
  ["101", "Driver 101", "0400 000 101", "Rigid", "APT101"],
  ["102", "Driver 102", "0400 000 102", "Rigid", "APT102"],
  ["103", "Driver 103", "0400 000 103", "Rigid", "APT103"],
  ["104", "Driver 104", "0400 000 104", "Rigid", "APT104"],
  ["105", "Driver 105", "0400 000 105", "Rigid", "APT105"],
  ["106", "Driver 106", "0400 000 106", "Pantech", "APT106"],
  ["107", "Driver 107", "0400 000 107", "Pantech", "APT107"],
  ["108", "Driver 108", "0400 000 108", "Semi trailer", "APT108"],
  ["109", "Driver 109", "0400 000 109", "Semi trailer", "APT109"],
  ["110", "Driver 110", "0400 000 110", "B double", "APT110"],
  ["111", "Driver 111", "0400 000 111", "Rigid", "APT111"],
  ["112", "Driver 112", "0400 000 112", "Pantech", "APT112"]
].map(([driverNumber, driverName, phone, vehicleType, rego]) => ({
  driverNumber, driverName, phone, vehicleType, rego
}));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

async function ensureDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, "[]", "utf8");
  }
}

async function readArrivals() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeArrivals(arrivals) {
  await fs.writeFile(DATA_FILE, JSON.stringify(arrivals, null, 2), "utf8");
}

async function readCollection(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, "[]", "utf8");
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeCollection(filePath, items) {
  await fs.writeFile(filePath, JSON.stringify(items, null, 2), "utf8");
}

async function ensureLocalDrivers() {
  try {
    await fs.access(LOCAL_DRIVERS_FILE);
  } catch {
    await writeCollection(LOCAL_DRIVERS_FILE, DEFAULT_LOCAL_DRIVERS);
  }
}

async function ensureForkliftOperators() {
  try {
    await fs.access(FORKLIFT_OPERATORS_FILE);
  } catch {
    await writeCollection(FORKLIFT_OPERATORS_FILE, DEFAULT_FORKLIFT_OPERATORS);
    return;
  }
  const operators = await readCollection(FORKLIFT_OPERATORS_FILE);
  let changed = false;
  const migrated = operators.map((operator) => {
    if (operator.passwordHash) return operator;
    changed = true;
    return createDefaultOperator(operator.name);
  });
  if (changed) await writeCollection(FORKLIFT_OPERATORS_FILE, migrated);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash?.includes(":")) return false;
  const [salt, expected] = storedHash.split(":");
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function createDefaultOperator(name) {
  return {
    name,
    passwordHash: hashPassword(name),
    mustChangePassword: true
  };
}

function publicOperator(operator) {
  return {
    name: operator.name,
    mustChangePassword: Boolean(operator.mustChangePassword)
  };
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...user, createdAt: Date.now() });
  return token;
}

async function startOperatorSession(user, token) {
  const records = await readCollection(OPERATOR_SESSIONS_FILE);
  const record = {
    id: crypto.randomUUID(),
    operatorName: user.name,
    loginAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    logoutAt: null
  };
  records.unshift(record);
  await writeCollection(OPERATOR_SESSIONS_FILE, records);
  const session = sessions.get(token);
  if (session) session.operatorSessionId = record.id;
}

async function touchOperatorSession(session, close = false) {
  if (!session?.operatorSessionId) return;
  const records = await readCollection(OPERATOR_SESSIONS_FILE);
  const record = records.find((item) => item.id === session.operatorSessionId);
  if (!record) return;
  record.lastSeenAt = new Date().toISOString();
  if (close) record.logoutAt = record.lastSeenAt;
  await writeCollection(OPERATOR_SESSIONS_FILE, records);
}

function minutesBetween(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return 0;
  return (endTime - startTime) / 60000;
}

async function buildStatistics() {
  const [arrivals, tasks, history, operators, operatorSessions] = await Promise.all([
    readArrivals(),
    readCollection(TASKS_FILE),
    readCollection(HISTORY_FILE),
    readCollection(FORKLIFT_OPERATORS_FILE),
    readCollection(OPERATOR_SESSIONS_FILE)
  ]);
  const completedVehicleHistory = history.filter((entry) =>
    entry.entityType === "vehicle" && entry.action === "Vehicle work completed"
  );
  const completedIds = new Set([
    ...arrivals.filter((item) => item.status === "complete").map((item) => item.id),
    ...completedVehicleHistory.map((entry) => entry.entityId)
  ]);
  const vehicles = arrivals
    .filter((item) => completedIds.has(item.id))
    .sort((a, b) => new Date(b.completedAt || b.arrivedAt) - new Date(a.completedAt || a.arrivedAt));
  const palletIn = vehicles.reduce((sum, item) => sum + Number(item.dropoffCount || 0), 0);
  const palletOut = vehicles.reduce((sum, item) => sum + Number(item.pickupCount || 0), 0);
  const now = new Date();
  const activeOperatorNames = new Set(operatorSessions
    .filter((record) =>
      !record.logoutAt
      && (now.getTime() - new Date(record.lastSeenAt || record.loginAt).getTime()) <= 150000
    )
    .map((record) => record.operatorName));
  const operatorsOnBreak = new Set(tasks
    .filter((task) => task.taskType === "break" && task.status === "working")
    .map((task) => task.operatorName));
  const operatorsOnVehicle = new Set(arrivals
    .filter((item) => item.status === "working" && item.forkliftOperator)
    .map((item) => item.forkliftOperator));
  const operatorsOnTask = new Set(tasks
    .filter((task) => task.taskType !== "break" && task.status === "working" && task.activeOperator)
    .map((task) => task.activeOperator));
  const resourceState = [...activeOperatorNames].reduce((counts, name) => {
    if (operatorsOnBreak.has(name)) counts.onBreak += 1;
    else if (operatorsOnVehicle.has(name)) counts.onVehicle += 1;
    else if (operatorsOnTask.has(name)) counts.onTask += 1;
    else counts.idle += 1;
    return counts;
  }, { loggedIn: activeOperatorNames.size, onVehicle: 0, onTask: 0, onBreak: 0, idle: 0 });
  const operatorStats = operators.map((operator) => {
    const name = operator.name;
    const workedVehicles = arrivals.filter((item) =>
      item.forkliftOperator === name && (item.status === "complete" || item.completedAt)
    );
    const vehicleHistoryCount = new Set(completedVehicleHistory
      .filter((entry) => entry.actor === name)
      .map((entry) => entry.entityId)).size;
    const completedTasks = tasks.filter((task) =>
      task.taskType !== "break"
      && task.status === "complete"
      && (task.activeOperator === name || task.actedBy === name)
    );
    const taskWorkItems = tasks.filter((task) =>
      task.taskType !== "break"
      && task.startedAt
      && (task.activeOperator === name || task.actedBy === name)
    );
    const vehicleWorkItems = arrivals.filter((item) =>
      item.forkliftOperator === name && item.workStartedAt
    );
    const breaks = tasks.filter((task) =>
      task.taskType === "break" && task.operatorName === name && task.breakStartedAt
    );
    const sessionMinutes = operatorSessions
      .filter((record) => record.operatorName === name)
      .reduce((sum, record) => sum + minutesBetween(
        record.loginAt,
        record.logoutAt || record.lastSeenAt || now
      ), 0);
    const vehicleWorkMinutes = vehicleWorkItems.reduce((sum, item) =>
      sum + minutesBetween(item.workStartedAt, item.completedAt || now), 0);
    const taskWorkMinutes = taskWorkItems.reduce((sum, task) =>
      sum + minutesBetween(task.startedAt, task.completedAt || now), 0);
    const breakMinutes = breaks.reduce((sum, task) =>
      sum + minutesBetween(task.breakStartedAt, task.completedAt || now), 0);
    return {
      name,
      vehiclesWorked: Math.max(workedVehicles.length, vehicleHistoryCount),
      tasksCompleted: completedTasks.length,
      palletsUnloaded: workedVehicles.reduce((sum, item) => sum + Number(item.dropoffCount || 0), 0),
      palletsLoaded: workedVehicles.reduce((sum, item) => sum + Number(item.pickupCount || 0), 0),
      vehicleWorkMinutes: Math.round(vehicleWorkMinutes),
      taskWorkMinutes: Math.round(taskWorkMinutes),
      workMinutes: Math.round(vehicleWorkMinutes + taskWorkMinutes),
      breakMinutes: Math.round(breakMinutes),
      loggedInMinutes: Math.round(sessionMinutes),
      idleMinutes: Math.max(0, Math.round(sessionMinutes - vehicleWorkMinutes - taskWorkMinutes - breakMinutes))
    };
  });
  return {
    overview: {
      vehiclesCheckedIn: new Set(history
        .filter((entry) => entry.entityType === "vehicle" && entry.action === "Vehicle checked in")
        .map((entry) => entry.entityId)).size,
      vehiclesCompleted: completedIds.size,
      palletsIn: palletIn,
      palletsOut: palletOut,
      tasksCompleted: history.filter((entry) => entry.entityType === "task" && entry.action === "Task completed").length
    },
    resources: resourceState,
    vehicles,
    operators: operatorStats
  };
}

function getSession(req) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  return sessions.get(authorization.slice(7)) || null;
}

function requireManager(req, res) {
  const session = getSession(req);
  if (!session || session.role !== "manager") {
    sendJson(res, 401, { error: "Manager login required" });
    return null;
  }
  return session;
}

function vehicleHistoryTitle(item) {
  if (item.type === "outside" || item.type === "linehaul") {
    return [item.label, item.vehicleType, item.rego].filter(Boolean).join(" / ");
  }
  return item.label;
}

function departureRequestLabel(requestType) {
  return requestType === "leave-queue" ? "queue departure" : "leave site";
}

function messageHistoryEntityId(item) {
  if (item.arrivalId) return item.arrivalId;
  if (item.fromType === "driver" && item.fromId) return item.fromId;
  if (item.toType === "driver") return item.toName;
  return item.id;
}

async function addHistoryEntry(entry) {
  const history = await readCollection(HISTORY_FILE);
  history.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...entry
  });
  await writeCollection(HISTORY_FILE, history);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function safeStaticPath(urlPath) {
  const fileName = urlPath === "/"
    ? "driver-checkin.html"
    : urlPath === "/favicon.ico"
      ? "apt-logo.jpeg"
      : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, fileName);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

async function handleApi(req, res, urlPath) {
  if (urlPath === "/api/auth/login" && req.method === "POST") {
    const body = await readRequestBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (body.role === "manager") {
      if (username.toLowerCase() !== "manager" || password !== "manager") {
        sendJson(res, 401, { error: "Invalid manager username or password" });
        return true;
      }
      const user = { role: "manager", name: "Manager", mustChangePassword: false };
      sendJson(res, 200, { token: createSession(user), user });
      return true;
    }
    const operators = await readCollection(FORKLIFT_OPERATORS_FILE);
    const operator = operators.find((item) => item.name.toLowerCase() === username.toLowerCase());
    if (!operator || !verifyPassword(password, operator.passwordHash)) {
      sendJson(res, 401, { error: "Invalid operator name or password" });
      return true;
    }
    const user = { role: "operator", name: operator.name, mustChangePassword: Boolean(operator.mustChangePassword) };
    const token = createSession(user);
    await startOperatorSession(user, token);
    sendJson(res, 200, { token, user });
    return true;
  }

  if (urlPath === "/api/auth/me" && req.method === "GET") {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 200, { user: null });
      return true;
    }
    sendJson(res, 200, { user: session });
    return true;
  }

  if (urlPath === "/api/auth/logout" && req.method === "POST") {
    const authorization = req.headers.authorization || "";
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      await touchOperatorSession(sessions.get(token), true);
      sessions.delete(token);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === "/api/auth/heartbeat" && req.method === "POST") {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Login required" });
      return true;
    }
    await touchOperatorSession(session);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === "/api/auth/change-password" && req.method === "POST") {
    const session = getSession(req);
    if (!session || session.role !== "operator") {
      sendJson(res, 401, { error: "Operator login required" });
      return true;
    }
    const body = await readRequestBody(req);
    const password = String(body.password || "");
    if (password.length < 6 || password.toLowerCase() === session.name.toLowerCase()) {
      sendJson(res, 400, { error: "Use at least 6 characters and do not reuse your name" });
      return true;
    }
    const operators = await readCollection(FORKLIFT_OPERATORS_FILE);
    const operator = operators.find((item) => item.name === session.name);
    if (!operator) {
      sendJson(res, 404, { error: "Operator not found" });
      return true;
    }
    operator.passwordHash = hashPassword(password);
    operator.mustChangePassword = false;
    session.mustChangePassword = false;
    await writeCollection(FORKLIFT_OPERATORS_FILE, operators);
    sendJson(res, 200, { user: session });
    return true;
  }

  if (urlPath === "/api/auth/confirm-manager" && req.method === "POST") {
    if (!requireManager(req, res)) return true;
    const body = await readRequestBody(req);
    if (String(body.password || "") !== "manager") {
      sendJson(res, 401, { error: "Incorrect manager password" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === "/api/admin/seed-demo" && req.method === "POST") {
    if (!requireManager(req, res)) return true;
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === "/api/admin/clear-queue" && req.method === "POST") {
    if (!requireManager(req, res)) return true;
    const body = await readRequestBody(req);
    if (String(body.password || "") !== "manager") {
      sendJson(res, 401, { error: "Incorrect manager password" });
      return true;
    }
    await writeArrivals([]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === "/api/statistics" && req.method === "GET") {
    if (!requireManager(req, res)) return true;
    sendJson(res, 200, await buildStatistics());
    return true;
  }

  if (urlPath === "/api/history" && req.method === "GET") {
    sendJson(res, 200, await readCollection(HISTORY_FILE));
    return true;
  }

  if (urlPath === "/api/history" && req.method === "PUT") {
    const body = await readRequestBody(req);
    await writeCollection(HISTORY_FILE, Array.isArray(body) ? body : []);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const collectionMatch = urlPath.match(/^\/api\/(tasks|messages|local-drivers|forklift-operators)(?:\/([^/]+))?$/);
  if (collectionMatch) {
    const collectionName = collectionMatch[1];
    const id = collectionMatch[2] ? decodeURIComponent(collectionMatch[2]) : "";
    const filePath = collectionName === "tasks"
      ? TASKS_FILE
      : collectionName === "messages"
        ? MESSAGES_FILE
        : collectionName === "local-drivers"
          ? LOCAL_DRIVERS_FILE
          : FORKLIFT_OPERATORS_FILE;

    if (!id && req.method === "GET") {
      const items = await readCollection(filePath);
      sendJson(res, 200, collectionName === "forklift-operators" ? items.map(publicOperator) : items);
      return true;
    }

    if (!id && req.method === "PUT") {
      const body = await readRequestBody(req);
      await writeCollection(filePath, Array.isArray(body) ? body : []);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (!id && req.method === "POST") {
      if (["local-drivers", "forklift-operators"].includes(collectionName) && !requireManager(req, res)) return true;
      let item = await readRequestBody(req);
      if (collectionName === "forklift-operators") item = createDefaultOperator(String(item.name || "").trim());
      const items = await readCollection(filePath);
      items.unshift(item);
      await writeCollection(filePath, items);
      if (collectionName === "tasks") {
        if (item.taskType === "break") {
          await addHistoryEntry({
            entityType: "break",
            entityId: item.id,
            title: `${item.operatorName} break`,
            action: "Break requested",
            actor: item.operatorName,
            details: `${item.breakMinutes} minute${item.breakMinutes === 1 ? "" : "s"}`
          });
        } else {
          await addHistoryEntry({
            entityType: "task",
            entityId: item.id,
            title: item.description,
            action: "Task created",
            actor: item.createdBy || "Manager",
            details: item.suggestedOperator
              ? `Suggested operator: ${item.suggestedOperator}`
              : "Available to any forklift operator"
          });
        }
      } else if (collectionName === "messages") {
        const departureRequest = ["leave-site", "leave-queue"].includes(item.requestType);
        const departureResponse = item.requestType === "departure-response";
        let action = "Message sent";
        let title = `${item.fromName} to ${item.toLabel || item.toName}`;
        let details = item.text;
        if (departureRequest) {
          action = `Driver ${departureRequestLabel(item.requestType)} requested`;
          title = `${item.vehicleLabel || item.fromName} departure request`;
          details = `Reason: ${item.text}`;
        } else if (departureResponse) {
          action = `Driver ${departureRequestLabel(item.departureRequestType)} request ${item.departureDecision}`;
          title = `${item.toLabel || item.toName} departure request`;
          details = `Manager response: ${item.text}`;
        }
        await addHistoryEntry({
          entityType: "message",
          entityId: messageHistoryEntityId(item),
          sourceMessageId: item.id,
          title,
          action,
          actor: item.fromName,
          details
        });
      }
      sendJson(res, 201, collectionName === "forklift-operators" ? publicOperator(item) : item);
      return true;
    }

    if (id && req.method === "PATCH") {
      if (["local-drivers", "forklift-operators"].includes(collectionName) && !requireManager(req, res)) return true;
      const body = await readRequestBody(req);
      const items = await readCollection(filePath);
      const item = items.find((entry) =>
        collectionName === "local-drivers"
          ? entry.driverNumber === id
          : collectionName === "forklift-operators"
            ? entry.name === id
            : entry.id === id
      );
      if (!item) {
        sendJson(res, 404, { error: "Item not found" });
        return true;
      }
      const previous = { ...item };
      if (collectionName === "forklift-operators" && body.resetPassword) {
        item.passwordHash = hashPassword(item.name);
        item.mustChangePassword = true;
        delete body.resetPassword;
      }
      Object.assign(item, body);
      if (collectionName === "forklift-operators" && body.name && body.name !== previous.name && item.mustChangePassword) {
        item.passwordHash = hashPassword(body.name);
      }
      await writeCollection(filePath, items);
      if (collectionName === "tasks") {
        if (item.taskType === "break") {
          let action = "Break request updated";
          let details = `${item.breakMinutes} minutes`;
          if (body.status === "working") {
            action = "Break approved and started";
          } else if (body.status === "rejected") {
            action = "Break rejected";
            details = body.rejectionMessage || "No reason supplied";
          } else if (body.status === "complete") {
            action = "Break ended";
            const started = new Date(item.breakStartedAt).getTime();
            const ended = new Date(item.completedAt).getTime();
            if (Number.isFinite(started) && Number.isFinite(ended)) {
              details = `Actual break: ${Math.max(0, Math.round((ended - started) / 60000))} minutes`;
            }
          }
          await addHistoryEntry({
            entityType: "break",
            entityId: item.id,
            title: `${item.operatorName} break`,
            action,
            actor: body.actedBy || item.operatorName || "Manager",
            details,
            previousStatus: previous.status,
            status: item.status
          });
        } else {
          let action = "Task updated";
          let details = "";
          if (body.status === "working") {
            action = "Task started";
            details = `Operator: ${body.activeOperator || item.activeOperator || "Unknown"}`;
          } else if (body.status === "complete") {
            action = "Task completed";
            details = `Completed by ${body.actedBy || item.activeOperator || "Manager"}`;
          } else if (Object.prototype.hasOwnProperty.call(body, "suggestedOperator")) {
            action = "Suggested operator changed";
            details = body.suggestedOperator
              ? `Suggested operator: ${body.suggestedOperator}`
              : "Suggestion cleared; available to anyone";
          }
          await addHistoryEntry({
            entityType: "task",
            entityId: item.id,
            title: item.description,
            action,
            actor: body.actedBy || body.activeOperator || "Manager",
            details,
            previousStatus: previous.status,
            status: item.status
          });
        }
      } else if (collectionName === "messages" && body.acknowledgedAt && !previous.acknowledgedAt) {
        if (!["leave-site", "leave-queue"].includes(item.requestType)) {
          await addHistoryEntry({
            entityType: "message",
            entityId: messageHistoryEntityId(item),
            sourceMessageId: item.id,
            title: `${item.fromName} to ${item.toLabel || item.toName}`,
            action: item.requestType === "departure-response"
              ? "Departure decision acknowledged by driver"
              : "Message acknowledged",
            actor: body.acknowledgedBy || item.toName,
            details: item.text
          });
        }
      }
      sendJson(res, 200, collectionName === "forklift-operators" ? publicOperator(item) : item);
      return true;
    }

    if (id && req.method === "DELETE") {
      if (["local-drivers", "forklift-operators"].includes(collectionName) && !requireManager(req, res)) return true;
      const items = await readCollection(filePath);
      const removed = items.find((entry) =>
        collectionName === "local-drivers"
          ? entry.driverNumber === id
          : collectionName === "forklift-operators"
            ? entry.name === id
            : entry.id === id
      );
      await writeCollection(filePath, items.filter((entry) =>
        collectionName === "local-drivers"
          ? entry.driverNumber !== id
          : collectionName === "forklift-operators"
            ? entry.name !== id
            : entry.id !== id
      ));
      if (collectionName === "tasks" && removed) {
        await addHistoryEntry({
          entityType: removed.taskType === "break" ? "break" : "task",
          entityId: removed.id,
          title: removed.taskType === "break" ? `${removed.operatorName} break` : removed.description,
          action: removed.taskType === "break" ? "Break record removed" : "Task removed",
          actor: "Manager",
          details: `Final status: ${removed.status}`
        });
      } else if (collectionName === "messages" && removed) {
        await addHistoryEntry({
          entityType: "message",
          entityId: removed.id,
          title: `${removed.fromName} to ${removed.toLabel || removed.toName}`,
          action: "Message removed from active view",
          actor: removed.acknowledgedBy || removed.toName || "Manager",
          details: removed.text
        });
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (urlPath === "/api/arrivals" && req.method === "GET") {
    sendJson(res, 200, await readArrivals());
    return true;
  }

  if (urlPath === "/api/arrivals" && req.method === "PUT") {
    const body = await readRequestBody(req);
    await writeArrivals(Array.isArray(body) ? body : []);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === "/api/arrivals" && req.method === "POST") {
    const item = await readRequestBody(req);
    const arrivals = await readArrivals();
    arrivals.unshift(item);
    await writeArrivals(arrivals);
    await addHistoryEntry({
      entityType: "vehicle",
      entityId: item.id,
      title: vehicleHistoryTitle(item),
      action: "Vehicle checked in",
      actor: item.driverName || item.label,
      details: item.type === "local"
        ? item.actionsRequired || ""
        : [
            item.rego || "",
            item.movementType || "",
            `Pallets in: ${Number(item.dropoffCount || 0)}`,
            `Pallets out: ${Number(item.pickupCount || 0)}`
          ].join(" / ")
    });
    if (item.inductionAcceptedAt) {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: "Outside carrier site induction acknowledged",
        actor: item.driverName || item.label,
        details: `${item.inductionVersion || "Site rules"} / Accepted ${item.inductionAcceptedAt}`
      });
    }
    sendJson(res, 201, item);
    return true;
  }

  const match = urlPath.match(/^\/api\/arrivals\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const id = decodeURIComponent(match[1]);
    const body = await readRequestBody(req);
    const arrivals = await readArrivals();
    const item = arrivals.find((arrival) => arrival.id === id);
    if (!item) {
      sendJson(res, 404, { error: "Arrival not found" });
      return true;
    }
    const previousStatus = item.status;
    const previousOperator = item.forkliftOperator || "";
    if (body.status) {
      const nextStatus = ["waiting", "called", "working", "complete", "departure-approved"].includes(body.status)
        ? body.status
        : "waiting";
      item.status = nextStatus;
      if (nextStatus === "called" && !item.calledAt) item.calledAt = new Date().toISOString();
      if (nextStatus === "waiting") item.calledAt = null;
      if (nextStatus === "working" && !item.workStartedAt) item.workStartedAt = new Date().toISOString();
      if (nextStatus === "complete") item.completedAt = new Date().toISOString();
    }
    if (Object.prototype.hasOwnProperty.call(body, "forkliftOperator")) {
      item.forkliftOperator = body.forkliftOperator || "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "notifiedBy")) {
      item.notifiedBy = body.notifiedBy || "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "notifiedAt")) {
      item.notifiedAt = body.notifiedAt || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "entryInstructions")) {
      item.entryInstructions = body.entryInstructions || "";
    }
    await writeArrivals(arrivals);
    if (body.status === "called") {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: item.entryInstructions
          ? "Driver notified with entry instructions"
          : "Driver notified to proceed",
        actor: body.notifiedBy || "Manager",
        details: item.entryInstructions || item.rego || item.actionsRequired || ""
      });
    } else if (body.status === "working") {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: "Vehicle work started",
        actor: body.actedBy || item.forkliftOperator || "Forklift operator",
        details: `Forklift operator: ${item.forkliftOperator || "Not assigned"}`
      });
    } else if (body.status === "complete") {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: "Vehicle work completed",
        actor: body.actedBy || item.forkliftOperator || "Forklift operator",
        details: item.rego || item.actionsRequired || ""
      });
    } else if (body.status === "departure-approved") {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: "Vehicle cleared from active queue after departure approval",
        actor: body.actedBy || "Manager",
        details: item.rego || item.actionsRequired || ""
      });
    } else if (body.status === "waiting" && previousStatus !== "waiting") {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: "Vehicle returned to waiting",
        actor: body.actedBy || "Manager",
        details: ""
      });
    } else if (
      Object.prototype.hasOwnProperty.call(body, "forkliftOperator")
      && previousOperator !== item.forkliftOperator
    ) {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: item.id,
        title: vehicleHistoryTitle(item),
        action: "Preferred forklift operator changed",
        actor: body.actedBy || "Manager",
        details: item.forkliftOperator
          ? `Suggested operator: ${item.forkliftOperator}`
          : "Operator suggestion cleared"
      });
    }
    sendJson(res, 200, item);
    return true;
  }

  if (match && req.method === "DELETE") {
    const id = decodeURIComponent(match[1]);
    const body = await readRequestBody(req);
    const arrivals = await readArrivals();
    const removed = arrivals.find((arrival) => arrival.id === id);
    await writeArrivals(arrivals.filter((arrival) => arrival.id !== id));
    if (removed) {
      await addHistoryEntry({
        entityType: "vehicle",
        entityId: removed.id,
        title: vehicleHistoryTitle(removed),
        action: "Vehicle removed from queue",
        actor: body.actedBy || "Manager",
        details: `Final status: ${removed.status}`
      });
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url.pathname);
      if (!handled) sendJson(res, 404, { error: "Not found" });
      return;
    }

    const staticPath = safeStaticPath(url.pathname);
    if (!staticPath) {
      sendText(res, 403, "Forbidden");
      return;
    }

    const content = await fs.readFile(staticPath);
    const ext = path.extname(staticPath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" || ext === ".js" ? "no-store, max-age=0" : "public, max-age=300"
    });
    res.end(content);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
});

Promise.all([
  ensureDataFile(),
  readCollection(TASKS_FILE),
  readCollection(MESSAGES_FILE),
  readCollection(HISTORY_FILE),
  readCollection(OPERATOR_SESSIONS_FILE),
  ensureLocalDrivers(),
  ensureForkliftOperators()
]).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`APT crossdock demo running at http://${HOST}:${PORT}/driver-checkin.html`);
  });
});
