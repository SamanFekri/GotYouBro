<script setup lang="ts">
import type { Backup, BackupStatus, Page } from '~/utils/types';

definePageMeta({ middleware: 'admin' });

const api = useApi();
const status = ref<BackupStatus | ''>('');
const items = ref<Backup[]>([]);
const total = ref(0);
const loading = ref(false);

async function load(append = false) {
  loading.value = true;
  try {
    const page = await api.get<Page<Backup>>('/admin/backups', { status: status.value, limit: 50, offset: append ? items.value.length : 0 });
    items.value = append ? [...items.value, ...page.items] : page.items;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());
watch(status, () => load());
</script>

<template>
  <div class="page">
    <div class="page-header"><NuxtLink to="/admin" class="btn ghost">‹ Admin</NuxtLink></div>
    <div class="spread"><h1>Backup activity</h1><span class="hint">{{ total }}</span></div>
    <div class="chips">
      <button v-for="s in ['', 'SUCCESS', 'FAILED', 'PROCESSING', 'RECEIVED'] as const" :key="s" class="chip" :class="{ active: status === s }" @click="status = s">{{ s || 'All' }}</button>
    </div>
    <div class="card table-wrap">
      <table class="table">
        <thead>
          <tr><th>Date</th><th>Service</th><th>File</th><th>Size</th><th>Status</th><th>Destination</th></tr>
        </thead>
        <tbody>
          <tr v-for="b in items" :key="b.id">
            <td>{{ formatDate(b.createdAt) }}</td>
            <td>{{ b.serviceName }}</td>
            <td :title="b.errorMessage ?? ''">{{ b.filename }}</td>
            <td>{{ formatBytes(b.sizeBytes) }}</td>
            <td><StatusBadge :status="b.status" /></td>
            <td>{{ b.destinationName ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="loading" class="spinner" />
    <button v-else-if="items.length < total" class="btn secondary block" @click="load(true)">Load more</button>
  </div>
</template>
