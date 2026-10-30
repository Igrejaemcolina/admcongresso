import { fetchDashboard, loginSession, registerPayment, endSession, AccessError } from './api.js';
import { normalizeId, currency, integer, percent, filterParticipants, lastInstallment, referenceKey, httpsReceipt, paymentDate, INSTALLMENT_REFERENCES, INSTALLMENT_VALUE, installmentLabel, sessionExpiresAt } from './data.js';

const $ = id => document.getElementById(id);
let accessId = '';
let data = null;
let activeFilter = 'all';
let requestNumber = 0;
let activeController = null;
let busy = false;
let dialogOpener = null;
let session = null;
let selectedParticipantId = null;
let paymentSelection = null;
let paymentOpener = null;
let paymentBusy = false;
let needsPaymentRefresh = false;
let confirmedPayment = null;

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
  updatePaymentControls();
}

function updatePaymentControls() {
  document.querySelectorAll('.mark-paid').forEach(button => { button.disabled = busy || needsPaymentRefresh; });
  $('confirm-payment').disabled = busy || needsPaymentRefresh;
  $('cancel-payment').disabled = paymentBusy;
  $('confirm-payment').textContent = paymentBusy ? 'Registrando…' : 'Confirmar pagamento';
  $('payment-dialog').setAttribute('aria-busy', String(paymentBusy));
}

function resetFilters() {
  activeFilter = 'all';
  $('search').value = '';
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === 'all')));
}

function clearPrivateView() {
  if ($('payment-dialog').open) $('payment-dialog').close();
  if ($('installment-dialog').open) $('installment-dialog').close();
  dialogOpener = null;
  paymentOpener = null;
  paymentSelection = null;
  selectedParticipantId = null;
  for (const id of ['administrator', 'total-participants', 'total-expected', 'total-received', 'total-outstanding', 'total-percent', 'consulted-at', 'participant-list', 'result-count', 'dialog-title', 'dialog-last', 'installments', 'payment-person', 'payment-id', 'payment-reference', 'payment-value', 'payment-message', 'installment-message']) $(id).replaceChildren();
  $('collection-progress').value = 0;
  $('collection-progress').removeAttribute('aria-valuetext');
  $('dashboard-message').textContent = '';
  $('empty').hidden = true;
  resetFilters();
}

function logout(message = '', focus = true) {
  const token = session?.token;
  session = null;
  paymentBusy = false;
  needsPaymentRefresh = false;
  confirmedPayment = null;
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
  // Limpeza local é imediata; uma falha de rede não garante revogação remota.
  if (token) void endSession(token, { timeout: 5000 }).catch(() => {});
}

function acceptDashboard(result) {
  data = result;
  // Um sucesso de gravação que ainda não aparece na consulta impede novo envio.
  const recorded = !confirmedPayment || data.participantes.find(person => person.id === confirmedPayment.id)?.parcelas.some(item => item.referencia === confirmedPayment.reference && item.pago);
  needsPaymentRefresh = !recorded;
  if (recorded) confirmedPayment = null;
  renderDashboard();
  if ($('installment-dialog').open) {
    const person = data.participantes.find(item => item.id === selectedParticipantId);
    const opener = [...document.querySelectorAll('.details-button')].find(button => button.dataset.participantId === selectedParticipantId && button.getClientRects().length);
    if (person) showInstallments(person, opener || dialogOpener);
    else $('installment-dialog').close();
  }
  if (!recorded) paymentNotice('O backend confirmou o pagamento, mas a consulta ainda não o mostra. Atualize os dados antes de registrar outro pagamento.', true);
}

function paymentNotice(message, warning = false) {
  for (const id of ['dashboard-message', 'installment-message']) {
    $(id).className = `message${warning ? ' warning' : ''}`;
    $(id).textContent = message;
  }
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
    $('access-id').value = '';
    acceptDashboard(result);
    $('login').hidden = true;
    $('dashboard').hidden = false;
    paymentNotice(needsPaymentRefresh ? 'O pagamento confirmado ainda não aparece na consulta. Atualize antes de registrar outro pagamento.' : refreshing ? 'Consulta atualizada.' : '', needsPaymentRefresh);
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
  button.dataset.participantId = person.id;
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
  const wasOpen = $('installment-dialog').open;
  const previousScroll = $('installment-dialog').scrollTop;
  selectedParticipantId = person.id;
  dialogOpener = opener;
  $('dialog-title').textContent = person.nome;
  $('dialog-last').textContent = `Última parcela paga: ${lastInstallment(person)}`;
  const container = $('installments');
  container.replaceChildren();
  const installments = [
    ...INSTALLMENT_REFERENCES.map(referencia => person.parcelas.find(item => item.referencia === referencia) || { referencia, missing: true }),
    ...person.parcelas.filter(item => !INSTALLMENT_REFERENCES.includes(item.referencia)),
  ].sort((a, b) => referenceKey(a.referencia) - referenceKey(b.referencia));
  for (const item of installments) {
    const section = element('section', 'installment');
    const heading = element('div', 'installment-heading');
    heading.append(element('h3', '', item.referencia), element('span', `badge ${item.pago ? 'paid' : 'pending'}`, item.missing ? 'Não informada' : item.pago ? '✓ Pago' : '◷ Pendente'));
    section.append(heading);
    if (item.missing) section.append(element('p', 'hint', 'Parcela não informada pelo serviço. Atualize a consulta ou avise a administração.'));
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
    if (!item.missing && !item.pago && INSTALLMENT_REFERENCES.includes(item.referencia)) {
      const button = element('button', 'button secondary mark-paid', 'Marcar como pago');
      button.type = 'button';
      button.disabled = busy || needsPaymentRefresh;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-label', `Marcar como pago: ${item.referencia}`);
      button.addEventListener('click', () => confirmPayment(person.id, item.referencia, button));
      section.append(button);
    }
    container.append(section);
  }
  if (!wasOpen) {
    $('installment-dialog').showModal();
    $('close-dialog').focus();
  } else $('installment-dialog').scrollTop = previousScroll;
}

