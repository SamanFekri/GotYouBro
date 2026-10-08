<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const { toasts } = useToast();

onMounted(() => {
  if (auth.status === 'idle') auth.login();
});

const tabs = [
  { to: '/', label: 'Home', icon: 'home' as const, match: (p: string) => p === '/' },
  { to: '/services', label: 'Services', icon: 'services' as const, match: (p: string) => p.startsWith('/services') },
  { to: '/backups', label: 'Backups', icon: 'package' as const, match: (p: string) => p.startsWith('/backups') },
  { to: '/health', label: 'Health', icon: 'activity' as const, match: (p: string) => p.startsWith('/health') },
  { to: '/more', label: 'More', icon: 'menu' as const, match: (p: string) => ['/more', '/destinations', '/keys', '/settings', '/admin'].some((x) => p.startsWith(x)) },
];
const activeTab = computed(() => tabs.findIndex((t) => t.match(route.path)));
</script>

<template>
  <div>
    <div v-if="auth.status === 'ready'">
      <slot />
      <nav class="tabbar">
        <span
          class="indicator"
          :style="{ transform: `translateX(${Math.max(activeTab, 0) * 100}%)`, opacity: activeTab < 0 ? 0 : 1 }"
          aria-hidden="true"
        ><span class="pill" /></span>
        <NuxtLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" :class="[`tab-${tab.icon}`, { active: tab.match(route.path) }]">
          <AppIcon :name="tab.icon" :size="22" :stroke-width="tab.match(route.path) ? 2.25 : 1.75" />
          <span>{{ tab.label }}</span>
        </NuxtLink>
      </nav>
    </div>

    <div v-else class="page gate">
      <img src="/logo.png" alt="GotYouBro" class="gate-logo" width="120" height="120" />
      <div v-if="auth.status === 'idle' || auth.status === 'loading'" class="spinner" />
      <EmptyState v-else-if="auth.status === 'no-telegram'" icon="telegram" title="Open GotYouBro from Telegram" text="This Web App signs you in with your Telegram account. Open it from the bot's menu button or send /start to the bot." />
      <EmptyState v-else-if="auth.status === 'blocked'" icon="blocked" title="Account blocked" :text="auth.error" />
      <EmptyState v-else icon="warning" title="Sign-in failed" :text="auth.error">
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
.gate-logo {
  align-self: center;
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
/* One highlight that slides to the active tab (tabs are equal width, so 100% = one tab). */
.indicator {
  position: absolute;
  top: 8px; /* tabbar padding 6 + tab padding 6 + icon 22 → pill centered on the icon */
  left: 4px;
  width: calc((100% - 8px) / 5);
  height: 30px;
  display: flex;
  justify-content: center;
  pointer-events: none;
  transition:
    transform 250ms var(--ease-in-out),
    opacity 150ms ease;
}
.pill {
  width: 56px;
  height: 100%;
  border-radius: 15px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .indicator {
    transition: opacity 150ms ease;
  }
}
.tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--hint);
  flex: 1;
  padding: 6px 0 0;
}
.tab {
  transition: color 150ms ease;
}
.tab:active .app-icon {
  transform: scale(0.92);
}
.tab .app-icon {
  transition: transform 120ms ease-out;
}
.tab.active {
  color: var(--accent);
}
/*
 * Each icon plays its own short animation once, when its tab becomes active.
 * Lucide draws with <path>s inside the svg, so :deep() reaches them; transform-box makes
 * each path transform around its own box rather than the whole 24×24 canvas.
 */
.tab :deep(.app-icon path),
.tab :deep(.app-icon polyline) {
  transform-box: fill-box;
}

/* Home: hop, then land with a little squash. */
.tab-home.active .app-icon {
  transform-origin: 50% 100%;
  animation: home-hop 460ms var(--ease-out);
}
@keyframes home-hop {
  0% { transform: translateY(0) scale(1, 1); }
  35% { transform: translateY(-4px) scale(0.96, 1.05); }
  70% { transform: translateY(0) scale(1.08, 0.9); }
  100% { transform: translateY(0) scale(1, 1); }
}

/* Services: the three boxes drop into the stack one after another (3 paths per box). */
.tab-services.active :deep(.app-icon path) {
  animation: box-drop 380ms var(--ease-out) both;
}
.tab-services.active :deep(.app-icon path:nth-child(n + 4)) {
  animation-delay: 70ms;
}
.tab-services.active :deep(.app-icon path:nth-child(n + 7)) {
  animation-delay: 140ms;
}
@keyframes box-drop {
  from { transform: translateY(-5px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* Backups: the package tips over and settles. */
.tab-package.active .app-icon {
  transform-origin: 50% 90%;
  animation: package-tip 480ms var(--ease-out);
}
@keyframes package-tip {
  0% { transform: rotate(0); }
  30% { transform: rotate(-14deg); }
  65% { transform: rotate(6deg); }
  100% { transform: rotate(0); }
}

/*
 * Health: the pulse line draws itself left → right like a monitor trace. The path (~49 units)
 * starts at the right edge, so a negative offset with an uneven dash/gap reveals it from its end.
 */
.tab-activity.active :deep(.app-icon path) {
  stroke-dasharray: 50 60;
  animation: trace 640ms var(--ease-in-out) both;
}
@keyframes trace {
  from { stroke-dashoffset: -50; }
  to { stroke-dashoffset: 0; }
}

/* More: the three lines slide out from the left, staggered. */
.tab-menu.active :deep(.app-icon path) {
  transform-origin: 0 50%;
  animation: line-grow 340ms var(--ease-out) both;
}
.tab-menu.active :deep(.app-icon path:nth-child(2)) {
  animation-delay: 50ms;
}
.tab-menu.active :deep(.app-icon path:nth-child(3)) {
  animation-delay: 100ms;
}
@keyframes line-grow {
  from { transform: scaleX(0.3); opacity: 0.3; }
  to { transform: scaleX(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tab.active .app-icon,
  .tab.active :deep(.app-icon path) {
    animation: none;
  }
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
