// App do cliente + paineis de estudo. Sem framework: DOM direto.

const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour12: false });

let config = null;
let state = null;
let current = null;
let pendingPayment = null;

const KIND_LABEL = {
  "pix-out": "Pix enviado",
  "pix-in": "Pix recebido",
  "return-out": "Devolução enviada",
  "return-in": "Devolução recebida",
  internal: "Transferência interna",
};

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function feedback(text, kind = "") {
  const el = $("#feedback");
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

// ---------------------------------------------------------------------------
// Estado e renderizacao
// ---------------------------------------------------------------------------

async function refresh() {
  state = await api("/api/state");
  if (!current || !state.customers.some((c) => c.id === current)) {
    current = localStorage.getItem(`customer:${config.ispb}`) || state.customers[0]?.id;
  }
  render();
}

function render() {
  const c = state.customers.find((x) => x.id === current);
  if (!c) return;

  $("#customers").innerHTML = state.customers
    .map((x) => `<button data-customer="${x.id}" class="${x.id === current ? "active" : ""}">${esc(x.name)}</button>`)
    .join("");

  $("#customer-name").textContent = c.name;
  $("#balance").textContent = brl.format(c.balance);
  $("#branch").textContent = c.branch;
  $("#account").textContent = c.account;
  $("#doc").textContent = c.taxId.length === 11 ? `CPF ${c.taxId}` : `CNPJ ${c.taxId}`;

  $("#keys").innerHTML = c.keys.length
    ? c.keys.map((k) => `<li><span>${esc(k.key)}</span><span class="type">${k.type}</span></li>`).join("")
    : `<li class="muted">Nenhuma chave cadastrada</li>`;
  $("#receive-key").innerHTML = c.keys.map((k) => `<option value="${esc(k.key)}">${esc(k.key)} (${k.type})</option>`).join("");

  const txs = state.transactions.filter((t) => t.customerId === current);
  $("#statement").innerHTML = txs.length
    ? txs.map((t) => {
        const incoming = t.kind === "pix-in" || t.kind === "return-in";
        const canReturn = t.kind === "pix-in" && t.status === "CONCLUIDO" && t.returned < t.amount;
        return `<li>
          <span class="title">${KIND_LABEL[t.kind]} · ${esc(t.counterparty)}</span>
          <span class="value ${incoming ? "in" : ""}">${incoming ? "+" : "−"} ${brl.format(t.amount)}</span>
          <span class="meta">${time(t.createdAt)} · ${esc(t.id)}${t.reason ? ` · motivo ${esc(t.reason)}` : ""}${t.returned ? ` · devolvido ${brl.format(t.returned)}` : ""}${t.description ? ` · "${esc(t.description)}"` : ""}</span>
          <span class="badge ${t.status}">${t.status}</span>
          ${canReturn ? `<button class="chip return" data-return="${t.id}" data-max="${t.amount - t.returned}">devolver</button>` : ""}
        </li>`;
      }).join("")
    : `<li class="muted">Sem movimentações</li>`;
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
}

// ---------------------------------------------------------------------------
// Paineis de estudo
// ---------------------------------------------------------------------------

function follow(list) {
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  return () => { if (nearBottom) list.scrollTop = list.scrollHeight; };
}

function connectJourney() {
  const list = $("#journey");
  const es = new EventSource("/api/journey/stream");
  es.addEventListener("start", (ev) => {
    const j = JSON.parse(ev.data);
    const scroll = follow(list);
    list.insertAdjacentHTML("beforeend", `<li class="title">▶ ${esc(j.title)} <span class="muted small">${time(j.startedAt)}</span></li>`);
    scroll();
  });
  es.addEventListener("step", (ev) => {
    const s = JSON.parse(ev.data);
    const scroll = follow(list);
    const detail = s.detail ? `<details><summary>ver ${s.detail.startsWith("<") ? "XML" : "conteúdo"}</summary><pre>${esc(s.detail)}</pre></details>` : "";
    list.insertAdjacentHTML("beforeend", `<li class="step ${s.kind}"><span class="n">${s.n}.</span><span><span class="text">${esc(s.text)}</span>${s.why ? `<span class="why">${esc(s.why)}</span>` : ""}${detail}</span></li>`);
    scroll();
    scheduleRefresh();
  });
}

function connectBacen() {
  const list = $("#bacen");
  const es = new EventSource(`${config.ctlUrl}/events/stream`);
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    const mine = !e.ispb || e.ispb === config.ispb;
    const scroll = follow(list);
    list.insertAdjacentHTML("beforeend", `<li data-mine="${mine}" class="${$("#only-mine").checked && !mine ? "hidden" : ""}">
      <span class="time">${time(e.at)}</span><span class="actor ${e.actor}">${e.actor}</span><span class="msg">${esc(e.message)}</span></li>`);
    scroll();
  };
  $("#only-mine").addEventListener("change", (ev) => {
    for (const li of list.children) li.classList.toggle("hidden", ev.target.checked && li.dataset.mine === "false");
  });
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

function showConfirm(p) {
  pendingPayment = p;
  $("#confirm-name").textContent = p.name;
  $("#confirm-meta").textContent = `${p.document} · banco ${p.bank}`;
  $("#confirm-amount").value = p.fixedAmount ? (p.fixedAmount / 100).toFixed(2).replace(".", ",") : "";
  $("#confirm-amount").disabled = Boolean(p.fixedAmount);
  $("#confirm").classList.remove("hidden");
  $("#confirm-amount").focus();
}

function hideConfirm() {
  pendingPayment = null;
  $("#confirm").classList.add("hidden");
  $("#confirm-desc").value = "";
}

async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    feedback(err.message, "err");
  } finally {
    button.disabled = false;
  }
}

