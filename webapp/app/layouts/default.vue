<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const { toasts } = useToast();

onMounted(() => {
  if (auth.status === 'idle') auth.login();
});

const tabs = [
  { to: '/', label: 'Home', icon: '🏠', match: (p: string) => p === '/' },
  { to: '/services', label: 'Services', icon: '🧩', match: (p: string) => p.startsWith('/services') },
  { to: '/backups', label: 'Backups', icon: '📦', match: (p: string) => p.startsWith('/backups') },
  { to: '/health', label: 'Health', icon: '💓', match: (p: string) => p.startsWith('/health') },
  { to: '/more', label: 'More', icon: '☰', match: (p: string) => ['/more', '/destinations', '/keys', '/settings', '/admin'].some((x) => p.startsWith(x)) },
];
</script>

<template>
  <div>
    <div v-if="auth.status === 'ready'">
      <slot />
      <nav class="tabbar">
        <NuxtLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" :class="{ active: tab.match(route.path) }">
          <span class="icon">{{ tab.icon }}</span>
          <span>{{ tab.label }}</span>
        </NuxtLink>
      </nav>
    </div>

    <div v-else class="page gate">
      <div v-if="auth.status === 'idle' || auth.status === 'loading'" class="spinner" />
      <EmptyState v-else-if="auth.status === 'no-telegram'" emoji="✈️" title="Open GotYouBro from Telegram" text="This Web App signs you in with your Telegram account. Open it from the bot's menu button or send /start to the bot." />
      <EmptyState v-else-if="auth.status === 'blocked'" emoji="⛔️" title="Account blocked" :text="auth.error" />
      <EmptyState v-else emoji="⚠️" title="Sign-in failed" :text="auth.error">
        <button class="btn" @click="auth.login()">Try again</button>
      </EmptyState>
    </div>

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.gate {
  min-height: 80vh;
  justify-content: center;
}
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: space-around;
  background: var(--surface);
  border-top: 1px solid var(--separator);
  padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
  z-index: 10;
}
.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--hint);
  flex: 1;
  padding: 2px 0;
}
.tab .icon {
  font-size: 20px;
  filter: grayscale(1);
  opacity: 0.7;
}
.tab.active {
  color: var(--accent);
}
.tab.active .icon {
  filter: none;
  opacity: 1;
}
.toasts {
  position: fixed;
  top: 12px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 100;
  pointer-events: none;
}
.toast {
  background: var(--text);
  color: var(--surface);
  padding: 10px 16px;
  border-radius: 12px;
  font-size: 14px;
  max-width: 90vw;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
.toast.error {
  background: var(--danger);
  color: #fff;
}
</style>
