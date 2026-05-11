require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const express = require("express");
const multer = require("multer");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const MONGODB_DB = process.env.MONGODB_DB || "almacen_tablet";
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "dev-secret";
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Europe/Madrid";
const FINALIZE_LOOKBACK_DAYS = Number(process.env.FINALIZE_LOOKBACK_DAYS || 14);

const WEEK_DAYS = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"];
const EMPLOYEE_SHIFT_VALUES = new Set(["morning", "afternoon", "both", "off"]);
const TASK_SHIFT_VALUES = new Set(["morning", "afternoon", "day"]);
const TASK_TARGETS = new Set(["employee", "shift"]);
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");

let client;
let db;
let rolloverDate = null;
let rolloverPromise = null;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));
app.use("/api", asyncHandler(async (_req, _res, next) => {
  await ensureCurrentDay();
  next();
}));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const original = String(file.originalname || "archivo").replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${original}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

function collection(name) {
  return db.collection(name);
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function todayString() {
  return dateFormatter.format(new Date());
}

function assertDateString(value, fallback = todayString()) {
  const date = String(value || fallback).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const error = new Error("Fecha invalida");
    error.status = 400;
    throw error;
  }
  return date;
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function weekdayIndex(dateString) {
  const date = new Date(`${dateString}T12:00:00.000Z`);
  return (date.getUTCDay() + 6) % 7;
}

function cleanText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function requireText(value, field, maxLength = 500) {
  const text = cleanText(value, maxLength);
  if (!text) {
    const error = new Error(`${field} es obligatorio`);
    error.status = 400;
    throw error;
  }
  return text;
}

function requireObjectId(value) {
  if (!ObjectId.isValid(value)) {
    const error = new Error("Identificador invalido");
    error.status = 400;
    throw error;
  }
  return new ObjectId(value);
}

function normalizeEmployeeCode(value) {
  const code = String(value || "").trim();
  if (!/^\d{2}$/.test(code)) {
    const error = new Error("El codigo de trabajador debe tener dos numeros");
    error.status = 400;
    throw error;
  }
  return code;
}

function normalizeEmployeeShift(value) {
  const shift = String(value || "").trim();
  if (EMPLOYEE_SHIFT_VALUES.has(shift)) return shift;
  return "off";
}

function normalizeTaskShift(value) {
  const shift = String(value || "").trim();
  if (TASK_SHIFT_VALUES.has(shift)) return shift;
  const error = new Error("Turno invalido");
  error.status = 400;
  throw error;
}

function normalizeShifts(input = {}) {
  const shifts = {};
  for (let day = 0; day < 7; day += 1) {
    const value = input[String(day)] ?? input[day] ?? "off";
    shifts[String(day)] = normalizeEmployeeShift(value);
  }
  return shifts;
}

function employeeShiftForDate(employee, dateString) {
  const day = weekdayIndex(dateString);
  return employee?.shifts?.[String(day)] || "off";
}

function employeeTaskShiftsForDate(employee, dateString) {
  const shift = employeeShiftForDate(employee, dateString);
  if (shift === "both") return ["morning", "afternoon", "day"];
  if (shift === "morning" || shift === "afternoon") return [shift, "day"];
  return [];
}

function shiftMatchesEmployee(item, employee, dateString) {
  if (item.targetType !== "shift") return false;
  return employeeTaskShiftsForDate(employee, dateString).includes(item.shift);
}

function itemVisibleForEmployee(item, employee, dateString) {
  if (item.targetType === "employee") return item.employeeCode === employee.code;
  return shiftMatchesEmployee(item, employee, dateString);
}

function normalizeDays(days) {
  const list = Array.isArray(days) ? days : [days];
  const normalized = [...new Set(list.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  if (!normalized.length) {
    const error = new Error("Selecciona al menos un dia");
    error.status = 400;
    throw error;
  }
  return normalized.sort((a, b) => a - b);
}

async function normalizeTaskPayload(body, options = {}) {
  const targetType = cleanText(body.targetType, 20);
  if (!TASK_TARGETS.has(targetType)) {
    const error = new Error("Destino de tarea invalido");
    error.status = 400;
    throw error;
  }

  const task = {
    title: requireText(body.title, "La tarea", 180),
    details: cleanText(body.details, 700),
    targetType,
    employeeCode: null,
    shift: null,
    production: normalizeProduction(body)
  };

  if (targetType === "employee") {
    task.employeeCode = normalizeEmployeeCode(body.employeeCode);
    const employee = await collection("employees").findOne({ code: task.employeeCode });
    if (!employee) {
      const error = new Error("No existe ese trabajador");
      error.status = 404;
      throw error;
    }
  } else {
    task.shift = normalizeTaskShift(body.shift);
  }

  if (options.recurring) {
    task.days = normalizeDays(body.days);
  }

  if (options.oneOff) {
    task.dueDate = assertDateString(body.dueDate);
  }

  return task;
}

function normalizeProduction(body) {
  const item = cleanText(body.productionItem, 120);
  const target = Math.max(0, Math.trunc(Number(body.productionTarget || 0)));
  if (!item && !target) return null;
  if (!item || target <= 0) {
    const error = new Error("Indica item y cantidad de productividad");
    error.status = 400;
    throw error;
  }
  return { item, target };
}

async function normalizeProductCategory(categoryId) {
  const raw = cleanText(categoryId, 80);
  if (!raw) return { categoryId: null, categoryName: null };
  const _id = requireObjectId(raw);
  const category = await collection("categories").findOne({ _id });
  if (!category) {
    const error = new Error("Categoria no encontrada");
    error.status = 404;
    throw error;
  }
  return {
    categoryId: String(category._id),
    categoryName: category.name
  };
}

function makeWorkItemFilter(workItem) {
  return {
    date: workItem.date,
    sourceType: workItem.sourceType,
    sourceId: workItem.sourceId,
    targetType: workItem.targetType,
    employeeCode: workItem.employeeCode || null,
    shift: workItem.shift || null
  };
}

function taskToWorkItem(task, sourceType, dateString) {
  return {
    date: dateString,
    sourceType,
    sourceId: String(task._id),
    title: task.title,
    details: task.details || "",
    targetType: task.targetType,
    employeeCode: task.employeeCode || null,
    shift: task.shift || null,
    production: task.production || null,
    productionEntries: [],
    totalQuantity: 0,
    checked: false,
    checkedBy: null,
    checkedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

async function ensureWorkItemsForDate(dateString) {
  const date = assertDateString(dateString);
  const day = weekdayIndex(date);
  const [recurringTasks, oneOffTasks] = await Promise.all([
    collection("recurringTasks").find({
      active: true,
      days: day,
      $or: [{ startDate: { $exists: false } }, { startDate: { $lte: date } }]
    }).toArray(),
    collection("oneOffTasks").find({ active: true, dueDate: date }).toArray()
  ]);

  const workItems = [
    ...recurringTasks.map((task) => taskToWorkItem(task, "recurring", date)),
    ...oneOffTasks.map((task) => taskToWorkItem(task, "oneOff", date))
  ];

  await Promise.all(workItems.map((workItem) => collection("workItems").updateOne(
    makeWorkItemFilter(workItem),
    { $setOnInsert: workItem },
    { upsert: true }
  )));
}

function sortWorkItems(items) {
  return items.sort((a, b) => {
    if (a.targetType !== b.targetType) return a.targetType === "shift" ? -1 : 1;
    return a.title.localeCompare(b.title, "es");
  });
}

function isProductionItem(item) {
  return Boolean(item?.production?.item && Number(item.production.target) > 0);
}

function productionTarget(item) {
  return Math.max(0, Math.trunc(Number(item?.production?.target || 0)));
}

function employeeQuantityForItem(item, employeeCode) {
  const entry = (item.productionEntries || []).find((row) => row.employeeCode === employeeCode);
  return Math.max(0, Math.trunc(Number(entry?.quantity || 0)));
}

function productionTotal(entries) {
  return (entries || []).reduce((sum, entry) => sum + Math.max(0, Math.trunc(Number(entry.quantity || 0))), 0);
}

function isWorkItemComplete(item) {
  if (!isProductionItem(item)) return Boolean(item.checked);
  return Math.max(0, Math.trunc(Number(item.totalQuantity || 0))) >= productionTarget(item);
}

function applyProductionEntry(item, employeeCode, desiredQuantity) {
  const target = productionTarget(item);
  const entries = [...(item.productionEntries || [])].filter((entry) => entry.employeeCode !== employeeCode);
  const otherTotal = productionTotal(entries);
  const maxForEmployee = Math.max(0, target - otherTotal);
  const quantity = Math.min(Math.max(0, Math.trunc(Number(desiredQuantity || 0))), maxForEmployee);

  if (quantity > 0) {
    entries.push({
      employeeCode,
      quantity,
      updatedAt: new Date()
    });
  }

  const totalQuantity = productionTotal(entries);
  return {
    productionEntries: entries.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode)),
    totalQuantity,
    checked: totalQuantity >= target
  };
}

async function visibleItemsForEmployee(employee, dateString) {
  await ensureWorkItemsForDate(dateString);
  const shift = employeeShiftForDate(employee, dateString);
  const taskShifts = employeeTaskShiftsForDate(employee, dateString);
  const clauses = [{ targetType: "employee", employeeCode: employee.code }];
  if (taskShifts.length) {
    clauses.push({ targetType: "shift", shift: { $in: taskShifts } });
  }
  const items = await collection("workItems").find({ date: dateString, $or: clauses }).toArray();
  return {
    shift,
    items: sortWorkItems(items)
  };
}

async function finalizeDay(dateString) {
  const date = assertDateString(dateString);
  await ensureWorkItemsForDate(date);

  const [employees, items, comments] = await Promise.all([
    collection("employees").find({}).toArray(),
    collection("workItems").find({ date }).toArray(),
    collection("comments").find({ date }).toArray()
  ]);

  const commentsByEmployee = new Map(comments.map((comment) => [comment.employeeCode, comment]));
  const now = new Date();

  await Promise.all(employees.map(async (employee) => {
    const shift = employeeShiftForDate(employee, date);
    const visible = items.filter((item) => itemVisibleForEmployee(item, employee, date));
    const comment = commentsByEmployee.get(employee.code);
    const commentText = cleanText(comment?.text || "", 2000);

    if (!visible.length && !commentText) return;

    const completed = visible.filter((item) => isWorkItemComplete(item)).length;
    const summary = {
      date,
      employeeCode: employee.code,
      employeeName: employee.name,
      shift,
      total: visible.length,
      completed,
      pending: visible.length - completed,
      tasks: sortWorkItems(visible).map((item) => ({
        title: item.title,
        details: item.details || "",
        targetType: item.targetType,
        shift: item.shift || null,
        production: item.production || null,
        employeeQuantity: employeeQuantityForItem(item, employee.code),
        totalQuantity: Number(item.totalQuantity || 0),
        checked: Boolean(item.checked),
        checkedBy: item.checkedBy || null,
        checkedAt: item.checkedAt || null
      })),
      comment: commentText,
      finalizedAt: now,
      updatedAt: now
    };

    await collection("dailySummaries").updateOne(
      { date, employeeCode: employee.code },
      { $set: summary, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
  }));
}

async function liveWorkForAll(dateString) {
  const date = assertDateString(dateString);
  await ensureWorkItemsForDate(date);

  const [employees, items, comments] = await Promise.all([
    collection("employees").find({}).sort({ code: 1 }).toArray(),
    collection("workItems").find({ date }).toArray(),
    collection("comments").find({ date }).toArray()
  ]);

  const commentsByEmployee = new Map(comments.map((comment) => [comment.employeeCode, comment]));

  return employees.map((employee) => {
    const shift = employeeShiftForDate(employee, date);
    const visible = sortWorkItems(items.filter((item) => itemVisibleForEmployee(item, employee, date)));
    const completed = visible.filter((item) => isWorkItemComplete(item)).length;

    return {
      date,
      employee: {
        code: employee.code,
        name: employee.name
      },
      shift,
      total: visible.length,
      completed,
      pending: visible.length - completed,
      comment: commentsByEmployee.get(employee.code)?.text || "",
      items: visible.map((item) => ({
        _id: item._id,
        title: item.title,
        details: item.details || "",
        targetType: item.targetType,
        shift: item.shift || null,
        production: item.production || null,
        employeeQuantity: employeeQuantityForItem(item, employee.code),
        totalQuantity: Number(item.totalQuantity || 0),
        checked: isWorkItemComplete(item),
        checkedBy: item.checkedBy || null,
        checkedAt: item.checkedAt || null
      }))
    };
  });
}

async function finalizePastDays() {
  const today = todayString();
  const dates = new Set();

  for (let offset = 1; offset <= Math.max(1, FINALIZE_LOOKBACK_DAYS); offset += 1) {
    dates.add(addDays(today, -offset));
  }

  const [workDates, oneOffDates] = await Promise.all([
    collection("workItems").distinct("date", { date: { $lt: today } }),
    collection("oneOffTasks").distinct("dueDate", { dueDate: { $lt: today }, active: true })
  ]);

  for (const date of [...workDates, ...oneOffDates]) {
    if (date < today) dates.add(date);
  }

  for (const date of [...dates].sort()) {
    await finalizeDay(date);
  }
}

async function ensureCurrentDay() {
  const today = todayString();
  if (rolloverDate === today) return;

  if (!rolloverPromise) {
    rolloverPromise = (async () => {
      const state = await collection("appState").findOne({ _id: "dailyRollover" });
      if (state?.date !== today) {
        await finalizePastDays();
        await ensureWorkItemsForDate(today);
        await collection("appState").updateOne(
          { _id: "dailyRollover" },
          { $set: { date: today, checkedAt: new Date() } },
          { upsert: true }
        );
      } else {
        await ensureWorkItemsForDate(today);
      }
      rolloverDate = today;
    })().finally(() => {
      rolloverPromise = null;
    });
  }

  await rolloverPromise;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(payload) {
  const body = base64urlJson(payload);
  const signature = crypto.createHmac("sha256", ADMIN_TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyAdminToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return false;
  const expected = crypto.createHmac("sha256", ADMIN_TOKEN_SECRET).update(body).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.role === "admin" && Number(payload.exp) > Date.now();
  } catch (_error) {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ error: "Admin no autorizado" });
  }
  return next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, today: todayString(), timezone: APP_TIMEZONE });
});

app.post("/api/admin/login", asyncHandler(async (req, res) => {
  const pin = String(req.body.pin || "");
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "PIN incorrecto" });
  }

  const token = signToken({
    role: "admin",
    exp: Date.now() + 12 * 60 * 60 * 1000
  });

  return res.json({ token });
}));

