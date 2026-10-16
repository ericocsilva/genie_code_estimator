"use strict";

// ---------------------------------------------------------------------------
// Sizing rápido: poucas perguntas -> faixa de custo e classificação P/M/G.
// Premissas de referência (out/2026), provisórias — calibrar com o consumo
// observado (Query 1): sessões/mês por persona x DBU por sessão
// (mediana ~5, P75 ~15). Cenários baixo/base/alto = 0,5x / 1x / 1,5x o DBU/sessão base.
// ---------------------------------------------------------------------------
const QUICK_PERSONAS = [
  { name: "Iniciante", sessions: 6.5, profile: "1–2 interações por semana" },
  { name: "Praticante", sessions: 21, profile: "~1 interação por dia" },
  { name: "Power user", sessions: 52.5, profile: "2–3 interações por dia" },
  { name: "Super power user", sessions: 105, profile: "Muitas interações por dia, tarefas agênticas longas" },
];
// Sessões/mês de um fluxo automatizado (equivalente a um super power user).
const AUTOMATION_SESSIONS = 105;

const USAGE_PROFILES = {
  light: { title: "Apoio pontual", desc: "Dúvidas, explicação e pequenos ajustes de código. Uso esporádico.", mix: [0.70, 0.25, 0.05, 0] },
  daily: { title: "Desenvolvimento diário", desc: "Constrói e mantém notebooks, pipelines e queries com o Genie todo dia.", mix: [0.30, 0.50, 0.20, 0] },
  heavy: { title: "Intensivo / agêntico", desc: "Migração de código, geração em massa, tarefas longas e multi-asset.", mix: [0.10, 0.40, 0.35, 0.15] },
};

const SCENARIOS = [
  { key: "low", label: "Baixo", factor: 0.5 },
  { key: "base", label: "Base", factor: 1 },
  { key: "high", label: "Alto", factor: 1.5 },
];

function quickCompute() {
  const q = state.quick;
  const mix = USAGE_PROFILES[q.usage].mix;
  const free = num(state.pricing.freeDbu) || 150;
  const netPrice = num(q.listPrice) * (1 - num(q.discountPct) / 100);
  const users = num(q.users);

  const scenarios = SCENARIOS.map((s) => {
    const dps = num(q.dbuPerSession) * s.factor;
    let paidPerUser = 0, freeShare = 0;
    QUICK_PERSONAS.forEach((p, i) => {
      const dbu = p.sessions * dps;
      paidPerUser += mix[i] * Math.max(dbu - free, 0);
      if (dbu <= free) freeShare += mix[i];
    });
    const spDbu = num(q.automations) * AUTOMATION_SESSIONS * dps;
    const monthlyDbu = users * paidPerUser + spDbu;
    const monthlyUsd = monthlyDbu * netPrice;
    const totalUsd = monthlyUsd * num(q.months);
    return { ...s, dps, monthlyDbu, monthlyUsd, totalUsd, totalBrl: totalUsd * num(q.fx), freeShare, perUserUsd: users ? (users * paidPerUser * netPrice) / users : 0 };
  });
  return { scenarios, base: scenarios[1] };
}

function tierOf(brlValue) {
  const q = state.quick;
  if (brlValue <= num(q.tierP)) return "P";
  if (brlValue <= num(q.tierM)) return "M";
  return "G";
}

function renderQuickForm({ keepInputs = false } = {}) {
  const q = state.quick;
  if (!keepInputs) {
    document.getElementById("q-users").value = q.users ?? "";
    document.querySelectorAll("[data-q]").forEach((el) => { el.value = q[el.dataset.q] ?? ""; });
  }
  document.getElementById("q-usage").innerHTML = Object.entries(USAGE_PROFILES).map(([k, p]) => `
    <button class="card-opt ${q.usage === k ? "active" : ""}" data-usage="${k}">
      <strong>${esc(p.title)}</strong><span>${esc(p.desc)}</span>
    </button>`).join("");
  document.querySelectorAll("[data-chips]").forEach((group) => {
    const key = group.dataset.chips;
    group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", String(q[key]) === b.dataset.v));
  });
}

