import { API_URL, REQUEST_TIMEOUT_MS } from './config.js';
import { validateResponse, validateLogin, validatePayment, ContractError, INSTALLMENT_REFERENCES } from './data.js';

export class AccessError extends Error {}
export class BusinessError extends Error {}

export async function fetchDashboard(id, { signal, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ tela: 'adm', id }).toString();
  return requestJson(url, { method: 'GET' }, body => {
    const data = validateResponse(body);
    if (!data.ok) throw new AccessError(data.erro);
    return data;
  }, { signal, timeout });
}

// JSON no corpo como text/plain evita preflight OPTIONS no Web App.
// A resposta continua sujeita a CORS e sempre precisa ser lida e validada.
async function post(payload, validate, options) {
  return requestJson(new URL(API_URL), {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload),
  }, body => {
    if (body?.ok === false && typeof body.erro === 'string' && body.erro.trim()) {
      // O backend não documenta códigos de erro. Recusas de sessão conhecidas
      // encerram o acesso; outros erros de negócio não são tratados como sucesso.
      const message = body.erro.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (payload.acao === 'login' || /token|sessao|autentic|nao autorizado|acesso (invalido|negado|recusado|desativado)|administrador.*(invalido|inativo|desativado)/.test(message)) throw new AccessError(body.erro);
      throw new BusinessError(body.erro);
    }
    return validate(body);
  }, options);
}

export const loginSession = (id, options) => post({ acao: 'login', id }, validateLogin, options);

export function registerPayment(token, participanteId, referencia, options) {
  if (!token || !participanteId || !INSTALLMENT_REFERENCES.includes(referencia)) throw new ContractError();
  return post({ acao: 'registrarPagamento', token, participanteId, referencia }, body => validatePayment(body, participanteId, referencia), options);
}

export const endSession = (token, options) => post({ acao: 'sair', token }, body => {
  if (body?.ok !== true) throw new ContractError();
  return body;
}, options);

async function requestJson(url, init, validate, { signal, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  let aborted;
  const abortListener = () => { controller.abort(); aborted?.(new DOMException('Consulta cancelada.', 'AbortError')); };
  const cancellation = new Promise((_, reject) => { aborted = reject; });
  signal?.addEventListener('abort', abortListener, { once: true });
  if (signal?.aborted) abortListener();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('A consulta demorou mais que o esperado. Verifique sua conexão e tente novamente.'));
      controller.abort();
    }, timeout);
  });
  try {
    const request = (async () => {
      if (controller.signal.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
      const response = await fetch(url, { ...init, mode: 'cors', redirect: 'follow', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if ([401, 403].includes(response.status)) throw new AccessError('O serviço recusou o acesso. Entre novamente com um ID autorizado e ativo.');
      if (!response.ok) throw new Error('O serviço está indisponível neste momento. Tente novamente em instantes.');
      let body;
      try { body = await response.json(); } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new ContractError();
      }
      return validate(body);
    })();
    return await Promise.race([request, deadline, cancellation]);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Não foi possível consultar o serviço. Verifique sua conexão. Se persistir, avise a administração para verificar a publicação e a permissão de acesso da API.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortListener);
  }
}
