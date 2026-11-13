import { evaluateTactics } from "./tacticalEvaluation";
import { styleSettings, defaultPriorities, PRIORITY_OPTIONS, TACTICAL_FIELDS, type TacticalConfig } from "./tacticalSettings";

export type ShapeType = "triangle" | "trapezoid" | "diamond" | "large_triangle";

export type GeneratorConfig = TacticalConfig & {
  fieldWidth: number;
  fieldHeight: number;
  gridSize: number;
  triangleCount: number;
  trapezoidCount: number;
  diamondCount: number;
  largeTriangleCount: number;
  minScore: number;
  maxAttempts: number;

};

export type Point = {
  x: number;
  y: number;
};

export type Barrier = {
  id: string;
  shape: ShapeType;
  anchorIndex?: number;
  x: number;
  y: number;
  angle: number;
  polygon: Point[];
  seams: [Point, Point][];
};

export type Evaluation = {
  score: number;
  details: Record<string, number>;
  diagnostics?: { forwardCross: number; rearCross: number; breakPressure: number; reachableRoutes: number[] };
};

export type GeneratedMap = {
  name: string;
  field: {
    width: number;
    height: number;
    gridSize: number;
    bottomStart: Point;
    topStart: Point;
  };
  barriers: Barrier[];
  evaluation: Evaluation;
  attempt: number;
  accepted: boolean;
};

const UNIT_SIDE = 0.9;
const SQRT3 = Math.sqrt(3);
const PLACEMENT_GAP = 1.0;
const GENERATION_EDGE_CLEARANCE_X = 0.5;
const GENERATION_EDGE_CLEARANCE_Y = 1;
const PLACEMENT_TOLERANCE = 1e-9;
const DEFAULT_START_BOX_WIDTH = 2;
const DEFAULT_START_BOX_HEIGHT = 1;
const START_BOX_CLEARANCE = 0.5;

const SHAPE_LABELS: Record<ShapeType, string> = {
  triangle: "三角形",
  trapezoid: "台形",
  diamond: "ひし形",
  large_triangle: "大三角形",
};

export const defaultGeneratorConfig: GeneratorConfig = {
  fieldWidth: 8,
  fieldHeight: 18,
  gridSize: 0.5,
  triangleCount: 4,
  trapezoidCount: 2,
  diamondCount: 2,
  largeTriangleCount: 2,
  minScore: 70,
  maxAttempts: 500,
  ...styleSettings(50),
  ...defaultPriorities,
};

export function validateConfig(config: GeneratorConfig): string | null {
  const counts: [string, number][] = [
    ["三角形", config.triangleCount],
    ["台形", config.trapezoidCount],
    ["ひし形", config.diamondCount],
    ["大三角形", config.largeTriangleCount],
  ];

  for (const [label, count] of counts) {
    if (!Number.isInteger(count) || count < 0) return `${label}の個数は0以上の整数にしてください。`;
    if (count % 2 !== 0) return `点対称を保つため、${label}の個数は偶数にしてください。`;
  }

  if (counts.reduce((total, [, count]) => total + count, 0) <= 0) {
    return "バリケードを1個以上設定してください。";
  }

  if (config.fieldWidth < 4 || config.fieldHeight < 8) return "フィールドサイズが小さすぎます。";
  if (config.gridSize <= 0) return "グリッド間隔は0より大きくしてください。";
  if (config.minScore < 0 || config.minScore > 100) return "採用スコアは0から100の範囲にしてください。";
  if (config.maxAttempts < 1) return "最大試行回数は1以上にしてください。";
  if (Object.values(config).some(value => !Number.isFinite(value))) return "設定値は有限の数値にしてください。";
  if (config.playStyle < 0 || config.playStyle > 100) return "攻め・守りは0から100の範囲にしてください。";
  if (TACTICAL_FIELDS.some(f => config[f.key] < 0 || config[f.key] > 100)) return "サブパラメータは0から100の範囲にしてください。";
  if (TACTICAL_FIELDS.some(f => !PRIORITY_OPTIONS.some(option => option.value === config[f.priorityKey]))) return "優先度は1から6の整数で選択してください。";
  return null;
}

