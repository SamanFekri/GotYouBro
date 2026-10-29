<script setup lang="ts">
import type { HealthHistory } from '~/utils/types';

/**
 * 7-day health strip: one bar per 4 hours. State is encoded by bar HEIGHT as well as color
 * (down = full, up = medium, no data = stub) so it stays readable with red–green colour blindness;
 * a text readout and a labelled legend back it up.
 */
/** `legend: false` when the page shows one shared <HealthLegend> instead of one per chart. */
const props = withDefaults(defineProps<{ history: HealthHistory; bucketHours?: number; legend?: boolean }>(), { legend: true });

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
const barHeight: Record<State, number> = { up: HEIGHT, down: 16, none: 4 };
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

// Scrub: a finger (or pointer) anywhere on the strip selects the nearest bar, so tiny bars are
// still easy to pick, and dragging across reads them out one by one.
const svgEl = ref<SVGSVGElement>();
function pick(e: PointerEvent) {
  const rect = svgEl.value?.getBoundingClientRect();
  if (!rect || !buckets.value.length) return;
  const i = Math.floor(((e.clientX - rect.left) / rect.width) * buckets.value.length);
  active.value = Math.min(buckets.value.length - 1, Math.max(0, i));
}

const finePointer = import.meta.client && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const hintText = finePointer ? 'Hover a bar for details' : 'Tap or drag across the bars for details';
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
        ref="svgEl"
        @pointerdown="pick"
        @pointermove="pick"
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
        <!-- Per-bar titles for hover tooltips and assistive tech; picking is done by pick(). -->
        <rect
          v-for="(b, i) in buckets"
          :key="`hit-${b.start}`"
          :x="i * (BAR_W + GAP) - GAP / 2"
          y="0"
          :width="BAR_W + GAP"
          :height="HEIGHT"
          fill="transparent"
        >
          <title>{{ describe(b) }}</title>
        </rect>
      </svg>
      <div class="axis"><span>7 days ago</span><span>now</span></div>
    </div>

    <div class="readout" :class="{ reserve: legend || readout }" aria-live="polite">{{ readout ?? (legend ? hintText : '') }}</div>

    <HealthLegend v-if="legend" />
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
  touch-action: pan-y;
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
  font-size: 0.6875rem;
  color: var(--hint);
}
.readout {
  font-size: 0.75rem;
  color: var(--text);
}
/* Reserve a line only when there is something to show, so shared-legend rows stay tight. */
.readout.reserve {
  min-height: 1.4em;
}
</style>
