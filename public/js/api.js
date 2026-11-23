// Komunikacja z serwerem: CSRF, błędy, wykrywanie braku sieci.
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `Błąd serwera (${status})`);
    this.status = status;
    this.code = data && data.code;
    this.data = data || {};
  }
}
export class NetworkError extends Error {
  constructor() { super('Brak połączenia z serwerem'); this.network = true; }
}

export async function api(method, url, body) {
  const headers = { 'X-Tysiac': '1' };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new NetworkError();
  }
  let data = null;
  try { data = await res.json(); } catch { /* nie-JSON */ }
  if (!res.ok || !data || data.ok === false) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('tys:unauthorized'));
    throw new ApiError(res.status, data);
  }
  if (data.csrf) setCsrf(data.csrf);
  return data;
}

export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b = {}) => api('PUT', u, b);

// Pobranie pliku (eksport) z nagłówkami CSRF.
export async function download(url, body, fallbackName) {
  const headers = { 'X-Tysiac': '1', 'X-CSRF-Token': csrf };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let d = null;
    try { d = await res.json(); } catch { /* */ }
    throw new ApiError(res.status, d);
  }
  const blob = await res.blob();
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
