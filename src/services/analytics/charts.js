// Programmatic PNG charts via @napi-rs/canvas (already the bot's image
// dependency). Pure drawing — no network, no AI. Drawing is a few ms of
// synchronous canvas work; PNG encoding runs on libuv's thread pool, so
// the event loop is never blocked by compression.
//
// The font is bundled in src/assets/fonts so text renders even on bare
// containers (Railway/Nixpacks) that ship no system fonts.

const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  try {
    GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans.ttf'), 'AnalyticsSans');
    GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), 'AnalyticsSans');
  } catch (err) {
    console.error('[analytics] could not register bundled font:', err.message);
  }
  fontsReady = true;
}
const FONT = '"AnalyticsSans", "DejaVu Sans", sans-serif';

const W = 900;
const H = 380;
const SCALE = 2; // render at 2x so it stays sharp in Discord
const COLORS = {
  bg: '#1e1f2b',
  grid: 'rgba(255,255,255,0.08)',
  axis: '#9aa0b5',
  text: '#e6e8f2',
  bars: '#8b5cf6', // brand violet
  barsAlt: '#c4b5fd',
  line: '#34d399',
};

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n * 10) / 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function labelFor(date, interval) {
  if (interval === 'hour') return `${String(date.getUTCHours()).padStart(2, '0')}:00`;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * Bars (left axis) + optional line (right axis).
 * points: [{date, <barKey>, <lineKey>}]
 */
async function renderChart({ title, subtitle, points, interval, bar, line }) {
  ensureFonts();
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Title block
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 20px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 28, 36);
  if (subtitle) {
    ctx.fillStyle = COLORS.axis;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(subtitle, 28, 57);
  }

  const hasLine = Boolean(line);
  const plot = { x: 62, y: 84, w: W - 62 - (hasLine ? 62 : 28), h: H - 84 - 58 };

  const barMax = niceMax(Math.max(0, ...points.map((p) => p[bar.key] || 0)));
  const lineMax = hasLine ? niceMax(Math.max(0, ...points.map((p) => p[line.key] || 0))) : 1;

  // Grid + axes labels
  ctx.font = `12px ${FONT}`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = plot.y + plot.h - (plot.h * i) / 4;
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'right';
    ctx.fillText(compact((barMax * i) / 4), plot.x - 8, y + 4);
    if (hasLine) {
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.line;
      ctx.fillText(compact((lineMax * i) / 4), plot.x + plot.w + 8, y + 4);
    }
  }

  const n = points.length;
  const slot = plot.w / Math.max(n, 1);
  const barW = Math.max(2, Math.min(36, slot * 0.7));

  // Bars
  ctx.fillStyle = COLORS.bars;
  points.forEach((p, i) => {
    const v = p[bar.key] || 0;
    const h = (v / barMax) * plot.h;
    const x = plot.x + slot * i + (slot - barW) / 2;
    if (h > 0) {
      const r = Math.min(4, barW / 2, h);
      ctx.beginPath();
      ctx.moveTo(x, plot.y + plot.h);
      ctx.lineTo(x, plot.y + plot.h - h + r);
      ctx.quadraticCurveTo(x, plot.y + plot.h - h, x + r, plot.y + plot.h - h);
      ctx.lineTo(x + barW - r, plot.y + plot.h - h);
      ctx.quadraticCurveTo(x + barW, plot.y + plot.h - h, x + barW, plot.y + plot.h - h + r);
      ctx.lineTo(x + barW, plot.y + plot.h);
      ctx.closePath();
      ctx.fill();
    }
  });

  // Line (right axis)
  if (hasLine && n > 0) {
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = plot.x + slot * i + slot / 2;
      const y = plot.y + plot.h - ((p[line.key] || 0) / lineMax) * plot.h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (n <= 40) {
      ctx.fillStyle = COLORS.line;
      points.forEach((p, i) => {
        const x = plot.x + slot * i + slot / 2;
        const y = plot.y + plot.h - ((p[line.key] || 0) / lineMax) * plot.h;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // X labels: at most ~8, evenly spaced
  ctx.fillStyle = COLORS.axis;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / 8));
  points.forEach((p, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    if (i !== n - 1 && n - 1 - i < step / 2 && n > 8) return;
    ctx.fillText(labelFor(p.date, interval), plot.x + slot * i + slot / 2, plot.y + plot.h + 20);
  });

  // Legend
  const ly = H - 14;
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.bars;
  ctx.fillRect(plot.x, ly - 9, 12, 12);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(bar.label, plot.x + 18, ly + 1);
  if (hasLine) {
    const lx = plot.x + 18 + ctx.measureText(bar.label).width + 28;
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(lx, ly - 9, 12, 12);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${line.label} (right axis)`, lx + 18, ly + 1);
  }

  if (!points.length || points.every((p) => !(p[bar.key] > 0) && !(hasLine && p[line.key] > 0))) {
    ctx.fillStyle = COLORS.axis;
    ctx.font = `bold 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('No activity recorded in this period', plot.x + plot.w / 2, plot.y + plot.h / 2);
  }

  return canvas.encode('png'); // async, off the main thread
}

function intervalNoun(interval) {
  return interval === 'hour' ? 'Hourly' : interval === 'day' ? 'Daily' : 'Weekly';
}

async function renderServerChart(report) {
  const { chart, intervals, window } = report;
  return renderChart({
    title: `${intervalNoun(intervals.chart)} Engagements & Active Users`,
    subtitle: `${window.label} · UTC · ${intervals.chart === 'week' ? 'weekly buckets (Mon–Sun)' : `${intervals.chart} buckets`}`,
    points: chart,
    interval: intervals.chart,
    bar: { key: 'engagements', label: 'Engagements' },
    line: { key: 'active', label: 'Active users' },
  });
}

async function renderMemberChart(report) {
  const { chart, intervals, window, user } = report;
  return renderChart({
    title: `${intervalNoun(intervals.chart)} Engagements — ${user.username}`.slice(0, 60),
    subtitle: `${window.label} · UTC · ${intervals.chart === 'week' ? 'weekly buckets (Mon–Sun)' : `${intervals.chart} buckets`}`,
    points: chart,
    interval: intervals.chart,
    bar: { key: 'engagements', label: 'Engagements' },
  });
}

module.exports = { renderServerChart, renderMemberChart, renderChart };
