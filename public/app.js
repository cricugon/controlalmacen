const appEl = document.getElementById("app");
const toastEl = document.getElementById("toast");

const DAYS = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
const SHIFT_LABELS = {
  morning: "Manana",
  afternoon: "Tarde",
  both: "Manana y tarde",
  day: "Todo el dia",
  off: "Libre"
};
const PRIORITY_LABELS = {
  low: "Baja",
  medium: "Media",
  high: "Alta"
};

const state = {
  view: "stock",
  stockCategory: "all",
  workCode: "",
  workData: null,
  commentTimer: null,
  circularCode: "",
  circularEmployee: null,
  circulars: null,
  openCircularId: null,
  shift: new Date().getHours() < 15 ? "morning" : "afternoon",
  adminToken: localStorage.getItem("adminToken") || "",
  adminData: null,
  adminTab: "products",
  adminLiveTimer: null,
  summaryDate: yesterdayISO()
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

function prettyDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function taskPriority(task) {
  return PRIORITY_LABELS[task?.priority] ? task.priority : "medium";
}

function taskPriorityBadge(task) {
  const priority = taskPriority(task);
  return `<span class="priority-badge priority-${priority}">${PRIORITY_LABELS[priority]}</span>`;
}

function taskPriorityClass(task) {
  return `priority-${taskPriority(task)}`;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("es-ES") : "";
}

function selectedAttr(value, expected) {
  return value === expected ? "selected" : "";
}

function checkedAttr(value) {
  return value ? "checked" : "";
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("is-visible"), 2800);
}

function setLoading(label = "Cargando") {
  appEl.innerHTML = `<div class="loading">${escapeHtml(label)}</div>`;
}

