<script setup lang="ts">
import type { Service } from '~/utils/types';

const api = useApi();
const toast = useToast();
const { confirm } = useTelegram();
const { data: services, loading, error, reload } = useLoader(() => api.get<Service[]>('/app/services'));
const reveal = ref<{ token: string; name: string } | null>(null);

async function rotate(s: Service) {
  if (s.token && !(await confirm(`Rotate the token for “${s.name}”? The current token stops working immediately.`))) return;
  try {
    const res = await api.post<{ token: string }>(`/app/services/${s.id}/token`);
    reveal.value = { token: res.token, name: s.name };
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function revoke(s: Service) {
  if (!(await confirm(`Revoke the token for “${s.name}”?`))) return;
  try {
    await api.del(`/app/services/${s.id}/token`);
    toast.success('Token revoked');
    await reload();
  } catch (err) {
    toast.error((err as Error).message);
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <NuxtLink to="/more" class="btn ghost">‹ More</NuxtLink>
    </div>
    <h1>API keys</h1>
    <div class="hint">One token per service. Tokens are stored hashed and shown only when generated.</div>

    <div v-if="loading && !services" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <EmptyState v-else-if="!services?.length" emoji="🔑" title="No services" text="Create a service to get an API token.">
      <NuxtLink class="btn" to="/services?new=1">Create a service</NuxtLink>
    </EmptyState>
    <div v-else class="list">
      <div v-for="s in services" :key="s.id" class="list-item">
        <div class="grow">
          <div class="title">{{ s.name }}</div>
          <div v-if="s.token" class="sub"><span class="mono">{{ s.token.prefix }}…</span> · used {{ timeAgo(s.token.lastUsedAt) }}</div>
          <div v-else class="sub">No active token</div>
        </div>
        <button class="btn small secondary" @click="rotate(s)">{{ s.token ? 'Rotate' : 'Generate' }}</button>
        <button v-if="s.token" class="btn small danger" @click="revoke(s)">Revoke</button>
      </div>
    </div>

    <TokenReveal :token="reveal?.token ?? null" :service-name="reveal?.name" @close="reveal = null" />
  </div>
</template>