function bind() {
  $("#customers").addEventListener("click", (ev) => {
    const id = ev.target.dataset?.customer;
    if (!id) return;
    current = id;
    localStorage.setItem(`customer:${config.ispb}`, id);
    hideConfirm();
    feedback("");
    render();
  });

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== b.dataset.tab));
      hideConfirm();
      feedback("");
    }),
  );

  document.querySelectorAll("[data-fill]").forEach((c) => c.addEventListener("click", () => { $("#form-key").key.value = c.dataset.fill; }));
  document.querySelectorAll("[data-manual]").forEach((c) => c.addEventListener("click", () => {
    const f = $("#form-manual");
    f.ispb.value = c.dataset.manual;
    f.branch.value = "1";
    f.account.value = "1";
    f.document.value = "11111111111";
  }));

  $("#form-key").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    busy(btn, async () => {
      feedback("Consultando o DICT…");
      showConfirm(await api("/api/pix/prepare", { customerId: current, key: ev.target.key.value }));
      feedback("");
    });
  });

  $("#form-qr").addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(ev.submitter, async () => {
      feedback("Lendo o QR Code…");
      showConfirm(await api("/api/pix/prepare", { customerId: current, qr: ev.target.qr.value }));
      feedback("");
    });
  });

  $("#confirm-go").addEventListener("click", (ev) =>
    busy(ev.currentTarget, async () => {
      const tx = await api("/api/pix/confirm", {
        paymentId: pendingPayment.paymentId,
        amount: $("#confirm-amount").value,
        description: $("#confirm-desc").value,
      });
      hideConfirm();
      feedback(tx.status === "CONCLUIDO" ? "Transferência concluída." : `Pix enviado ao SPI (${tx.id}). Acompanhe no diário →`, "ok");
      refresh();
    }),
  );
  $("#confirm-cancel").addEventListener("click", () => { hideConfirm(); feedback(""); });

  $("#form-manual").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target;
    busy(ev.submitter, async () => {
      const tx = await api("/api/pix/manual", {
        customerId: current, ispb: f.ispb.value.trim().toUpperCase(), branch: f.branch.value, account: f.account.value,
        accountType: f.accountType.value, document: f.document.value, amount: f.amount.value,
      });
      feedback(`Pix enviado ao SPI (${tx.id}). Acompanhe no diário →`, "ok");
      refresh();
    });
  });

  $("#form-receive").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target;
    busy(ev.submitter, async () => {
      const { payload } = await api("/api/qr", { customerId: current, key: f.key.value, amount: f.amount.value || undefined, txId: f.txId.value || undefined });
      $("#qr-payload").textContent = payload;
      $("#qr-out").classList.remove("hidden");
    });
  });
  $("#copy-qr").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#qr-payload").textContent);
    feedback("Payload copiado.", "ok");
  });

  $("#form-newkey").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target;
    busy(ev.submitter, async () => {
      const { key } = await api(`/api/customers/${current}/keys`, { type: f.type.value === "CPF" && state.customers.find((c) => c.id === current).taxId.length === 14 ? "CNPJ" : f.type.value, key: f.key.value });
      feedback(`Chave ${key} cadastrada no DICT.`, "ok");
      f.key.value = "";
      refresh();
    });
  });

  $("#statement").addEventListener("click", (ev) => {
    const id = ev.target.dataset?.return;
    if (!id) return;
    const max = Number(ev.target.dataset.max);
    const value = prompt(`Quanto devolver? (até ${brl.format(max)})`, max.toFixed(2).replace(".", ","));
    if (!value) return;
    busy(ev.target, async () => {
      await api(`/api/pix/${id}/return`, { amount: value });
      feedback("Devolução (pacs.004) enviada ao SPI.", "ok");
      refresh();
    });
  });
}

async function bindLab() {
  const offline = $("#lab-offline");
  const blocked = $("#lab-blocked");
  offline.checked = Boolean(config.offline);
  try {
    const me = (await (await fetch(`${config.ctlUrl}/participants`)).json()).find((p) => p.ispb === config.ispb);
    blocked.checked = Boolean(me?.sendBlocked);
  } catch {
    blocked.disabled = true;
  }
  offline.addEventListener("change", async () => {
    await api("/api/lab/offline", { on: offline.checked });
    feedback(offline.checked ? "Banco fora do ar: veja o AB03 no outro banco depois de 40 s." : "Banco de volta.", "ok");
  });
  blocked.addEventListener("change", async () => {
    await fetch(`${config.ctlUrl}/participants/${config.ispb}/${blocked.checked ? "block" : "unblock"}`, { method: "POST" });
    feedback(blocked.checked ? "Envio bloqueado no SPI (DS02)." : "Envio liberado.", "ok");
  });
}

async function main() {
  config = await api("/api/config");
  document.body.classList.add(config.theme);
  document.title = `${config.name} · Open Pix`;
  $("#bank-name").textContent = config.name;
  $("#bank-ispb").textContent = config.ispb;
  bind();
  await refresh();
  await bindLab();
  connectJourney();
  connectBacen();
}

main().catch((err) => feedback(err.message, "err"));