app.get("/api/categories", asyncHandler(async (_req, res) => {
  const categories = await collection("categories").find({}).sort({ name: 1 }).toArray();
  res.json(categories);
}));

app.post("/api/admin/categories", requireAdmin, asyncHandler(async (req, res) => {
  const now = new Date();
  const category = {
    name: requireText(req.body.name, "La categoria", 80),
    createdAt: now,
    updatedAt: now
  };

  const result = await collection("categories").insertOne(category);
  res.status(201).json({ ...category, _id: result.insertedId });
}));

app.delete("/api/admin/categories/:id", requireAdmin, asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  await collection("products").updateMany(
    { categoryId: String(_id) },
    { $set: { categoryId: null, categoryName: null, updatedAt: new Date() } }
  );
  await collection("categories").deleteOne({ _id });
  res.status(204).end();
}));

app.get("/api/products", asyncHandler(async (_req, res) => {
  const products = await collection("products").find({}).sort({ name: 1 }).toArray();
  res.json(products);
}));

app.post("/api/products", requireAdmin, asyncHandler(async (req, res) => {
  const category = await normalizeProductCategory(req.body.categoryId);
  const product = {
    name: requireText(req.body.name, "El producto", 120),
    unit: cleanText(req.body.unit || "ud", 30) || "ud",
    stock: Math.max(0, Math.trunc(Number(req.body.stock || 0))),
    ...category,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await collection("products").insertOne(product);
  res.status(201).json({ ...product, _id: result.insertedId });
}));

app.put("/api/products/:id", requireAdmin, asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  const category = await normalizeProductCategory(req.body.categoryId);
  const update = {
    name: requireText(req.body.name, "El producto", 120),
    unit: cleanText(req.body.unit || "ud", 30) || "ud",
    stock: Math.max(0, Math.trunc(Number(req.body.stock || 0))),
    ...category,
    updatedAt: new Date()
  };

  await collection("products").updateOne({ _id }, { $set: update });
  const product = await collection("products").findOne({ _id });
  res.json(product);
}));

