export class ContractError extends Error {
  constructor() { super('A resposta do serviço está incompleta ou fora do formato esperado. Tente atualizar ou avise a administração.'); }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => numeric(value) && Number.isInteger(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const require = condition => { if (!condition) throw new ContractError(); };

export const INSTALLMENT_REFERENCES = Object.freeze(['11/2026', '12/2026', '01/2027', '02/2027', '03/2027', '04/2027']);
export const INSTALLMENT_VALUE = 100;
export function installmentLabel(reference) {
  const [month, year] = reference.split('/').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
}

// Aceita Unix em segundos ou milissegundos, sempre como número absoluto.
export const sessionExpiresAt = value => value < 1e12 ? value * 1000 : value;
export function validateLogin(data) {
  require(record(data) && data.ok === true && nonempty(data.token) && nonempty(data.administrador));
  require(numeric(data.expiraEm) && Number.isSafeInteger(data.expiraEm) && sessionExpiresAt(data.expiraEm) > Date.now());
  return data;
}

export function validatePayment(data, participantId, reference) {
  require(record(data) && data.ok === true && nonempty(data.mensagem) && nonempty(data.administrador));
  require(record(data.participante) && data.participante.id === participantId && nonempty(data.participante.nome));
  const item = data.parcela;
  require(record(item) && item.referencia === reference && item.pago === true && item.valor === INSTALLMENT_VALUE);
  require(nonempty(item.data) && paymentDate(item.data) !== 'Data não informada em formato reconhecido');
  require(typeof data.historicoRegistrado === 'boolean');
  return data;
}

export function normalizeId(value) { return value.trim().toLowerCase(); }
export function normalizeSearch(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR'); }
export const currency = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
export const integer = value => new Intl.NumberFormat('pt-BR').format(value);
export const percent = value => `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value)}%`;

export function referenceKey(value) {
  if (typeof value !== 'string' || !/^(0[1-9]|1[0-2])\/\d{4}$/.test(value)) return null;
  const [month, year] = value.split('/').map(Number);
  return year * 12 + month;
}

export function httpsReceipt(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function brazilianDate(value, withTime = false) {
  if (typeof value !== 'string') return false;
  const match = value.match(withTime ? /^(\d{2})\/(\d{2})\/(\d{4}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/ : /^(\d{2})\/(\d{2})\/(\d{4})(?: ([01]\d|2[0-3]):([0-5]\d):([0-5]\d))?$/);
  if (!match) return false;
  const [, day, month, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function paymentDate(value) {
  if (brazilianDate(value)) return value;
  // ISO com timezone explícito, sem interpretação de datas brasileiras por Date.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date);
  }
  return 'Data não informada em formato reconhecido';
}

export function lastInstallment(person) {
  if (referenceKey(person.ultimaParcelaPaga) !== null) return person.ultimaParcelaPaga;
  const paid = person.parcelas.filter(item => item.pago).sort((a, b) => referenceKey(b.referencia) - referenceKey(a.referencia));
  if (paid.length) return paid[0].referencia;
  return person.parcelasPagas === 0 ? 'Nenhuma parcela paga' : 'Referência não informada';
}

export function validateResponse(data) {
  require(record(data) && typeof data.ok === 'boolean');
  if (!data.ok) { require(nonempty(data.erro)); return data; }
  require(nonempty(data.administrador) && brazilianDate(data.consultaRealizadaEm, true));
  const summary = data.resumo;
  require(record(summary) && count(summary.participantes));
  for (const key of ['totalPrevisto', 'totalRecebido', 'totalAReceber', 'percentualArrecadado']) require(numeric(summary[key]));
  require(summary.percentualArrecadado <= 100 && Array.isArray(data.participantes));
  for (const person of data.participantes) {
    require(record(person) && nonempty(person.id) && nonempty(person.nome));
    for (const key of ['valorPago', 'saldo', 'totalPrevisto']) require(numeric(person[key]));
    require(count(person.parcelasPagas) && count(person.parcelasFaltantes));
    require(['Com pendências', 'Quitada'].includes(person.situacao));
    require(person.ultimaParcelaPaga == null || referenceKey(person.ultimaParcelaPaga) !== null);
    require(Array.isArray(person.parcelas));
    for (const item of person.parcelas) {
      require(record(item) && referenceKey(item.referencia) !== null && typeof item.pago === 'boolean');
      require(item.data == null || typeof item.data === 'string');
      require(item.comprovante == null || typeof item.comprovante === 'string');
      require(item.valor === undefined || numeric(item.valor));
    }
  }
  return data;
}

export function filterParticipants(people, search, filter) {
  const query = normalizeSearch(search.trim());
  return people.filter(person => (normalizeSearch(person.nome).includes(query) || normalizeSearch(person.id).includes(query)) && (filter === 'all' || (filter === 'paid' ? person.situacao === 'Quitada' : person.situacao === 'Com pendências')));
}
