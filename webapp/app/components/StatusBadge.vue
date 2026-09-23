<script setup lang="ts">
const props = defineProps<{ status: string; kind?: 'health' | 'backup' | 'service' }>();

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
</script>

<template>
  <span class="badge" :class="entry.cls"><span class="dot" />{{ entry.label }}</span>
</template>
