const { createCanvas } = require('@napi-rs/canvas');

// Everything here is drawn procedurally (text + simple vector shapes) so
// the Visual Verification Gate never depends on fetching external image
// assets at runtime — no network call, no asset bundle to ship, nothing
// that can 404 in production.

const WIDTH = 320;
const HEIGHT = 130;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomColor(minL, maxL) {
  const h = randInt(0, 360);
  const l = randInt(minL, maxL);
  return `hsl(${h}, 70%, ${l}%)`;
}

function paintBackground(ctx) {
  ctx.fillStyle = '#1e1b2e';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Light noise lines behind the text so the answer can't be lifted by
  // simple thresholding.
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = randomColor(25, 45);
    ctx.lineWidth = randInt(1, 2);
    ctx.beginPath();
    ctx.moveTo(randInt(0, WIDTH), randInt(0, HEIGHT));
    ctx.lineTo(randInt(0, WIDTH), randInt(0, HEIGHT));
    ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = randomColor(25, 40);
    ctx.beginPath();
    ctx.arc(randInt(0, WIDTH), randInt(0, HEIGHT), 1, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Renders a short alphanumeric or numeric string with each character
 * independently rotated/offset/colored, plus a foreground scribble —
 * used by both the "letters/numbers" and "number" challenge types.
 */
function renderText(text) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  paintBackground(ctx);

  const chars = text.split('');
  const charWidth = WIDTH / (chars.length + 1);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  chars.forEach((ch, i) => {
    const x = charWidth * (i + 1);
    const y = HEIGHT / 2 + randInt(-8, 8);
    const angle = (randInt(-18, 18) * Math.PI) / 180;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.font = `bold ${randInt(42, 52)}px sans-serif`;
    ctx.fillStyle = randomColor(75, 95);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });

  // A couple of foreground scribble lines on top of the text.
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = randomColor(55, 75);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(randInt(0, WIDTH), randInt(0, HEIGHT));
    ctx.bezierCurveTo(
      randInt(0, WIDTH), randInt(0, HEIGHT),
      randInt(0, WIDTH), randInt(0, HEIGHT),
      randInt(0, WIDTH), randInt(0, HEIGHT)
    );
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

// A small fixed set of objects, each drawn with plain canvas primitives
// — no fonts, no emoji, no external files, so rendering is guaranteed
// to succeed the same way on every host.
const OBJECT_DRAWERS = {
  Car(ctx, cx, cy) {
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(cx - 70, cy + 10);
    ctx.lineTo(cx - 50, cy - 20);
    ctx.lineTo(cx + 40, cy - 20);
    ctx.lineTo(cx + 70, cy + 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx - 80, cy + 5, 170, 20);
    ctx.fillStyle = '#a8dadc';
    ctx.fillRect(cx - 42, cy - 15, 30, 16);
    ctx.fillRect(cx - 4, cy - 15, 30, 16);
    ctx.fillStyle = '#1d1d1d';
    ctx.beginPath();
    ctx.arc(cx - 55, cy + 28, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 45, cy + 28, 14, 0, Math.PI * 2);
    ctx.fill();
  },
  Tree(ctx, cx, cy) {
    ctx.fillStyle = '#8d5524';
    ctx.fillRect(cx - 8, cy + 10, 16, 35);
    ctx.fillStyle = '#2a9d8f';
    ctx.beginPath();
    ctx.arc(cx, cy - 10, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - 28, cy + 10, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 28, cy + 10, 26, 0, Math.PI * 2);
    ctx.fill();
  },
  Dog(ctx, cx, cy) {
    ctx.fillStyle = '#b98868';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 15, 45, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 45, cy - 5, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6b4a34';
    ctx.beginPath();
    ctx.ellipse(cx + 60, cy - 15, 8, 16, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1d1d1d';
    ctx.beginPath();
    ctx.arc(cx + 52, cy - 8, 3, 0, Math.PI * 2);
    ctx.fill();
  },
  Apple(ctx, cx, cy) {
    ctx.fillStyle = '#d62828';
    ctx.beginPath();
    ctx.arc(cx - 15, cy, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 15, cy, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8d5524';
    ctx.fillRect(cx - 3, cy - 40, 6, 16);
    ctx.fillStyle = '#2a9d8f';
    ctx.beginPath();
    ctx.ellipse(cx + 10, cy - 32, 10, 5, 0.6, 0, Math.PI * 2);
    ctx.fill();
  },
  House(ctx, cx, cy) {
    ctx.fillStyle = '#e9c46a';
    ctx.fillRect(cx - 40, cy, 80, 45);
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(cx - 50, cy);
    ctx.lineTo(cx, cy - 40);
    ctx.lineTo(cx + 50, cy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#457b9d';
    ctx.fillRect(cx - 10, cy + 15, 20, 30);
  },
  Star(ctx, cx, cy) {
    ctx.fillStyle = '#f4d35e';
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const outerAngle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      const innerAngle = outerAngle + Math.PI / 5;
      const ox = cx + Math.cos(outerAngle) * 40;
      const oy = cy + Math.sin(outerAngle) * 40;
      const ix = cx + Math.cos(innerAngle) * 16;
      const iy = cy + Math.sin(innerAngle) * 16;
      if (i === 0) ctx.moveTo(ox, oy);
      else ctx.lineTo(ox, oy);
      ctx.lineTo(ix, iy);
    }
    ctx.closePath();
    ctx.fill();
  },
  Umbrella(ctx, cx, cy) {
    ctx.fillStyle = '#457b9d';
    ctx.beginPath();
    ctx.arc(cx, cy, 45, Math.PI, 0);
    ctx.fill();
    ctx.strokeStyle = '#1d1d1d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 45);
    ctx.quadraticCurveTo(cx, cy + 55, cx + 10, cy + 50);
    ctx.stroke();
  },
  Cup(ctx, cx, cy) {
    ctx.fillStyle = '#f1faee';
    ctx.fillRect(cx - 22, cy - 20, 44, 45);
    ctx.strokeStyle = '#1d1d1d';
    ctx.lineWidth = 3;
    ctx.strokeRect(cx - 22, cy - 20, 44, 45);
    ctx.beginPath();
    ctx.arc(cx + 30, cy + 2, 14, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  },
};

const OBJECT_NAMES = Object.keys(OBJECT_DRAWERS);

function renderObject(name) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  paintBackground(ctx);

  const drawer = OBJECT_DRAWERS[name];
  drawer(ctx, WIDTH / 2, HEIGHT / 2 + 6);

  return canvas.toBuffer('image/png');
}

module.exports = { renderText, renderObject, OBJECT_NAMES };
