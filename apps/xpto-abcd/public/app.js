const XPTO = "40000004";
const ABCD = "50000005";
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brl = (v) => BRL.format(v);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------------------------------------------------------------------
// Etapas de um Pix XPTO -> ABCD. Cada uma fecha quando aparece o passo
// correspondente no diario de um banco ou na linha do tempo do Bacen.
// ---------------------------------------------------------------------------

const STAGES = [
  { title: "XPTO consulta a chave no DICT", why: "GET /api/v2/entries/{chave}: descobre banco, agência, conta e titular.", src: "XPTO", done: /^DICT: 200/ },
  { title: "XPTO monta a pacs.008 e valida no XSD", why: "AppHdr To = 00038166 (SPI); o ABCD só aparece em CdtrAgt.", src: "XPTO", done: /Validada no XSD/ },
  { title: "XPTO grava a mensagem no ICOM", why: "POST /api/v1/in/40000004/msgs com mTLS (CN = ISPB). 201 só diz que chegou.", src: "XPTO", done: /ICOM respondeu 201/ },
  { title: "SPI valida e encaminha ao ABCD", why: "Schema, cabeçalho, idempotência e regras; abre o prazo de 40 s.", src: "BACEN", done: /pacs\.008 encaminhada a 50000005/ },
  { title: "ABCD confere a conta e responde ACSP", why: "O ABCD lê o stream do ICOM e responde uma pacs.002.", src: "ABCD", done: /pacs\.002 ACSP enviada/ },
  { title: "SPI liquida nas contas PI", why: "Conta PI do XPTO −valor, conta PI do ABCD +valor.", src: "BACEN", done: /LIQUIDADA/ },
  { title: "ABCD credita o cliente (ACCC)", why: "O recebedor só credita depois do aviso de liquidação.", src: "ABCD", done: /SPI liquidou/ },
];
const FAIL = { BACEN: /Rejeitada pelo SPI|Transacao rejeitada|admi\.002/ };

const track = { active: false, e2e: null, done: [], fail: -1 };

function resetTrack() {
  Object.assign(track, { active: true, e2e: null, done: STAGES.map(() => null), fail: -1 });
  $("e2e").textContent = "consultando…";
  renderTrack();
}

function renderTrack() {
  const current = track.active ? track.done.findIndex((d) => !d) : -1;
  $("track").innerHTML = STAGES.map((s, i) => {
    const cls = track.fail === i ? "fail" : track.done[i] ? "done" : i === current && track.fail < 0 ? "wait" : "";
    return `<li class="${cls}"><b>${esc(s.title)}</b><span class="why">${esc(s.why)}</span><span class="got">${esc(track.done[i] ?? "")}</span></li>`;
  }).join("");

  const left = $("wire-left");
  const right = $("wire-right");
  left.className = right.className = "wire";
  if (track.fail >= 0) {
    (track.fail <= 3 ? left : right).classList.add("fail");
    if (track.fail > 3) left.classList.add("done");
  } else if (current === -1 && track.done[0]) {
    left.classList.add("done");
    right.classList.add("done");
  } else if (current >= 0 && track.active) {
    if (current <= 3) left.classList.add("fwd");
    else {
      left.classList.add("done");
      right.classList.add(current === 4 || current === 6 ? "fwd" : "back");
    }
  }
}

function onTrackEvent(ev) {
  if (!track.active) return;
  const text = ev.text ?? ev.message ?? "";
  if (ev.source === "BACEN" && ev.txId && track.e2e && ev.txId !== track.e2e) return;

  const m = /EndToEndId gerado: (E\w+)/.exec(text);
  if (m && ev.source === "XPTO") {
    track.e2e = m[1];
    $("e2e").textContent = m[1];
  }

  const failed = (ev.source === "BACEN" && FAIL.BACEN.test(text)) || ((ev.source === "XPTO" || ev.source === "ABCD") && ev.kind === "error");
  if (failed) {
    track.fail = Math.max(0, track.done.findIndex((d) => !d));
    track.done[track.fail] = text;
    track.active = false;
    return renderTrack();
  }

  STAGES.forEach((s, i) => {
    if (!track.done[i] && s.src === ev.source && s.done.test(text)) track.done[i] = text;
  });
  if (track.done.every(Boolean)) track.active = false;
  renderTrack();
}