function confirmPayment(id, reference, opener) {
  if (busy || needsPaymentRefresh || !accessId) return;
  const person = data?.participantes.find(item => item.id === id);
  const item = person?.parcelas.find(item => item.referencia === reference);
  if (!item || item.pago) return;
  paymentSelection = { id, reference };
  paymentOpener = opener;
  $('payment-person').textContent = person.nome;
  $('payment-id').textContent = person.id;
  $('payment-reference').textContent = `${installmentLabel(reference)} (${reference})`;
  $('payment-value').textContent = currency(INSTALLMENT_VALUE);
  $('payment-message').textContent = '';
  updatePaymentControls();
  $('payment-dialog').showModal();
  $('cancel-payment').focus();
}

async function submitPayment() {
  if (busy || needsPaymentRefresh || !paymentSelection || !accessId) return;
  if (session && sessionExpiresAt(session.expiraEm) <= Date.now()) {
    logout('Sua sessão expirou. Entre novamente para registrar pagamentos.');
    return;
  }
  const selection = { ...paymentSelection };
  const person = data?.participantes.find(item => item.id === selection.id);
  if (!person?.parcelas.some(item => item.referencia === selection.reference && !item.pago)) return;
  const sequence = ++requestNumber;
  activeController = new AbortController();
  const signal = activeController.signal;
  paymentBusy = true;
  setBusy(true, true);
  let submitted = false;
  let recorded = false;
  try {
    if (!session) {
      const result = await loginSession(accessId, { signal });
      if (sequence !== requestNumber) return;
      session = result;
    }
    if (sessionExpiresAt(session.expiraEm) <= Date.now()) throw new AccessError('Sua sessão expirou. Entre novamente.');
    submitted = true;
    needsPaymentRefresh = true;
    const result = await registerPayment(session.token, selection.id, selection.reference, { signal });
    if (sequence !== requestNumber) return;
    recorded = true;
    confirmedPayment = selection;
    $('payment-dialog').close();
    const historyWarning = result.historicoRegistrado ? '' : ' Atenção: o backend não confirmou o registro do histórico do administrador.';
    paymentNotice(`Pagamento registrado com sucesso! Atualizando os dados oficiais…${historyWarning}`, !result.historicoRegistrado);
    const updated = await fetchDashboard(accessId, { signal });
    if (sequence !== requestNumber) return;
    acceptDashboard(updated);
    if (!needsPaymentRefresh) paymentNotice(`Pagamento registrado com sucesso!${historyWarning}`, !result.historicoRegistrado);
    $('close-dialog').focus();
  } catch (error) {
    if (sequence !== requestNumber) return;
    if (error instanceof AccessError) {
      logout(recorded ? 'Pagamento registrado com sucesso! A sessão foi encerrada ao atualizar os dados. Entre novamente para consultar os valores oficiais.' : error.message);
      return;
    }
    const message = recorded
      ? `Pagamento registrado com sucesso! Não foi possível atualizar os dados: ${error.message} Os valores exibidos são da consulta anterior. Use Atualizar antes de registrar outro pagamento.`
      : `${error.message}${submitted ? ' O resultado da gravação não foi confirmado nesta tela. Cancele e use Atualizar para conferir a parcela antes de tentar novamente.' : ' Nenhum pagamento foi enviado.'}`;
    $('payment-message').textContent = message;
    paymentNotice(message, true);
  } finally {
    if (sequence === requestNumber) {
      paymentBusy = false;
      setBusy(false);
      activeController = null;
    }
  }
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

$('confirm-payment').addEventListener('click', submitPayment);
$('cancel-payment').addEventListener('click', () => { if (!paymentBusy) $('payment-dialog').close(); });
$('payment-dialog').addEventListener('cancel', event => { if (paymentBusy) event.preventDefault(); });
$('payment-dialog').addEventListener('close', () => {
  paymentSelection = null;
  for (const id of ['payment-person', 'payment-id', 'payment-reference', 'payment-value', 'payment-message']) $(id).textContent = '';
  if (paymentOpener?.isConnected && !paymentOpener.disabled) paymentOpener.focus();
  else if ($('installment-dialog').open) $('close-dialog').focus();
  paymentOpener = null;
});
$('installment-dialog').addEventListener('close', () => {
  if (dialogOpener?.isConnected) dialogOpener.focus();
  else if (data) $('dashboard-title').focus();
});
for (const dialog of [$('installment-dialog'), $('payment-dialog')]) dialog.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...dialog.querySelectorAll('button:not(:disabled), a[href]')];
  const first = controls[0];
  const last = controls.at(-1);
  if (!controls.length) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
});
// Evita restaurar dados privados pelo histórico (back/forward cache).
window.addEventListener('pagehide', () => logout('', false));
window.addEventListener('pageshow', event => { if (event.persisted) logout('', false); });
