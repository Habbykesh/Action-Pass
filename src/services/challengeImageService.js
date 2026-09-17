const { createCanvas } = require('@napi-rs/canvas');

// Everything here is drawn procedurally (text + simple vector shapes) so
// the Visual Verification Gate never depends on fetching external image
// assets at runtime — no network call, no asset bundle to ship, nothing
// that can 404 in production.
//
// This is a human-friendliness gate, not an anti-OCR captcha, so the
// bias throughout is toward legibility: minimal background noise, high
// contrast, thick outlines, and a 2x render scale so it stays sharp on
// mobile.

const WIDTH = 320;
const HEIGHT = 140;
const SCALE = 2;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeCanvas() {
  const canvas = createCanvas(WIDTH * SCALE, HEIGHT * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  return { canvas, ctx };
}

function paintBackground(ctx) {
  ctx.fillStyle = '#20233a';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Very light speckle only — enough to signal "this is a generated
  // challenge image", not enough to compete with the subject.
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.arc(randInt(0, WIDTH), randInt(0, HEIGHT), 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Renders a short alphanumeric or numeric string, large and high
 * contrast, with a subtle per-character rotation/offset for a bit of
 * texture without hurting readability. Each glyph gets a dark outline
 * so it stays crisp against the background regardless of fill color.
 */
function renderText(text) {
  const { canvas, ctx } = makeCanvas();
  paintBackground(ctx);

  const chars = text.split('');
  const charWidth = WIDTH / (chars.length + 1);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  chars.forEach((ch, i) => {
    const x = charWidth * (i + 1);
    const y = HEIGHT / 2 + randInt(-4, 4);
    const angle = (randInt(-8, 8) * Math.PI) / 180;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.font = `900 58px sans-serif`;
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#0d0e1a';
    ctx.strokeText(ch, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });

  return canvas.toBuffer('image/png');
}

// A small fixed set of objects, each drawn with plain canvas primitives
// and a dark outline on every shape — no fonts, no emoji, no external
// files, so rendering is guaranteed to succeed the same way on every
// host, and every icon reads clearly even at Discord's thumbnail size.
const STROKE = '#12131f';

function outlinedPath(ctx, fillStyle, draw) {
  ctx.beginPath();
  draw();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = STROKE;
  ctx.stroke();
}

const OBJECT_DRAWERS = {
  Car(ctx, cx, cy) {
    outlinedPath(ctx, '#ef4444', () => {
      ctx.moveTo(cx - 85, cy + 18);
      ctx.lineTo(cx - 85, cy - 2);
      ctx.lineTo(cx - 58, cy - 28);
      ctx.lineTo(cx + 45, cy - 28);
      ctx.lineTo(cx + 85, cy - 2);
      ctx.lineTo(cx + 85, cy + 18);
      ctx.closePath();
    });
    outlinedPath(ctx, '#bfe3ff', () => {
      ctx.moveTo(cx - 50, cy - 4);
      ctx.lineTo(cx - 44, cy - 24);
      ctx.lineTo(cx + 2, cy - 24);
      ctx.lineTo(cx + 2, cy - 4);
      ctx.closePath();
    });
    outlinedPath(ctx, '#bfe3ff', () => {
      ctx.moveTo(cx + 10, cy - 4);
      ctx.lineTo(cx + 10, cy - 24);
      ctx.lineTo(cx + 40, cy - 24);
      ctx.lineTo(cx + 48, cy - 4);
      ctx.closePath();
    });
    outlinedPath(ctx, '#111827', () => ctx.arc(cx - 50, cy + 22, 16, 0, Math.PI * 2));
    outlinedPath(ctx, '#111827', () => ctx.arc(cx + 50, cy + 22, 16, 0, Math.PI * 2));
    outlinedPath(ctx, '#9ca3af', () => ctx.arc(cx - 50, cy + 22, 6, 0, Math.PI * 2));
    outlinedPath(ctx, '#9ca3af', () => ctx.arc(cx + 50, cy + 22, 6, 0, Math.PI * 2));
  },

  Tree(ctx, cx, cy) {
    outlinedPath(ctx, '#92603a', () => ctx.rect(cx - 9, cy + 15, 18, 38));
    outlinedPath(ctx, '#2f9e6e', () => ctx.arc(cx, cy - 5, 42, 0, Math.PI * 2));
    outlinedPath(ctx, '#37b57f', () => ctx.arc(cx - 26, cy + 15, 26, 0, Math.PI * 2));
    outlinedPath(ctx, '#37b57f', () => ctx.arc(cx + 26, cy + 15, 26, 0, Math.PI * 2));
  },

  Dog(ctx, cx, cy) {
    // Legs first, so the body/head overlap them at the joints.
    outlinedPath(ctx, '#c4915c', () => ctx.rect(cx - 40, cy + 24, 12, 20));
    outlinedPath(ctx, '#c4915c', () => ctx.rect(cx + 18, cy + 24, 12, 20));
    // Tail.
    outlinedPath(ctx, '#c4915c', () => {
      ctx.moveTo(cx - 48, cy - 4);
      ctx.quadraticCurveTo(cx - 68, cy - 24, cx - 56, cy - 34);
      ctx.quadraticCurveTo(cx - 44, cy - 18, cx - 34, cy - 2);
      ctx.closePath();
    });
    // Body.
    outlinedPath(ctx, '#c4915c', () => ctx.ellipse(cx - 6, cy + 8, 48, 26, 0, 0, Math.PI * 2));
    // Head.
    outlinedPath(ctx, '#c4915c', () => ctx.arc(cx + 46, cy - 10, 26, 0, Math.PI * 2));
    // Ears.
    outlinedPath(ctx, '#8a5e34', () => ctx.ellipse(cx + 64, cy - 28, 9, 18, 0.5, 0, Math.PI * 2));
    outlinedPath(ctx, '#8a5e34', () => ctx.ellipse(cx + 30, cy - 28, 9, 18, -0.5, 0, Math.PI * 2));
    // Snout.
    outlinedPath(ctx, '#e0b688', () => ctx.ellipse(cx + 62, cy - 2, 13, 10, 0, 0, Math.PI * 2));
    outlinedPath(ctx, '#3f2a17', () => ctx.ellipse(cx + 70, cy - 3, 4, 3.2, 0, 0, Math.PI * 2));
    outlinedPath(ctx, '#3f2a17', () => ctx.arc(cx + 42, cy - 14, 3.2, 0, Math.PI * 2));
  },

  Apple(ctx, cx, cy) {
    outlinedPath(ctx, '#e5383b', () => {
      ctx.moveTo(cx, cy - 22);
      ctx.bezierCurveTo(cx - 8, cy - 34, cx - 34, cy - 30, cx - 34, cy - 4);
      ctx.bezierCurveTo(cx - 34, cy + 22, cx - 14, cy + 40, cx, cy + 40);
      ctx.bezierCurveTo(cx + 14, cy + 40, cx + 34, cy + 22, cx + 34, cy - 4);
      ctx.bezierCurveTo(cx + 34, cy - 30, cx + 8, cy - 34, cx, cy - 22);
      ctx.closePath();
    });
    outlinedPath(ctx, '#7a4a20', () => ctx.rect(cx - 3, cy - 40, 6, 16));
    outlinedPath(ctx, '#2f9e6e', () => ctx.ellipse(cx + 12, cy - 32, 12, 6, 0.6, 0, Math.PI * 2));
  },

  House(ctx, cx, cy) {
    outlinedPath(ctx, '#f2c14e', () => ctx.rect(cx - 45, cy, 90, 48));
    outlinedPath(ctx, '#e5383b', () => {
      ctx.moveTo(cx - 58, cy);
      ctx.lineTo(cx, cy - 44);
      ctx.lineTo(cx + 58, cy);
      ctx.closePath();
    });
    outlinedPath(ctx, '#3d6ea5', () => ctx.rect(cx - 12, cy + 16, 24, 32));
  },

  Star(ctx, cx, cy) {
    outlinedPath(ctx, '#facc15', () => {
      for (let i = 0; i < 5; i++) {
        const outerAngle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        const innerAngle = outerAngle + Math.PI / 5;
        const ox = cx + Math.cos(outerAngle) * 44;
        const oy = cy + Math.sin(outerAngle) * 44;
        const ix = cx + Math.cos(innerAngle) * 18;
        const iy = cy + Math.sin(innerAngle) * 18;
        if (i === 0) ctx.moveTo(ox, oy);
        else ctx.lineTo(ox, oy);
        ctx.lineTo(ix, iy);
      }
      ctx.closePath();
    });
  },

  Umbrella(ctx, cx, cy) {
    outlinedPath(ctx, '#3d6ea5', () => {
      ctx.arc(cx, cy, 48, Math.PI, 0);
      ctx.closePath();
    });
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 46);
    ctx.quadraticCurveTo(cx, cy + 58, cx + 12, cy + 52);
    ctx.stroke();
    for (let i = 1; i < 4; i++) {
      const angle = Math.PI - (Math.PI * i) / 4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * 48, cy - Math.sin(angle) * 48);
      ctx.stroke();
    }
  },

  Cup(ctx, cx, cy) {
    // Steam.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    [-12, 4].forEach((offsetX) => {
      ctx.beginPath();
      ctx.moveTo(cx + offsetX, cy - 34);
      ctx.quadraticCurveTo(cx + offsetX - 8, cy - 44, cx + offsetX, cy - 54);
      ctx.stroke();
    });
    // Handle, drawn first so the cup body overlaps its inner edge.
    outlinedPath(ctx, '#e07a1f', () => {
      ctx.arc(cx + 26, cy + 2, 17, -Math.PI / 2 - 0.3, Math.PI / 2 + 0.3);
    });
    ctx.lineWidth = 4;
    // Cup body — slightly narrower at the base, rim as a flattened ellipse on top.
    outlinedPath(ctx, '#e07a1f', () => {
      ctx.moveTo(cx - 26, cy - 22);
      ctx.lineTo(cx + 26, cy - 22);
      ctx.lineTo(cx + 20, cy + 26);
      ctx.quadraticCurveTo(cx, cy + 34, cx - 20, cy + 26);
      ctx.closePath();
    });
    outlinedPath(ctx, '#f4b183', () => ctx.ellipse(cx, cy - 22, 26, 7, 0, 0, Math.PI * 2));
  },
};

const OBJECT_NAMES = Object.keys(OBJECT_DRAWERS);

function renderObject(name) {
  const { canvas, ctx } = makeCanvas();
  paintBackground(ctx);

  const drawer = OBJECT_DRAWERS[name];
  drawer(ctx, WIDTH / 2, HEIGHT / 2 + 6);

  return canvas.toBuffer('image/png');
}

module.exports = { renderText, renderObject, OBJECT_NAMES };