app.patch("/api/products/:id/stock", asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  const delta = Math.trunc(Number(req.body.delta || 0));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000) {
    return res.status(400).json({ error: "Cambio de stock invalido" });
  }

  await collection("products").updateOne(
    { _id },
    [{
      $set: {
        stock: { $max: [0, { $add: [{ $ifNull: ["$stock", 0] }, delta] }] },
        updatedAt: new Date()
      }
    }]
  );

  const product = await collection("products").findOne({ _id });
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(product);
}));

app.delete("/api/products/:id", requireAdmin, asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  await collection("products").deleteOne({ _id });
  res.status(204).end();
}));

app.get("/api/work/:code", asyncHandler(async (req, res) => {
  const code = normalizeEmployeeCode(req.params.code);
  const date = assertDateString(req.query.date);
  const employee = await collection("employees").findOne({ code });
  if (!employee) return res.status(404).json({ error: "Trabajador no encontrado" });

  const [{ shift, items }, comment] = await Promise.all([
    visibleItemsForEmployee(employee, date),
    collection("comments").findOne({ employeeCode: code, date })
  ]);

  res.json({
    date,
    employee: {
      code: employee.code,
      name: employee.name
    },
    shift,
    items,
    comment: comment?.text || ""
  });
}));

app.patch("/api/work-items/:id/toggle", asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  const checked = Boolean(req.body.checked);
  const employeeCode = req.body.employeeCode ? normalizeEmployeeCode(req.body.employeeCode) : null;
  const item = await collection("workItems").findOne({ _id });
  if (!item) return res.status(404).json({ error: "Tarea no encontrada" });

  if (isProductionItem(item)) {
    return res.status(400).json({ error: "Esta tarea se marca por cantidad" });
  }

  if (employeeCode) {
    const employee = await collection("employees").findOne({ code: employeeCode });
    if (!employee || !itemVisibleForEmployee(item, employee, item.date)) {
      return res.status(403).json({ error: "Esta tarea no pertenece a ese trabajador" });
    }
  }

  const update = {
    checked,
    checkedBy: checked ? employeeCode : null,
    checkedAt: checked ? new Date() : null,
    updatedAt: new Date()
  };

  await collection("workItems").updateOne({ _id }, { $set: update });
  const updated = await collection("workItems").findOne({ _id });
  res.json(updated);
}));

