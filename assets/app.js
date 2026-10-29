import { fetchDashboard, AccessError } from './api.js';
import { normalizeId, currency, integer, percent, filterParticipants, lastInstallment, referenceKey, httpsReceipt, paymentDate } from './data.js';

const $ = id => document.getElementById(id);
let accessId = '';
let data = null;
let activeFilter = 'all';
let requestNumber = 0;
let activeController = null;
let busy = false;
let dialogOpener = null;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function setBusy(value, refreshing = false) {
  busy = value;
  $('enter').disabled = value;
  $('refresh').disabled = value;
  $('access-id').readOnly = value;
  $('enter').textContent = value && !refreshing ? 'Consultando…' : 'Entrar →';
  $('refresh').textContent = value && refreshing ? 'Consultando…' : '↻ Atualizar';
  $('login-form').setAttribute('aria-busy', String(value && !refreshing));
  $('dashboard').setAttribute('aria-busy', String(value && refreshing));
}

function resetFilters() {
  activeFilter = 'all';
  $('search').value = '';
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === 'all')));
}

function clearPrivateView() {
  if ($('installment-dialog').open) $('installment-dialog').close();
  dialogOpener = null;
  for (const id of ['administrator', 'total-participants', 'total-expected', 'total-received', 'total-outstanding', 'total-percent', 'consulted-at', 'participant-list', 'result-count', 'dialog-title', 'dialog-last', 'installments']) $(id).replaceChildren();
  $('collection-progress').value = 0;
  $('collection-progress').removeAttribute('aria-valuetext');
  $('dashboard-message').textContent = '';
  $('empty').hidden = true;
  resetFilters();
}

function logout(message = '', focus = true) {
  requestNumber++;
  activeController?.abort();
  activeController = null;
  accessId = '';
  data = null;
  clearPrivateView();
  $('access-id').value = '';
  $('access-id').type = 'password';
  $('toggle-password').textContent = 'Mostrar';
  $('toggle-password').setAttribute('aria-label', 'Mostrar ID de acesso');
  $('toggle-password').setAttribute('aria-pressed', 'false');
  $('dashboard').hidden = true;
  $('login').hidden = false;
  $('login-message').textContent = message;
  setBusy(false);
  if (focus) $('access-id').focus();
}

async function consult(refreshing) {
  if (busy) return;
  const id = refreshing ? accessId : normalizeId($('access-id').value);
  if (!id) { $('login-message').textContent = 'Informe seu ID de acesso.'; $('access-id').focus(); return; }
  // A autorização depende exclusivamente do backend, sem lista local de IDs.
  const sequence = ++requestNumber;
  activeController = new AbortController();
  $('login-message').textContent = '';
  $('dashboard-message').className = 'message';
  $('dashboard-message').textContent = refreshing ? 'Consultando pagamentos… Os dados exibidos ainda são da consulta anterior.' : '';
  setBusy(true, refreshing);
  try {
    const result = await fetchDashboard(id, { signal: activeController.signal });
    if (sequence !== requestNumber) return;
    accessId = id;
    data = result;
    $('access-id').value = '';
    if ($('installment-dialog').open) $('installment-dialog').close();
    $('installments').replaceChildren();
    $('dialog-title').textContent = '';
    $('dialog-last').textContent = '';
    renderDashboard();
    $('login').hidden = true;
    $('dashboard').hidden = false;
    $('dashboard-message').textContent = refreshing ? 'Consulta atualizada.' : '';
    if (!refreshing) $('dashboard-title').focus();
  } catch (error) {
    if (sequence !== requestNumber) return;
    if (refreshing && error instanceof AccessError) { logout(error.message); return; }
    if (refreshing) {
      $('dashboard-message').className = 'message warning';
      $('dashboard-message').textContent = `${error.message} Os dados exibidos são da consulta anterior (${data.consultaRealizadaEm}).`;
    } else {
      $('login-message').textContent = error.message;
      $('access-id').focus();
    }
  } finally {
    if (sequence === requestNumber) { setBusy(false); activeController = null; }
  }
}

function statusBadge(person) {
  return element('span', `badge ${person.situacao === 'Quitada' ? 'paid' : 'pending'}`, `${person.situacao === 'Quitada' ? '✓' : '◷'} ${person.situacao}`);
}

function detailsButton(person) {
  const button = element('button', 'button details-button', 'Ver parcelas');
  button.type = 'button';
  button.setAttribute('aria-label', `Ver parcelas de ${person.nome}`);
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => showInstallments(person, button));
  return button;
}

function renderDashboard() {
  $('administrator').textContent = data.administrador;
  const summary = data.resumo;
  $('total-participants').textContent = integer(summary.participantes);
  $('total-expected').textContent = currency(summary.totalPrevisto);
  $('total-received').textContent = currency(summary.totalRecebido);
  $('total-outstanding').textContent = currency(summary.totalAReceber);
  $('total-percent').textContent = percent(summary.percentualArrecadado);
  $('collection-progress').value = summary.percentualArrecadado;
  $('collection-progress').setAttribute('aria-valuetext', `${percent(summary.percentualArrecadado)} arrecadado`);
  $('consulted-at').textContent = `Consulta realizada em: ${data.consultaRealizadaEm}`;
  renderList();
}

