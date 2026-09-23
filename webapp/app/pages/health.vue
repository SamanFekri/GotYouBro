<script setup lang="ts">
import type { HealthEvent, HealthStatus, ServiceStatus } from '~/utils/types';

interface HealthService {
  id: string;
  name: string;
  status: ServiceStatus;
  healthEnabled: boolean;
  healthStatus: HealthStatus;
  healthIntervalSeconds: number;
  healthGraceSeconds: number;
  lastHeartbeatAt: string | null;
  wentDownAt: string | null;
  totalDowntimeSeconds: number;
  downCount: number;
  uptimeSinceCreationPercent: number;
}

const api = useApi();
const { data, loading, error, reload } = useLoader(() => api.get<{ services: HealthService[]; events: HealthEvent[] }>('/app/health'));

// Heartbeat freshness changes over time; refresh while the page is open.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => (timer = setInterval(reload, 30_000)));
onBeforeUnmount(() => clearInterval(timer));

const monitored = computed(() => data.value?.services.filter((s) => s.healthEnabled) ?? []);
const unmonitored = computed(() => data.value?.services.filter((s) => !s.healthEnabled) ?? []);
</script>

<template>
  <div class="page">
    <div class="page-header"><h1>Health</h1></div>

    <div v-if="loading && !data" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else-if="data">
      <EmptyState v-if="!monitored.length" emoji="💓" title="No monitored services" text="Enable health monitoring on a service and send heartbeats to POST /api/v1/health/heartbeat." />
      <div v-else class="list">
        <NuxtLink v-for="s in monitored" :key="s.id" :to="`/services/${s.id}`" class="list-item">
          <div class="grow">
            <div class="title">{{ s.name }}</div>
            <div class="sub">
              <template v-if="s.healthStatus === 'DOWN'">Down {{ timeAgo(s.wentDownAt) }}</template>
              <template v-else>♥ {{ timeAgo(s.lastHeartbeatAt) }} · every {{ s.healthIntervalSeconds }}s</template>
              · {{ s.uptimeSinceCreationPercent }}% uptime · {{ s.downCount }} outages
            </div>
          </div>
          <StatusBadge :status="s.status === 'ACTIVE' ? s.healthStatus : s.status" />
        </NuxtLink>
      </div>

      <div v-if="unmonitored.length" class="hint" style="padding: 0 4px">
        Not monitored: {{ unmonitored.map((s) => s.name).join(', ') }}
      </div>

      <template v-if="data.events.length">
        <div class="section-label">Outage history</div>
        <div class="list">
          <div v-for="e in data.events" :key="e.id" class="list-item">
            <div class="grow">
              <div class="title">{{ e.serviceName }}</div>
              <div class="sub">{{ formatDate(e.startedAt) }} · {{ e.endedAt ? formatDuration(e.durationSeconds) : 'ongoing' }}</div>
            </div>
            <StatusBadge :status="e.endedAt ? 'HEALTHY' : 'DOWN'" />
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
