<script setup lang="ts">
defineProps<{ emoji?: string; title: string; text?: string }>();
</script>

<template>
  <div class="card empty">
    <div class="emoji">{{ emoji ?? '📭' }}</div>
    <div style="font-weight: 600; color: var(--text)">{{ title }}</div>
    <div v-if="text" class="hint" style="margin-top: 4px">{{ text }}</div>
    <div v-if="$slots.default" style="margin-top: 14px"><slot /></div>
  </div>
</template>
