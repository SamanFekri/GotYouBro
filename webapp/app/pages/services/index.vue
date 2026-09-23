<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';
import type { Destination, Service } from '~/utils/types';

const api = useApi();
const auth = useAuthStore();
const toast = useToast();
const route = useRoute();
const { data: services, loading, error, reload } = useLoader(() => api.get<Service[]>('/app/services'));

const creating = ref(route.query.new === '1');
const destinations = ref<Destination[]>([]);
const form = reactive({ name: '', description: '', destinationId: '', healthEnabled: true, healthIntervalSeconds: 60, healthGraceSeconds: 60 });
const saving = ref(false);
const newToken = ref<string | null>(null);
const newServiceName = ref('');

watch(creating, async (open) => {
  if (open) {
    destinations.value = await api.get<Destination[]>('/app/destinations');
    form.destinationId = destinations.value.find((d) => d.verified)?.id ?? '';
  }
}, { immediate: true });

async function create() {
  saving.value = true;
  try {
    const res = await api.post<{ service: Service; token: string }>('/app/services', {
      name: form.name,
      description: form.description || null,
      destinationId: form.destinationId || null,
      healthEnabled: form.healthEnabled,
      healthIntervalSeconds: Number(form.healthIntervalSeconds),
      healthGraceSeconds: Number(form.healthGraceSeconds),
    });
    creating.value = false;
    newServiceName.value = res.service.name;
    newToken.value = res.token;
    Object.assign(form, { name: '', description: '' });
    await reload();
    auth.refreshMe();
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}

const atLimit = computed(() => (services.value?.length ?? 0) >= (auth.user?.limits.maxServices ?? Infinity));
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>Services</h1>
      <button class="btn small" :disabled="atLimit" @click="creating = true">+ New</button>
    </div>
    <div v-if="atLimit" class="hint">You reached the limit of {{ auth.user?.limits.maxServices }} services.</div>

    <div v-if="loading" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <EmptyState v-else-if="!services?.length" emoji="🧩" title="No services yet" text="A service is an app that sends backups and/or heartbeats. Each has its own API token.">
      <button class="btn" @click="creating = true">Create your first service</button>
    </EmptyState>
    <div v-else class="list">
      <NuxtLink v-for="s in services" :key="s.id" :to="`/services/${s.id}`" class="list-item">
        <div class="grow">
          <div class="title">{{ s.name }}</div>
          <div class="sub">
            {{ s.backupCount }} backups · last {{ timeAgo(s.lastBackupAt) }}
            <template v-if="s.healthEnabled"> · ♥ {{ timeAgo(s.lastHeartbeatAt) }}</template>
          </div>
        </div>
        <StatusBadge v-if="s.status !== 'ACTIVE'" :status="s.status" />
        <StatusBadge v-else :status="s.healthEnabled ? s.healthStatus : 'OFF'" />
      </NuxtLink>
    </div>

    <AppModal :open="creating" title="New service" @close="creating = false">
      <form class="form" @submit.prevent="create">
        <label class="field"><span>Name</span><input v-model="form.name" class="input" required maxlength="80" placeholder="Production API" /></label>
        <label class="field"><span>Description</span><textarea v-model="form.description" class="input" maxlength="500" placeholder="Optional" /></label>
        <label class="field">
          <span>Backup destination</span>
          <select v-model="form.destinationId" class="input">
            <option value="">None (heartbeats only)</option>
            <option v-for="d in destinations" :key="d.id" :value="d.id" :disabled="!d.verified">
              {{ d.name }} · {{ destinationTypeLabel[d.type] }}{{ d.verified ? '' : ' (unverified)' }}
            </option>
          </select>
          <NuxtLink v-if="!destinations.length" to="/destinations" class="hint">Add a destination first →</NuxtLink>
        </label>
        <label class="switch">Health monitoring <input v-model="form.healthEnabled" type="checkbox" /></label>
        <div v-if="form.healthEnabled" class="row" style="flex-wrap: nowrap">
          <label class="field" style="flex: 1"><span>Interval (s)</span><input v-model.number="form.healthIntervalSeconds" class="input" type="number" min="10" /></label>
          <label class="field" style="flex: 1"><span>Grace (s)</span><input v-model.number="form.healthGraceSeconds" class="input" type="number" min="0" /></label>
        </div>
        <button class="btn block" :disabled="saving || !form.name">{{ saving ? 'Creating…' : 'Create service' }}</button>
      </form>
    </AppModal>

    <TokenReveal :token="newToken" :service-name="newServiceName" @close="newToken = null" />
  </div>
</template>
