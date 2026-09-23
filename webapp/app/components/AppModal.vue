<script setup lang="ts">
const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();
watch(
  () => props.open,
  (open) => document.body.style.setProperty('overflow', open ? 'hidden' : ''),
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="backdrop" @click.self="emit('close')">
      <div class="sheet" role="dialog" :aria-label="title">
        <div class="spread" style="margin-bottom: 14px">
          <h2>{{ title }}</h2>
          <button class="btn ghost" aria-label="Close" @click="emit('close')">✕</button>
        </div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 50;
}
.sheet {
  background: var(--surface);
  width: 100%;
  max-width: 560px;
  max-height: 92vh;
  overflow-y: auto;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
}
@media (min-width: 640px) {
  .backdrop {
    align-items: center;
  }
  .sheet {
    border-radius: 18px;
  }
}
</style>