function renderQuickResult() {
  const q = state.quick;
  const r = quickCompute();
  const tier = tierOf(r.base.totalBrl);
  const tierName = { P: "Projeto P", M: "Projeto M", G: "Projeto G" }[tier];
  const tierDesc = {
    P: `até ${fmtBrl.format(num(q.tierP))}`,
    M: `de ${fmtBrl.format(num(q.tierP))} a ${fmtBrl.format(num(q.tierM))}`,
    G: `acima de ${fmtBrl.format(num(q.tierM))}`,
  }[tier];

  // Escala visual: P e M ocupam 1/3 cada; G vai até 2x o limite M.
  const scaleMax = num(q.tierM) * 2;
  const pos = (v) => {
    const p = num(q.tierP), m = num(q.tierM);
    if (v <= p) return (v / p) * 33.33;
    if (v <= m) return 33.33 + ((v - p) / (m - p)) * 33.33;
    return Math.min(100, 66.66 + ((v - m) / (scaleMax - m)) * 33.34);
  };
  const lo = pos(r.scenarios[0].totalBrl), hi = pos(r.scenarios[2].totalBrl), mid = pos(r.base.totalBrl);
  const tiersInRange = [...new Set(r.scenarios.map((s) => tierOf(s.totalBrl)))];

  document.getElementById("quick-result").innerHTML = `
    <h2>Estimativa</h2>
    <div class="tier-badge">
      <div class="tier-letter tier-${tier}">${tier}</div>
      <div class="tier-text">
        <div class="t1">${tierName} · ${tierDesc}</div>
        <div class="t2">${fmtBrl.format(r.base.totalBrl)}</div>
        <div class="t3">Genie Code em ${fmtNum.format(num(q.months))} meses · faixa ${fmtBrl.format(r.scenarios[0].totalBrl)} a ${fmtBrl.format(r.scenarios[2].totalBrl)}</div>
      </div>
    </div>
    <div class="scale" title="Faixa entre os cenários baixo e alto; a linha marca o cenário base">
      <div class="scale-bar"><div class="tier-P"></div><div class="tier-M"></div><div class="tier-G"></div></div>
      <div class="scale-range" style="left:${lo}%; width:${Math.max(hi - lo, 1)}%"></div>
      <div class="scale-marker" style="left:${mid}%"></div>
      <div class="scale-labels"><span>P · até ${fmtBrl.format(num(q.tierP))}</span><span>M · até ${fmtBrl.format(num(q.tierM))}</span><span>G · acima</span></div>
    </div>
    ${tiersInRange.length > 1 ? `<div class="warn">A faixa cruza as classes ${tiersInRange.join(" / ")}. Recomendado: Deep dive com o histórico de consumo do cliente.</div>` : ""}
    <div class="mini-kpis">
      <div class="kpi"><div class="label">Por mês (base)</div><div class="value">${fmtBrl.format(r.base.monthlyUsd * num(q.fx))}</div><div class="detail">${fmtUsd.format(r.base.monthlyUsd)}</div></div>
      <div class="kpi"><div class="label">Por usuário/mês (base)</div><div class="value">${fmtBrl.format(r.base.perUserUsd * num(q.fx))}</div><div class="detail">${fmtUsd2.format(r.base.perUserUsd)}</div></div>
      <div class="kpi"><div class="label">Usuários no free tier</div><div class="value">~${fmtNum.format(r.base.freeShare * 100)}%</div><div class="detail">consomem ≤ 150 DBU/mês</div></div>
      <div class="kpi"><div class="label">DBU faturado/mês</div><div class="value">${fmtNum.format(r.base.monthlyDbu)}</div><div class="detail">após o free tier</div></div>
    </div>
    <table class="result-table">
      <thead><tr><th>Cenário</th><th class="num">DBU/sessão</th><th class="num">R$/mês</th><th class="num">Total R$</th><th>Classe</th></tr></thead>
      <tbody>${r.scenarios.map((s) => `<tr${s.key === "base" ? ' style="font-weight:700"' : ""}><td>${s.label}</td><td class="num">${fmtNum1.format(s.dps)}</td><td class="num">${fmtBrl.format(s.monthlyUsd * num(q.fx))}</td><td class="num">${fmtBrl.format(s.totalBrl)}</td><td>${tierOf(s.totalBrl)}</td></tr>`).join("")}</tbody>
    </table>
    <p class="note">Premissas: free tier de 150 DBU/usuário/mês; preço ${fmtUsd2.format(num(q.listPrice))}/DBU${num(q.discountPct) ? ` com ${fmtNum1.format(num(q.discountPct))}% de desconto` : ""}; câmbio R$ ${fmtNum1.format(num(q.fx))}; adoção plena desde o 1º mês, sem a promoção de 25% (cenário conservador). Consumo por persona da referência interna provisória de out/2026 (sessões/mês × DBU/sessão). <strong>Não inclui</strong> o compute que executa o código gerado (warehouses, jobs).</p>
    <button class="cta no-print" id="btn-to-deep">Detalhar no Deep dive →</button>`;
}

