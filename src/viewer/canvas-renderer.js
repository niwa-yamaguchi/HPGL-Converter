const radians = degrees => degrees * Math.PI / 180;

const tracePoints = (context, points, screenPoint) => {
  const [first, ...rest] = points;
  context.beginPath();
  context.moveTo(...screenPoint(first));
  rest.forEach(point => context.lineTo(...screenPoint(point)));
  context.stroke();
};

const renderGeometry = (context, geometry, viewport, screenPoint) => {
  if (geometry.type === 'line' || geometry.type === 'polyline') {
    tracePoints(context, geometry.points, screenPoint);
    return;
  }

  if (geometry.type === 'circle') {
    context.beginPath();
    context.arc(...screenPoint(geometry.center), geometry.radius * viewport.scale, 0, Math.PI * 2);
    context.stroke();
    return;
  }

  if (geometry.type === 'arc') {
    context.beginPath();
    context.arc(
      ...screenPoint(geometry.center),
      geometry.radius * viewport.scale,
      -radians(geometry.startAngle),
      -radians(geometry.endAngle),
      geometry.endAngle > geometry.startAngle,
    );
    context.stroke();
    return;
  }

  if (geometry.type === 'text') {
    context.save();
    context.translate(...screenPoint(geometry.point));
    context.rotate(-radians(geometry.rotation));
    context.font = `${Math.max(8, geometry.height * viewport.scale)}px sans-serif`;
    context.fillText(geometry.text, 0, 0);
    context.restore();
  }
};

const HIGHLIGHT_COLOR = '#ffffff';
const HIGHLIGHT_DIM_ALPHA = 0.3;
const MARKER_RADIUS = 3.5;

const renderOverlay = (context, overlay, viewport, screenPoint) => {
  if (!overlay) {
    return;
  }
  context.globalAlpha = overlay.highlightOn === false ? HIGHLIGHT_DIM_ALPHA : 1;
  context.strokeStyle = HIGHLIGHT_COLOR;
  context.fillStyle = HIGHLIGHT_COLOR;
  context.lineWidth = 3.5;
  (overlay.highlights ?? []).forEach(
    geometry => renderGeometry(context, geometry, viewport, screenPoint),
  );

  if (!overlay.segment) {
    return;
  }
  const from = screenPoint(overlay.segment[0]);
  const to = screenPoint(overlay.segment[1]);
  const coincident = Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.5;
  if (!coincident) {
    context.lineWidth = 1.5;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(...from);
    context.lineTo(...to);
    context.stroke();
    context.setLineDash([]);
  }
  (coincident ? [from] : [from, to]).forEach(point => {
    context.beginPath();
    context.arc(point[0], point[1], MARKER_RADIUS, 0, Math.PI * 2);
    context.fill();
  });
};

export function renderViewer(canvas, groups, viewport, options = {}) {
  const ratio = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const screenPoint = ([x, y]) => [
    rect.width / 2 + (x - viewport.centerX) * viewport.scale,
    rect.height / 2 - (y - viewport.centerY) * viewport.scale,
  ];

  groups.forEach(group => {
    context.strokeStyle = group.color;
    context.fillStyle = group.color;
    context.globalAlpha = group.opacity ?? 1;
    context.lineWidth = 1.25;
    group.geometries.forEach(geometry => renderGeometry(context, geometry, viewport, screenPoint));
  });
  renderOverlay(context, options.overlay ?? null, viewport, screenPoint);
}
