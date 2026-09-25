<script setup lang="ts">
import type { Monitor } from '~/utils/types';

/** One health monitor: state, 7-day history and (when editable) its settings. */
const props = defineProps<{ monitor: Monitor; editable?: boolean }>();
const emit = defineEmits<{ changed: [] }>();

const api = useApi();
const toast = useToast();
const { confirm } = useTelegram();
const origin = import.meta.client ? window.location.origin : '';

const heartbeatUrl = computed(() => `${origin}/api/v1/health/heartbeat/${props.monitor.key}`);
const status = computed(() => (props.monitor.enabled ? props.monitor.status : 'OFF'));

const editing = ref(false);
const form = reactive({ name: '', intervalSeconds: 60, graceSeconds: 60 });
function startEdit() {
  Object.assign(form, { name: props.monitor.name, intervalSeconds: props.monitor.intervalSeconds, graceSeconds: props.monitor.graceSeconds });
  editing.value = true;
}

async function patch(body: Record<string, unknown>, message: string) {
  try {
    await api.patch(`/app/monitors/${props.monitor.id}`, body);
    toast.success(message);
    editing.value = false;
    emit('changed');
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function remove() {
  if (!(await confirm(`Delete monitor “${props.monitor.name}”? Heartbeats sent to it will be rejected.`))) return;
  try {
    await api.del(`/app/monitors/${props.monitor.id}`);
    toast.success('Monitor deleted');
    emit('changed');
  } catch (err) {
    toast.error((err as Error).message);
  }
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(heartbeatUrl.value);
    toast.success('Heartbeat URL copied');
  } catch {
    toast.error('Copy failed');
  }
}

const h = computed(() => props.monitor.history);
</script>

<template>
  <div class="card monitor">
    <div class="spread">
      <div style="min-width: 0">
        <div class="title">{{ monitor.name }}</div>
        <div class="hint">
          <span class="mono">{{ monitor.key }}</span> · every {{ formatDuration(monitor.intervalSeconds) }} + {{ formatDuration(monitor.graceSeconds) }} grace ·
          ♥ {{ timeAgo(monitor.lastHeartbeatAt) }}
        </div>
      </div>
      <StatusBadge :status="status" />
    </div>

    <template v-if="h">
      <HealthTimeline :history="h" />
      <dl class="kv">
        <dt>Uptime (7 days)</dt>
        <dd>{{ h.uptimePercent === null ? '—' : `${h.uptimePercent}%` }}</dd>
        <dt>Outages (7 days)</dt>
        <dd>{{ h.outages }} · {{ formatDuration(h.downtimeSeconds) }}</dd>
        <dt>Last outage</dt>
        <dd>
          <template v-if="h.lastOutage">
            {{ formatDate(h.lastOutage.startedAt) }} ·
            {{ h.lastOutage.endedAt ? formatDuration(h.lastOutage.durationSeconds) : 'ongoing' }}
          </template>
          <template v-else>none</template>
        </dd>
      </dl>
    </template>

    <template v-if="editable">
      <div class="url mono" @click="copyUrl">POST {{ heartbeatUrl }}</div>

      <form v-if="editing" class="form" @submit.prevent="patch({ ...form }, 'Monitor saved')">
        <label class="field"><span>Name</span><input v-model="form.name" class="input" required maxlength="80" /></label>
        <div class="row" style="flex-wrap: nowrap">
          <label class="field" style="flex: 1"><span>Interval (s)</span><input v-model.number="form.intervalSeconds" class="input" type="number" min="10" /></label>
          <label class="field" style="flex: 1"><span>Grace (s)</span><input v-model.number="form.graceSeconds" class="input" type="number" min="0" /></label>
        </div>
        <div class="row">
          <button class="btn small">Save</button>
          <button type="button" class="btn small ghost" @click="editing = false">Cancel</button>
        </div>
      </form>

      <div v-else class="row">
        <label class="switch compact">On <input type="checkbox" :checked="monitor.enabled" @change="patch({ enabled: !monitor.enabled }, monitor.enabled ? 'Monitor paused' : 'Monitor enabled')" /></label>
        <label class="switch compact">Alerts <input type="checkbox" :checked="monitor.notify" @change="patch({ notify: !monitor.notify }, 'Saved')" /></label>
        <button class="btn small secondary" @click="startEdit">Edit</button>
        <button class="btn small danger" @click="remove">Delete</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.title {
  font-weight: 600;
}
.url {
  background: var(--bg);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  word-break: break-all;
  cursor: pointer;
}
.switch.compact {
  gap: 8px;
  font-size: 14px;
}
</style>
