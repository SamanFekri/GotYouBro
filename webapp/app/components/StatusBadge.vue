<script setup lang="ts">
/**
 * `live` marks a badge that shows current health (not a history row). A live DOWN badge pings
 * continuously; a live HEALTHY badge pings once whenever `beat` (the last heartbeat time) changes.
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

// One ping per new heartbeat. Not on mount: a page full of badges pinging at once is noise.
watch(
  () => props.beat,
  (beat, prev) => {
    if (!props.live || props.status !== 'HEALTHY' || !beat || !prev || beat === prev) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ring.value?.animate(
      [
        { transform: 'scale(1)', opacity: 0.6 },
        { transform: 'scale(2.8)', opacity: 0 },
      ],
      { duration: 900, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
  },
);
</script>

<template>
  <span class="badge" :class="entry.cls">
    <span class="dot" :class="{ alarm }"><span v-if="live" ref="ring" class="ring" /></span>{{ entry.label }}
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
  background: currentColor;
  opacity: 0;
  pointer-events: none;
}
/* Down: a steady ping until it recovers. Ambient state, so a loop is right; it never interrupts. */
.alarm .ring {
  animation: ping 1.6s var(--ease-out) infinite;
}
@keyframes ping {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  75%,
  100% {
    transform: scale(2.8);
    opacity: 0;
  }
}
/* Reduced motion: no expanding ring; a gentle opacity pulse still says "needs attention". */
@media (prefers-reduced-motion: reduce) {
  .alarm .ring {
    animation: none;
  }
  .dot.alarm {
    animation: dim 2s ease infinite;
  }
}
@keyframes dim {
  50% {
    opacity: 0.45;
  }
}
</style>
