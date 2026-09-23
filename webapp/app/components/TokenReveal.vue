<script setup lang="ts">
/** Shows a freshly generated API token exactly once, with copy + usage examples. */
const props = defineProps<{ token: string | null; serviceName?: string }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();
const origin = import.meta.client ? window.location.origin : '';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Copy failed — select the text manually');
  }
}

const curlBackup = computed(() => `curl -X POST ${origin}/api/v1/backups \\\n  -H "Authorization: Bearer ${props.token}" \\\n  -F "file=@backup.sqlite"`);
const curlHeartbeat = computed(() => `curl -X POST ${origin}/api/v1/health/heartbeat \\\n  -H "Authorization: Bearer ${props.token}"`);
</script>

<template>
  <AppModal :open="!!token" title="Your API token" @close="emit('close')">
    <div class="form">
      <div class="alert info">
        ⚠️ Copy this token now{{ serviceName ? ` for “${serviceName}”` : '' }}. It is stored hashed and <b>won’t be shown again</b>.
      </div>
      <div class="token mono" @click="copy(token!)">{{ token }}</div>
      <button class="btn block" @click="copy(token!)">Copy token</button>
      <div class="section-label">Send a backup</div>
      <pre class="snippet mono" @click="copy(curlBackup)">{{ curlBackup }}</pre>
      <div class="section-label">Send a heartbeat</div>
      <pre class="snippet mono" @click="copy(curlHeartbeat)">{{ curlHeartbeat }}</pre>
      <a class="hint" href="/api/docs" target="_blank">Full API documentation →</a>
    </div>
  </AppModal>
</template>

<style scoped>
.token {
  background: var(--bg);
  border-radius: 10px;
  padding: 12px;
  word-break: break-all;
  cursor: pointer;
  user-select: all;
}
.snippet {
  background: var(--bg);
  border-radius: 10px;
  padding: 10px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  cursor: pointer;
  font-size: 12px;
}
</style>
