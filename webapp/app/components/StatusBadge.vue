<script setup lang="ts">
/**
 * `live` marks a badge that shows current health (not a history row). Live badges ping:
 * HEALTHY with a slow, soft heartbeat; DOWN with a faster, stronger ping until it recovers.
 * A new heartbeat (`beat` changes) also restarts the healthy ping so it lands on the update.
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

const pulse = computed(() => (!props.live ? null : props.status === 'DOWN' ? 'alarm' : props.status === 'HEALTHY' ? 'alive' : null));
const ring = ref<HTMLElement>();

// Restart the heartbeat loop from the top when a fresh heartbeat arrives.
watch(
  () => props.beat,
  (beat, prev) => {
    if (pulse.value !== 'alive' || !beat || !prev || beat === prev) return;
    for (const a of ring.value?.getAnimations() ?? []) a.currentTime = 0;
  },
);
</script>

<template>
  <span class="badge" :class="entry.cls">
    <span class="dot" :class="pulse"><span v-if="live" ref="ring" class="ring" /></span>{{ entry.label }}
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
/* Ambient state indicators: loops are right here, nothing interrupts them. */
.alive .ring {
  animation: alive 2.4s var(--ease-out) infinite;
}
.alarm .ring {
  animation: alarm 1.2s var(--ease-out) infinite;
}
/* Scale eases out fast while opacity holds, then fades — the ring stays readable as it grows. */
@keyframes alive {
  0% {
    transform: scale(1);
    opacity: 0.55;
  }
  35% {
    opacity: 0.35;
  }
  70%,
  100% {
    transform: scale(2.8);
    opacity: 0;
  }
}
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
/* Reduced motion: no expanding ring. Down keeps a gentle opacity pulse; healthy stays still. */
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
