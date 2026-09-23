<script setup lang="ts">
defineProps<{ label: string; value: string | number; tone?: 'ok' | 'bad' | 'default'; to?: string }>();
</script>

<template>
  <component :is="to ? resolveComponent('NuxtLink') : 'div'" :to="to" class="card stat">
    <div class="value" :class="tone">{{ value }}</div>
    <div class="label">{{ label }}</div>
  </component>
</template>

<style scoped>
.stat {
  display: block;
  color: inherit;
}
.value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
}
.value.ok {
  color: var(--ok);
}
.value.bad {
  color: var(--danger);
}
.label {
  color: var(--hint);
  font-size: 13px;
  margin-top: 4px;
}
</style>
