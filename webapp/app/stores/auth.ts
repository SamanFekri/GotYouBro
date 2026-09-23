import { defineStore } from 'pinia';
import type { Me } from '~/utils/types';

type Status = 'idle' | 'loading' | 'ready' | 'no-telegram' | 'blocked' | 'error';

/**
 * Session state. Identity comes exclusively from Telegram's signed initData, verified by the
 * backend; the frontend never sends a user id of its own.
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: '' as string,
    user: null as Me | null,
    status: 'idle' as Status,
    error: '' as string,
  }),
  getters: {
    isAdmin: (s) => !!s.user?.isAdmin,
  },
  actions: {
    async login(): Promise<boolean> {
      const { initData, webApp } = useTelegram();
      webApp?.ready();
      webApp?.expand();
      if (webApp) document.documentElement.classList.add('tg');
      if (!initData) {
        this.status = 'no-telegram';
        return false;
      }
      this.status = 'loading';
      try {
        const res = await $fetch<{ success: true; data: { token: string; user: Me } }>('/api/v1/app/auth', {
          method: 'POST',
          body: { initData },
        });
        this.token = res.data.token;
        this.user = res.data.user;
        this.status = 'ready';
        return true;
      } catch (err: unknown) {
        const e = err as { data?: { error?: { code: string; message: string } } };
        this.status = e.data?.error?.code === 'USER_BLOCKED' ? 'blocked' : 'error';
        this.error = e.data?.error?.message ?? 'Could not sign in';
        return false;
      }
    },
    async refreshMe() {
      this.user = await useApi().get<Me>('/app/me');
    },
  },
});