export function generateMap(config: GeneratorConfig, index = 1, onAttempt?: (attempt: number) => void): GeneratedMap {
  const validation = validateConfig(config);
  if (validation) throw new Error(validation);
  const starts = startPointsForField(config.fieldWidth, config.fieldHeight);

  const field = {
    width: config.fieldWidth,
    height: config.fieldHeight,
    gridSize: config.gridSize,
    bottomStart: starts.bottomStart,
    topStart: starts.topStart,
  };
  const shapeCounts = getShapeCounts(config);
  const expectedCount = Object.values(shapeCounts).reduce((total, count) => total + count, 0);
  let best: GeneratedMap | null = null;
  let evaluated = 0;
  const comparisonPool = config.minScore === 0 ? 1 : Math.min(12, config.maxAttempts);

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    onAttempt?.(attempt);
    const barriers = placeBarriers(field, shapeCounts);
    if (barriers.length !== expectedCount) continue;
    const evaluation = evaluateMap(field, barriers, config);
    evaluated++;
    const candidate: GeneratedMap = {
      name: `UAB自動生成マップ ${String(index).padStart(2, "0")}`,
      field,
      barriers,
      evaluation,
      attempt,
      accepted: barriers.length === expectedCount && evaluation.score >= config.minScore,
    };

    if (!best || betterCandidate(candidate, best, expectedCount)) best = candidate;
    if (evaluated >= comparisonPool && best.accepted) {
      return best;
    }
  }

  if (!best || best.barriers.length !== expectedCount) {
    throw new Error("設定されたバリケードをすべて配置できませんでした。個数を減らすか、最大試行回数を増やしてください。");
  }
  return best;
}

function getShapeCounts(config: GeneratorConfig): Record<ShapeType, number> {
  return {
    triangle: config.triangleCount,
    trapezoid: config.trapezoidCount,
    diamond: config.diamondCount,
    large_triangle: config.largeTriangleCount,
  };
}

function betterCandidate(candidate: GeneratedMap, current: GeneratedMap, expectedCount: number): boolean {
  const candidateHasAll = candidate.barriers.length === expectedCount;
  const currentHasAll = current.barriers.length === expectedCount;
  if (candidateHasAll !== currentHasAll) return candidateHasAll;
  return candidate.evaluation.score > current.evaluation.score;
}

function placeBarriers(
  field: GeneratedMap["field"],
  shapeCounts: Record<ShapeType, number>,
): Barrier[] {
  const pending = shapePairPlan(shapeCounts).sort(() => Math.random() - 0.5);
  const barriers: Barrier[] = [];
  const anchors = tacticalAnchors(field, pending.length);
  const maxPlacementAttempts = Math.max(240, pending.length * 320);

  for (const anchor of anchors) {
    if (!pending.length) return barriers;
    const candidate = createSnappedBarrier(field, pending[0], anchor.x, anchor.y, randomAngle(pending[0]));
    const pair = [candidate, mirrorBarrier(field, candidate)];
    if (isValidPair(field, pair, barriers)) {
      barriers.push(...pair);
      pending.shift();
    }
  }

  for (let attempt = 0; attempt < maxPlacementAttempts && pending.length; attempt += 1) {
    const x = randomBetween(0.75, field.width - 0.75);
    const y = randomBetween(1.5, field.height / 2 - 0.45);
    const candidate = createSnappedBarrier(field, pending[0], x, y, randomAngle(pending[0]));
    const pair = [candidate, mirrorBarrier(field, candidate)];
    if (isValidPair(field, pair, barriers)) {
      barriers.push(...pair);
      pending.shift();
    }
  }

  return barriers;
}

function shapePairPlan(shapeCounts: Record<ShapeType, number>): ShapeType[] {
  return (Object.entries(shapeCounts) as [ShapeType, number][]).flatMap(([shape, count]) =>
    Array.from({ length: count / 2 }, () => shape),
  );
}

