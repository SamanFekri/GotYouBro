<script setup lang="ts">
/**
 * `live` marks a badge that shows current health (not a history row).
 * DOWN pings continuously — the one motion on screen that means "look here".
 * HEALTHY pings once when a new heartbeat arrives (`beat` changes), never on its own.
 */
const props = defineProps<{ status: string; kind?: 'health' | 'backup' | 'service'; live?: boolean; beat?: string | null }>();

const map: Record<string, { cls: string; label: string }> = {
  HEALTHY: { cls: 'ok', label: 'Healthy' },
  DOWN: { cls: 'bad', label: 'Down' },
  UNKNOWN: { cls: '', label: 'Waiting' },
  SUCCESS: { cls: 'ok', label: 'Delivered' },
  FAILED: { cls: 'bad', label: 'Failed' },
  RECEIVED: { cls: 'info', label: 'Queued' },
  PROCESSING: { cls: 'info', label: 'Sending' },
  ACTIVE: { cls: 'ok', label: 'Active' },
  DISABLED: { cls: '', label: 'Disabled' },
  SUSPENDED: { cls: 'warn', label: 'Suspended' },
  OFF: { cls: '', label: 'Not monitored' },
};
const entry = computed(() => map[props.status] ?? { cls: '', label: props.status });

const alarm = computed(() => props.live && props.status === 'DOWN');
const ring = ref<HTMLElement>();

// One ping per fresh heartbeat. Not on mount: a page of badges pinging together is noise.
watch(
  () => props.beat,
  (beat, prev) => {
    if (!props.live || props.status !== 'HEALTHY' || !beat || !prev || beat === prev) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ring.value?.animate(
      [
        { transform: 'scale(1)', opacity: 0.55 },
        { opacity: 0.35, offset: 0.4 },
        { transform: 'scale(2.8)', opacity: 0 },
      ],
      { duration: 1000, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
  },
);
</script>

<template>
  <span class="badge" :class="entry.cls">
    <span class="dot" :class="{ alarm }" aria-hidden="true"><span v-if="live" ref="ring" class="ring" /></span>{{ entry.label }}
  </span>
</template>

<style scoped>
.dot {
  position: relative;
}
.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--tone, currentColor);
  opacity: 0;
  pointer-events: none;
}
/* Down: steady ping until it recovers. Ambient state, so a loop is right; nothing interrupts it. */
.alarm .ring {
  animation: alarm 1.2s var(--ease-out) infinite;
}
/* Scale eases out fast while opacity holds, then fades, so the ring stays readable as it grows. */
@keyframes alarm {
  0% {
    transform: scale(1);
    opacity: 0.85;
  }
  40% {
    opacity: 0.55;
  }
  85%,
  100% {
    transform: scale(3.4);
    opacity: 0;
  }
}
/* Reduced motion: no expanding ring; a gentle opacity pulse still says "needs attention". */
@media (prefers-reduced-motion: reduce) {
  .ring {
    display: none;
  }
  .dot.alarm {
    animation: dim 2s ease infinite;
  }
}
@keyframes dim {
  50% {
    opacity: 0.4;
  }
}
</style>
