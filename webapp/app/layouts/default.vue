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
  { to: '/more', label: 'Settings', icon: 'settings' as const, match: (p: string) => ['/more', '/destinations', '/keys', '/settings', '/admin'].some((x) => p.startsWith(x)) },
];
const activeTab = computed(() => tabs.findIndex((t) => t.match(route.path)));
</script>

<template>
  <div>
    <div v-if="auth.status === 'ready'">
      <slot />
      <!-- Scroll edge effect: content blurs and fades where it meets the floating bar. -->
      <div class="edge-fade" aria-hidden="true" />
      <nav class="tabbar" aria-label="Main">
        <span
          class="indicator"
          :style="{ transform: `translateX(${Math.max(activeTab, 0) * 100}%)`, opacity: activeTab < 0 ? 0 : 1 }"
          aria-hidden="true"
        ><span class="pill" /></span>
        <NuxtLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" :class="[`tab-${tab.icon}`, { active: tab.match(route.path) }]" :aria-current="tab.match(route.path) ? 'page' : undefined">
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

/*
 * Liquid Glass tab bar: the one glass surface in the app, floating over the content layer.
 * Regular variant (text on it): backdrop blur + saturation boost, translucent fill, hairline edge
 * and top highlight. Labels stay monochrome; only the selected tab carries the accent.
 */
.tabbar {
  --glass-fill: rgba(255, 255, 255, 0.66);
  --glass-edge: rgba(0, 0, 0, 0.07);
  --glass-highlight: rgba(255, 255, 255, 0.7);
  --glass-shadow: 0 10px 30px rgba(15, 20, 30, 0.14), 0 1px 3px rgba(15, 20, 30, 0.08);
  --tab-label: color-mix(in srgb, var(--text) 74%, transparent);
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(8px + env(safe-area-inset-bottom));
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  padding: 4px;
  border-radius: 32px;
  background: var(--glass-fill);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  backdrop-filter: blur(24px) saturate(1.4);
  border: 1px solid var(--glass-edge);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--glass-shadow);
  z-index: 10;
}
:root[data-scheme='dark'] .tabbar {
  --glass-fill: rgba(32, 35, 42, 0.62);
  --glass-edge: rgba(255, 255, 255, 0.09);
  --glass-highlight: rgba(255, 255, 255, 0.08);
  --glass-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
@media (prefers-color-scheme: dark) {
  :root:not(.tg) .tabbar {
    --glass-fill: rgba(32, 35, 42, 0.62);
    --glass-edge: rgba(255, 255, 255, 0.09);
    --glass-highlight: rgba(255, 255, 255, 0.08);
    --glass-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
}

/* Scroll edge effect: a blur that fades in toward the bottom, so content dissolves under the
   glass instead of colliding with it. No solid color is painted beneath the bar. */
.edge-fade {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(104px + env(safe-area-inset-bottom));
  pointer-events: none;
  z-index: 9;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  background: linear-gradient(to top, color-mix(in srgb, var(--bg) 65%, transparent), transparent);
  -webkit-mask-image: linear-gradient(to top, #000 45%, transparent);
  mask-image: linear-gradient(to top, #000 45%, transparent);
}

/* No backdrop-filter support, Reduce Transparency, or Increase Contrast → an opaque bar. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .tabbar {
    background: var(--surface);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .tabbar {
    background: var(--surface);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .edge-fade {
    display: none;
  }
}
@media (prefers-contrast: more) {
  .tabbar {
    background: var(--surface);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    border-color: color-mix(in srgb, var(--text) 45%, transparent);
    --tab-label: var(--text);
  }
}

/* Selected-tab lozenge, sliding between tabs (equal widths, so 100% = one tab). */
.indicator {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 8px) / 5);
  display: flex;
  justify-content: center;
  pointer-events: none;
  transition:
    transform 250ms var(--ease-in-out),
    opacity 150ms ease;
}
.pill {
  width: calc(100% - 4px);
  border-radius: 26px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .indicator {
    transition: opacity 150ms ease;
  }
}

.tab {
  position: relative;
  flex: 1;
  min-height: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 6px 0;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--tab-label);
  transition: color 150ms ease;
}
.tab.active {
  color: var(--accent);
  font-weight: 600;
}
.tab .app-icon {
  transition: transform 120ms var(--ease-out);
}
.tab:active .app-icon {
  transform: scale(0.92);
}
/* Selected icons fill in, per the platform's preference for filled tab icons. */
.tab-home.active :deep(.app-icon),
.tab-services.active :deep(.app-icon),
.tab-package.active :deep(.app-icon),
.tab-settings.active :deep(.app-icon) {
  fill: currentColor;
  fill-opacity: 0.18;
}

/*
 * Each icon plays its own short animation once, as its tab becomes active.
 * Lucide draws with <path>s inside the svg, so :deep() reaches them; transform-box makes
 * each path transform around its own box rather than the whole 24×24 canvas.
 */
.tab :deep(.app-icon path) {
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

/* Health: the pulse line draws itself left → right like a monitor trace. The path (~49 units)
   starts at the right edge, so a negative offset with an uneven dash/gap reveals it from its end. */
.tab-activity.active :deep(.app-icon path) {
  stroke-dasharray: 50 60;
  animation: trace 640ms var(--ease-in-out) both;
}
@keyframes trace {
  from { stroke-dashoffset: -50; }
  to { stroke-dashoffset: 0; }
}

/* Settings: the gear turns a notch and settles. */
.tab-settings.active .app-icon {
  animation: gear-turn 520ms var(--ease-out);
}
@keyframes gear-turn {
  from { transform: rotate(-90deg); }
  to { transform: rotate(0); }
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
  font-size: 0.875rem;
  max-width: 90vw;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
.toast.error {
  background: var(--danger);
  color: #fff;
}
</style>
