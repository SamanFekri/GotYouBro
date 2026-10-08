<script setup lang="ts">
import type { IconName } from './AppIcon.vue';

withDefaults(defineProps<{ icon?: IconName; title: string; text?: string }>(), { icon: 'empty' });
</script>

<template>
  <div class="card empty">
    <div class="empty-icon"><AppIcon :name="icon" :size="26" :stroke-width="1.75" /></div>
    <div style="font-weight: 600; color: var(--text)">{{ title }}</div>
    <div v-if="text" class="hint" style="margin-top: 4px">{{ text }}</div>
    <div v-if="$slots.default" style="margin-top: 14px"><slot /></div>
  </div>
</template>
