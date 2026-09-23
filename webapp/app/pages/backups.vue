<script setup lang="ts">
import type { Backup, BackupStatus, Page, Service } from '~/utils/types';

const api = useApi();
const route = useRoute();
const PAGE = 30;

const serviceId = ref((route.query.serviceId as string) ?? '');
const status = ref<BackupStatus | ''>((route.query.status as BackupStatus) ?? '');
const items = ref<Backup[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref('');
const services = ref<Service[]>([]);

async function load(append = false) {
  loading.value = true;
  error.value = '';
  try {
    const page = await api.get<Page<Backup>>('/app/backups', {
      serviceId: serviceId.value,
      status: status.value,
      limit: PAGE,
      offset: append ? items.value.length : 0,
    });
    items.value = append ? [...items.value, ...page.items] : page.items;
    total.value = page.total;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  load();
  services.value = await api.get<Service[]>('/app/services');
});
watch([serviceId, status], () => load());

const statuses: Array<{ value: BackupStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'SUCCESS', label: 'Delivered' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'PROCESSING', label: 'Sending' },
  { value: 'RECEIVED', label: 'Queued' },
];
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Backups</h1>
      <span class="hint">{{ total }} total</span>
    </div>

    <select v-model="serviceId" class="input">
      <option value="">All services</option>
      <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }}</option>
    </select>
    <div class="chips">
      <button v-for="s in statuses" :key="s.value" class="chip" :class="{ active: status === s.value }" @click="status = s.value">{{ s.label }}</button>
    </div>

    <div v-if="error" class="alert">{{ error }}</div>
    <EmptyState v-else-if="!loading && !items.length" emoji="📦" title="No backups" text="Backups sent through the API will show up here." />
    <div v-else class="list">
      <div v-for="b in items" :key="b.id" class="list-item" style="align-items: flex-start">
        <div class="grow">
          <div class="title">{{ b.filename }}</div>
          <div class="sub">{{ b.serviceName }} · {{ formatBytes(b.sizeBytes) }} · {{ formatDate(b.createdAt) }}</div>
          <div class="sub">→ {{ b.destinationName ?? 'deleted destination' }}</div>
          <div v-if="b.errorMessage" class="sub danger-text" style="white-space: normal">{{ b.errorMessage }}</div>
        </div>
        <StatusBadge :status="b.status" />
      </div>
    </div>
    <div v-if="loading" class="spinner" />
    <button v-else-if="items.length < total" class="btn secondary block" @click="load(true)">Load more</button>
  </div>
</template>