app.patch("/api/work-items/:id/progress", asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  const employeeCode = normalizeEmployeeCode(req.body.employeeCode);
  const [item, employee] = await Promise.all([
    collection("workItems").findOne({ _id }),
    collection("employees").findOne({ code: employeeCode })
  ]);

  if (!item) return res.status(404).json({ error: "Tarea no encontrada" });
  if (!employee || !itemVisibleForEmployee(item, employee, item.date)) {
    return res.status(403).json({ error: "Esta tarea no pertenece a ese trabajador" });
  }
  if (!isProductionItem(item)) {
    return res.status(400).json({ error: "Esta tarea no tiene productividad" });
  }

  const desiredQuantity = req.body.complete ? productionTarget(item) : req.body.quantity;
  const progress = applyProductionEntry(item, employeeCode, desiredQuantity);
  const update = {
    ...progress,
    checkedBy: progress.checked ? employeeCode : null,
    checkedAt: progress.checked ? new Date() : null,
    updatedAt: new Date()
  };

  await collection("workItems").updateOne({ _id }, { $set: update });
  const updated = await collection("workItems").findOne({ _id });
  res.json(updated);
}));

app.put("/api/work/:code/comments", asyncHandler(async (req, res) => {
  const employeeCode = normalizeEmployeeCode(req.params.code);
  const date = assertDateString(req.body.date);
  const employee = await collection("employees").findOne({ code: employeeCode });
  if (!employee) return res.status(404).json({ error: "Trabajador no encontrado" });

  const comment = {
    date,
    employeeCode,
    text: cleanText(req.body.text, 2500),
    updatedAt: new Date()
  };

  await collection("comments").updateOne(
    { date, employeeCode },
    { $set: comment, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  res.json(comment);
}));

app.get("/api/shift-tasks", asyncHandler(async (req, res) => {
  const date = assertDateString(req.query.date);
  const shift = normalizeTaskShift(req.query.shift || "morning");
  if (shift === "day") {
    return res.status(400).json({ error: "Selecciona manana o tarde" });
  }
  await ensureWorkItemsForDate(date);

  const [items, employees] = await Promise.all([
    collection("workItems").find({ date, targetType: "shift", shift: { $in: [shift, "day"] } }).sort({ title: 1 }).toArray(),
    collection("employees").find({ [`shifts.${weekdayIndex(date)}`]: { $in: [shift, "both"] } }).sort({ name: 1 }).toArray()
  ]);

  res.json({
    date,
    shift,
    employees: employees.map((employee) => ({ code: employee.code, name: employee.name })),
    items
  });
}));

app.get("/api/circulars", asyncHandler(async (_req, res) => {
  const circulars = await collection("circulars").find({}).sort({ createdAt: -1 }).toArray();
  res.json(circulars);
}));

app.get("/api/admin/employees", requireAdmin, asyncHandler(async (_req, res) => {
  const employees = await collection("employees").find({}).sort({ code: 1 }).toArray();
  res.json(employees);
}));

app.post("/api/admin/employees", requireAdmin, asyncHandler(async (req, res) => {
  const employee = {
    code: normalizeEmployeeCode(req.body.code),
    name: requireText(req.body.name, "El nombre", 120),
    shifts: normalizeShifts(req.body.shifts),
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await collection("employees").insertOne(employee);
  res.status(201).json({ ...employee, _id: result.insertedId });
}));

app.put("/api/admin/employees/:code", requireAdmin, asyncHandler(async (req, res) => {
  const code = normalizeEmployeeCode(req.params.code);
  const update = {
    name: requireText(req.body.name, "El nombre", 120),
    shifts: normalizeShifts(req.body.shifts),
    updatedAt: new Date()
  };

  await collection("employees").updateOne({ code }, { $set: update });
  const employee = await collection("employees").findOne({ code });
  if (!employee) return res.status(404).json({ error: "Trabajador no encontrado" });
  res.json(employee);
}));

app.delete("/api/admin/employees/:code", requireAdmin, asyncHandler(async (req, res) => {
  const code = normalizeEmployeeCode(req.params.code);
  await collection("employees").deleteOne({ code });
  res.status(204).end();
}));

app.get("/api/admin/recurring-tasks", requireAdmin, asyncHandler(async (_req, res) => {
  const tasks = await collection("recurringTasks").find({ active: true }).sort({ title: 1 }).toArray();
  res.json(tasks);
}));

app.post("/api/admin/recurring-tasks", requireAdmin, asyncHandler(async (req, res) => {
  const task = await normalizeTaskPayload(req.body, { recurring: true });
  const now = new Date();
  const doc = {
    ...task,
    startDate: todayString(),
    active: true,
    createdAt: now,
    updatedAt: now
  };

  const result = await collection("recurringTasks").insertOne(doc);
  await ensureWorkItemsForDate(todayString());
  res.status(201).json({ ...doc, _id: result.insertedId });
}));

app.delete("/api/admin/recurring-tasks/:id", requireAdmin, asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  await collection("recurringTasks").updateOne({ _id }, { $set: { active: false, updatedAt: new Date() } });
  await collection("workItems").deleteMany({ sourceType: "recurring", sourceId: String(_id), date: { $gte: todayString() } });
  res.status(204).end();
}));

app.get("/api/admin/oneoff-tasks", requireAdmin, asyncHandler(async (_req, res) => {
  const tasks = await collection("oneOffTasks").find({ active: true }).sort({ dueDate: -1, title: 1 }).toArray();
  res.json(tasks);
}));

app.post("/api/admin/oneoff-tasks", requireAdmin, asyncHandler(async (req, res) => {
  const task = await normalizeTaskPayload(req.body, { oneOff: true });
  const now = new Date();
  const doc = {
    ...task,
    active: true,
    createdAt: now,
    updatedAt: now
  };

  const result = await collection("oneOffTasks").insertOne(doc);
  await ensureWorkItemsForDate(task.dueDate);
  res.status(201).json({ ...doc, _id: result.insertedId });
}));

app.delete("/api/admin/oneoff-tasks/:id", requireAdmin, asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  await collection("oneOffTasks").updateOne({ _id }, { $set: { active: false, updatedAt: new Date() } });
  await collection("workItems").deleteMany({ sourceType: "oneOff", sourceId: String(_id), date: { $gte: todayString() } });
  res.status(204).end();
}));

