<script setup lang="ts">
/** Key for the 7-day health bars. Shown once per page, not under every chart. */
const finePointer = import.meta.client && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
defineProps<{ hint?: boolean }>();
</script>

<template>
  <div class="legend">
    <span><i class="swatch up" /> Up</span>
    <span><i class="swatch down" /> Down</span>
    <span><i class="swatch none" /> No data</span>
    <span v-if="hint" class="hint-text">{{ finePointer ? 'Hover' : 'Tap or drag across' }} a chart for details</span>
  </div>
</template>

<style scoped>
.legend {
  --status-good: #0ca30c;
  --status-critical: #d03b3b;
  --status-none: color-mix(in srgb, var(--hint) 45%, transparent);
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 6px 14px;
  font-size: 0.75rem;
  color: var(--hint);
}
.legend span {
  display: inline-flex;
  align-items: flex-end;
  gap: 5px;
}
.hint-text {
  flex-basis: 100%;
}
.swatch {
  display: inline-block;
  width: 6px;
  border-radius: 1.5px;
}
.swatch.up {
  height: 13px;
  background: var(--status-good);
}
.swatch.down {
  height: 7px;
  background: var(--status-critical);
}
.swatch.none {
  height: 3px;
  background: var(--status-none);
}
</style>
