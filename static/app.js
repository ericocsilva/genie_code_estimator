"use strict";

// ---------------------------------------------------------------------------
// Constantes de pricing (fonte: docs "Monitor and understand your Genie cost"
// e "Genie consumption guide", atualizados em set/2026)
// ---------------------------------------------------------------------------
const PROMO_END = "2027-01";      // promoção de 25% vale até 31/01/2027
const PROMO_FACTOR = 0.75;
const STORAGE_KEY = "genie-code-estimator-v1";

const CHECKLIST = [
  {
    group: "Escopo e pessoas",
    items: [
      { id: "users", q: "Quantas pessoas vão usar Genie Code no projeto, e com qual perfil (engenharia de dados, ciência de dados, analistas)?", why: "Base da estimativa: o custo é por usuário, separado por persona." },
      { id: "tasks", q: "Quais tarefas principais? (construir pipelines, migrar código, notebooks exploratórios, dashboards, debug)", why: "Tarefas agênticas longas consomem muito mais do que perguntas pontuais." },
      { id: "freq", q: "Frequência de uso esperada e duração do projeto?", why: "Define o horizonte e a rampa de adoção." },
      { id: "baseline", q: "Existe time ou projeto atual com uso de Genie Code parecido que sirva de baseline?", why: "Se sim, use a Query 1 (passo 2). Se não, recomende um piloto de 14 a 30 dias." },
    ],
  },
  {
    group: "Identidade e automação",
    items: [
      { id: "identity", q: "Os usuários vão acessar com identidade individual?", why: "O free tier de 150 DBU/mês vale só para usuários identificados." },
      { id: "sp", q: "Haverá uso de Genie Code por service principal ou automação (jobs, agentes)?", why: "Service principals não têm free tier: todo o consumo é cobrado." },
    ],
  },
  {
    group: "Comercial",
    items: [
      { id: "region", q: "Cloud e região do(s) workspace(s) do projeto?", why: "O preço do SKU Serverless Real-Time Inference varia por região." },
      { id: "discount", q: "Qual o desconto contratual sobre o SKU Serverless Real-Time Inference?", why: "Aplicado sobre o preço list." },
      { id: "fx", q: "Qual câmbio de referência o time de infra usa no orçamento?", why: "Para apresentar o valor em R$." },
    ],
  },
  {
    group: "Compute e governança",
    items: [
      { id: "compute", q: "Onde vai rodar o que o Genie Code gerar (SQL Warehouse, Jobs, Serverless, clusters)? Isso já está orçado?", why: "Esse compute é cobrado à parte e não entra no budget de Genie." },
      { id: "budget", q: "Qual o teto de gasto aprovado e quem aprova limites maiores para power users?", why: "Base para configurar os Budgets de Genie (teto compartilhado + limite por usuário)." },
      { id: "context", q: "Existem workspace instructions, skills e comentários de tabelas no Unity Catalog?", why: "Bom contexto reduz a exploração do agente e, com isso, o consumo." },
    ],
  },
];

const SQL_BASELINE = `-- DBU BRUTO de Genie Code por usuário/mês (humanos), com percentis.
-- O DBU pago já vem com o desconto promocional de 25% aplicado na medição
-- (até jan/2027); dividimos por 0,75 para voltar ao consumo bruto.
-- O SKU GENIE_FREE_USAGE só existe a partir de 20/07/2026, por isso usamos meses completos a partir de ago/2026.
WITH por_usuario AS (
  SELECT
    DATE_TRUNC('MONTH', usage_date)  AS mes,
    identity_metadata.run_as         AS usuario,
    SUM(CASE WHEN sku_name =  'GENIE_FREE_USAGE' THEN usage_quantity ELSE 0 END) AS free_dbus,
    SUM(CASE WHEN sku_name != 'GENIE_FREE_USAGE' THEN usage_quantity ELSE 0 END) AS paid_dbus
  FROM system.billing.usage
  WHERE billing_origin_product = 'GENIE'
    AND usage_metadata.genie.surface = 'GENIE_CODE'
    AND identity_metadata.run_as LIKE '%@%'          -- exclui service principals
    AND usage_date >= '2026-08-01'
    AND usage_date <  DATE_TRUNC('MONTH', CURRENT_DATE)
  GROUP BY ALL
),
bruto AS (
  SELECT *,
    free_dbus + paid_dbus / CASE WHEN mes < '2027-02-01' THEN 0.75 ELSE 1 END AS dbu_bruto
  FROM por_usuario
)
SELECT
  mes,
  COUNT(DISTINCT usuario)                                  AS usuarios_ativos,
  ROUND(PERCENTILE(dbu_bruto, 0.50), 1)                    AS p50,
  ROUND(PERCENTILE(dbu_bruto, 0.75), 1)                    AS p75,
  ROUND(PERCENTILE(dbu_bruto, 0.95), 1)                    AS p95,
  ROUND(MAX(dbu_bruto), 1)                                 AS maximo,
  ROUND(AVG(CASE WHEN dbu_bruto <= 150 THEN 1 ELSE 0 END) * 100, 1) AS pct_dentro_free_tier,
  ROUND(SUM(dbu_bruto), 1)                                 AS dbu_bruto_total
FROM bruto
GROUP BY mes
ORDER BY mes;`;