function tacticalAnchors(field: GeneratedMap["field"], count: number): Point[] {
  const yLevels = [field.height * 0.18, field.height * 0.28, field.height * 0.38, field.height * 0.46];
  const xPairs = [
    [field.width * 0.20, field.width * 0.80],
    [field.width * 0.30, field.width * 0.70],
  ];
  const points: Point[] = [
    {
      x: field.width * 0.5 + randomBetween(-0.2, 0.2),
      y: field.height * 0.42 + randomBetween(-0.45, 0.15),
    },
  ];

  for (const y of yLevels) {
    const pair = xPairs[Math.floor(Math.random() * xPairs.length)];
    points.push({ x: pair[0] + randomBetween(-0.35, 0.25), y: y + randomBetween(-0.45, 0.45) });
    points.push({ x: pair[1] + randomBetween(-0.25, 0.35), y: y + randomBetween(-0.45, 0.45) });
  }

  return points.sort(() => Math.random() - 0.5).slice(0, Math.max(count, points.length));
}

function createSnappedBarrier(
  field: GeneratedMap["field"],
  shape: ShapeType,
  x: number,
  y: number,
  angle: number,
): Barrier {
  const draft = createBarrier(shape, x, y, angle);
  const vertex = draft.polygon[Math.floor(Math.random() * draft.polygon.length)];
  const grid = nearestGridPoint(field, vertex);
  return createBarrier(shape, x + grid.x - vertex.x, y + grid.y - vertex.y, angle);
}

export function createBarrier(
  shape: ShapeType,
  x: number,
  y: number,
  angle: number,
  id: string = crypto.randomUUID(),
  anchorIndex?: number,
): Barrier {
  const localPolygon = shapePolygon(shape);
  const localSeams = seamLines(shape);
  const polygon = localPolygon.map((point) => translatePoint(rotatePoint(point, angle), x, y));
  const seams = localSeams.map(([a, b]) => [
    translatePoint(rotatePoint(a, angle), x, y),
    translatePoint(rotatePoint(b, angle), x, y),
  ] as [Point, Point]);
  return {
    id,
    shape,
    anchorIndex,
    x,
    y,
    angle,
    polygon,
    seams,
  };
}

export function rebuildBarrier(barrier: Barrier, x: number, y: number, angle: number): Barrier {
  return createBarrier(barrier.shape, x, y, ((angle % 360) + 360) % 360, barrier.id, barrier.anchorIndex);
}

export function barrierClearsStartBoxes(field: GeneratedMap["field"], barrier: Barrier): boolean {
  return startBoxPolygons(field).every((box) => !polygonsTooClose(barrier.polygon, box, START_BOX_CLEARANCE));
}

export function barrierWithinPlacementBounds(field: GeneratedMap["field"], barrier: Barrier): boolean {
  // Allow for rounding when moving, rotating, or mirroring a barrier at the edge.
  return barrier.polygon.every((point) =>
    point.x >= -PLACEMENT_TOLERANCE && point.x <= field.width + PLACEMENT_TOLERANCE &&
    point.y >= -PLACEMENT_TOLERANCE && point.y <= field.height + PLACEMENT_TOLERANCE,
  );
}

export function startBoxSizeForField(width: number, height: number): { width: number; height: number } {
  if (isUab1Field(width, height)) return { width: 1, height: 1 };
  if (isUab5Field(width, height)) return { width: 2, height: 2 };
  return { width: DEFAULT_START_BOX_WIDTH, height: DEFAULT_START_BOX_HEIGHT };
}

export function refreshGeneratedMap(map: GeneratedMap, config: GeneratorConfig, barriers = map.barriers): GeneratedMap {
  const evaluation = evaluateMap(map.field, barriers, config);
  return {
    ...map,
    barriers,
    evaluation,
    accepted: barriers.length > 0 && evaluation.score >= config.minScore,
  };
}

function mirrorBarrier(field: GeneratedMap["field"], barrier: Barrier): Barrier {
  return createBarrier(
    barrier.shape,
    field.width - barrier.x,
    field.height - barrier.y,
    (barrier.angle + 180) % 360,
    undefined,
    barrier.anchorIndex,
  );
}

