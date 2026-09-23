<script setup lang="ts">
import type { Destination } from '~/utils/types';

const api = useApi();
const toast = useToast();
const { confirm } = useTelegram();
const { data: destinations, loading, error, reload } = useLoader(() => api.get<Destination[]>('/app/destinations'));

const adding = ref(false);
const form = reactive({ name: '', chatId: '', threadId: '' });
const busy = ref('');

async function run(key: string, fn: () => Promise<unknown>, success: string) {
  busy.value = key;
  try {
    await fn();
    toast.success(success);
    await reload();
    return true;
  } catch (err) {
    toast.error((err as Error).message);
    return false;
  } finally {
    busy.value = '';
  }
}

const addPrivate = () => run('private', () => api.post('/app/destinations/private'), 'Private chat connected');
const verify = (d: Destination) => run(d.id, () => api.post(`/app/destinations/${d.id}/verify`), 'Test message sent — verified');
async function remove(d: Destination) {
  const extra = d.serviceCount ? ` ${d.serviceCount} service(s) will lose their destination.` : '';
  if (!(await confirm(`Remove “${d.name}”?${extra}`))) return;
  run(d.id, () => api.del(`/app/destinations/${d.id}`), 'Destination removed');
}
async function addManual() {
  const ok = await run(
    'manual',
    () => api.post('/app/destinations', { name: form.name, chatId: Number(form.chatId), threadId: form.threadId ? Number(form.threadId) : null }),
    'Destination connected',
  );
  if (ok) {
    adding.value = false;
    Object.assign(form, { name: '', chatId: '', threadId: '' });
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <NuxtLink to="/more" class="btn ghost">‹ More</NuxtLink>
    </div>
    <div class="spread">
      <h1>Destinations</h1>
      <button class="btn small" @click="adding = true">+ Add</button>
    </div>
    <div class="hint">Where backups are delivered. The bot sends a test message to verify access.</div>

    <div v-if="loading && !destinations" class="spinner" />
    <div v-else-if="error" class="alert">{{ error }}</div>
    <template v-else>
      <div v-if="destinations?.length" class="list">
        <div v-for="d in destinations" :key="d.id" class="list-item">
          <div class="grow">
            <div class="title">{{ d.name }}</div>
            <div class="sub">
              {{ destinationTypeLabel[d.type] }} · <span class="mono">{{ d.telegramChatId }}{{ d.telegramThreadId ? ` / ${d.telegramThreadId}` : '' }}</span>
              · {{ d.serviceCount }} service(s)
            </div>
          </div>
          <span v-if="d.verified" class="badge ok"><span class="dot" />Verified</span>
          <button v-else class="btn small secondary" :disabled="busy === d.id" @click="verify(d)">Verify</button>
          <button class="btn ghost" aria-label="Remove" :disabled="busy === d.id" @click="remove(d)">🗑</button>
        </div>
      </div>
      <EmptyState v-else emoji="📬" title="No destinations yet" text="Start with your private chat with the bot.">
        <button class="btn" :disabled="busy === 'private'" @click="addPrivate">Use my private chat</button>
      </EmptyState>
    </template>

    <div class="section-label">How to connect</div>
    <div class="card" style="font-size: 14px">
      <p style="margin-top: 0"><b>Private chat:</b> <a href="#" @click.prevent="addPrivate">connect your chat with the bot</a>.</p>
      <p><b>Group:</b> add the bot to the group, then an admin sends <code>/connect</code> in the group.</p>
      <p><b>Group topic:</b> in a forum group, send <code>/connect</code> inside the topic.</p>
      <p style="margin-bottom: 0"><b>Channel:</b> add the bot as a channel admin with “Post messages” — it connects automatically.</p>
    </div>

    <AppModal :open="adding" title="Add destination by ID" @close="adding = false">
      <form class="form" @submit.prevent="addManual">
        <div class="hint">Prefer <code>/connect</code> in the chat itself. Manual setup requires you to be an admin of that chat and the bot to be a member.</div>
        <label class="field"><span>Name</span><input v-model="form.name" class="input" required maxlength="80" placeholder="Ops backups" /></label>
        <label class="field"><span>Chat ID</span><input v-model="form.chatId" class="input mono" required inputmode="numeric" placeholder="-1001234567890" /></label>
        <label class="field"><span>Topic ID (optional)</span><input v-model="form.threadId" class="input mono" inputmode="numeric" placeholder="For forum topics" /></label>
        <button class="btn block" :disabled="busy === 'manual'">{{ busy === 'manual' ? 'Verifying…' : 'Add & verify' }}</button>
      </form>
    </AppModal>
  </div>
</template>