function clearAdminLiveTimer() {
  if (state.adminLiveTimer) {
    clearInterval(state.adminLiveTimer);
    state.adminLiveTimer = null;
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const init = {
    method: options.method || "GET",
    headers
  };

  if (state.adminToken) {
    headers.Authorization = `Bearer ${state.adminToken}`;
  }

  if (options.body instanceof FormData) {
    init.body = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    if (response.status === 401 && path.startsWith("/api/admin")) {
      state.adminToken = "";
      state.adminData = null;
      localStorage.removeItem("adminToken");
    }
    throw new Error(data?.error || "Error de conexion");
  }

  return data;
}

function activateNav(view) {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
}

async function navigate(view) {
  clearAdminLiveTimer();
  state.view = view;
  activateNav(view);

  if (view === "stock") return renderStock();
  if (view === "work-login") return renderWorkLogin();
  if (view === "shift") return renderShift();
  if (view === "circulars") return renderCirculars();
  if (view === "admin") return renderAdmin();
}

async function renderStock() {
  setLoading("Cargando stock");
  try {
    const [products, categories] = await Promise.all([
      api("/api/products"),
      api("/api/categories")
    ]);
    const visibleProducts = filterProductsByCategory(products, state.stockCategory);

    appEl.innerHTML = `
      <section class="view-head">
        <div>
          <h1>Stock</h1>
          <p>${products.length} productos</p>
        </div>
        <button class="button secondary" type="button" data-refresh-view="stock">Actualizar</button>
      </section>
      ${stockCategoryTabs(products, categories)}
      ${visibleProducts.length ? `
        <section class="grid product-grid">
          ${visibleProducts.map(productCard).join("")}
        </section>
      ` : emptyState("No hay productos en esta categoria")}
    `;
  } catch (error) {
    renderError(error);
  }
}

function filterProductsByCategory(products, categoryId) {
  if (categoryId === "all") return products;
  if (categoryId === "none") return products.filter((product) => !product.categoryId);
  return products.filter((product) => product.categoryId === categoryId);
}

function stockCategoryTabs(products, categories) {
  const hasUncategorized = products.some((product) => !product.categoryId);
  const tabs = [
    { id: "all", name: "Todas" },
    ...categories.map((category) => ({ id: String(category._id), name: category.name })),
    ...(hasUncategorized ? [{ id: "none", name: "Sin categoria" }] : [])
  ];

  if (!tabs.some((tab) => tab.id === state.stockCategory)) state.stockCategory = "all";

  return `
    <nav class="category-tabs" aria-label="Categorias de stock">
      ${tabs.map((tab) => `
        <button class="${state.stockCategory === tab.id ? "is-active" : ""}" type="button" data-stock-category="${tab.id}">
          ${escapeHtml(tab.name)}
        </button>
      `).join("")}
    </nav>
  `;
}

function productCard(product) {
  return `
    <article class="product-card" data-product-id="${product._id}">
      <header>
        <h2 class="product-title">${escapeHtml(product.name)}</h2>
        <span class="product-unit">${escapeHtml(product.categoryName || "Sin categoria")} - ${escapeHtml(product.unit || "ud")}</span>
      </header>
      <div class="stock-value">
        <span class="stock-number" data-stock-value="${product._id}">${Number(product.stock || 0)}</span>
        <span class="product-unit">${escapeHtml(product.unit || "ud")}</span>
      </div>
      <div class="stock-actions">
        <button class="icon-button down" type="button" title="Bajar una unidad" data-stock-delta="-1" data-id="${product._id}">&#9660;</button>
        <button class="icon-button up" type="button" title="Subir una unidad" data-stock-delta="1" data-id="${product._id}">&#9650;</button>
      </div>
    </article>
  `;
}

async function changeStock(id, delta) {
  const valueEl = appEl.querySelector(`[data-stock-value="${id}"]`);
  const card = appEl.querySelector(`[data-product-id="${id}"]`);
  const buttons = card ? [...card.querySelectorAll("button")] : [];
  const previous = Number(valueEl?.textContent || 0);
  if (valueEl) valueEl.textContent = Math.max(0, previous + delta);
  buttons.forEach((button) => { button.disabled = true; });

  try {
    const product = await api(`/api/products/${id}/stock`, {
      method: "PATCH",
      body: { delta }
    });
    if (valueEl) valueEl.textContent = Number(product.stock || 0);
  } catch (error) {
    if (valueEl) valueEl.textContent = previous;
    showToast(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function renderWorkLogin() {
  state.workCode = "";
  state.workData = null;
  appEl.innerHTML = `
    <section class="login-panel">
      <h1>Codigo trabajador</h1>
      <div class="code-display" aria-label="Codigo introducido">
        <span class="code-cell" data-code-cell="0"></span>
        <span class="code-cell" data-code-cell="1"></span>
      </div>
      <div class="keypad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => `<button type="button" data-digit="${digit}">${digit}</button>`).join("")}
        <button type="button" data-code-clear>CLR</button>
        <button type="button" data-digit="0">0</button>
        <button type="button" data-code-back>DEL</button>
      </div>
    </section>
  `;
}

function updateCodeDisplay() {
  appEl.querySelectorAll("[data-code-cell]").forEach((cell, index) => {
    const digit = state.workCode[index] || "";
    cell.textContent = digit;
    cell.classList.toggle("is-filled", Boolean(digit));
  });
}

async function pushWorkDigit(digit) {
  if (state.workCode.length >= 2) return;
  state.workCode += String(digit);
  updateCodeDisplay();
  if (state.workCode.length === 2) {
    await loadWorkPart(state.workCode);
  }
}

async function loadWorkPart(code) {
  setLoading("Abriendo parte");
  try {
    const data = await api(`/api/work/${code}`);
    state.workData = data;
    renderWorkPart(data);
  } catch (error) {
    showToast(error.message);
    renderWorkLogin();
  }
}

function renderWorkPart(data) {
  appEl.innerHTML = `
    <section class="work-header">
      <div>
        <h1>Parte de ${escapeHtml(data.employee.name)}</h1>
        <p>${prettyDate(data.date)} - Turno ${escapeHtml(SHIFT_LABELS[data.shift] || data.shift)}</p>
      </div>
      <button class="button secondary" type="button" data-view-local="work-login">Salir</button>
    </section>
    <div class="worker-badge">${escapeHtml(data.employee.code)} - ${escapeHtml(data.employee.name)}</div>
    <section class="task-list" aria-label="Tareas del parte">
      ${data.items.length ? data.items.map(workTaskRow).join("") : emptyState("No hay tareas para hoy")}
    </section>
    <section class="comment-box">
      <label for="work-comment">Comentarios</label>
      <textarea id="work-comment" data-work-comment placeholder="Anotar tareas no previstas">${escapeHtml(data.comment || "")}</textarea>
      <p class="meta" data-comment-status>Guardado automatico</p>
    </section>
  `;
}

function isProductionTask(item) {
  return Boolean(item.production?.item && Number(item.production.target) > 0);
}

function ownQuantity(item) {
  const code = state.workData?.employee?.code;
  const entry = (item?.productionEntries || []).find((row) => row.employeeCode === code);
  return Number(entry?.quantity || 0);
}

function totalQuantity(item) {
  return Number(item?.totalQuantity || 0);
}

function workTaskRow(item) {
  if (isProductionTask(item)) return productionTaskRow(item);

  const scope = item.targetType === "shift" ? `Turno ${SHIFT_LABELS[item.shift]}` : "Individual";
  return `
    <label class="task-row ${taskPriorityClass(item)} ${item.checked ? "is-checked" : ""}" data-task-row="${item._id}">
      <input type="checkbox" data-work-check="${item._id}" ${item.checked ? "checked" : ""}>
      <span class="check-ui" aria-hidden="true"></span>
      <span>
        <span class="task-title-line"><strong class="task-title">${escapeHtml(item.title)}</strong>${taskPriorityBadge(item)}</span>
        <span class="scope">${escapeHtml(scope)}</span>
        ${item.details ? `<p class="task-details">${escapeHtml(item.details)}</p>` : ""}
      </span>
    </label>
  `;
}

function productionTaskRow(item) {
  const scope = item.targetType === "shift" ? `Turno ${SHIFT_LABELS[item.shift]}` : "Individual";
  const mine = ownQuantity(item);
  const total = totalQuantity(item);
  const target = Number(item.production.target || 0);
  const noProceed = Boolean(item.notApplicable);
  return `
    <article class="task-row production-task ${taskPriorityClass(item)} ${item.checked ? "is-checked" : ""}" data-task-row="${item._id}">
      <span class="check-ui" aria-hidden="true"></span>
      <div class="task-content">
        <span class="task-title-line"><strong class="task-title">${escapeHtml(item.title)}</strong>${taskPriorityBadge(item)}</span>
        <span class="scope">${noProceed ? "No procede" : `${escapeHtml(scope)} - ${total}/${target} ${escapeHtml(item.production.item)} - tu llevas ${mine}`}</span>
        ${item.details ? `<p class="task-details">${escapeHtml(item.details)}</p>` : ""}
        <div class="production-controls">
          <button class="qty-button" type="button" data-production-step="-1" data-id="${item._id}">-</button>
          <label class="quantity-field">
            <span>Mi cantidad</span>
            <input type="number" min="0" inputmode="numeric" value="${mine}" data-production-input="${item._id}">
          </label>
          <button class="qty-button" type="button" data-production-step="1" data-id="${item._id}">+</button>
          <button class="button primary" type="button" data-production-complete="${item._id}">Completar</button>
          <button class="button secondary" type="button" data-production-not-applicable="${item._id}">No procede</button>
        </div>
      </div>
    </article>
  `;
}

async function toggleWorkItem(id, checked) {
  const row = appEl.querySelector(`[data-task-row="${id}"]`);
  row?.classList.toggle("is-checked", checked);
  try {
    const updated = await api(`/api/work-items/${id}/toggle`, {
      method: "PATCH",
      body: {
        checked,
        employeeCode: state.workData?.employee?.code
      }
    });
    const item = state.workData.items.find((entry) => entry._id === id);
    if (item) Object.assign(item, updated);
  } catch (error) {
    row?.classList.toggle("is-checked", !checked);
    const input = appEl.querySelector(`[data-work-check="${id}"]`);
    if (input) input.checked = !checked;
    showToast(error.message);
  }
}

async function updateProduction(id, quantity, complete = false) {
  const row = appEl.querySelector(`[data-task-row="${id}"]`);
  row?.querySelectorAll("button,input").forEach((control) => { control.disabled = true; });

  try {
    const updated = await api(`/api/work-items/${id}/progress`, {
      method: "PATCH",
      body: {
        employeeCode: state.workData?.employee?.code,
        quantity,
        complete
      }
    });
    const item = state.workData.items.find((entry) => entry._id === id);
    if (item) {
      Object.assign(item, updated);
      const currentRow = appEl.querySelector(`[data-task-row="${id}"]`);
      if (currentRow) currentRow.outerHTML = workTaskRow(item);
    }
  } catch (error) {
    row?.querySelectorAll("button,input").forEach((control) => { control.disabled = false; });
    showToast(error.message);
  }
}

async function markNotApplicable(id) {
  const row = appEl.querySelector(`[data-task-row="${id}"]`);
  row?.querySelectorAll("button,input").forEach((control) => { control.disabled = true; });

  try {
    const updated = await api(`/api/work-items/${id}/not-applicable`, {
      method: "PATCH",
      body: {
        employeeCode: state.workData?.employee?.code
      }
    });
    const item = state.workData.items.find((entry) => entry._id === id);
    if (item) {
      Object.assign(item, updated);
      const currentRow = appEl.querySelector(`[data-task-row="${id}"]`);
      if (currentRow) currentRow.outerHTML = workTaskRow(item);
    }
  } catch (error) {
    row?.querySelectorAll("button,input").forEach((control) => { control.disabled = false; });
    showToast(error.message);
  }
}

function scheduleCommentSave(text) {
  clearTimeout(state.commentTimer);
  const currentWork = state.workData;
  const status = appEl.querySelector("[data-comment-status]");
  if (status) status.textContent = "Guardando";

  state.commentTimer = setTimeout(async () => {
    try {
      await api(`/api/work/${currentWork.employee.code}/comments`, {
        method: "PUT",
        body: {
          date: currentWork.date,
          text
        }
      });
      if (status) status.textContent = "Guardado automatico";
    } catch (error) {
      if (status) status.textContent = "No guardado";
      showToast(error.message);
    }
  }, 500);
}

async function renderShift() {
  setLoading("Cargando turno");
  try {
    const data = await api(`/api/shift-tasks?shift=${state.shift}`);
    appEl.innerHTML = `
      <section class="view-head">
        <div>
          <h1>Turno</h1>
          <p>${prettyDate(data.date)}</p>
        </div>
        <div class="segmented">
          <button type="button" data-shift="morning" class="${state.shift === "morning" ? "is-active" : ""}">Manana</button>
          <button type="button" data-shift="afternoon" class="${state.shift === "afternoon" ? "is-active" : ""}">Tarde</button>
        </div>
      </section>
      <div class="shift-people">
        ${data.employees.length ? data.employees.map((employee) => `<span class="pill">${escapeHtml(employee.code)} - ${escapeHtml(employee.name)}</span>`).join("") : `<span class="pill">Sin trabajadores asignados</span>`}
      </div>
      <section class="task-list">
        ${data.items.length ? data.items.map(shiftTaskRow).join("") : emptyState("No hay tareas de turno")}
      </section>
    `;
  } catch (error) {
    renderError(error);
  }
}

function shiftTaskRow(item) {
  const progress = isProductionTask(item)
    ? (item.notApplicable ? " - No procede" : ` - ${Number(item.totalQuantity || 0)}/${Number(item.production.target || 0)} ${escapeHtml(item.production.item)}`)
    : "";
  return `
    <article class="task-row ${taskPriorityClass(item)} ${item.checked ? "is-checked" : ""}">
      <span class="check-ui" aria-hidden="true"></span>
      <span>
        <span class="task-title-line"><strong class="task-title">${escapeHtml(item.title)}</strong>${taskPriorityBadge(item)}</span>
        <span class="scope">${item.checked ? "Completada" : "Pendiente"}${progress}</span>
        ${item.details ? `<p class="task-details">${escapeHtml(item.details)}</p>` : ""}
      </span>
    </article>
  `;
}

async function renderCirculars() {
  if (!state.circularEmployee) return renderCircularLogin();
  return renderCircularList();
}

function renderCircularLogin() {
  state.circularCode = "";
  state.circularEmployee = null;
  state.circulars = null;
  state.openCircularId = null;
  appEl.innerHTML = `
    <section class="login-panel">
      <h1>PIN trabajador</h1>
      <div class="code-display" aria-label="PIN introducido">
        <span class="code-cell" data-circular-code-cell="0"></span>
        <span class="code-cell" data-circular-code-cell="1"></span>
      </div>
      <div class="keypad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => `<button type="button" data-circular-digit="${digit}">${digit}</button>`).join("")}
        <button type="button" data-circular-code-clear>CLR</button>
        <button type="button" data-circular-digit="0">0</button>
        <button type="button" data-circular-code-back>DEL</button>
      </div>
    </section>
  `;
}

function updateCircularCodeDisplay() {
  appEl.querySelectorAll("[data-circular-code-cell]").forEach((cell, index) => {
    const digit = state.circularCode[index] || "";
    cell.textContent = digit;
    cell.classList.toggle("is-filled", Boolean(digit));
  });
}

async function pushCircularDigit(digit) {
  if (state.circularCode.length >= 2) return;
  state.circularCode += String(digit);
  updateCircularCodeDisplay();
  if (state.circularCode.length === 2) {
    await loadCircularsForWorker(state.circularCode);
  }
}

async function loadCircularsForWorker(code) {
  setLoading("Cargando circulares");
  try {
    const data = await api(`/api/circulars?employeeCode=${encodeURIComponent(code)}`);
    state.circularEmployee = data.employee;
    state.circulars = data.circulars || [];
    state.openCircularId = null;
    renderCircularList();
  } catch (error) {
    showToast(error.message);
    renderCircularLogin();
  }
}

function renderCircularList() {
  const circulars = state.circulars || [];
  appEl.innerHTML = `
      <section class="view-head">
        <div>
          <h1>Circulares</h1>
          <p>${escapeHtml(state.circularEmployee.code)} - ${escapeHtml(state.circularEmployee.name)} - ${circulars.length} publicaciones</p>
        </div>
        <div class="button-row">
          <button class="button secondary" type="button" data-circular-reload>Actualizar</button>
          <button class="button secondary" type="button" data-circular-logout>Salir</button>
        </div>
      </section>
      ${circulars.length ? `
        <section class="grid notice-grid">
          ${circulars.map(circularCard).join("")}
        </section>
      ` : emptyState("No hay circulares publicadas")}
    `;
}

function circularCard(circular) {
  const isOpen = state.openCircularId === String(circular._id);
  return `
    <article class="notice-card ${circular.viewed ? "is-viewed" : ""}">
      <div class="notice-head">
        <h3>${escapeHtml(circular.title)}</h3>
        <span class="read-pill ${circular.viewed ? "done" : "pending"}">${circular.viewed ? "Vista" : "No vista"}</span>
      </div>
      ${isOpen ? `
        ${circular.body ? `<p>${escapeHtml(circular.body)}</p>` : ""}
        ${circular.fileUrl ? `<a class="button secondary" href="${escapeHtml(circular.fileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(circular.fileName || "Abrir archivo")}</a>` : ""}
      ` : `<button class="button primary" type="button" data-circular-open="${circular._id}">Abrir circular</button>`}
      <p class="meta">${formatDateTime(circular.createdAt)}${circular.viewedAt ? ` - vista ${formatDateTime(circular.viewedAt)}` : ""}</p>
    </article>
  `;
}

async function openCircular(id) {
  try {
    const updated = await api(`/api/circulars/${id}/read`, {
      method: "POST",
      body: {
        employeeCode: state.circularEmployee?.code
      }
    });
    const circular = state.circulars.find((entry) => entry._id === id);
    if (circular) Object.assign(circular, updated);
    state.openCircularId = id;
    renderCircularList();
  } catch (error) {
    showToast(error.message);
  }
}

async function renderAdmin() {
  if (!state.adminToken) {
    state.adminData = null;
    appEl.innerHTML = `
      <section class="login-panel">
        <h1>Administracion</h1>
        <form data-admin-form="login" class="form-grid">
          <label class="field">
            <span>PIN</span>
            <input name="pin" type="password" inputmode="numeric" autocomplete="off" required>
          </label>
          <button class="button primary" type="submit">Entrar</button>
        </form>
      </section>
    `;
    return;
  }

  setLoading("Cargando admin");
  try {
    if (!state.adminData) {
      const [products, categories, employees, recurring, oneOff, circulars] = await Promise.all([
        api("/api/products"),
        api("/api/categories"),
        api("/api/admin/employees"),
        api("/api/admin/recurring-tasks"),
        api("/api/admin/oneoff-tasks"),
        api("/api/admin/circulars")
      ]);
      state.adminData = { products, categories, employees, recurring, oneOff, circulars, liveWork: null, summaries: null };
    }

    if (state.adminTab === "summaries") {
      const [liveWork, summaries] = await Promise.all([
        api("/api/admin/live-work"),
        api(`/api/admin/summaries?date=${state.summaryDate}`)
      ]);
      state.adminData.liveWork = liveWork;
      state.adminData.summaries = summaries;
    } else {
      clearAdminLiveTimer();
    }

    appEl.innerHTML = `
      <section class="view-head">
        <div>
          <h1>Administracion</h1>
          <p>PIN activo</p>
        </div>
        <button class="button secondary" type="button" data-admin-logout>Salir</button>
      </section>
      <nav class="admin-tabs">
        ${adminTabButton("products", "Productos")}
        ${adminTabButton("employees", "Trabajadores")}
        ${adminTabButton("recurring", "Diarias")}
        ${adminTabButton("oneoff", "Puntuales")}
        ${adminTabButton("circulars", "Circulares")}
        ${adminTabButton("summaries", "Partes")}
      </nav>
      <section class="admin-layout">
        ${renderAdminTab()}
      </section>
    `;
    syncAllTargetBlocks();
    configureAdminLiveRefresh();
  } catch (error) {
    renderError(error);
  }
}

function adminTabButton(tab, label) {
  return `<button class="button ${state.adminTab === tab ? "primary" : "secondary"}" type="button" data-admin-tab="${tab}">${label}</button>`;
}

function renderAdminTab() {
  if (state.adminTab === "products") return renderAdminProducts();
  if (state.adminTab === "employees") return renderAdminEmployees();
  if (state.adminTab === "recurring") return renderAdminRecurring();
  if (state.adminTab === "oneoff") return renderAdminOneOff();
  if (state.adminTab === "circulars") return renderAdminCirculars();
  if (state.adminTab === "summaries") return renderAdminSummaries();
  return "";
}

function renderAdminProducts() {
  const { products, categories } = state.adminData;
  return `
    <article class="admin-card">
      <h3>Categorias</h3>
      <form data-admin-form="category-create" class="form-grid">
        <label class="field"><span>Nombre categoria</span><input name="name" required></label>
        <button class="button primary" type="submit">Crear categoria</button>
      </form>
      <div class="inline-list">
        ${categories.length ? categories.map((category) => `
          <span class="pill">${escapeHtml(category.name)} <button type="button" data-admin-delete="category" data-id="${category._id}">x</button></span>
        `).join("") : `<span class="meta">Sin categorias</span>`}
      </div>
    </article>
    <article class="admin-card">
      <h3>Nuevo producto</h3>
      <form data-admin-form="product-create" class="form-grid">
        <label class="field"><span>Nombre</span><input name="name" required></label>
        <label class="field"><span>Categoria</span><select name="categoryId">${categoryOptions("")}</select></label>
        <label class="field"><span>Unidad</span><input name="unit" value="ud"></label>
        <label class="field"><span>Stock inicial</span><input name="stock" type="number" min="0" value="0"></label>
        <button class="button primary" type="submit">Anadir</button>
      </form>
    </article>
    <section class="admin-list">
      ${products.length ? products.map(productEditCard).join("") : emptyState("Sin productos")}
    </section>
  `;
}

function categoryOptions(selected) {
  const options = [`<option value="" ${!selected ? "selected" : ""}>Sin categoria</option>`];
  options.push(...state.adminData.categories.map((category) => `
    <option value="${category._id}" ${selected === String(category._id) ? "selected" : ""}>${escapeHtml(category.name)}</option>
  `));
  return options.join("");
}

function productEditCard(product) {
  return `
    <form class="admin-card compact-form" data-admin-form="product-update" data-id="${product._id}">
      <div class="form-grid">
        <label class="field"><span>Nombre</span><input name="name" value="${escapeHtml(product.name)}" required></label>
        <label class="field"><span>Categoria</span><select name="categoryId">${categoryOptions(product.categoryId || "")}</select></label>
        <label class="field"><span>Unidad</span><input name="unit" value="${escapeHtml(product.unit || "ud")}"></label>
        <label class="field"><span>Stock</span><input name="stock" type="number" min="0" value="${Number(product.stock || 0)}"></label>
      </div>
      <div class="admin-actions">
        <button class="button primary" type="submit">Guardar</button>
        <button class="button danger" type="button" data-admin-delete="product" data-id="${product._id}">Eliminar</button>
      </div>
    </form>
  `;
}

function renderAdminEmployees() {
  const employees = state.adminData.employees;
  return `
    <article class="admin-card">
      <h3>Nuevo trabajador</h3>
      <form data-admin-form="employee-create" class="stack-form">
        <div class="form-grid">
          <label class="field"><span>Codigo</span><input name="code" inputmode="numeric" maxlength="2" required></label>
          <label class="field"><span>Nombre</span><input name="name" required></label>
        </div>
        <div class="shift-week">${shiftSelects({})}</div>
        <button class="button primary" type="submit">Anadir</button>
      </form>
    </article>
    <section class="admin-list">
      ${employees.length ? employees.map(employeeEditCard).join("") : emptyState("Sin trabajadores")}
    </section>
  `;
}

function employeeEditCard(employee) {
  return `
    <form class="admin-card stack-form" data-admin-form="employee-update" data-code="${employee.code}">
      <div class="form-grid">
        <label class="field"><span>Codigo</span><input value="${escapeHtml(employee.code)}" disabled></label>
        <label class="field"><span>Nombre</span><input name="name" value="${escapeHtml(employee.name)}" required></label>
      </div>
      <div class="shift-week">${shiftSelects(employee.shifts || {})}</div>
      <div class="admin-actions">
        <button class="button primary" type="submit">Guardar</button>
        <button class="button danger" type="button" data-admin-delete="employee" data-code="${employee.code}">Eliminar</button>
      </div>
    </form>
  `;
}

function shiftSelects(shifts) {
  return DAYS.map((day, index) => `
    <label class="field">
      <span>${day}</span>
      <select name="shift-${index}">
        <option value="off" ${shifts[String(index)] === "off" ? "selected" : ""}>Libre</option>
        <option value="morning" ${shifts[String(index)] === "morning" ? "selected" : ""}>Manana</option>
        <option value="afternoon" ${shifts[String(index)] === "afternoon" ? "selected" : ""}>Tarde</option>
        <option value="both" ${shifts[String(index)] === "both" ? "selected" : ""}>Ambos</option>
      </select>
    </label>
  `).join("");
}

function renderAdminRecurring() {
  return `
    <article class="admin-card">
      <h3>Tarea diaria programada</h3>
      <form data-admin-form="recurring-create" class="stack-form task-form">
        <div class="form-grid">${taskCommonFields()}</div>
        <div class="form-grid">${taskProductionFields()}</div>
        <div class="day-picker">${DAYS.map((day, index) => `
          <label class="day-check">${day}<input type="checkbox" name="days" value="${index}"></label>
        `).join("")}</div>
        <button class="button primary" type="submit">Crear</button>
      </form>
    </article>
    <section class="admin-list">
      ${state.adminData.recurring.length ? state.adminData.recurring.map(recurringTaskEditCard).join("") : emptyState("Sin tareas diarias")}
    </section>
  `;
}

function renderAdminOneOff() {
  return `
    <article class="admin-card">
      <h3>Tarea puntual</h3>
      <form data-admin-form="oneoff-create" class="stack-form task-form">
        <div class="form-grid">${taskCommonFields()}</div>
        <div class="form-grid">
          ${taskProductionFields()}
          <label class="field"><span>Fecha</span><input name="dueDate" type="date" value="${todayISO()}" required></label>
        </div>
        <button class="button primary" type="submit">Crear</button>
      </form>
    </article>
    <section class="admin-list">
      ${state.adminData.oneOff.length ? state.adminData.oneOff.map(oneOffTaskEditCard).join("") : emptyState("Sin tareas puntuales")}
    </section>
  `;
}

function recurringTaskEditCard(task) {
  return `
    <form class="admin-card stack-form task-form" data-admin-form="recurring-update" data-id="${task._id}">
      <div class="section-head compact">
        <div>
          <h3>${escapeHtml(task.title)}</h3>
          <p class="meta">${taskTargetLabel(task)} - ${task.days.map((day) => DAYS[day]).join(", ")}${taskProductionLabel(task)}</p>
        </div>
        ${taskPriorityBadge(task)}
      </div>
      <div class="form-grid">${taskCommonFields(task)}</div>
      <div class="form-grid">${taskProductionFields(task)}</div>
      <div class="day-picker">${DAYS.map((day, index) => `
        <label class="day-check">${day}<input type="checkbox" name="days" value="${index}" ${checkedAttr((task.days || []).includes(index))}></label>
      `).join("")}</div>
      <div class="admin-actions">
        <button class="button primary" type="submit">Guardar</button>
        <button class="button danger" type="button" data-admin-delete="recurring" data-id="${task._id}">Eliminar</button>
      </div>
    </form>
  `;
}

function oneOffTaskEditCard(task) {
  return `
    <form class="admin-card stack-form task-form" data-admin-form="oneoff-update" data-id="${task._id}">
      <div class="section-head compact">
        <div>
          <h3>${escapeHtml(task.title)}</h3>
          <p class="meta">${prettyDate(task.dueDate)} - ${taskTargetLabel(task)}${taskProductionLabel(task)}</p>
        </div>
        ${taskPriorityBadge(task)}
      </div>
      <div class="form-grid">${taskCommonFields(task)}</div>
      <div class="form-grid">
        ${taskProductionFields(task)}
        <label class="field"><span>Fecha</span><input name="dueDate" type="date" value="${escapeHtml(task.dueDate || todayISO())}" required></label>
      </div>
      <div class="admin-actions">
        <button class="button primary" type="submit">Guardar</button>
        <button class="button danger" type="button" data-admin-delete="oneoff" data-id="${task._id}">Eliminar</button>
      </div>
    </form>
  `;
}

function taskCommonFields(task = {}) {
  const employees = state.adminData.employees;
  const priority = taskPriority(task);
  const targetType = task.targetType || "shift";
  const shift = task.shift || "morning";
  const employeeCode = task.employeeCode || employees[0]?.code || "";
  return `
    <label class="field"><span>Tarea</span><input name="title" value="${escapeHtml(task.title || "")}" required></label>
    <label class="field"><span>Detalle</span><textarea name="details">${escapeHtml(task.details || "")}</textarea></label>
    <label class="field">
      <span>Prioridad</span>
      <select name="priority">
        <option value="low" ${selectedAttr(priority, "low")}>Baja</option>
        <option value="medium" ${selectedAttr(priority, "medium")}>Media</option>
        <option value="high" ${selectedAttr(priority, "high")}>Alta</option>
      </select>
    </label>
    <label class="field">
      <span>Destino</span>
      <select name="targetType" data-target-type>
        <option value="shift" ${selectedAttr(targetType, "shift")}>Turno</option>
        <option value="employee" ${selectedAttr(targetType, "employee")}>Trabajador</option>
      </select>
    </label>
    <label class="field target-shift">
      <span>Turno</span>
      <select name="shift">
        <option value="morning" ${selectedAttr(shift, "morning")}>Manana</option>
        <option value="afternoon" ${selectedAttr(shift, "afternoon")}>Tarde</option>
        <option value="day" ${selectedAttr(shift, "day")}>Todo el dia</option>
      </select>
    </label>
    <label class="field target-employee is-hidden">
      <span>Trabajador</span>
      <select name="employeeCode">
        ${employees.map((employee) => `<option value="${employee.code}" ${selectedAttr(employeeCode, employee.code)}>${escapeHtml(employee.code)} - ${escapeHtml(employee.name)}</option>`).join("")}
      </select>
    </label>
  `;
}

function taskProductionFields(task = {}) {
  const production = task.production || {};
  return `
    <label class="field"><span>Item productividad</span><input name="productionItem" placeholder="Ej. bowls pequenos" value="${escapeHtml(production.item || "")}"></label>
    <label class="field"><span>Cantidad objetivo</span><input name="productionTarget" type="number" min="0" value="${Number(production.target || 0)}"></label>
  `;
}

function taskTargetLabel(task) {
  if (task.targetType === "shift") return `Turno ${SHIFT_LABELS[task.shift]}`;
  const employee = state.adminData.employees.find((entry) => entry.code === task.employeeCode);
  return employee ? `${employee.code} - ${employee.name}` : `Trabajador ${task.employeeCode}`;
}

function taskProductionLabel(task) {
  return task.production ? ` - ${task.production.target} ${task.production.item}` : "";
}

function renderAdminCirculars() {
  return `
    <article class="admin-card">
      <h3>Nueva circular</h3>
      <form data-admin-form="circular-create" class="form-grid">
        <label class="field"><span>Titulo</span><input name="title" required></label>
        <label class="field"><span>Texto</span><textarea name="body"></textarea></label>
        <label class="field"><span>Archivo</span><input name="file" type="file"></label>
        <button class="button primary" type="submit">Publicar</button>
      </form>
    </article>
    <section class="admin-list">
      ${state.adminData.circulars.length ? state.adminData.circulars.map(adminCircularItem).join("") : emptyState("Sin circulares")}
    </section>
  `;
}

function adminCircularItem(circular) {
  const readBy = circular.readBy || [];
  const unreadBy = circular.unreadBy || [];
  const readNames = readBy.length
    ? readBy.map((read) => `${read.employeeCode} - ${read.employeeName || ""}`.trim()).join(", ")
    : "Nadie";
  const unreadNames = unreadBy.length
    ? unreadBy.map((employee) => `${employee.employeeCode} - ${employee.employeeName}`.trim()).join(", ")
    : "Todos la han visto";

  return `
    <article class="admin-item circular-admin-item">
      <span>
        <strong>${escapeHtml(circular.title)}</strong>
        <span class="meta">${circular.fileName ? escapeHtml(circular.fileName) : "Sin archivo"} - Vista por ${Number(circular.readCount || 0)}/${Number(circular.totalEmployees || 0)}</span>
        <details class="read-details">
          <summary>Control de lectura</summary>
          <p><strong>Vistas:</strong> ${escapeHtml(readNames)}</p>
          <p><strong>No vistas:</strong> ${escapeHtml(unreadNames)}</p>
        </details>
      </span>
      <button class="button danger" type="button" data-admin-delete="circular" data-id="${circular._id}">Eliminar</button>
    </article>
  `;
}

function renderAdminSummaries() {
  const liveWork = state.adminData.liveWork;
  const summaries = state.adminData.summaries || [];
  return `
    <article class="admin-card">
      <div class="section-head">
        <div>
          <h3>Partes en tiempo real</h3>
          <p class="meta" data-live-work-meta>${liveWork ? `${prettyDate(liveWork.date)} - actualizado ${new Date(liveWork.generatedAt).toLocaleTimeString("es-ES")}` : "Cargando"}</p>
        </div>
        <button class="button secondary" type="button" data-admin-live-refresh>Actualizar</button>
      </div>
    </article>
    <section class="grid live-work-grid" data-live-work-list>
      ${liveWork?.workers?.length ? liveWork.workers.map(liveWorkCard).join("") : emptyState("Sin trabajadores")}
    </section>
    <article class="admin-card">
      <h3>Partes cerrados</h3>
      <form data-admin-form="summary-date" class="form-grid">
        <label class="field"><span>Fecha</span><input name="date" type="date" value="${state.summaryDate}" required></label>
        <button class="button primary" type="submit">Ver</button>
      </form>
    </article>
    <section class="grid">
      ${summaries.length ? summaries.map(summaryCard).join("") : emptyState("Sin partes para esa fecha")}
    </section>
  `;
}

function liveWorkCard(worker) {
  return `
    <article class="summary-card">
      <div class="section-head compact">
        <div>
          <h3>${escapeHtml(worker.employee.code)} - ${escapeHtml(worker.employee.name)}</h3>
          <p>${escapeHtml(SHIFT_LABELS[worker.shift] || worker.shift)} - ${worker.completed}/${worker.total} hechas</p>
        </div>
        <span class="status-pill ${worker.pending ? "pending" : "done"}">${worker.pending ? `${worker.pending} pendientes` : "Completo"}</span>
      </div>
      ${worker.items.length ? `<ul>${worker.items.map(liveTaskLine).join("")}</ul>` : `<p class="meta">Sin tareas para hoy</p>`}
      ${worker.comment ? `<p><strong>Comentario:</strong> ${escapeHtml(worker.comment)}</p>` : ""}
    </article>
  `;
}

function liveTaskLine(task) {
  const production = task.production
    ? (task.notApplicable ? " - No procede" : ` - ${Number(task.employeeQuantity || 0)} propios / ${Number(task.totalQuantity || 0)} total de ${Number(task.production.target || 0)} ${escapeHtml(task.production.item)}`)
    : "";
  const scope = task.targetType === "shift" ? `Turno ${SHIFT_LABELS[task.shift]}` : "Individual";
  return `<li>${task.checked ? "OK" : "NO"} - ${escapeHtml(task.title)} ${taskPriorityBadge(task)} <span class="meta">(${escapeHtml(scope)}${production})</span></li>`;
}

function configureAdminLiveRefresh() {
  clearAdminLiveTimer();
  if (state.view !== "admin" || state.adminTab !== "summaries") return;
  state.adminLiveTimer = setInterval(() => {
    refreshLiveWorkPanel(false);
  }, 5000);
}

async function refreshLiveWorkPanel(showMessage = true) {
  if (state.view !== "admin" || state.adminTab !== "summaries" || !state.adminData) return;
  try {
    const liveWork = await api("/api/admin/live-work");
    state.adminData.liveWork = liveWork;
    const list = appEl.querySelector("[data-live-work-list]");
    if (list) {
      list.innerHTML = liveWork.workers.length ? liveWork.workers.map(liveWorkCard).join("") : emptyState("Sin trabajadores");
    }
    const meta = appEl.querySelector("[data-live-work-meta]");
    if (meta) {
      meta.textContent = `${prettyDate(liveWork.date)} - actualizado ${new Date(liveWork.generatedAt).toLocaleTimeString("es-ES")}`;
    }
    if (showMessage) showToast("Partes actualizados");
  } catch (error) {
    if (showMessage) showToast(error.message);
  }
}

function summaryCard(summary) {
  return `
    <article class="summary-card">
      <h3>${escapeHtml(summary.employeeCode)} - ${escapeHtml(summary.employeeName)}</h3>
      <p>${prettyDate(summary.date)} - Turno ${escapeHtml(SHIFT_LABELS[summary.shift] || summary.shift)} - ${summary.completed}/${summary.total} hechas</p>
      <ul>
        ${summary.tasks.map(summaryTaskLine).join("")}
      </ul>
      ${summary.comment ? `<p><strong>Comentario:</strong> ${escapeHtml(summary.comment)}</p>` : ""}
    </article>
  `;
}

function summaryTaskLine(task) {
  const production = task.production
    ? (task.notApplicable ? " - No procede" : ` - ${Number(task.employeeQuantity || 0)} propios / ${Number(task.totalQuantity || 0)} total de ${Number(task.production.target || 0)} ${escapeHtml(task.production.item)}`)
    : "";
  return `<li>${task.checked ? "OK" : "NO"} - ${escapeHtml(task.title)} ${taskPriorityBadge(task)}${production}</li>`;
}

function syncAllTargetBlocks() {
  appEl.querySelectorAll(".task-form").forEach(syncTargetBlocks);
}

function syncTargetBlocks(form) {
  const targetType = form.querySelector("[data-target-type]")?.value || "shift";
  form.querySelectorAll(".target-shift").forEach((element) => element.classList.toggle("is-hidden", targetType !== "shift"));
  form.querySelectorAll(".target-employee").forEach((element) => element.classList.toggle("is-hidden", targetType !== "employee"));
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderError(error) {
  appEl.innerHTML = `
    <section class="empty-state">
      <h2>No se pudo cargar</h2>
      <p>${escapeHtml(error.message)}</p>
      <button class="button secondary" type="button" data-refresh-view="${state.view}">Reintentar</button>
    </section>
  `;
}

function formJson(form) {
  const data = new FormData(form);
  return Object.fromEntries(data.entries());
}

function shiftsFromForm(form) {
  const data = new FormData(form);
  const shifts = {};
  DAYS.forEach((_day, index) => {
    shifts[String(index)] = data.get(`shift-${index}`) || "off";
  });
  return shifts;
}

function taskPayloadFromForm(form, extra = {}) {
  const data = new FormData(form);
  return {
    title: data.get("title"),
    details: data.get("details"),
    priority: data.get("priority"),
    targetType: data.get("targetType"),
    employeeCode: data.get("employeeCode"),
    shift: data.get("shift"),
    productionItem: data.get("productionItem"),
    productionTarget: Number(data.get("productionTarget") || 0),
    ...extra
  };
}

async function handleAdminSubmit(form) {
  const kind = form.dataset.adminForm;

  if (kind === "login") {
    const payload = formJson(form);
    const data = await api("/api/admin/login", {
      method: "POST",
      body: { pin: payload.pin }
    });
    state.adminToken = data.token;
    localStorage.setItem("adminToken", data.token);
    state.adminData = null;
    return renderAdmin();
  }

  if (kind === "summary-date") {
    const payload = formJson(form);
    state.summaryDate = payload.date;
    return renderAdmin();
  }

  if (kind === "category-create") {
    const payload = formJson(form);
    await api("/api/admin/categories", {
      method: "POST",
      body: { name: payload.name }
    });
  }

  if (kind === "product-create") {
    const payload = formJson(form);
    await api("/api/products", {
      method: "POST",
      body: {
        name: payload.name,
        categoryId: payload.categoryId,
        unit: payload.unit,
        stock: Number(payload.stock || 0)
      }
    });
  }

  if (kind === "product-update") {
    const payload = formJson(form);
    await api(`/api/products/${form.dataset.id}`, {
      method: "PUT",
      body: {
        name: payload.name,
        categoryId: payload.categoryId,
        unit: payload.unit,
        stock: Number(payload.stock || 0)
      }
    });
  }

  if (kind === "employee-create") {
    const payload = formJson(form);
    await api("/api/admin/employees", {
      method: "POST",
      body: {
        code: payload.code,
        name: payload.name,
        shifts: shiftsFromForm(form)
      }
    });
  }

  if (kind === "employee-update") {
    const payload = formJson(form);
    await api(`/api/admin/employees/${form.dataset.code}`, {
      method: "PUT",
      body: {
        name: payload.name,
        shifts: shiftsFromForm(form)
      }
    });
  }

  if (kind === "recurring-create") {
    const data = new FormData(form);
    await api("/api/admin/recurring-tasks", {
      method: "POST",
      body: taskPayloadFromForm(form, { days: data.getAll("days") })
    });
  }

  if (kind === "recurring-update") {
    const data = new FormData(form);
    await api(`/api/admin/recurring-tasks/${form.dataset.id}`, {
      method: "PUT",
      body: taskPayloadFromForm(form, { days: data.getAll("days") })
    });
  }

  if (kind === "oneoff-create") {
    const data = new FormData(form);
    await api("/api/admin/oneoff-tasks", {
      method: "POST",
      body: taskPayloadFromForm(form, { dueDate: data.get("dueDate") })
    });
  }

  if (kind === "oneoff-update") {
    const data = new FormData(form);
    await api(`/api/admin/oneoff-tasks/${form.dataset.id}`, {
      method: "PUT",
      body: taskPayloadFromForm(form, { dueDate: data.get("dueDate") })
    });
  }

  if (kind === "circular-create") {
    await api("/api/admin/circulars", {
      method: "POST",
      body: new FormData(form)
    });
  }

  state.adminData = null;
  showToast("Guardado");
  return renderAdmin();
}

async function deleteAdminItem(type, idOrCode) {
  const paths = {
    category: `/api/admin/categories/${idOrCode}`,
    product: `/api/products/${idOrCode}`,
    employee: `/api/admin/employees/${idOrCode}`,
    recurring: `/api/admin/recurring-tasks/${idOrCode}`,
    oneoff: `/api/admin/oneoff-tasks/${idOrCode}`,
    circular: `/api/admin/circulars/${idOrCode}`
  };

  if (!paths[type]) return;
  if (!window.confirm("Eliminar este registro?")) return;

  try {
    await api(paths[type], { method: "DELETE" });
    state.adminData = null;
    showToast("Eliminado");
    await renderAdmin();
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector(".main-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  navigate(button.dataset.view);
});

appEl.addEventListener("click", async (event) => {
  const stockCategory = event.target.closest("[data-stock-category]");
  if (stockCategory) {
    state.stockCategory = stockCategory.dataset.stockCategory;
    return renderStock();
  }

  const stockButton = event.target.closest("[data-stock-delta]");
  if (stockButton) {
    return changeStock(stockButton.dataset.id, Number(stockButton.dataset.stockDelta));
  }

  const digit = event.target.closest("[data-digit]");
  if (digit) {
    return pushWorkDigit(digit.dataset.digit);
  }

  const circularDigit = event.target.closest("[data-circular-digit]");
  if (circularDigit) {
    return pushCircularDigit(circularDigit.dataset.circularDigit);
  }

  if (event.target.closest("[data-code-clear]")) {
    state.workCode = "";
    return updateCodeDisplay();
  }

  if (event.target.closest("[data-code-back]")) {
    state.workCode = state.workCode.slice(0, -1);
    return updateCodeDisplay();
  }

  if (event.target.closest("[data-circular-code-clear]")) {
    state.circularCode = "";
    return updateCircularCodeDisplay();
  }

  if (event.target.closest("[data-circular-code-back]")) {
    state.circularCode = state.circularCode.slice(0, -1);
    return updateCircularCodeDisplay();
  }

  const localView = event.target.closest("[data-view-local]");
  if (localView) {
    return navigate(localView.dataset.viewLocal);
  }

  const stepButton = event.target.closest("[data-production-step]");
  if (stepButton) {
    const id = stepButton.dataset.id;
    const item = state.workData.items.find((entry) => entry._id === id);
    return updateProduction(id, ownQuantity(item) + Number(stepButton.dataset.productionStep || 0));
  }

  const completeButton = event.target.closest("[data-production-complete]");
  if (completeButton) {
    return updateProduction(completeButton.dataset.productionComplete, 0, true);
  }

  const notApplicableButton = event.target.closest("[data-production-not-applicable]");
  if (notApplicableButton) {
    return markNotApplicable(notApplicableButton.dataset.productionNotApplicable);
  }

  const circularOpen = event.target.closest("[data-circular-open]");
  if (circularOpen) {
    return openCircular(circularOpen.dataset.circularOpen);
  }

  if (event.target.closest("[data-circular-reload]")) {
    return loadCircularsForWorker(state.circularEmployee?.code || "");
  }

  if (event.target.closest("[data-circular-logout]")) {
    state.circularCode = "";
    state.circularEmployee = null;
    state.circulars = null;
    state.openCircularId = null;
    return renderCircularLogin();
  }

  const shiftButton = event.target.closest("[data-shift]");
  if (shiftButton) {
    state.shift = shiftButton.dataset.shift;
    return renderShift();
  }

  const refresh = event.target.closest("[data-refresh-view]");
  if (refresh) {
    return navigate(refresh.dataset.refreshView);
  }

  if (event.target.closest("[data-admin-live-refresh]")) {
    return refreshLiveWorkPanel(true);
  }

  const tab = event.target.closest("[data-admin-tab]");
  if (tab) {
    state.adminTab = tab.dataset.adminTab;
    return renderAdmin();
  }

  if (event.target.closest("[data-admin-logout]")) {
    clearAdminLiveTimer();
    state.adminToken = "";
    state.adminData = null;
    localStorage.removeItem("adminToken");
    return renderAdmin();
  }

  const deleteButton = event.target.closest("[data-admin-delete]");
  if (deleteButton) {
    return deleteAdminItem(deleteButton.dataset.adminDelete, deleteButton.dataset.id || deleteButton.dataset.code);
  }
});

appEl.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-work-check]");
  if (checkbox) {
    return toggleWorkItem(checkbox.dataset.workCheck, checkbox.checked);
  }

  const productionInput = event.target.closest("[data-production-input]");
  if (productionInput) {
    return updateProduction(productionInput.dataset.productionInput, Number(productionInput.value || 0));
  }

  const targetType = event.target.closest("[data-target-type]");
  if (targetType) {
    return syncTargetBlocks(targetType.closest("form"));
  }
});

appEl.addEventListener("input", (event) => {
  const comment = event.target.closest("[data-work-comment]");
  if (comment && state.workData) {
    scheduleCommentSave(comment.value);
  }
});

appEl.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();

  try {
    if (form.dataset.adminForm) {
      await handleAdminSubmit(form);
    }
  } catch (error) {
    showToast(error.message);
  }
});

navigate("stock");
