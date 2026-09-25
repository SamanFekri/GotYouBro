<script setup lang="ts">
import type { HealthHistory } from '~/utils/types';

/**
 * 7-day health strip: one bar per 4 hours. State is encoded by bar HEIGHT as well as color
 * (down = full, up = medium, no data = stub) so it stays readable with red–green colour blindness;
 * a text readout and a labelled legend back it up.
 */
const props = defineProps<{ history: HealthHistory; bucketHours?: number }>();

type State = 'up' | 'down' | 'none';
interface Bucket {
  start: number;
  end: number;
  state: State;
  downMs: number;
}

const HOUR = 3_600_000;

const buckets = computed<Bucket[]>(() => {
  const h = props.history;
  const size = (props.bucketHours ?? 4) * HOUR;
  const from = new Date(h.windowStart).getTime();
  const to = new Date(h.windowEnd).getTime();
  const historyStart = new Date(h.historyStart).getTime();
  const segments = h.segments.map((s) => ({ type: s.type, start: new Date(s.start).getTime(), end: s.end ? new Date(s.end).getTime() : to }));
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

  const out: Bucket[] = [];
  for (let start = from; start < to; start += size) {
    const end = Math.min(to, start + size);
    const length = end - start;
    let noData = overlap(start, end, from, historyStart); // before the service existed
    let downMs = 0;
    for (const s of segments) {
      const o = overlap(start, end, s.start, s.end);
      if (s.type === 'OUTAGE') downMs += o;
      else noData += o;
    }
    const state: State = downMs > 0 ? 'down' : noData >= length - 1000 ? 'none' : 'up';
    out.push({ start, end, state, downMs });
  }
  return out;
});

const BAR_W = 8;
const GAP = 2;
const HEIGHT = 32;
const barHeight: Record<State, number> = { down: HEIGHT, up: 20, none: 4 };
const width = computed(() => buckets.value.length * (BAR_W + GAP) - GAP);

const active = ref<number | null>(null);

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function describe(b: Bucket) {
  const range = `${fmtTime(b.start)} – ${new Date(b.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  if (b.state === 'down') return `${range} · Down ${formatDuration(b.downMs / 1000)}`;
  if (b.state === 'none') return `${range} · No data (not monitored)`;
  return `${range} · Up`;
}

const readout = computed(() => (active.value !== null && buckets.value[active.value] ? describe(buckets.value[active.value]!) : null));
const summaryLabel = computed(() => {
  const h = props.history;
  const up = h.uptimePercent === null ? 'no monitored time' : `${h.uptimePercent}% uptime`;
  return `Health over the last 7 days: ${up}, ${h.outages} outage(s), ${formatDuration(h.downtimeSeconds)} downtime.`;
});
</script>

<template>
  <div class="timeline">
    <div class="chart" @pointerleave="active = null">
      <svg
        :viewBox="`0 0 ${width} ${HEIGHT}`"
        preserveAspectRatio="none"
        role="img"
        :aria-label="summaryLabel"
        class="bars"
      >
        <rect
          v-for="(b, i) in buckets"
          :key="b.start"
          :x="i * (BAR_W + GAP)"
          :y="HEIGHT - barHeight[b.state]"
          :width="BAR_W"
          :height="barHeight[b.state]"
          rx="1.5"
          :class="['bar', b.state, { active: active === i }]"
        />
        <!-- Hit targets span the full height, bigger than the marks, for hover and tap. -->
        <rect
          v-for="(b, i) in buckets"
          :key="`hit-${b.start}`"
          :x="i * (BAR_W + GAP) - GAP / 2"
          y="0"
          :width="BAR_W + GAP"
          :height="HEIGHT"
          fill="transparent"
          @pointerenter="active = i"
          @click="active = i"
        >
          <title>{{ describe(b) }}</title>
        </rect>
      </svg>
      <div class="axis"><span>7 days ago</span><span>now</span></div>
    </div>

    <div class="readout" aria-live="polite">{{ readout ?? 'Tap or hover a bar for details' }}</div>

    <div class="legend">
      <span><i class="swatch up" /> Up</span>
      <span><i class="swatch down" /> Down</span>
      <span><i class="swatch none" /> No data</span>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  --status-good: #0ca30c;
  --status-critical: #d03b3b;
  --status-none: color-mix(in srgb, var(--hint) 45%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bars {
  display: block;
  width: 100%;
  height: 32px;
}
.bar.up {
  fill: var(--status-good);
}
.bar.down {
  fill: var(--status-critical);
}
.bar.none {
  fill: var(--status-none);
}
.bar.active {
  stroke: var(--text);
  stroke-width: 1;
}
.axis {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--hint);
}
.readout {
  font-size: 12px;
  color: var(--text);
  min-height: 1.4em;
}
.legend {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--hint);
}
.legend span {
  display: inline-flex;
  align-items: flex-end;
  gap: 5px;
}
.swatch {
  display: inline-block;
  width: 6px;
  border-radius: 1.5px;
}
.swatch.up {
  height: 9px;
  background: var(--status-good);
}
.swatch.down {
  height: 13px;
  background: var(--status-critical);
}
.swatch.none {
  height: 3px;
  background: var(--status-none);
}
</style>
