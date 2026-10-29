<script setup lang="ts">
/**
 * A file name that truncates in the middle, so the end (timestamp, extension, part number) stays
 * visible: "postgres-2026…T030000Z.sql.gz" rather than "postgres-20261022T030000Z.sq…".
 */
const props = withDefaults(defineProps<{ name: string; tail?: number }>(), { tail: 14 });
const head = computed(() => props.name.slice(0, Math.max(0, props.name.length - props.tail)));
const end = computed(() => props.name.slice(-props.tail));
</script>

<template>
  <span class="file-name" :title="name"><span class="head">{{ head }}</span><span class="end">{{ end }}</span></span>
</template>

<style scoped>
.file-name {
  display: flex;
  min-width: 0;
  white-space: nowrap;
}
.head {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.end {
  flex-shrink: 0;
}
</style>