// ---------------------------------------------------------------------------
// Estado dos bancos e contas PI
// ---------------------------------------------------------------------------

let state;

function renderCustomers(el, customers) {
  el.innerHTML = customers.map((c) => `
    <li><div><div>${esc(c.name)}</div><div class="keys">ag ${esc(c.branch)} · cc ${esc(c.account)}${c.keys.length ? " · " + c.keys.map((k) => esc(k.key)).join(", ") : ""}</div></div>
    <span class="money">${brl(c.balance)}</span></li>`).join("");
}

function renderTxs(el, txs, side) {
  if (!txs.length) {
    el.innerHTML = `<li class="empty">Nenhuma movimentação.</li>`;
    return;
  }
  el.innerHTML = txs.map((t) => {
    const incoming = t.kind === "pix-in" || t.kind === "return-in";
    const canReturn = side === "abcd" && t.kind === "pix-in" && t.status === "CONCLUIDO" && t.returned < t.amount;
    const label = { "pix-out": "Pix enviado", "pix-in": "Pix recebido", "return-out": "Devolução enviada", "return-in": "Devolução recebida", internal: "Transferência interna" }[t.kind];
    return `<li>
      <span class="who">${esc(t.counterparty)}</span>
      <span class="money ${incoming ? "in" : "out"}">${incoming ? "+" : "−"}${brl(t.amount)}</span>
      <span class="meta"><span class="st ${t.status}">${t.status}${t.reason ? " " + esc(t.reason) : ""}</span>${esc(label)}${t.returned ? ` · devolvido ${brl(t.returned)}` : ""}
      ${canReturn ? `<button class="small" data-return="${esc(t.id)}" data-amount="${t.amount - t.returned}">devolver</button>` : ""}</span>
    </li>`;
  }).join("");
}

function renderKeyChips() {
  const keys = state.abcd.customers.flatMap((c) => c.keys.map((k) => ({ ...k, owner: c.name })));
  $("key-chips").innerHTML = keys.map((k) => `<button type="button" class="chip" data-key="${esc(k.key)}" title="${esc(k.owner)} · ${k.type}">${esc(k.type === "EVP" ? k.key.slice(0, 8) + "…" : k.key)}</button>`).join("")
    + `<button type="button" class="chip bad" data-key="naoexiste@abcd.com.br" title="Chave que não existe no DICT">chave inexistente</button>`;
}

async function refresh() {
  state = await api("/api/state");
  const sel = $("from");
  const keep = sel.value;
  sel.innerHTML = state.xpto.customers.map((c) => `<option value="${c.id}">${esc(c.name)} · ${brl(c.balance)}</option>`).join("");
  if (keep) sel.value = keep;
  renderCustomers($("xpto-customers"), state.xpto.customers);
  renderCustomers($("abcd-customers"), state.abcd.customers);
  renderTxs($("xpto-txs"), state.xpto.transactions.filter((t) => t.kind !== "internal"), "xpto");
  renderTxs($("abcd-txs"), state.abcd.transactions, "abcd");
  renderKeyChips();
  $("offline").checked = state.abcd.bank.offline;
  $("ctl-link").href = `${state.ctlUrl}/transactions`;

  const pis = await api("/api/bacen/participants");
  $("pi").innerHTML = [XPTO, ABCD].map((ispb) => {
    const p = pis.find((x) => x.ispb === ispb);
    if (!p) return `<div><span class="name">${ispb}</span><br><span class="empty">fora do SPI</span></div>`;
    const delta = Number(p.balance) - 1_000_000;
    return `<div><span class="name">${esc(p.name)} · ${ispb}</span><br><span class="money">${brl(Number(p.balance))}</span><br>
      <span class="delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta ? (delta > 0 ? "+" : "−") + brl(Math.abs(delta)) : "sem movimento"}</span></div>`;
  }).join("");
}