function shapePolygon(shape: ShapeType): Point[] {
  const side = UNIT_SIDE;
  const h = (side * SQRT3) / 2;
  if (shape === "triangle") return centerPolygon([{ x: -side / 2, y: -h / 3 }, { x: side / 2, y: -h / 3 }, { x: 0, y: (2 * h) / 3 }]);
  if (shape === "diamond") return centerPolygon([{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side * 1.5, y: h }, { x: side * 0.5, y: h }]);
  if (shape === "trapezoid") return centerPolygon([{ x: 0, y: 0 }, { x: side * 2, y: 0 }, { x: side * 1.5, y: h }, { x: side * 0.5, y: h }]);

  const largeSide = side * 2;
  const largeH = (largeSide * SQRT3) / 2;
  return centerPolygon([
    { x: -largeSide / 2, y: -largeH / 3 },
    { x: largeSide / 2, y: -largeH / 3 },
    { x: 0, y: (2 * largeH) / 3 },
  ]);
}

function seamLines(shape: ShapeType): [Point, Point][] {
  const side = UNIT_SIDE;
  const h = (side * SQRT3) / 2;
  if (shape === "diamond") {
    const base = [{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side * 1.5, y: h }, { x: side * 0.5, y: h }];
    return centerLines([ [{ x: side, y: 0 }, { x: side * 0.5, y: h }] ], base);
  }
  if (shape === "trapezoid") {
    const base = [{ x: 0, y: 0 }, { x: side * 2, y: 0 }, { x: side * 1.5, y: h }, { x: side * 0.5, y: h }];
    return centerLines([
      [{ x: side, y: 0 }, { x: side * 0.5, y: h }],
      [{ x: side, y: 0 }, { x: side * 1.5, y: h }],
    ], base);
  }
  if (shape === "large_triangle") {
    const largeH = (side * 2 * SQRT3) / 2;
    return [
      [{ x: -side / 2, y: -largeH / 3 + h }, { x: side / 2, y: -largeH / 3 + h }],
      [{ x: 0, y: -largeH / 3 }, { x: -side / 2, y: -largeH / 3 + h }],
      [{ x: 0, y: -largeH / 3 }, { x: side / 2, y: -largeH / 3 + h }],
    ];
  }
  return [];
}

function centerPolygon(points: Point[]): Point[] {
  const centroid = polygonCentroid(points);
  return points.map((point) => ({ x: point.x - centroid.x, y: point.y - centroid.y }));
}

function centerLines(lines: [Point, Point][], polygon: Point[]): [Point, Point][] {
  const centroid = polygonCentroid(polygon);
  return lines.map(([a, b]) => [
    { x: a.x - centroid.x, y: a.y - centroid.y },
    { x: b.x - centroid.x, y: b.y - centroid.y },
  ]);
}

function polygonCentroid(points: Point[]): Point {
  let signedArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    signedArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  signedArea *= 0.5;
  return { x: cx / (6 * signedArea), y: cy / (6 * signedArea) };
}

function isValidPair(field: GeneratedMap["field"], pair: Barrier[], existing: Barrier[]): boolean {
  const [first, second] = pair;
  if (polygonsTooClose(first.polygon, second.polygon, PLACEMENT_GAP)) return false;
  return isValidPlacement(field, first, existing) && isValidPlacement(field, second, [...existing, first]);
}

function isValidPlacement(field: GeneratedMap["field"], candidate: Barrier, existing: Barrier[]): boolean {
  const insetX = GENERATION_EDGE_CLEARANCE_X - PLACEMENT_TOLERANCE;
  const insetY = GENERATION_EDGE_CLEARANCE_Y - PLACEMENT_TOLERANCE;
  if (!candidate.polygon.every(({ x, y }) =>
    x >= insetX && x <= field.width - insetX && y >= insetY && y <= field.height - insetY,
  )) return false;
  if (!barrierClearsStartBoxes(field, candidate)) return false;
  if (candidate.polygon.some((point) => distance(point, field.bottomStart) < 0.35 || distance(point, field.topStart) < 0.35)) return false;
  if (pointInPolygon(field.bottomStart, candidate.polygon) || pointInPolygon(field.topStart, candidate.polygon)) return false;
  if (existing.some((barrier) => polygonsTooClose(candidate.polygon, barrier.polygon, PLACEMENT_GAP))) return false;

  return true;
}

export function evaluateMap(field: GeneratedMap["field"], barriers: Barrier[], config: GeneratorConfig): Evaluation {
  return evaluateTactics(field, barriers, config);
}