const SQL_PRICE = `-- Preço list vigente do SKU usado pelo Genie na(s) região(ões) do cliente
SELECT DISTINCT
  lp.sku_name,
  lp.pricing.effective_list.default AS usd_por_dbu,
  lp.price_start_time
FROM system.billing.list_prices lp
WHERE lp.price_end_time IS NULL
  AND lp.sku_name IN (
    SELECT DISTINCT sku_name
    FROM system.billing.usage
    WHERE billing_origin_product = 'GENIE'
      AND sku_name != 'GENIE_FREE_USAGE'
      AND usage_date >= CURRENT_DATE - 30
  );`;

const SQL_SP = `-- Consumo de Genie por service principal (não tem free tier).
-- Para Genie Code, divida por 0,75 os meses até jan/2027 para obter o DBU bruto.
SELECT
  DATE_TRUNC('MONTH', usage_date)   AS mes,
  identity_metadata.run_as          AS service_principal,
  usage_metadata.genie.surface      AS superficie,
  SUM(usage_quantity)               AS dbus_medidos
FROM system.billing.usage
WHERE billing_origin_product = 'GENIE'
  AND identity_metadata.run_as NOT LIKE '%@%'
  AND usage_date >= '2026-08-01'
GROUP BY ALL
ORDER BY mes, dbus_medidos DESC;`;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
function nextMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function defaultState() {
  return {
    version: 1,
    mode: "quick",
    quick: { users: 25, usage: "daily", months: 12, automations: 0, listPrice: 0.07, discountPct: 0, fx: 5.4, dbuPerSession: 10, tierP: 10000, tierM: 50000 },
    project: { name: "", area: "", ownerCustomer: "", ownerDatabricks: "", startMonth: nextMonth(), horizon: 12, description: "" },
    checklist: {},
    baseline: { period: "", users: null, p50: null, p75: null, p95: null, pctFree: null },
    personas: [
      { name: "Iniciante", profile: "Uso esporádico: dúvidas, explicação e correção de código", users: 0, dbu: null, source: "" },
      { name: "Praticante", profile: "Uso regular: constrói e otimiza pipelines e notebooks", users: 0, dbu: null, source: "" },
      { name: "Power user", profile: "Tarefas agênticas longas, migrações, multi-assets", users: 0, dbu: null, source: "" },
    ],
    adoption: { rampMonths: 3, startPct: 30, growthPct: 0 },
    pricing: { region: "", listPrice: 0.07, discountPct: 0, fx: null, freeDbu: 150, contingencyPct: 30, applyPromo: true },
    automation: { spDbu: 0, notes: "" },
    compute: [
      { name: "SQL Warehouse Serverless", dbu: 0, price: null },
      { name: "Jobs / Serverless compute", dbu: 0, price: null },
    ],
  };
}

let state = loadState();
let currentStep = 0;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return mergeDefaults(JSON.parse(raw));
  } catch (_) { /* estado corrompido: recomeça */ }
  return defaultState();
}

