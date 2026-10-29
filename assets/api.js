import { API_URL, REQUEST_TIMEOUT_MS } from './config.js';
import { validateResponse, ContractError } from './data.js';

export class AccessError extends Error {}

export async function fetchDashboard(id, { signal, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ tela: 'adm', id }).toString();
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
      const response = await fetch(url, { method: 'GET', mode: 'cors', redirect: 'follow', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if ([401, 403].includes(response.status)) throw new AccessError('O serviço recusou o acesso. Entre novamente com um ID autorizado e ativo.');
      if (!response.ok) throw new Error('O serviço está indisponível neste momento. Tente novamente em instantes.');
      let body;
      try { body = await response.json(); } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new ContractError();
      }
      const data = validateResponse(body);
      if (!data.ok) throw new AccessError(data.erro);
      return data;
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