function startBoxPolygons(field: GeneratedMap["field"]): Point[][] {
  const box = startBoxSizeForField(field.width, field.height);
  if (isDiagonalStartField(field.width, field.height)) {
    return [
      rectanglePolygon(field.width - box.width, 0, box.width, box.height),
      rectanglePolygon(0, field.height - box.height, box.width, box.height),
    ];
  }

  const left = field.width / 2 - box.width / 2;
  return [
    rectanglePolygon(left, 0, box.width, box.height),
    rectanglePolygon(left, field.height - box.height, box.width, box.height),
  ];
}

export function startPointsForField(width: number, height: number): { bottomStart: Point; topStart: Point } {
  const box = startBoxSizeForField(width, height);
  if (isDiagonalStartField(width, height)) {
    return {
      bottomStart: { x: width, y: 0 },
      topStart: { x: 0, y: height },
    };
  }

  return {
    bottomStart: { x: width / 2, y: box.height / 2 },
    topStart: { x: width / 2, y: height - box.height / 2 },
  };
}

function isDiagonalStartField(width: number, height: number): boolean {
  return isUab1Field(width, height) || isUab5Field(width, height);
}

function isUab1Field(width: number, height: number): boolean {
  return Math.abs(width - 6.5) < 1e-9 && Math.abs(height - 12) < 1e-9;
}

function isUab5Field(width: number, height: number): boolean {
  return Math.abs(width - 10) < 1e-9 && Math.abs(height - 25) < 1e-9;
}

function rectanglePolygon(x: number, y: number, width: number, height: number): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function polygonsTooClose(a: Point[], b: Point[], gap: number): boolean {
  if (polygonsIntersect(a, b)) return true;
  return a.some((point) => distanceToPolygon(point, b) < gap) || b.some((point) => distanceToPolygon(point, a) < gap);
}

function polygonsIntersect(a: Point[], b: Point[]): boolean {
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a))) return true;
  return polygonEdges(a).some(([a1, a2]) => polygonEdges(b).some(([b1, b2]) => segmentsIntersect(a1, a2, b1, b2)));
}

function segmentIntersectsPolygon(a: Point, b: Point, polygon: Point[]): boolean {
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return true;
  return polygonEdges(polygon).some(([p1, p2]) => segmentsIntersect(a, b, p1, p2));
}

function segmentNearPolygon(a: Point, b: Point, polygon: Point[], clearance: number): boolean {
  if (segmentIntersectsPolygon(a, b, polygon)) return true;
  return polygonEdges(polygon).some(([p1, p2]) => segmentDistance(a, b, p1, p2) < clearance);
}

function polygonEdges(points: Point[]): [Point, Point][] {
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return false;
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function nearestGridPoint(field: GeneratedMap["field"], point: Point): Point {
  return {
    x: clamp(Math.round(point.x / field.gridSize) * field.gridSize, 0, field.width),
    y: clamp(Math.round(point.y / field.gridSize) * field.gridSize, 0, field.height),
  };
}

function rotatePoint(point: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}

function translatePoint(point: Point, x: number, y: number): Point {
  return { x: point.x + x, y: point.y + y };
}

function polygonArea(points: Point[]): number {
  return points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function distanceToPolygon(point: Point, polygon: Point[]): number {
  return Math.min(...polygonEdges(polygon).map(([a, b]) => pointSegmentDistance(point, a, b)));
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (lengthSquared === 0) return distance(point, a);
  const t = clamp(((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared, 0, 1);
  return distance(point, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function polygonDistance(a: Point[], b: Point[]): number {
  if (polygonsIntersect(a, b)) return 0;
  return Math.min(
    ...a.map((point) => distanceToPolygon(point, b)),
    ...b.map((point) => distanceToPolygon(point, a)),
  );
}

function clampScore(value: number): number {
  return clamp(value, 0, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomAngle(shape: ShapeType): number {
  const angles = shape === "diamond"
    ? [0, 30, 90, 120, 180, 210, 270, 300]
    : [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return angles[Math.floor(Math.random() * angles.length)];
}

export function getShapeLabel(shape: ShapeType): string {
  return SHAPE_LABELS[shape];
}