function renderList() {
  if (!data) return;
  const people = filterParticipants(data.participantes, $('search').value, activeFilter);
  $('result-count').textContent = `${people.length === 1 ? '1 participante encontrada' : `${integer(people.length)} participantes encontradas`} · ${integer(data.participantes.length)} no grupo`;
  const container = $('participant-list');
  container.replaceChildren();
  $('empty').hidden = people.length > 0;
  $('empty-help').textContent = data.participantes.length ? 'Tente outro nome ou escolha o filtro Todas.' : 'O serviço não retornou participantes nesta consulta.';
  $('clear-filters').hidden = data.participantes.length === 0;
  if (!people.length) return;

  const table = element('table', 'participants-table');
  const caption = element('caption', 'sr-only', 'Pagamentos das participantes. Os indicadores superiores representam todo o grupo.');
  const head = element('thead');
  const headRow = element('tr');
  for (const label of ['Nome completo', 'Parcelas pagas', 'Parcelas faltantes', 'Valor pago', 'Saldo a pagar', 'Situação', 'Detalhes']) {
    const cell = element('th', '', label);
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  const body = element('tbody');
  const cards = element('div', 'participant-cards');
  for (const person of people) {
    const row = element('tr');
    const name = element('th', 'participant-name', person.nome);
    name.scope = 'row';
    row.append(name);
    for (const value of [integer(person.parcelasPagas), integer(person.parcelasFaltantes), currency(person.valorPago), currency(person.saldo)]) row.append(element('td', 'table-value', value));
    const status = element('td');
    status.append(statusBadge(person));
    const action = element('td');
    action.append(detailsButton(person));
    row.append(status, action);
    body.append(row);

    const card = element('article', 'participant-card');
    const cardHeader = element('div', 'card-heading');
    cardHeader.append(element('h3', '', person.nome), statusBadge(person));
    const description = element('dl', 'card-values');
    for (const [label, value] of [['Parcelas pagas', integer(person.parcelasPagas)], ['Parcelas faltantes', integer(person.parcelasFaltantes)], ['Valor pago', currency(person.valorPago)], ['Saldo a pagar', currency(person.saldo)]]) {
      const group = element('div');
      group.append(element('dt', '', label), element('dd', '', value));
      description.append(group);
    }
    const last = element('p', 'card-last');
    last.append(element('span', '', 'Última parcela paga'), element('strong', '', lastInstallment(person)));
    card.append(cardHeader, description, last, detailsButton(person));
    cards.append(card);
  }
  table.append(caption, head, body);
  container.append(table, cards);
}

function showInstallments(person, opener) {
  dialogOpener = opener;
  $('dialog-title').textContent = person.nome;
  $('dialog-last').textContent = `Última parcela paga: ${lastInstallment(person)}`;
  const container = $('installments');
  container.replaceChildren();
  const installments = [...person.parcelas].sort((a, b) => referenceKey(a.referencia) - referenceKey(b.referencia));
  if (!installments.length) container.append(element('p', 'empty-installments', 'Nenhuma parcela informada pelo serviço.'));
  for (const item of installments) {
    const section = element('section', 'installment');
    const heading = element('div', 'installment-heading');
    heading.append(element('h3', '', item.referencia), element('span', `badge ${item.pago ? 'paid' : 'pending'}`, item.pago ? '✓ Paga' : '◷ Pendente'));
    section.append(heading);
    if (item.valor !== undefined) section.append(element('p', 'installment-value', currency(item.valor)));
    if (item.pago && item.data) section.append(element('p', 'installment-date', `Data de pagamento: ${paymentDate(item.data)}`));
    const receipt = httpsReceipt(item.comprovante);
    if (receipt) {
      const link = element('a', 'receipt-link', 'Abrir comprovante ↗');
      link.href = receipt;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      link.setAttribute('aria-label', `Abrir comprovante de ${item.referencia} em nova aba`);
      section.append(link);
    } else if (item.comprovante) section.append(element('p', 'hint', 'Comprovante sem link HTTPS válido.'));
    container.append(section);
  }
  $('installment-dialog').showModal();
  $('close-dialog').focus();
}

$('login-form').addEventListener('submit', event => { event.preventDefault(); consult(false); });
$('toggle-password').addEventListener('click', () => {
  const show = $('access-id').type === 'password';
  $('access-id').type = show ? 'text' : 'password';
  $('toggle-password').textContent = show ? 'Ocultar' : 'Mostrar';
  $('toggle-password').setAttribute('aria-label', `${show ? 'Ocultar' : 'Mostrar'} ID de acesso`);
  $('toggle-password').setAttribute('aria-pressed', String(show));
});
$('refresh').addEventListener('click', () => consult(true));
$('logout').addEventListener('click', () => logout());
$('search').addEventListener('input', renderList);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderList();
}));
$('clear-filters').addEventListener('click', () => { resetFilters(); renderList(); $('search').focus(); });
$('close-dialog').addEventListener('click', () => $('installment-dialog').close());
$('installment-dialog').addEventListener('close', () => { if (dialogOpener?.isConnected) dialogOpener.focus(); });
$('installment-dialog').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...$('installment-dialog').querySelectorAll('button:not(:disabled), a[href]')];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $('installment-dialog'))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
});
// Evita restaurar dados privados pelo histórico (back/forward cache).
window.addEventListener('pagehide', () => logout('', false));
window.addEventListener('pageshow', event => { if (event.persisted) logout('', false); });