function renderQuick() {
  renderQuickForm();
  renderQuickResult();
}

function setMode(mode) {
  state.mode = mode;
  saveState();
  document.body.classList.toggle("mode-quick", mode === "quick");
  document.body.classList.toggle("mode-deep", mode === "deep");
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  if (mode === "quick") renderQuick();
  else goTo(currentStep);
  window.scrollTo({ top: 0 });
}

// Leva as respostas do sizing rápido para o Deep dive como ponto de partida.
function quickToDeep() {
  const q = state.quick;
  const mix = USAGE_PROFILES[q.usage].mix;
  const dps = num(q.dbuPerSession);
  state.project.horizon = num(q.months);
  state.personas = QUICK_PERSONAS.map((p, i) => ({
    name: p.name,
    profile: p.profile,
    users: Math.round(num(q.users) * mix[i]),
    dbu: Math.round(p.sessions * dps * 10) / 10,
    source: "Sizing rápido (premissa interna provisória)",
  })).filter((p) => p.users > 0);
  state.automation.spDbu = num(q.automations) * AUTOMATION_SESSIONS * dps;
  state.automation.notes = num(q.automations) ? `${q.automations} fluxo(s) automatizado(s), estimado no sizing rápido` : "";
  Object.assign(state.pricing, { listPrice: q.listPrice, discountPct: q.discountPct, fx: q.fx, contingencyPct: 0, applyPromo: false });
  Object.assign(state.adoption, { rampMonths: 1, startPct: 100, growthPct: 0 });
  renderAll();
  currentStep = 3;
  setMode("deep");
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("button, a");
  if (!el) return;
  if (el.dataset.mode) setMode(el.dataset.mode);
  else if (el.dataset.modeLink) { e.preventDefault(); setMode(el.dataset.modeLink); }
  else if (el.dataset.usage) { state.quick.usage = el.dataset.usage; saveState(); renderQuick(); }
  else if (el.dataset.v !== undefined && el.parentElement.dataset.chips) {
    const key = el.parentElement.dataset.chips;
    state.quick[key] = Number(el.dataset.v);
    saveState(); renderQuick();
  } else if (el.id === "btn-to-deep") quickToDeep();
  else if (el.id === "btn-quick-print") window.print();
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "q-users") state.quick.users = parseNum(el.value);
  else if (el.dataset.q) state.quick[el.dataset.q] = parseNum(el.value);
  else return;
  saveState();
  renderQuickForm({ keepInputs: true });
  renderQuickResult();
});

setMode(state.mode || "quick");
