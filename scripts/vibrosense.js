const MODULE_ID = "vibrosense";
const VISION_ID = "vibrosense";
const DETECTION_ID = "vibrosense";
const WALL_DAMPING_FLAG = "damping";

Hooks.once("init", () => {
  registerSettings();
  registerVisionMode();
  registerDetectionMode();
  patchVisionPolygon();

  console.log(`${MODULE_ID} | initialized`);
});

Hooks.on("renderWallConfig", injectWallDampingField);

Hooks.on("updateWall", (wall, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${WALL_DAMPING_FLAG}`)) {
    refreshSight();
  }
});

Hooks.on("createWall", refreshSight);
Hooks.on("deleteWall", refreshSight);

Hooks.on("preUpdateToken", (tokenDocument, changes) => {
  syncVibrosenseDetectionMode(tokenDocument, changes);
});

/**
 * Register a simple performance setting.
 */
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

/**
 * Register the selectable Token Vision Mode.
 *
 * This mostly controls the token's visual behaviour.
 * The detection logic is handled separately by DetectionModeVibrosense.
 */
function registerVisionMode() {
  const base =
    CONFIG.Canvas.visionModes.tremorsense
    ?? CONFIG.Canvas.visionModes.monochromatic
    ?? CONFIG.Canvas.visionModes.basic;

  if (!base) {
    console.error(`${MODULE_ID} | Could not find a base vision mode to clone.`);
    return;
  }

  const baseData = base.toObject ? base.toObject() : foundry.utils.deepClone(base);

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

/**
 * Detection mode used for target detection.
 *
 * Its LOS check always passes.
 * Its range check uses:
 *
 *   physical distance + crossed wall damping <= vibrosense range
 */
class DetectionModeVibrosense extends DetectionMode {
  _canDetect(visionSource, target) {
    return true;
  }

  _testLOS(visionSource, mode, target, test) {
    return true;
  }

  _testRange(visionSource, mode, target, test) {
    const range = getVibrosenseRange(visionSource, mode);
    if (!Number.isFinite(range) || range <= 0) return false;

    const origin = {
      x: visionSource.x,
      y: visionSource.y
    };

    const point = getVisibilityTestPoint(target, test);
    if (!point) return false;

    const cost = measureVibrosenseCost(origin, point);
    return cost <= range;
  }
}

function registerDetectionMode() {
  CONFIG.Canvas.detectionModes[DETECTION_ID] = new DetectionModeVibrosense({
    id: DETECTION_ID,
    label: "VIBROSENSE.DetectionMode",
    tokenConfig: true,

    // This tells Foundry not to use normal wall LOS for this detection mode.
    // We handle wall effects manually with wall damping.
    walls: false,

    // Movement/tremor-style detection type.
    type: DetectionMode.DETECTION_TYPES.MOVE
  });
}

/**
 * Add a damping number field to Wall Configuration.
 *
 * The value is saved as:
 *   flags.vibrosense.damping
 */
function injectWallDampingField(app, html) {
  const wallDocument = app.document ?? app.object?.document ?? app.object;
  if (!wallDocument?.getFlag) return;

  const current = Number(wallDocument.getFlag(MODULE_ID, WALL_DAMPING_FLAG) ?? 0);
  const value = Number.isFinite(current) ? current : 0;

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
  const anchor = form.find(".form-group").last();

  if (anchor.length) anchor.after(field);
  else form.append(field);
}

/**
 * When a token is assigned the Vibrosense vision mode, automatically add the
 * matching detection mode and sync its range to the token's sight range.
 *
 * When a token is changed away from Vibrosense, remove the automatic mode.
 */
function syncVibrosenseDetectionMode(tokenDocument, changes) {
  const visionModeChanged = foundry.utils.hasProperty(changes, "sight.visionMode");

  const nextVisionMode =
    foundry.utils.getProperty(changes, "sight.visionMode")
    ?? tokenDocument.sight?.visionMode;

  const sightRange =
    Number(foundry.utils.getProperty(changes, "sight.range")
    ?? tokenDocument.sight?.range
    ?? 0);

  let modes = foundry.utils.deepClone(
    changes.detectionModes ?? tokenDocument.detectionModes ?? []
  );

  modes = modes.filter(m => m?.id !== DETECTION_ID);

  if (nextVisionMode === VISION_ID) {
    modes.push({
      id: DETECTION_ID,
      enabled: true,
      range: Math.max(0, sightRange)
    });

    foundry.utils.setProperty(changes, "sight.enabled", true);
    changes.detectionModes = modes;
    return;
  }

  if (visionModeChanged) {
    changes.detectionModes = modes;
  }
}

/**
 * A Foundry-compatible polygon class.
 *
 * The previous version returned a plain PIXI.Polygon, which crashes Foundry V10
 * because Foundry later expects LOS polygons to have PointSourcePolygon methods
 * like applyConstraint().
 */
class VibrosensePolygon extends ClockwiseSweepPolygon {
  _compute() {
    this.points = createVibrosensePoints(this.origin, this.config);
    this.rays = [];
    return this;
  }
}

/**
 * Override PointSource polygon creation only for Vibrosense VisionSources.
 *
 * Uses libWrapper if present, otherwise falls back to a direct monkey-patch.
 */
function patchVisionPolygon() {
  if (!globalThis.PointSource?.prototype?._createPolygon) {
    console.error(`${MODULE_ID} | PointSource.prototype._createPolygon was not found.`);
    return;
  }

  if (globalThis.libWrapper) {
    libWrapper.register(
      MODULE_ID,
      "PointSource.prototype._createPolygon",
      function (wrapped, ...args) {
        if (!isVibrosenseSource(this)) return wrapped(...args);
        return createVibrosensePolygon(this);
      },
      "MIXED"
    );
  } else {
    const original = PointSource.prototype._createPolygon;
    PointSource.prototype._createPolygon = function (...args) {
      if (!isVibrosenseSource(this)) return original.call(this, ...args);
      return createVibrosensePolygon(this);
    };
  }
}

function isVibrosenseSource(source) {
  const isVisionSource =
    globalThis.VisionSource
      ? source instanceof VisionSource
      : source?.constructor?.name === "VisionSource";

  if (!isVisionSource) return false;

  return source.visionMode?.id === VISION_ID
    || source.data?.visionMode === VISION_ID
    || source.object?.document?.sight?.visionMode === VISION_ID;
}

function createVibrosensePolygon(source) {
  const origin = {
    x: source.x,
    y: source.y
  };

  const config = source._getPolygonConfiguration
    ? source._getPolygonConfiguration()
    : {};

  config.type = "sight";
  config.radius = Number(source.radius ?? source.data?.radius ?? config.radius ?? 0);
  config.angle = Number(source.data?.angle ?? config.angle ?? 360);
  config.rotation = Number(source.data?.rotation ?? source.object?.document?.rotation ?? config.rotation ?? 0);

  const polygon = new VibrosensePolygon();
  polygon.initialize(origin, config);
  polygon.compute();

  return polygon;
}

/**
 * Build an approximate radial polygon.
 *
 * Each ray travels until:
 *
 *   travelled scene distance + crossed wall damping > Vibrosense range
 */
function createVibrosensePoints(origin, config) {
  const rangePx = Number(config.radius ?? 0);

  if (!Number.isFinite(rangePx) || rangePx <= 0) {
    return [];
  }

  const rangeDistance = pixelsToDistance(rangePx);
  const rayCount = Number(game.settings.get(MODULE_ID, "rayCount") ?? 360);

  const angleLimit = Number(config.angle ?? 360);
  const rotation = Number(config.rotation ?? 0);

  const fullCircle = angleLimit >= 360;
  const startDeg = fullCircle ? 0 : rotation - (angleLimit / 2);
  const endDeg = fullCircle ? 360 : rotation + (angleLimit / 2);
  const steps = Math.max(8, Math.round(rayCount * (Math.min(angleLimit, 360) / 360)));

  const points = [];

  if (!fullCircle) {
    points.push(origin.x, origin.y);
  }

  const sampleCount = fullCircle ? steps : steps + 1;

  for (let i = 0; i < sampleCount; i++) {
    const t = fullCircle ? (i / steps) : (i / steps);
    const deg = startDeg + ((endDeg - startDeg) * t);
    const rad = degreesToRadians(deg);

    const reachPx = getReachAlongRay(origin, rad, rangePx, rangeDistance);

    points.push(
      origin.x + Math.cos(rad) * reachPx,
      origin.y + Math.sin(rad) * reachPx
    );
  }

  return points;
}

/**
 * Returns the effective Vibrosense cost between two canvas points:
 *
 *   base scene distance + sum of crossed wall damping
 */
function measureVibrosenseCost(a, b) {
  const base = pixelsToDistance(Math.hypot(b.x - a.x, b.y - a.y));
  let damping = 0;

  for (const wall of getSceneWalls()) {
    const d = getWallDamping(wall);
    if (d <= 0) continue;

    const segment = getWallSegment(wall);
    if (!segment) continue;

    if (segmentsIntersect(a, b, segment.a, segment.b)) {
      damping += d;
    }
  }

  return base + damping;
}

/**
 * Finds how far a ray can travel before its cost exceeds the range.
 */
function getReachAlongRay(origin, angle, maxPx, maxDistance) {
  const end = {
    x: origin.x + Math.cos(angle) * maxPx,
    y: origin.y + Math.sin(angle) * maxPx
  };

  const hits = [];

  for (const wall of getSceneWalls()) {
    const damping = getWallDamping(wall);
    if (damping <= 0) continue;

    const segment = getWallSegment(wall);
    if (!segment) continue;

    const t = segmentIntersectionParameter(origin, end, segment.a, segment.b);
    if (t === null) continue;

    hits.push({
      t,
      damping
    });
  }

  hits.sort((a, b) => a.t - b.t);

  let spentDistance = 0;
  let lastPx = 0;

  for (const hit of hits) {
    const hitPx = hit.t * maxPx;
    const segmentDistance = pixelsToDistance(hitPx - lastPx);

    if (spentDistance + segmentDistance > maxDistance) {
      return lastPx + distanceToPixels(maxDistance - spentDistance);
    }

    spentDistance += segmentDistance;

    if (spentDistance + hit.damping > maxDistance) {
      return hitPx;
    }

    spentDistance += hit.damping;
    lastPx = hitPx;
  }

  const remainingDistance = pixelsToDistance(maxPx - lastPx);

  if (spentDistance + remainingDistance > maxDistance) {
    return lastPx + distanceToPixels(maxDistance - spentDistance);
  }

  return maxPx;
}

function getVibrosenseRange(visionSource, mode) {
  const modeRange = Number(mode?.range ?? 0);
  if (Number.isFinite(modeRange) && modeRange > 0) return modeRange;

  const sightRange = Number(visionSource.object?.document?.sight?.range ?? 0);
  if (Number.isFinite(sightRange) && sightRange > 0) return sightRange;

  const radius = Number(visionSource.radius ?? 0);
  return pixelsToDistance(radius);
}

function getVisibilityTestPoint(target, test) {
  if (test?.point) return test.point;
  if (target?.center) return target.center;
  if (target?.x !== undefined && target?.y !== undefined) return target;
  return null;
}

function getSceneWalls() {
  return canvas?.walls?.placeables ?? [];
}

function getWallSegment(wall) {
  const c = wall?.document?.c;
  if (!Array.isArray(c) || c.length < 4) return null;

  return {
    a: { x: c[0], y: c[1] },
    b: { x: c[2], y: c[3] }
  };
}

function getWallDamping(wall) {
  const raw = wall?.document?.getFlag?.(MODULE_ID, WALL_DAMPING_FLAG) ?? 0;
  const value = Number(raw);

  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function pixelsToDistance(px) {
  const gridSize = Number(canvas?.dimensions?.size ?? 100);
  const gridDistance = Number(canvas?.dimensions?.distance ?? 5);

  if (!Number.isFinite(gridSize) || gridSize <= 0) return px;
  if (!Number.isFinite(gridDistance) || gridDistance <= 0) return px;

  return (px / gridSize) * gridDistance;
}

function distanceToPixels(distance) {
  const gridSize = Number(canvas?.dimensions?.size ?? 100);
  const gridDistance = Number(canvas?.dimensions?.distance ?? 5);

  if (!Number.isFinite(gridSize) || gridSize <= 0) return distance;
  if (!Number.isFinite(gridDistance) || gridDistance <= 0) return distance;

  return (distance / gridDistance) * gridSize;
}

function segmentsIntersect(a, b, c, d) {
  return segmentIntersectionParameter(a, b, c, d) !== null;
}

/**
 * Returns the intersection parameter t on segment AB where it intersects CD.
 * t is 0 at A and 1 at B.
 *
 * Returns null if the segments do not properly intersect.
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

  const denominator = cross2d(r, s);
  if (Math.abs(denominator) < 1e-8) return null;

  const cma = {
    x: c.x - a.x,
    y: c.y - a.y
  };

  const t = cross2d(cma, s) / denominator;
  const u = cross2d(cma, r) / denominator;

  // Avoid double-counting exact endpoints.
  if (t <= 1e-6 || t >= 1 - 1e-6) return null;
  if (u <= 1e-6 || u >= 1 - 1e-6) return null;

  return t;
}

function cross2d(a, b) {
  return (a.x * b.y) - (a.y * b.x);
}

function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

function refreshSight() {
  canvas?.perception?.update?.({ sight: true, lighting: true }, true);
}
