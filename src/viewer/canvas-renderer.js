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
}