function mergeDefaults(loaded) {
  const base = defaultState();
  for (const key of Object.keys(base)) {
    if (loaded[key] === undefined) continue;
    if (Array.isArray(base[key])) base[key] = loaded[key];
    else if (typeof base[key] === "object") base[key] = { ...base[key], ...loaded[key] };
    else base[key] = loaded[key];
  }
  return base;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

const num = (v) => (v === null || v === undefined || v === "" || isNaN(v) ? 0 : Number(v));
const parseNum = (v) => (v === "" ? null : Number(v));

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
const fmtUsd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtBrl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const fmtNum1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function brl(usd) {
  return state.pricing.fx ? fmtBrl.format(usd * state.pricing.fx) : "—";
}

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------
function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]}/${String(y).slice(2)}`;
}

// Fator de adoção do mês m (1-based): rampa linear até rampMonths, depois crescimento composto.
function adoptionFactor(m) {
  const R = Math.max(1, num(state.adoption.rampMonths));
  const s = Math.min(100, Math.max(0, num(state.adoption.startPct))) / 100;
  const g = num(state.adoption.growthPct) / 100;
  if (m < R) return s + (1 - s) * (m - 1) / (R - 1);
  return Math.pow(1 + g, m - R);
}

// Custo de Genie Code por usuário/mês de uma persona, a preço cheio (sem promoção).
function perUserMonthly(dbu) {
  const p = state.pricing;
  const free = num(p.freeDbu);
  const paid = Math.max(num(dbu) - free, 0);
  const billed = paid * (1 + num(p.contingencyPct) / 100);
  return { free: Math.min(num(dbu), free), paid, usd: billed * num(p.listPrice) * (1 - num(p.discountPct) / 100) };
}

function compute() {
  const p = state.pricing;
  const free = num(p.freeDbu);
  const contingency = 1 + num(p.contingencyPct) / 100;
  const netPrice = num(p.listPrice) * (1 - num(p.discountPct) / 100);
  const horizon = Math.max(1, Math.min(60, num(state.project.horizon) || 12));
  const start = state.project.startMonth || nextMonth();

  const months = [];
  for (let i = 0; i < horizon; i++) {
    const ym = addMonths(start, i);
    const f = adoptionFactor(i + 1);
    let users = 0, raw = 0, freeUsed = 0, paidUsers = 0;
    for (const per of state.personas) {
      const n = num(per.users) * f;
      const dbu = num(per.dbu);
      users += n;
      raw += n * dbu;
      freeUsed += n * Math.min(dbu, free);
      paidUsers += n * Math.max(dbu - free, 0);
    }
    const sp = num(state.automation.spDbu);
    const paidRaw = paidUsers + sp;
    const promo = p.applyPromo && ym <= PROMO_END;
    const billed = paidRaw * (promo ? PROMO_FACTOR : 1) * contingency;
    const genieUsd = billed * netPrice;
    const computeUsd = state.compute.reduce((acc, c) => acc + num(c.dbu) * f * num(c.price), 0);
    months.push({ ym, f, users, raw: raw + sp, freeUsed, paidRaw, promo, billed, genieUsd, computeUsd, totalUsd: genieUsd + computeUsd });
  }

  const sum = (k) => months.reduce((a, m) => a + m[k], 0);
  const totals = { raw: sum("raw"), freeUsed: sum("freeUsed"), paidRaw: sum("paidRaw"), billed: sum("billed"), genieUsd: sum("genieUsd"), computeUsd: sum("computeUsd"), totalUsd: sum("totalUsd") };

  const totalUsers = state.personas.reduce((a, per) => a + num(per.users), 0);
  const usersInFree = state.personas.reduce((a, per) => a + (num(per.dbu) <= free ? num(per.users) : 0), 0);
  const peak = months.reduce((a, m) => (m.genieUsd > a.genieUsd ? m : a), months[0]);
  const fullAdoptionGenie = state.personas.reduce((a, per) => a + num(per.users) * perUserMonthly(per.dbu).usd, 0)
    + num(state.automation.spDbu) * contingency * netPrice;

  return { months, totals, totalUsers, usersInFree, peak, fullAdoptionGenie, netPrice, horizon };
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------
function renderSteps() {
  const nav = document.getElementById("steps");
  const sections = [...document.querySelectorAll(".step")];
  nav.innerHTML = sections.map((s, i) =>
    `<button data-goto="${i}" class="${i === currentStep ? "active" : ""}"><span class="num">${i}</span>${esc(s.dataset.title)}</button>`
  ).join("");
  sections.forEach((s, i) => s.classList.toggle("active", i === currentStep));
  document.getElementById("btn-prev").style.visibility = currentStep === 0 ? "hidden" : "visible";
  document.getElementById("btn-next").style.visibility = currentStep === sections.length - 1 ? "hidden" : "visible";
}

function goTo(i) {
  const total = document.querySelectorAll(".step").length;
  currentStep = Math.max(0, Math.min(total - 1, i));
  renderSteps();
  if (currentStep === total - 1) renderResult();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindInputs() {
  document.querySelectorAll("[data-bind]").forEach((el) => {
    const path = el.dataset.bind;
    const type = el.dataset.type;
    const value = getPath(state, path);
    if (type === "bool") el.checked = !!value;
    else el.value = value ?? "";
  });
}

function renderChecklist() {
  const html = CHECKLIST.map((g) => `
    <div class="checklist-group">
      <h3>${esc(g.group)}</h3>
      ${g.items.map((it) => {
        const st = state.checklist[it.id] || {};
        return `<div class="check-item">
          <input type="checkbox" data-check="${it.id}" ${st.done ? "checked" : ""} />
          <div><div class="q">${esc(it.q)}</div><div class="why">${esc(it.why)}</div></div>
          <input type="text" data-answer="${it.id}" placeholder="Resposta / anotação" value="${esc(st.answer)}" />
        </div>`;
      }).join("")}
    </div>`).join("");
  document.getElementById("checklist").innerHTML = html;
}

function renderPersonas() {
  const tbody = document.querySelector("#personas-table tbody");
  tbody.innerHTML = state.personas.map((p, i) => `
    <tr>
      <td><input data-persona="${i}" data-field="name" value="${esc(p.name)}" /></td>
      <td><input data-persona="${i}" data-field="profile" value="${esc(p.profile)}" /></td>
      <td><input type="number" min="0" data-persona="${i}" data-field="users" data-type="number" value="${p.users ?? ""}" /></td>
      <td><input type="number" min="0" step="any" data-persona="${i}" data-field="dbu" data-type="number" value="${p.dbu ?? ""}" placeholder="ex.: P50 do histórico" /></td>
      <td><input data-persona="${i}" data-field="source" value="${esc(p.source)}" placeholder="Histórico / piloto / premissa" /></td>
      <td class="no-print"><button class="icon" data-remove-persona="${i}" title="Remover">✕</button></td>
    </tr>`).join("");
}

function renderCompute() {
  const tbody = document.querySelector("#compute-table tbody");
  tbody.innerHTML = state.compute.map((c, i) => `
    <tr>
      <td><input data-compute="${i}" data-field="name" value="${esc(c.name)}" /></td>
      <td><input type="number" min="0" step="any" data-compute="${i}" data-field="dbu" data-type="number" value="${c.dbu ?? ""}" /></td>
      <td><input type="number" min="0" step="any" data-compute="${i}" data-field="price" data-type="number" value="${c.price ?? ""}" placeholder="US$/DBU" /></td>
      <td class="no-print"><button class="icon" data-remove-compute="${i}" title="Remover">✕</button></td>
    </tr>`).join("");
}

function warnings() {
  const w = [];
  if (state.personas.some((p) => num(p.users) > 0 && (p.dbu === null || p.dbu === ""))) w.push("Há personas com usuários sem DBU/usuário preenchido (passo 3).");
  if (!state.pricing.region) w.push("Região não informada. O preço list padrão (US$ 0,07/DBU) é a referência de US East; confirme com a Query 2.");
  if (state.personas.every((p) => num(p.users) === 0)) w.push("Nenhum usuário informado ainda.");
  if (state.compute.some((c) => num(c.dbu) > 0 && !num(c.price))) w.push("Há componentes de compute com DBU mas sem preço (passo 5).");
  return w;
}

function renderResult() {
  const r = compute();
  const p = state.pricing;
  const pr = state.project;

  document.getElementById("result-header").innerHTML = `
    <h2>${esc(pr.name || "Estimativa de Genie Code")}</h2>
    <p class="hint">${esc(pr.area)} · Cliente: ${esc(pr.ownerCustomer)} · Databricks: ${esc(pr.ownerDatabricks)} · Gerado em ${new Date().toLocaleDateString("pt-BR")}</p>
    ${pr.description ? `<p>${esc(pr.description)}</p>` : ""}`;

  const warn = warnings();
  const avgGenie = r.totals.genieUsd / r.horizon;
  const pctFree = r.totalUsers ? (r.usersInFree / r.totalUsers) * 100 : 0;
  const perUser = r.totalUsers ? r.fullAdoptionGenie / r.totalUsers : 0;

  document.getElementById("kpis").innerHTML = `
    ${warn.map((x) => `<div class="warn" style="grid-column: 1 / -1">⚠ ${esc(x)}</div>`).join("")}
    <div class="kpi primary"><div class="label">Total no horizonte (${r.horizon} meses)</div><div class="value">${fmtUsd.format(r.totals.totalUsd)}</div><div class="detail">${brl(r.totals.totalUsd)} · Genie Code + compute</div></div>
    <div class="kpi"><div class="label">Genie Code: total no horizonte</div><div class="value">${fmtUsd.format(r.totals.genieUsd)}</div><div class="detail">${brl(r.totals.genieUsd)} · média ${fmtUsd.format(avgGenie)}/mês</div></div>
    <div class="kpi"><div class="label">Genie Code: mensal em adoção plena</div><div class="value">${fmtUsd.format(r.fullAdoptionGenie)}</div><div class="detail">${brl(r.fullAdoptionGenie)} · preço cheio, sem promoção</div></div>
    <div class="kpi"><div class="label">Custo Genie por usuário/mês</div><div class="value">${fmtUsd2.format(perUser)}</div><div class="detail">média em adoção plena (${fmtNum.format(r.totalUsers)} usuários)</div></div>
    <div class="kpi"><div class="label">Usuários dentro do free tier</div><div class="value">${fmtNum1.format(pctFree)}%</div><div class="detail">${fmtNum.format(r.usersInFree)} de ${fmtNum.format(r.totalUsers)} (≤ ${fmtNum.format(num(p.freeDbu))} DBU/mês)</div></div>
    <div class="kpi"><div class="label">Compute associado: total</div><div class="value">${fmtUsd.format(r.totals.computeUsd)}</div><div class="detail">${brl(r.totals.computeUsd)} · fora do budget Genie</div></div>`;

  renderChart(r);

  const rows = r.months.map((m) => `
    <tr>
      <td>${monthLabel(m.ym)}${m.promo ? " *" : ""}</td>
      <td class="num">${fmtNum1.format(m.f * 100)}%</td>
      <td class="num">${fmtNum1.format(m.users)}</td>
      <td class="num">${fmtNum.format(m.raw)}</td>
      <td class="num">${fmtNum.format(m.freeUsed)}</td>
      <td class="num">${fmtNum.format(m.billed)}</td>
      <td class="num">${fmtUsd.format(m.genieUsd)}</td>
      <td class="num">${fmtUsd.format(m.computeUsd)}</td>
      <td class="num"><strong>${fmtUsd.format(m.totalUsd)}</strong></td>
      <td class="num">${brl(m.totalUsd)}</td>
    </tr>`).join("");
  document.getElementById("monthly-table").innerHTML = `
    <thead><tr><th>Mês</th><th class="num">Adoção</th><th class="num">Usuários</th><th class="num">DBU bruto</th><th class="num">DBU free</th><th class="num">DBU faturado</th><th class="num">Genie Code</th><th class="num">Compute</th><th class="num">Total US$</th><th class="num">Total R$</th></tr></thead>
    <tbody>${rows}
      <tr class="total"><td>Total</td><td></td><td></td><td class="num">${fmtNum.format(r.totals.raw)}</td><td class="num">${fmtNum.format(r.totals.freeUsed)}</td><td class="num">${fmtNum.format(r.totals.billed)}</td><td class="num">${fmtUsd.format(r.totals.genieUsd)}</td><td class="num">${fmtUsd.format(r.totals.computeUsd)}</td><td class="num">${fmtUsd.format(r.totals.totalUsd)}</td><td class="num">${brl(r.totals.totalUsd)}</td></tr>
    </tbody>
    ${r.months.some((m) => m.promo) ? `<caption style="caption-side: bottom; text-align: left; color: var(--muted); font-size: 12px; padding-top: 6px">* Mês com a promoção de 25% aplicada (até jan/2027). DBU faturado já inclui a contingência de ${fmtNum1.format(num(p.contingencyPct))}%.</caption>` : ""}`;

  const personaRows = state.personas.map((per) => {
    const u = perUserMonthly(per.dbu);
    return `<tr><td>${esc(per.name)}</td><td class="num">${fmtNum.format(num(per.users))}</td><td class="num">${fmtNum1.format(num(per.dbu))}</td><td class="num">${fmtNum1.format(u.free)}</td><td class="num">${fmtNum1.format(u.paid)}</td><td class="num">${fmtUsd2.format(u.usd)}</td><td class="num">${fmtUsd.format(u.usd * num(per.users))}</td><td>${esc(per.source)}</td></tr>`;
  }).join("");
  const spUsd = num(state.automation.spDbu) * (1 + num(p.contingencyPct) / 100) * r.netPrice;
  document.getElementById("persona-result").innerHTML = `
    <thead><tr><th>Persona</th><th class="num">Usuários</th><th class="num">DBU bruto/usuário</th><th class="num">Free/usuário</th><th class="num">Excedente/usuário</th><th class="num">US$/usuário/mês</th><th class="num">US$/mês</th><th>Fonte</th></tr></thead>
    <tbody>${personaRows}
      ${num(state.automation.spDbu) ? `<tr><td>Service principals</td><td class="num">—</td><td class="num">${fmtNum.format(num(state.automation.spDbu))}</td><td class="num">0</td><td class="num">${fmtNum.format(num(state.automation.spDbu))}</td><td class="num">—</td><td class="num">${fmtUsd.format(spUsd)}</td><td>${esc(state.automation.notes)}</td></tr>` : ""}
      <tr class="total"><td>Total</td><td class="num">${fmtNum.format(r.totalUsers)}</td><td></td><td></td><td></td><td></td><td class="num">${fmtUsd.format(r.fullAdoptionGenie)}</td><td></td></tr>
    </tbody>`;

  renderGovernance(r);
  renderAssumptions(r);
  renderChecklistPrint();
}

function renderChart(r) {
  const W = 900, H = 260, padL = 70, padB = 30, padT = 10;
  const max = Math.max(1, ...r.months.map((m) => m.totalUsd));
  const n = r.months.length;
  const bw = (W - padL - 10) / n;
  const y = (v) => H - padB - (v / max) * (H - padB - padT);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const bars = r.months.map((m, i) => {
    const x = padL + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const yG = y(m.genieUsd), yT = y(m.totalUsd);
    return `<g><title>${monthLabel(m.ym)}: Genie ${fmtUsd.format(m.genieUsd)} · Compute ${fmtUsd.format(m.computeUsd)}</title>
      <rect x="${x}" y="${yG}" width="${w}" height="${H - padB - yG}" fill="var(--genie)" rx="2"/>
      <rect x="${x}" y="${yT}" width="${w}" height="${yG - yT}" fill="var(--compute)" rx="2"/>
      <text x="${x + w / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="var(--muted)">${monthLabel(m.ym)}</text></g>`;
  }).join("");
  const grid = ticks.map((t) => `<line x1="${padL}" x2="${W - 10}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/>
    <text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtUsd.format(t)}</text>`).join("");
  document.getElementById("chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Custo mensal estimado">${grid}${bars}</svg>
    <div class="legend"><span style="--c: var(--genie)">Genie Code</span><span style="--c: var(--compute)">Compute associado</span></div>`;
}

function renderGovernance(r) {
  const sharedCap = r.fullAdoptionGenie * 1.2;
  const perPersona = state.personas.map((per) => ({ name: per.name, usd: perUserMonthly(per.dbu).usd }));
  const fmtLimit = (usd) => (usd > 0 ? `${fmtUsd.format(Math.ceil(usd * 1.5))}/usuário/mês` : "dentro do free tier (limite baixo, mas que permita crescer)");
  document.getElementById("governance").innerHTML = `
    <div class="card"><strong>Teto compartilhado (conta ou workspace)</strong>
      Cerca de ${fmtUsd.format(sharedCap)}/mês (adoção plena + 20%). Alerta em 80%, bloqueio em 100%. No piloto, configure só alerta, alto o bastante para não barrar os power users.</div>
    <div class="card"><strong>Limite por usuário e overrides por grupo</strong>
      ${perPersona.map((x) => `${esc(x.name)}: ${fmtLimit(x.usd)}`).join(" · ")}
      <br/><small>Valores = custo estimado × 1,5 de folga. Crie grupos de conta por persona (ex.: <code>genie-iniciantes</code>, <code>genie-praticantes</code>, <code>genie-power-users</code>). O limite do iniciante deve permitir que ele evolua para praticante.</small></div>
    <div class="card"><strong>Boas práticas que reduzem consumo</strong>
      Um chat novo por tarefa · referenciar assets com <code>@</code> · effort <em>Low</em> em tarefas simples · skills para tarefas repetidas · comentários de tabelas no Unity Catalog · desligar MCP servers sem uso. Autocomplete e quick-fix não consomem a cota paga.</div>
    <div class="card"><strong>Acompanhamento</strong>
      Compare o real com esta estimativa mensalmente via <code>system.billing.usage</code> (Query 1) e ajuste personas e limites.</div>`;
}

function renderAssumptions(r) {
  const p = state.pricing;
  const a = state.adoption;
  const items = [
    `Início em ${monthLabel(state.project.startMonth || nextMonth())}, horizonte de ${r.horizon} meses.`,
    `Free tier de ${fmtNum.format(num(p.freeDbu))} DBU/usuário/mês, individual (não é pool) e só para usuários identificados; service principals pagam todo o consumo.`,
    `Preço list ${fmtUsd2.format(num(p.listPrice))}/DBU (SKU Serverless Real-Time Inference${p.region ? `, ${esc(p.region)}` : ""}), desconto contratual de ${fmtNum1.format(num(p.discountPct))}%, preço efetivo ${fmtUsd2.format(r.netPrice)}/DBU.`,
    p.applyPromo ? "Promoção de 25% aplicada nos meses até jan/2027; a partir de fev/2027, preço cheio." : "Promoção de 25% desconsiderada (cenário conservador).",
    `Contingência de ${fmtNum1.format(num(p.contingencyPct))}% sobre o DBU faturado, para cobrir a variação dos power users.`,
    `Adoção: ${fmtNum1.format(num(a.startPct))}% dos usuários no 1º mês, chegando a 100% no mês ${fmtNum.format(num(a.rampMonths))}${num(a.growthPct) ? `, depois crescimento de ${fmtNum1.format(num(a.growthPct))}% ao mês` : ""}.`,
    state.baseline.period ? `Baseline histórica: ${esc(state.baseline.period)}${state.baseline.users ? `, ${fmtNum.format(state.baseline.users)} usuários ativos` : ""} (P50 ${fmtNum1.format(num(state.baseline.p50))} / P75 ${fmtNum1.format(num(state.baseline.p75))} / P95 ${fmtNum1.format(num(state.baseline.p95))} DBU).` : "Sem baseline histórica informada: valores por persona são premissas e devem ser validados com um piloto de 14 a 30 dias.",
    "O compute que executa o código gerado (warehouses, jobs, serverless) é cobrado à parte e acompanha a rampa de adoção.",
    state.pricing.fx ? `Câmbio de referência: R$ ${fmtNum1.format(state.pricing.fx)} por US$.` : "Câmbio não informado: valores só em US$.",
    "Estimativa indicativa: o consumo de Genie Code é agêntico e varia com a complexidade das tarefas, o contexto disponível e o estilo de uso.",
  ];
  document.getElementById("assumptions").innerHTML = items.map((x) => `<li>${x}</li>`).join("");
}

function renderChecklistPrint() {
  const answered = CHECKLIST.flatMap((g) => g.items).filter((it) => state.checklist[it.id]?.answer);
  document.getElementById("checklist-print").innerHTML = answered.length
    ? `<h3>Respostas do levantamento</h3><ul>${answered.map((it) => `<li><strong>${esc(it.q)}</strong><br/>${esc(state.checklist[it.id].answer)}</li>`).join("")}</ul>`
    : "";
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function onChange() {
  saveState();
  if (currentStep === document.querySelectorAll(".step").length - 1) renderResult();
}

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    const t = el.dataset.type;
    setPath(state, el.dataset.bind, t === "number" ? parseNum(el.value) : t === "bool" ? el.checked : el.value);
  } else if (el.dataset.persona !== undefined) {
    state.personas[+el.dataset.persona][el.dataset.field] = el.dataset.type === "number" ? parseNum(el.value) : el.value;
  } else if (el.dataset.compute !== undefined) {
    state.compute[+el.dataset.compute][el.dataset.field] = el.dataset.type === "number" ? parseNum(el.value) : el.value;
  } else if (el.dataset.check) {
    state.checklist[el.dataset.check] = { ...(state.checklist[el.dataset.check] || {}), done: el.checked };
  } else if (el.dataset.answer) {
    state.checklist[el.dataset.answer] = { ...(state.checklist[el.dataset.answer] || {}), answer: el.value };
  } else return;
  onChange();
});

document.addEventListener("click", (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.goto !== undefined) goTo(+el.dataset.goto);
  else if (el.dataset.removePersona !== undefined) { state.personas.splice(+el.dataset.removePersona, 1); renderPersonas(); onChange(); }
  else if (el.dataset.removeCompute !== undefined) { state.compute.splice(+el.dataset.removeCompute, 1); renderCompute(); onChange(); }
  else if (el.dataset.copy) {
    navigator.clipboard.writeText(document.getElementById(el.dataset.copy).textContent);
    const old = el.textContent; el.textContent = "Copiado ✓"; setTimeout(() => (el.textContent = old), 1500);
  }
});

document.getElementById("btn-prev").onclick = () => goTo(currentStep - 1);
document.getElementById("btn-next").onclick = () => goTo(currentStep + 1);

document.getElementById("btn-add-persona").onclick = () => {
  state.personas.push({ name: "Nova persona", profile: "", users: 0, dbu: null, source: "" });
  renderPersonas(); onChange();
};
document.getElementById("btn-add-compute").onclick = () => {
  state.compute.push({ name: "Novo componente", dbu: 0, price: null });
  renderCompute(); onChange();
};

document.getElementById("btn-apply-baseline").onclick = () => {
  const b = state.baseline;
  const map = [["p50", 0], ["p75", 1], ["p95", 2]];
  for (const [k, i] of map) {
    if (state.personas[i] && b[k] !== null && b[k] !== "") {
      state.personas[i].dbu = b[k];
      state.personas[i].source = `Histórico ${b.period || ""} (${k.toUpperCase()})`.trim();
    }
  }
  renderPersonas(); onChange();
  goTo(3);
};

document.getElementById("btn-new").onclick = () => {
  if (!confirm("Iniciar uma nova estimativa? Os dados atuais serão apagados. Salve o JSON antes, se precisar.")) return;
  state = defaultState(); saveState(); renderAll(); goTo(0);
};

function slug() {
  return (state.project.name || "estimativa-genie-code").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}

function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("btn-save").onclick = () => download(`${slug()}.json`, JSON.stringify(state, null, 2), "application/json");

document.getElementById("btn-load").onclick = () => document.getElementById("file-input").click();
document.getElementById("file-input").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state = mergeDefaults(JSON.parse(await file.text()));
    saveState(); renderAll(); goTo(currentStep);
  } catch (err) {
    alert("Arquivo inválido: " + err.message);
  }
  e.target.value = "";
};

document.getElementById("btn-csv").onclick = () => {
  const r = compute();
  const fx = state.pricing.fx || "";
  const header = ["mes", "fator_adocao", "usuarios", "dbu_bruto", "dbu_free", "dbu_faturado", "promo_25pct", "genie_code_usd", "compute_usd", "total_usd", "total_brl"];
  const lines = r.months.map((m) => [m.ym, m.f.toFixed(3), m.users.toFixed(1), m.raw.toFixed(1), m.freeUsed.toFixed(1), m.billed.toFixed(1), m.promo ? "sim" : "nao", m.genieUsd.toFixed(2), m.computeUsd.toFixed(2), m.totalUsd.toFixed(2), fx ? (m.totalUsd * fx).toFixed(2) : ""].join(";"));
  download(`${slug()}.csv`, [header.join(";"), ...lines].join("\n"), "text/csv");
};

document.getElementById("btn-print").onclick = () => { goTo(document.querySelectorAll(".step").length - 1); setTimeout(() => window.print(), 100); };

function renderAll() {
  bindInputs();
  renderChecklist();
  renderPersonas();
  renderCompute();
}

document.getElementById("sql-baseline").textContent = SQL_BASELINE;
document.getElementById("sql-price").textContent = SQL_PRICE;
document.getElementById("sql-sp").textContent = SQL_SP;
renderAll();
renderSteps();
