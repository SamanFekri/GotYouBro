<script setup lang="ts">
import type { HealthEvent, Service } from '~/utils/types';

const api = useApi();
const { data, loading, error, reload } = useLoader(() =>
  api.get<{ historyDays: number; services: Service[]; events: HealthEvent[] }>('/app/health'),
);

// Heartbeat freshness changes over time; refresh while the page is open.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => (timer = setInterval(reload, 60_000)));
onBeforeUnmount(() => clearInterval(timer));

const withMonitors = computed(() => data.value?.services.filter((s) => s.monitors.length) ?? []);
const withoutMonitors = computed(() => data.value?.services.filter((s) => !s.monitors.length) ?? []);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Health</h1>
      <span class="hint">Last {{ data?.historyDays ?? 7 }} days</span>
    </div>

    <div v-if="loading && !data" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else-if="data">
      <EmptyState
        v-if="!withMonitors.length"
        emoji="💓"
        title="No monitors yet"
        text="Open a service and add a monitor. Then send heartbeats to POST /api/v1/health/heartbeat/<key>."
      />

      <section v-for="s in withMonitors" :key="s.id" class="service">
        <NuxtLink :to="`/services/${s.id}`" class="spread section-label service-head">
          <span>{{ s.name }}</span>
          <StatusBadge :status="s.status === 'ACTIVE' ? (s.healthEnabled ? s.healthStatus : 'OFF') : s.status" />
        </NuxtLink>
        <MonitorCard v-for="m in s.monitors" :key="m.id" :monitor="m" />
      </section>

      <div v-if="withoutMonitors.length" class="hint" style="padding: 0 4px">
        Not monitored: {{ withoutMonitors.map((s) => s.name).join(', ') }}
      </div>

      <template v-if="data.events.length">
        <div class="section-label">Outage history</div>
        <div class="list">
          <div v-for="e in data.events" :key="e.id" class="list-item">
            <div class="grow">
              <div class="title">{{ e.serviceName }} · {{ e.monitorName }}</div>
              <div class="sub">{{ formatDate(e.startedAt) }} · {{ e.endedAt ? formatDuration(e.durationSeconds) : 'ongoing' }}</div>
            </div>
            <StatusBadge :status="e.endedAt ? 'HEALTHY' : 'DOWN'" />
          </div>
        </div>
        <div class="hint" style="padding: 0 4px">History older than 7 days is removed; each monitor's most recent outage is always kept.</div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.service {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.service-head {
  color: var(--hint);
}
</style>