let pending;
const refreshSoon = () => {
  clearTimeout(pending);
  pending = setTimeout(() => refresh().catch(() => {}), 150);
};

// ---------------------------------------------------------------------------
// Linha do tempo
// ---------------------------------------------------------------------------

const hidden = new Set();
const log = $("log");

function addLog(ev) {
  const time = new Date(ev.at ?? ev.startedAt ?? Date.now()).toLocaleTimeString("pt-BR");
  const li = document.createElement("li");
  li.dataset.src = ev.source;
  li.hidden = hidden.has(ev.source);
  let msg;
  if (ev.type === "start") {
    li.className = "title";
    msg = `▶ ${esc(ev.title)}`;
  } else if (ev.type === "step") {
    msg = `<span class="k-${ev.kind}">${esc(ev.text)}</span>${ev.why ? `<span class="why">${esc(ev.why)}</span>` : ""}`;
  } else {
    msg = `<b>${esc(ev.actor)}</b> ${esc(ev.message)}`;
  }
  li.innerHTML = `<span class="t">${time}</span><span class="src ${ev.source}">${ev.source}</span><span class="msg">${msg}</span>`;
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(li);
  while (log.children.length > 600) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
}

const events = new EventSource("/api/stream");
events.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  addLog(ev);
  onTrackEvent(ev);
  refreshSoon();
};

document.querySelectorAll(".filters input").forEach((cb) => cb.addEventListener("change", () => {
  cb.checked ? hidden.delete(cb.dataset.src) : hidden.add(cb.dataset.src);
  for (const li of log.children) li.hidden = hidden.has(li.dataset.src);
}));
$("clear").onclick = () => { log.innerHTML = ""; };

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

function feedback(text, kind) {
  const el = $("feedback");
  el.textContent = text;
  el.className = `feedback ${kind ?? ""}`;
}

$("key-chips").onclick = (e) => {
  const key = e.target.closest("[data-key]")?.dataset.key;
  if (key) $("key").value = key;
};

$("pix-form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("send");
  btn.disabled = true;
  feedback("");
  resetTrack();
  try {
    const { recipient, tx } = await api("/api/pix", { from: $("from").value, key: $("key").value, amount: $("amount").value, description: $("desc").value });
    track.e2e = tx.endToEndId;
    $("e2e").textContent = tx.endToEndId;
    feedback(tx.status === "REJEITADO" ? `Rejeitado: ${tx.reason ?? ""}` : `Enviado para ${recipient.name}. Acompanhe ao lado →`, tx.status === "REJEITADO" ? "err" : "ok");
  } catch (err) {
    feedback(err.message, "err");
    if (track.fail < 0) {
      track.fail = Math.max(0, track.done.findIndex((d) => !d));
      track.done[track.fail] = err.message;
      track.active = false;
      renderTrack();
    }
  } finally {
    btn.disabled = false;
    refreshSoon();
  }
};

$("abcd-txs").onclick = async (e) => {
  const b = e.target.closest("[data-return]");
  if (!b) return;
  b.disabled = true;
  try {
    await api(`/api/pix/${b.dataset.return}/return`, { amount: b.dataset.amount });
  } catch (err) {
    feedback(err.message, "err");
  }
  refreshSoon();
};

$("offline").onchange = async (e) => {
  await api("/api/lab/offline", { on: e.target.checked });
  refreshSoon();
};

track.active = false;
track.done = STAGES.map(() => null);
renderTrack();
refresh();
setInterval(() => refresh().catch(() => {}), 5_000);
