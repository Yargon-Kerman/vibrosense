const MODULE_ID = "vibrosense";
const VISION_ID = "vibrosense";
const DETECTION_ID = "vibrosense";
const WALL_DAMPING_FLAG = "damping";

Hooks.once("init", () => {
  registerSettings();
  registerVisionMode();
  registerDetectionMode();
  patchVisionPolygon();
});

Hooks.on("renderWallConfig", injectWallDampingField);

Hooks.on("updateWall", (wall, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${WALL_DAMPING_FLAG}`)) {
    canvas?.perception?.update({ sight: true, lighting: true }, true);
  }
});

Hooks.on("createWall", () => canvas?.perception?.update({ sight: true, lighting: true }, true));
Hooks.on("deleteWall", () => canvas?.perception?.update({ sight: true, lighting: true }, true));

Hooks.on("preUpdateToken", (tokenDocument, changes) => {
  syncVibrosenseDetectionMode(tokenDocument, changes);
});

function registerSettings() {
  game.settings.register(MODULE_ID, "rayCount", {
    name: "VIBROSENSE.RayCount",
    hint: "VIBROSENSE.RayCountHint",
    scope: "world",
    config: true,
    type: Number,
    default: 360,
    range: {
      min: 90,
      max: 720,
      step: 30
    }
  });
}

function registerVisionMode() {
  const base = CONFIG.Canvas.visionModes.tremorsense
    ?? CONFIG.Canvas.visionModes.monochromatic
    ?? CONFIG.Canvas.visionModes.basic;

  const baseData = base?.toObject?.() ?? {};

  const data = foundry.utils.mergeObject(baseData, {
    id: VISION_ID,
    label: "VIBROSENSE.VisionMode",
    tokenConfig: true
  }, {
    inplace: false,
    overwrite: true
  });

  CONFIG.Canvas.visionModes[VISION_ID] = new VisionMode(data);
}

class DetectionModeVibrosense extends DetectionMode {
  _canDetect(visionSource, target) {
    return true;
  }

  _testLOS(visionSource, mode, target, test) {
    return true;
  }

  _testRange(visionSource, mode, target, test) {
    const range = Number(mode.range ?? visionSource.object?.document?.sight?.range ?? 0);

    // Foundry convention: null can mean unlimited in some versions.
    if (mode.range === null) return true;
    if (!Number.isFinite(range) || range <= 0) return false;

    const origin = {
      x: visionSource.x,
      y: visionSource.y
    };

    const point = test.point;
    const cost = measureVibrosenseCost(origin, point);

    return cost <= range;
  }
}

function registerDetectionMode() {
  CONFIG.Canvas.detectionModes[DETECTION_ID] = new DetectionModeVibrosense({
    id: DETECTION_ID,
    label: "VIBROSENSE.DetectionMode",
    tokenConfig: true,

    // False means the detection mode bypasses normal wall LOS.
    // The custom damping check is handled in _testRange.
    walls: false,

    // MOVE is closest to tremor/vibration style detection.
    type: DetectionMode.DETECTION_TYPES.MOVE
  });
}

function injectWallDampingField(app, html) {
  const wallDocument = app.object?.document ?? app.document ?? app.object;
  if (!wallDocument) return;

  const value = Number(wallDocument.getFlag(MODULE_ID, WALL_DAMPING_FLAG) ?? 0);

  const field = $(`
    <div class="form-group">
      <label>${game.i18n.localize("VIBROSENSE.WallDamping")}</label>
      <div class="form-fields">
        <input
          type="number"
          name="flags.${MODULE_ID}.${WALL_DAMPING_FLAG}"
          value="${value}"
          min="0"
          step="1"
        />
      </div>
      <p class="notes">${game.i18n.localize("VIBROSENSE.WallDampingHint")}</p>
    </div>
  `);

  const form = html.find("form");
  const lastGroup = form.find(".form-group").last();

  if (lastGroup.length) lastGroup.after(field);
  else form.prepend(field);
}

function syncVibrosenseDetectionMode(tokenDocument, changes) {
  const nextVisionMode =
    foundry.utils.getProperty(changes, "sight.visionMode")
    ?? tokenDocument.sight?.visionMode;

  if (nextVisionMode !== VISION_ID) return;

  const range =
    Number(foundry.utils.getProperty(changes, "sight.range")
    ?? tokenDocument.sight?.range
    ?? 0);

  const currentModes = foundry.utils.deepClone(
    changes.detectionModes ?? tokenDocument.detectionModes ?? []
  );

  const existing = currentModes.find(m => m.id === DETECTION_ID);

  if (existing) {
    existing.enabled = true;
    existing.range = range;
  } else {
    currentModes.push({
      id: DETECTION_ID,
      enabled: true,
      range
    });
  }

  changes.detectionModes = currentModes;
  foundry.utils.setProperty(changes, "sight.enabled", true);
}

/**
 * Patch the actual sight polygon so Vibrosense can reveal the scene through walls.
 *
 * The polygon is approximated with radial rays.
 * Each ray travels until:
 *   travelled scene distance + crossed wall damping > Vibrosense range
 */
function patchVisionPolygon() {
  const original = PointSource.prototype._createPolygon;

  PointSource.prototype._createPolygon = function (...args) {
    if (!isVibrosenseSource(this)) {
      return original.call(this, ...args);
    }

    return createVibrosensePolygon(this);
  };
}

function isVibrosenseSource(source) {
  if (!(source instanceof VisionSource)) return false;

  return source.visionMode?.id === VISION_ID
    || source.data?.visionMode === VISION_ID
    || source.object?.document?.sight?.visionMode === VISION_ID;
}

function createVibrosensePolygon(source) {
  const origin = {
    x: source.x,
    y: source.y
  };

  const rangePx = Number(source.radius ?? 0);
  if (!Number.isFinite(rangePx) || rangePx <= 0) {
    return new PIXI.Polygon([]);
  }

  const rangeDistance = pixelsToDistance(rangePx);
  const rayCount = Number(game.settings.get(MODULE_ID, "rayCount") ?? 360);
  const points = [];

  const angleLimit = Number(source.data?.angle ?? 360);
  const rotation = Number(source.data?.rotation ?? 0);

  const fullCircle = angleLimit >= 360;
  const startDeg = fullCircle ? 0 : rotation - (angleLimit / 2);
  const endDeg = fullCircle ? 360 : rotation + (angleLimit / 2);
  const steps = Math.max(8, Math.round(rayCount * (angleLimit / 360)));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const deg = startDeg + ((endDeg - startDeg) * t);
    const rad = Math.toRadians(deg);

    const reachPx = getReachAlongRay(origin, rad, rangePx, rangeDistance);

    points.push(
      origin.x + Math.cos(rad) * reachPx,
      origin.y + Math.sin(rad) * reachPx
    );
  }

  if (!fullCircle) {
    points.unshift(origin.x, origin.y);
  }

  const polygon = new PIXI.Polygon(points);
  polygon.origin = origin;
  polygon.config = source._getPolygonConfiguration?.() ?? {};
  polygon.rays = [];

  return polygon;
}

/**
 * Returns the effective distance cost between two points:
 * physical distance + sum of crossed wall damping.
 */
function measureVibrosenseCost(a, b) {
  const base = pixelsToDistance(Math.hypot(b.x - a.x, b.y - a.y));
  let damping = 0;

  for (const wall of canvas.walls.placeables) {
    const d = getWallDamping(wall);
    if (d <= 0) continue;

    const c = wall.document.c;
    const w1 = { x: c[0], y: c[1] };
    const w2 = { x: c[2], y: c[3] };

    if (segmentsIntersect(a, b, w1, w2)) {
      damping += d;
    }
  }

  return base + damping;
}

/**
 * Finds how far a Vibrosense ray can travel before distance+damping exceeds range.
 */
function getReachAlongRay(origin, angle, maxPx, maxDistance) {
  const end = {
    x: origin.x + Math.cos(angle) * maxPx,
    y: origin.y + Math.sin(angle) * maxPx
  };

  const hits = [];

  for (const wall of canvas.walls.placeables) {
    const damping = getWallDamping(wall);
    if (damping <= 0) continue;

    const c = wall.document.c;
    const w1 = { x: c[0], y: c[1] };
    const w2 = { x: c[2], y: c[3] };

    const t = segmentIntersectionParameter(origin, end, w1, w2);
    if (t === null) continue;

    hits.push({
      t,
      damping
    });
  }

  hits.sort((a, b) => a.t - b.t);

  let spent = 0;
  let lastPx = 0;

  for (const hit of hits) {
    const hitPx = hit.t * maxPx;
    const segmentDistance = pixelsToDistance(hitPx - lastPx);

    if (spent + segmentDistance > maxDistance) {
      return lastPx + distanceToPixels(maxDistance - spent);
    }

    spent += segmentDistance;

    if (spent + hit.damping > maxDistance) {
      return hitPx;
    }

    spent += hit.damping;
    lastPx = hitPx;
  }

  const finalSegmentDistance = pixelsToDistance(maxPx - lastPx);

  if (spent + finalSegmentDistance > maxDistance) {
    return lastPx + distanceToPixels(maxDistance - spent);
  }

  return maxPx;
}

function getWallDamping(wall) {
  return Number(wall.document.getFlag(MODULE_ID, WALL_DAMPING_FLAG) ?? 0);
}

function pixelsToDistance(px) {
  const gridSize = canvas.dimensions.size;
  const gridDistance = canvas.dimensions.distance;
  return (px / gridSize) * gridDistance;
}

function distanceToPixels(distance) {
  const gridSize = canvas.dimensions.size;
  const gridDistance = canvas.dimensions.distance;
  return (distance / gridDistance) * gridSize;
}

function segmentsIntersect(a, b, c, d) {
  return segmentIntersectionParameter(a, b, c, d) !== null;
}

/**
 * Returns t on segment AB where AB intersects CD.
 * t is 0 at A and 1 at B.
 */
function segmentIntersectionParameter(a, b, c, d) {
  const r = {
    x: b.x - a.x,
    y: b.y - a.y
  };

  const s = {
    x: d.x - c.x,
    y: d.y - c.y
  };

  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-8) return null;

  const cma = {
    x: c.x - a.x,
    y: c.y - a.y
  };

  const t = cross(cma, s) / denominator;
  const u = cross(cma, r) / denominator;

  // Avoid counting intersections exactly at endpoints.
  if (t <= 1e-6 || t >= 1 - 1e-6) return null;
  if (u <= 1e-6 || u >= 1 - 1e-6) return null;

  return t;
}

function cross(a, b) {
  return (a.x * b.y) - (a.y * b.x);
}