app.post("/api/admin/circulars", requireAdmin, upload.single("file"), asyncHandler(async (req, res) => {
  const file = req.file || null;
  const circular = {
    title: requireText(req.body.title, "El titulo", 160),
    body: cleanText(req.body.body, 4000),
    fileName: file?.originalname || null,
    fileUrl: file ? `/uploads/${file.filename}` : null,
    fileMime: file?.mimetype || null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await collection("circulars").insertOne(circular);
  res.status(201).json({ ...circular, _id: result.insertedId });
}));

app.delete("/api/admin/circulars/:id", requireAdmin, asyncHandler(async (req, res) => {
  const _id = requireObjectId(req.params.id);
  const circular = await collection("circulars").findOne({ _id });
  await collection("circulars").deleteOne({ _id });

  if (circular?.fileUrl?.startsWith("/uploads/")) {
    const filePath = path.join(UPLOAD_DIR, path.basename(circular.fileUrl));
    await fs.unlink(filePath).catch(() => {});
  }

  res.status(204).end();
}));

app.get("/api/admin/live-work", requireAdmin, asyncHandler(async (req, res) => {
  const date = assertDateString(req.query.date || todayString());
  const workers = await liveWorkForAll(date);
  res.json({
    date,
    generatedAt: new Date(),
    workers
  });
}));

app.get("/api/admin/summaries", requireAdmin, asyncHandler(async (req, res) => {
  const date = assertDateString(req.query.date || addDays(todayString(), -1));
  if (date < todayString()) await finalizeDay(date);
  const summaries = await collection("dailySummaries").find({ date }).sort({ employeeCode: 1 }).toArray();
  res.json(summaries);
}));

app.use((err, _req, res, _next) => {
  if (err.code === 11000) {
    return res.status(409).json({ error: "Ya existe un registro con esos datos" });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(err);
  return res.status(status).json({ error: err.message || "Error del servidor" });
});

async function ensureIndexes() {
  await Promise.all([
    collection("categories").createIndex({ name: 1 }, { unique: true }),
    collection("products").createIndex({ name: 1 }, { unique: true }),
    collection("products").createIndex({ categoryId: 1, name: 1 }),
    collection("employees").createIndex({ code: 1 }, { unique: true }),
    collection("recurringTasks").createIndex({ active: 1, days: 1 }),
    collection("oneOffTasks").createIndex({ active: 1, dueDate: 1 }),
    collection("comments").createIndex({ date: 1, employeeCode: 1 }, { unique: true }),
    collection("dailySummaries").createIndex({ date: 1, employeeCode: 1 }, { unique: true }),
    collection("workItems").createIndex(
      { date: 1, sourceType: 1, sourceId: 1, targetType: 1, employeeCode: 1, shift: 1 },
      { unique: true }
    )
  ]);
}

async function start() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(MONGODB_DB);
  await ensureIndexes();

  app.listen(PORT, () => {
    console.log(`Almacen tablet disponible en http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("No se pudo arrancar la aplicacion:", error);
  process.exit(1);
});
