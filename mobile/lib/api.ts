import * as SecureStore from 'expo-secure-store';

export type Auth = { token: string; csrf: string; user: { email: string; name?: string; role: string } };
export const BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/$/, '');

export async function readAuth(): Promise<Auth | null> {
  try {
    const saved = await SecureStore.getItemAsync('library-auth');
    return saved ? JSON.parse(saved) as Auth : null;
  } catch { return null; }
}

export async function request(path: string, auth: Auth | null, init: RequestInit = {}) {
  if (!BASE) throw new Error('Set EXPO_PUBLIC_API_URL to your deployed HTTPS API (or local emulator URL for development).');
  if (!/^https:\/\//i.test(BASE) && !__DEV__) throw new Error('The mobile app requires HTTPS outside development.');
  const headers: Record<string,string> = { ...(init.headers as Record<string,string> || {}) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth?.csrf && ['POST','PATCH','DELETE'].includes((init.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = auth.csrf;
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
