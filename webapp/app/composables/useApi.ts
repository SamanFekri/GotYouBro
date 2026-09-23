import { useAuthStore } from '~/stores/auth';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Calls the backend and unwraps `{ success, data }`. Errors become ApiError with the server's
 * error code. A 401 triggers one silent re-login using Telegram initData.
 */
export function useApi() {
  const auth = useAuthStore();

  async function request<T>(method: Method, path: string, body?: unknown, query?: Record<string, unknown>, retried = false): Promise<T> {
    const cleanQuery = query ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== '' && v !== null)) : undefined;
    try {
      const res = await $fetch<{ success: true; data: T }>(`/api/v1${path}`, {
        method,
        body: body as Record<string, unknown> | undefined,
        query: cleanQuery,
        headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
      });
      return res.data;
    } catch (err: unknown) {
      const e = err as { status?: number; data?: { error?: { code: string; message: string; details?: unknown } } };
      const status = e.status ?? 0;
      if (status === 401 && !retried && path !== '/app/auth' && (await auth.login())) {
        return request<T>(method, path, body, query, true);
      }
      const apiErr = e.data?.error;
      throw new ApiError(apiErr?.code ?? 'NETWORK_ERROR', apiErr?.message ?? 'Network error, please try again', status, apiErr?.details);
    }
  }

  return {
    get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, undefined, query),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}

/** Load data with loading/error state; `reload()` refetches. */
export function useLoader<T>(fn: () => Promise<T>) {
  const data = ref<T>();
  const error = ref<string>();
  const loading = ref(true);
  async function reload() {
    loading.value = true;
    error.value = undefined;
    try {
      data.value = await fn();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }
  onMounted(reload);
  return { data, error, loading, reload };
}
