import { useAuthStore } from '~/stores/auth';

/** UX guard only — every admin endpoint is authorized server-side. */
export default defineNuxtRouteMiddleware(() => {
  const auth = useAuthStore();
  if (auth.status === 'ready' && !auth.isAdmin) return navigateTo('/');
});
