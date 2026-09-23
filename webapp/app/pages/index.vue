<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
import type { Backup, DashboardStats, Service } from '~/utils/types';

const auth = useAuthStore();
const api = useApi();
const { data, loading, error } = useLoader(() =>
  api.get<{ stats: DashboardStats; recentBackups: Backup[]; downServices: Service[] }>('/app/dashboard'),
);
</script>

<template>
  <div class="page">
    <div class="page-header" style="justify-content: flex-start; gap: 12px">
      <img src="/logo.png" alt="GotYouBro" width="56" height="56" />
      <div>
        <h1>Hey {{ auth.user?.firstName ?? 'there' }} 👋</h1>
        <div class="hint">GotYouBro has your back.</div>
      </div>
    </div>

    <div v-if="loading" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else-if="data">
      <div v-for="s in data.downServices" :key="s.id" class="alert">
        🚨 <b>{{ s.name }}</b> is down since {{ timeAgo(s.wentDownAt) }}.
        <NuxtLink :to="`/services/${s.id}`">Details</NuxtLink>
      </div>

      <div class="grid">
        <StatCard label="Total services" :value="data.stats.totalServices" to="/services" />
        <StatCard label="Healthy" :value="data.stats.healthyServices" tone="ok" to="/health" />
        <StatCard label="Down" :value="data.stats.downServices" :tone="data.stats.downServices ? 'bad' : 'default'" to="/health" />
        <StatCard :label="`Backups (${data.stats.periodDays}d)`" :value="data.stats.recentBackups" to="/backups" />
        <StatCard label="Failed backups" :value="data.stats.failedBackups" :tone="data.stats.failedBackups ? 'bad' : 'default'" to="/backups?status=FAILED" />
        <StatCard label="Delivered" :value="formatBytes(data.stats.recentBackupBytes)" />
      </div>

      <EmptyState v-if="!data.stats.totalServices" emoji="🧩" title="No services yet" text="Create a service to get an API token for backups and heartbeats.">
        <NuxtLink class="btn" to="/services?new=1">Create a service</NuxtLink>
      </EmptyState>

      <template v-if="data.recentBackups.length">
        <div class="section-label">Recent backups</div>
        <div class="list">
          <div v-for="b in data.recentBackups" :key="b.id" class="list-item">
            <div class="grow">
              <div class="title">{{ b.filename }}</div>
              <div class="sub">{{ b.serviceName }} · {{ formatBytes(b.sizeBytes) }} · {{ timeAgo(b.createdAt) }}</div>
            </div>
            <StatusBadge :status="b.status" />
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
