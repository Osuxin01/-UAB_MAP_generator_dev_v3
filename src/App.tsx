import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import {
  defaultGeneratorConfig,
  barrierClearsStartBoxes,
  barrierWithinPlacementBounds,
  createBarrier,
  generateMap,
  getShapeLabel,
  rebuildBarrier,
  refreshGeneratedMap,
  startBoxSizeForField,
  startPointsForField,
  type Barrier,
  type GeneratedMap,
  type GeneratorConfig,
  type Point,
  type ShapeType,
} from "./mapGenerator";
import { TACTICAL_FIELDS, PRIORITY_OPTIONS, styleSettings, styleLabel } from "./tacticalSettings";
import { generateMapInWorker } from "./generateMapClient";
import type { Player, Team } from "./types";
import "./styles.css";

const CANVAS_WIDTH = 1100;
const CANVAS_HEIGHT = 1900;
const PADDING = 92;
const SCENARIO_SCALE = 2;
const PARAMETER_MAX = 10;
const PARAMETER_SCALE = 100 / PARAMETER_MAX;
const PARAMETER_STEP = 1 / PARAMETER_SCALE;

type ConfigKey = keyof GeneratorConfig;
type MapPlayer = Pick<Player, "id" | "team" | "x" | "y" | "angle"> & { waypoints?: Point[]; inherited?: boolean };
type PlayerDrag = { pointerId: number; player: MapPlayer; offset: Point; waypoints: Point[] | null };
type PlayerRoute = { playerId: string; team: Team; points: Point[] };
type PlaybackFrame = { positions: Map<string, Point>; movementFinished: boolean };
type ShotLine = { team: Team; start: Point; end: Point };
type ShotDraft = { team: Team; start: Point | null };
type Scene = { players: MapPlayer[]; shotLines: ShotLine[]; removedPlayerIds?: string[] };
type ImportedScene = { players?: unknown[]; shotLines?: unknown[]; removedPlayerIds?: unknown[] };
type MapMode = "preview" | "edit" | "move";

type ImportedScenarioFile = {
  version?: string;
  scenario?: {
    id?: string;
    name?: string;
    createdAt?: string;
    updatedAt?: string;
    field?: {
      id?: string;
      name?: string;
      width: number;
      height: number;
      gridSize: number;
      barriers: ImportedBarrier[];
      scenes?: ImportedScene[];
    } & ImportedScene;
  };
};

type ImportedBarrier = {
  id?: string;
  shape: string;
  anchorIndex?: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation: number;
  obstacleHeight?: number;
};

type ScoreTuningField = {
  key: ConfigKey;
  label: string;
  low: string;
  mid: string;
  high: string;
};

const ADD_SHAPE_OPTIONS: ShapeType[] = ["triangle", "trapezoid", "diamond", "large_triangle"];
const TEAM_LABELS: Record<Team, string> = { ally: "味方", enemy: "敵" };
const PLAYER_RADIUS = 0.3;
const ROUTE_POINT_SPACING = 0.04;
const ROUTE_SPEED = 2;
const SHOT_DISPLAY_MS = 1500;

const FIELD_PRESETS = [
  { key: "custom", label: "カスタム", width: null, height: null },
  { key: "uab1", label: "UAB1 (6.5m x 12m)", width: 6.5, height: 12 },
  { key: "uab3", label: "UAB3 (8m x 18m)", width: 8, height: 18 },
  { key: "uab5", label: "UAB5 (10m x 25m)", width: 10, height: 25 },
] as const;

type Metrics = {
  scale: number;
  offsetX: number;
  offsetY: number;
  fieldHeight: number;
};

const basicConfigFields: { key: ConfigKey; label: string; step: number; min: number; max: number }[] = [
  { key: "minScore", label: "採用スコア", step: 1, min: 0, max: 100 },
];

const detailConfigFields: { key: ConfigKey; label: string; step: number; min: number; max: number }[] = [
  { key: "fieldWidth", label: "フィールド幅", step: 0.5, min: 4, max: 20 },
  { key: "fieldHeight", label: "フィールド奥行き", step: 0.5, min: 8, max: 30 },
  { key: "gridSize", label: "グリッド間隔", step: 0.5, min: 0.5, max: 2 },
  { key: "triangleCount", label: "三角形の個数", step: 2, min: 0, max: 24 },
  { key: "trapezoidCount", label: "台形の個数", step: 2, min: 0, max: 24 },
  { key: "diamondCount", label: "ひし形の個数", step: 2, min: 0, max: 24 },
  { key: "largeTriangleCount", label: "大三角形の個数", step: 2, min: 0, max: 16 },
  { key: "maxAttempts", label: "最大試行回数", step: 50, min: 50, max: 3000 },
];

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const mapPanelRef = useRef<HTMLElement | null>(null);
  const playerDragRef = useRef<PlayerDrag | null>(null);
  const [config, setConfig] = useState<GeneratorConfig>(defaultGeneratorConfig);
  const scoreTuningFields = [...TACTICAL_FIELDS].sort(
    (a, b) => config[a.priorityKey] - config[b.priorityKey],
  );
  const [generated, setGenerated] = useState<GeneratedMap>(() => {
    const initial = generateMap({ ...defaultGeneratorConfig, minScore: 0 });
    return { ...initial, accepted: initial.evaluation.score >= defaultGeneratorConfig.minScore };
  });
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [mode, setMode] = useState<MapMode>("preview");
  const [scenes, setScenes] = useState<Scene[]>([{ players: [], shotLines: [] }]);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedVertexIndex, setSelectedVertexIndex] = useState(0);
  const [addShape, setAddShape] = useState<ShapeType>("triangle");
  const [placingTeam, setPlacingTeam] = useState<Team | null>(null);
  const [drawingRoute, setDrawingRoute] = useState(false);
  const [shotDraft, setShotDraft] = useState<ShotDraft | null>(null);
  const [draftWaypoints, setDraftWaypoints] = useState<Point[] | null>(null);
  const [playback, setPlayback] = useState<number[] | null>(null);
  const [playbackFrame, setPlaybackFrame] = useState<(PlaybackFrame & { sceneIndex: number }) | null>(null);
  const resolvedScenes = useMemo(() => resolveSceneStarts(scenes), [scenes]);
  const { players, shotLines } = resolvedScenes[sceneIndex];
  const previousPlayers = resolvedScenes[sceneIndex - 1]?.players;
  const displayedSceneIndex = playbackFrame?.sceneIndex ?? playback?.[0] ?? sceneIndex;
  const displayedScene = resolvedScenes[displayedSceneIndex];
  const isEditing = mode !== "preview";
  const selectedBarrier = mode === "edit" ? generated.barriers.find((barrier) => barrier.id === selectedId) : undefined;
  const selectedPlayer = mode === "move" ? players.find((player) => player.id === selectedId) : undefined;
  const selectedWaypoints = selectedPlayer?.waypoints;
  const hasRoutes = players.some((player) => player.waypoints?.length);
  const canEditSelection = Boolean(selectedId) && !playback && draftWaypoints === null;
  const canMoveSelection = canEditSelection && !previousPlayers?.some((player) => player.id === selectedPlayer?.id);
  const showingArrivalShots = Boolean(playbackFrame?.movementFinished && displayedScene.shotLines.length);
  const selectionLabel = playback ? `シーン${displayedSceneIndex + 1}・${showingArrivalShots ? "射線を表示中" : "再生中"}`
    : shotDraft ? `${TEAM_LABELS[shotDraft.team]}の射線の${shotDraft.start ? "終点" : "始点"}を選択`
    : drawingRoute ? "プレイヤーからドラッグして経路を描く"
    : placingTeam
    ? `${TEAM_LABELS[placingTeam]}の配置先を選択`
    : selectedPlayer ? TEAM_LABELS[selectedPlayer.team]
    : selectedBarrier ? getShapeLabel(selectedBarrier.shape) : "未選択";
  useEffect(() => {
    if (isEditing && window.matchMedia("(min-width: 721px)").matches) {
      mapPanelRef.current?.scrollIntoView({ block: "start" });
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const routes = mode === "move" && !playback ? getPlayerRoutes(players, selectedPlayer?.id, draftWaypoints) : [];
    const displayedPlayers = playbackFrame
      ? displayedScene.players.map((player) => ({ ...player, ...playbackFrame.positions.get(player.id) }))
      : displayedScene.players;
    const visibleShotLines = !playback || showingArrivalShots ? displayedScene.shotLines : [];
    drawMap(canvas, generated, displayedPlayers, selectedBarrier?.id ?? null, playback ? null : selectedPlayer?.id ?? null, selectedVertexIndex, routes, visibleShotLines, shotDraft);
  }, [mode, generated, players, selectedBarrier, selectedPlayer, selectedVertexIndex, draftWaypoints, playback, playbackFrame, showingArrivalShots, displayedScene, shotDraft]);

  useEffect(() => {
    if (!playback) return;
    let cancelFrame: (() => void) | undefined;
    function playScene(remaining: number[]) {
      const [index, ...next] = remaining;
      const scene = resolvedScenes[index];
      cancelFrame = animateRoutes(getPlayerRoutes(scene.players), scene.shotLines.length ? SHOT_DISPLAY_MS : 400,
        (frame) => setPlaybackFrame({ ...frame, sceneIndex: index }),
        () => next.length ? playScene(next) : stopPlayback());
    }
    playScene(playback);
    return () => cancelFrame?.();
  }, [playback, resolvedScenes]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!canMoveSelection) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) return;

      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelected(0, 0.5);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelected(0, -0.5);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelected(-0.5, 0);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelected(0.5, 0);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canMoveSelection, mode, selectedId, selectedVertexIndex, generated, config, players]);

  function updateConfig(key: ConfigKey, value: number) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function updatePlayStyle(value: number) {
    setConfig(current => ({ ...current, ...styleSettings(value) }));
  }

  function selectedFieldPreset(): string {
    return FIELD_PRESETS.find(
      (preset) =>
        preset.width !== null &&
        preset.height !== null &&
        config.fieldWidth === preset.width &&
        config.fieldHeight === preset.height,
    )?.key ?? "custom";
  }

  function applyFieldPreset(presetKey: string) {
    const preset = FIELD_PRESETS.find((candidate) => candidate.key === presetKey);
    if (!preset || preset.width === null || preset.height === null) return;
    setConfig((current) => ({
      ...current,
      fieldWidth: preset.width,
      fieldHeight: preset.height,
    }));
  }

  function handleConfigNumberChange(key: ConfigKey, event: ChangeEvent<HTMLInputElement>) {
    const rawValue = event.currentTarget.value;
    const nextValue = rawValue === "" ? 0 : Number(rawValue);
    if (!Number.isFinite(nextValue)) return;
    if (/^0+\d+$/.test(rawValue)) event.currentTarget.value = String(nextValue);
    updateConfig(key, nextValue);
  }

  function handleConfigNumberBlur(
    key: ConfigKey,
    event: FocusEvent<HTMLInputElement>,
    step: number,
    min: number,
    max: number,
  ) {
    const rawValue = event.currentTarget.value;
    const nextValue = rawValue === "" ? min : Number(rawValue);
    if (!Number.isFinite(nextValue)) return;
    const normalized = clampNumber(roundToStep(nextValue, step), min, max);
    event.currentTarget.value = formatStepValue(normalized, step);
    updateConfig(key, normalized);
  }

  async function handleGenerate() {
    setIsGenerating(true);
    resetRouteInteraction();
    setError(null);
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    try {
      const next = await generateMapInWorker(config);
      setGenerated(next);
      setScenes([{ players: [], shotLines: [] }]);
      setSceneIndex(0);
      setSelectedId(null);
      setPlacingTeam(null);
      setError(null);
      setSettingsOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成に失敗しました。");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fileName = `uab-map-score-${generated.evaluation.score}.png`;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;

    const file = new File([blob], fileName, { type: "image/png" });
    const canShareImage =
      typeof navigator !== "undefined" &&
      "share" in navigator &&
      "canShare" in navigator &&
      navigator.canShare({ files: [file] });
    const prefersMobileSave =
      typeof window !== "undefined" && (window.matchMedia("(max-width: 720px)").matches || navigator.maxTouchPoints > 0);

    if (prefersMobileSave && canShareImage) {
      try {
        await navigator.share({
          files: [file],
          title: "UABマップ",
          text: "生成したUABマップです。",
        });
        return;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
      }
    }

    const link = document.createElement("a");
    link.download = fileName;
    link.href = URL.createObjectURL(blob);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function handleExportJson() {
    const now = new Date().toISOString();
    const exportedScenes = scenes.map((scene) => exportScene(scene, generated.field.width));
    const payload = {
      version: "1.0.0",
      scenario: {
        id: "scenario-uab-generated",
        name: generated.name,
        createdAt: now,
        updatedAt: now,
        field: {
          id: "field-uab-generated",
          name: "UAB generated field",
          width: generated.field.width * SCENARIO_SCALE,
          height: generated.field.height * SCENARIO_SCALE,
          gridSize: generated.field.gridSize * SCENARIO_SCALE,
          barriers: generated.barriers.map((barrier) => exportBarrier(barrier, generated.field.width)),
          ...exportedScenes[0],
          scenes: exportedScenes.length > 1 ? exportedScenes : undefined,
        },
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.download = `uab-map-${Date.now()}.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function handleImportJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    try {
      const imported = JSON.parse(await file.text()) as ImportedScenarioFile;
      const field = imported.scenario?.field;
      if (!field || !Array.isArray(field.barriers)) throw new Error("field.barriers が見つかりません。");

      const nextConfig = {
        ...config,
        fieldWidth: field.width / SCENARIO_SCALE,
        fieldHeight: field.height / SCENARIO_SCALE,
        gridSize: field.gridSize / SCENARIO_SCALE,
      };
      const base = { ...generated, field: { ...generated.field, width: nextConfig.fieldWidth, height: nextConfig.fieldHeight, gridSize: nextConfig.gridSize, ...startPointsForField(nextConfig.fieldWidth, nextConfig.fieldHeight) } };
      const barriers = field.barriers
        .map((barrier) => importBarrier(barrier, nextConfig.fieldWidth))
        .filter((barrier): barrier is Barrier => barrier !== null);
      const nextMap = refreshGeneratedMap({
        ...base,
        name: imported.scenario?.name || "インポートマップ",
        barriers,
      }, nextConfig, barriers);
      const importedScenes = Array.isArray(field.scenes) && field.scenes.length ? field.scenes : [field];
      const knownPlayerIds = new Set<string>();
      const nextScenes = importedScenes.map((scene) => {
        const next = importScene(scene, nextMap.field);
        next.players = next.players.map((player) => {
          const inherited = player.inherited || knownPlayerIds.has(player.id);
          knownPlayerIds.add(player.id);
          return inherited ? { ...player, inherited: true } : player;
        });
        return next;
      });

      resetRouteInteraction();
      setConfig(nextConfig);
      setGenerated(nextMap);
      setScenes(nextScenes);
      setSceneIndex(0);
      setSelectedId(null);
      setPlacingTeam(null);
      setSelectedVertexIndex(0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? `JSONインポートに失敗しました: ${caught.message}` : "JSONインポートに失敗しました。");
    }
  }

  function toggleMode(nextMode: "edit" | "move") {
    resetRouteInteraction();
    setMode(mode === nextMode ? "preview" : nextMode);
    setSelectedId(null);
    setSelectedVertexIndex(0);
    setPlacingTeam(null);
    setSettingsOpen(false);
  }

  function stopPlayback() {
    setPlayback(null);
    setPlaybackFrame(null);
  }

  function setPlayers(update: (current: MapPlayer[]) => MapPlayer[]) {
    setScenes((current) => current.map((scene, index) => index === sceneIndex
      ? { ...scene, players: update(scene.players) }
      : scene));
  }

  function setShotLines(update: (current: ShotLine[]) => ShotLine[]) {
    setScenes((current) => current.map((scene, index) => index === sceneIndex
      ? { ...scene, shotLines: update(scene.shotLines) }
      : scene));
  }

  function selectScene(index: number) {
    resetRouteInteraction();
    setPlacingTeam(null);
    setSelectedId(null);
    setSceneIndex(index);
  }

  function addScene() {
    setScenes((current) => [...current, { players: [], shotLines: [] }]);
    selectScene(scenes.length);
  }

  function startScenePlayback(indices: number[]) {
    resetRouteInteraction();
    setPlacingTeam(null);
    setPlayback(indices);
  }

  function resetRouteInteraction() {
    playerDragRef.current = null;
    setDrawingRoute(false);
    setShotDraft(null);
    setDraftWaypoints(null);
    stopPlayback();
  }

  function updateEditedBarriers(nextBarriers: Barrier[], nextSelectedId = selectedId) {
    setGenerated((current) => refreshGeneratedMap(current, config, nextBarriers));
    setSelectedId(nextSelectedId);
  }

  function selectedPivotIndex(barrier: Barrier): number {
    return Math.min(selectedVertexIndex, barrier.polygon.length - 1);
  }

  function mirroredBarrierOf(source: Barrier, partner: Barrier): Barrier {
    return createBarrier(
      source.shape,
      generated.field.width - source.x,
      generated.field.height - source.y,
      source.angle + 180,
      partner.id,
      partner.anchorIndex ?? source.anchorIndex,
    );
  }

  function symmetricPartnerOf(source: Barrier): Barrier | null {
    const mirrorCenter = {
      x: generated.field.width - source.x,
      y: generated.field.height - source.y,
    };
    const candidates = generated.barriers.filter((barrier) => barrier.id !== source.id && barrier.shape === source.shape);
    if (!candidates.length) return null;
    return candidates.reduce((nearest, barrier) => (
      pointDistance(barrier, mirrorCenter) < pointDistance(nearest, mirrorCenter) ? barrier : nearest
    ));
  }

  function updateBarrierWithSymmetricPartner(
    original: Barrier,
    updated: Barrier,
  ) {
    const partner = symmetricPartnerOf(original);
    const mirrored = partner ? mirroredBarrierOf(updated, partner) : null;
    if (!barrierWithinPlacementBounds(generated.field, updated)) return;
    if (!barrierClearsStartBoxes(generated.field, updated)) return;
    if (mirrored && !barrierWithinPlacementBounds(generated.field, mirrored)) return;
    if (mirrored && !barrierClearsStartBoxes(generated.field, mirrored)) return;

    updateEditedBarriers(generated.barriers.map((barrier) => {
      if (barrier.id === updated.id) return updated;
      if (mirrored && barrier.id === mirrored.id) return mirrored;
      return barrier;
    }));
  }

  function moveSelected(dx: number, dy: number) {
    if (selectedPlayer) {
      updatePlayer({ ...selectedPlayer, x: selectedPlayer.x + dx, y: selectedPlayer.y + dy });
      return;
    }
    const target = selectedBarrier;
    if (!target) return;
    const pivot = target.polygon[selectedPivotIndex(target)];
    const nextPivot = nextPivotGridPoint(pivot, dx, dy, generated.field);
    const moved = fitMovedBarrierToPlacementBounds(rebuildBarrier(
      target,
      target.x + nextPivot.x - pivot.x,
      target.y + nextPivot.y - pivot.y,
      target.angle,
    ), generated.field);
    updateBarrierWithSymmetricPartner(target, moved);
  }

  function rotateSelected(delta: number) {
    const target = selectedBarrier;
    if (!target) return;
    const pivotIndex = selectedPivotIndex(target);
    const pivot = target.polygon[pivotIndex];
    const rotatedCenter = rotateAround({ x: target.x, y: target.y }, pivot, delta);
    const rotated = rebuildBarrier(target, rotatedCenter.x, rotatedCenter.y, target.angle + delta);
    updateBarrierWithSymmetricPartner(target, rotated);
  }

  function deleteSelected() {
    if (selectedPlayer) {
      setScenes((current) => current.map((scene, index) => index === sceneIndex ? {
        ...scene,
        players: scene.players.filter((player) => player.id !== selectedPlayer.id),
        removedPlayerIds: [...(scene.removedPlayerIds ?? []), selectedPlayer.id],
      } : scene));
      setSelectedId(null);
      return;
    }
    const target = selectedBarrier;
    if (!target) return;
    const partner = symmetricPartnerOf(target);
    const deleteIds = new Set([target.id, partner?.id]);
    updateEditedBarriers(generated.barriers.filter((barrier) => !deleteIds.has(barrier.id)), null);
  }

  function updatePlayer(player: MapPlayer) {
    const next = fitPlayerToField(player, generated.field);
    setPlayers((current) => current.some((candidate) => candidate.id === next.id)
      ? current.map((candidate) => candidate.id === next.id ? next : candidate)
      : [...current, next]);
  }

  function addBarrier() {
    const created = createBarrier(addShape, generated.field.width / 2, generated.field.height / 2 - 1.25, 0);
    const mirrored = createBarrier(addShape, generated.field.width - created.x, generated.field.height - created.y, created.angle + 180);
    updateEditedBarriers([...generated.barriers, created, mirrored], created.id);
    setSelectedVertexIndex(0);
  }

  function canvasEventPoint(event: MouseEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const metrics = getMetrics(generated.field.width, generated.field.height);
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasPoint = {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
    return canvasToWorld(canvasPoint, metrics);
  }

  function handleCanvasPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (mode !== "move" || placingTeam || shotDraft || playback || !event.isPrimary || event.button !== 0 || playerDragRef.current) return;
    const point = canvasEventPoint(event);
    const player = [...players].reverse().find((candidate) => pointDistance(point, candidate) <= PLAYER_RADIUS);
    setSelectedId(player?.id ?? null);
    if (!player) return;
    if (!drawingRoute && previousPlayers?.some((previous) => previous.id === player.id)) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    playerDragRef.current = {
      pointerId: event.pointerId,
      player,
      offset: { x: player.x - point.x, y: player.y - point.y },
      waypoints: drawingRoute ? [] : null,
    };
    if (drawingRoute) setDraftWaypoints([]);
  }

  function handleCanvasPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const drag = playerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = canvasEventPoint(event);
    const next = { x: point.x + drag.offset.x, y: point.y + drag.offset.y };
    if (drag.waypoints) {
      const waypoint = fitPlayerPointToField(next, generated.field);
      const lastPoint = drag.waypoints.at(-1) ?? drag.player;
      if (pointDistance(lastPoint, waypoint) < ROUTE_POINT_SPACING) return;
      drag.waypoints.push(waypoint);
      setDraftWaypoints([...drag.waypoints]);
      return;
    }
    updatePlayer({ ...drag.player, ...next });
  }

  function endPlayerDrag(event: PointerEvent<HTMLCanvasElement>) {
    const drag = playerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.waypoints && event.type === "pointerup") {
      handleCanvasPointerMove(event);
      if (drag.waypoints.length) updatePlayer({ ...drag.player, waypoints: drag.waypoints });
    }
    playerDragRef.current = null;
    setDraftWaypoints(null);
  }

  function handleCanvasClick(event: MouseEvent<HTMLCanvasElement>) {
    if (!isEditing) return;
    const world = canvasEventPoint(event);
    if (mode === "move" && shotDraft) {
      const { width, height } = generated.field;
      if (world.x < 0 || world.x > width || world.y < 0 || world.y > height) return;
      if (!shotDraft.start) {
        setShotDraft({ ...shotDraft, start: world });
      } else if (pointDistance(shotDraft.start, world) > 1e-6) {
        const line = { team: shotDraft.team, start: shotDraft.start, end: world };
        setShotLines((current) => [...current, line]);
        setShotDraft({ team: shotDraft.team, start: null });
      }
      return;
    }
    if (mode === "move" && placingTeam) {
      const { width, height } = generated.field;
      if (world.x < 0 || world.x > width || world.y < 0 || world.y > height) return;
      const player = fitPlayerToField({
        ...world,
        id: crypto.randomUUID(),
        team: placingTeam,
        angle: placingTeam === "ally" ? 90 : 270,
      }, generated.field);
      setPlayers((current) => [...current, player]);
      setSelectedId(player.id);
      return;
    }
    if (mode !== "edit") return;
    const clicked = [...generated.barriers].reverse().find((barrier) => pointInPolygonLocal(world, barrier.polygon));
    setSelectedId(clicked?.id ?? null);
    setSelectedVertexIndex(0);
  }

  const rotationControls = mode === "edit" && (
    <>
      <button type="button" onClick={() => rotateSelected(-15)} disabled={!selectedBarrier}>-15°</button>
      <button type="button" onClick={() => rotateSelected(15)} disabled={!selectedBarrier}>+15°</button>
    </>
  );

  const sceneControls = mode === "move" && (
    <div className="route-controls">
      <select
        aria-label="シーンを選択"
        value={displayedSceneIndex}
        disabled={Boolean(playback) || draftWaypoints !== null || isGenerating}
        onChange={(event) => selectScene(Number(event.currentTarget.value))}
      >
        {scenes.map((_, index) => <option key={index} value={index}>シーン{index + 1}</option>)}
      </select>
      <button className="secondary-button" type="button" onClick={addScene} disabled={Boolean(playback) || draftWaypoints !== null || isGenerating}>
        シーンを追加
      </button>
      <button
        className="secondary-button"
        type="button"
        disabled={scenes.length < 2 || Boolean(playback) || draftWaypoints !== null || isGenerating}
        onClick={() => startScenePlayback(scenes.map((_, index) => index))}
      >
        全シーンを再生
      </button>
    </div>
  );

  const routeControls = mode === "move" && (
    <div className="route-controls">
      <button
        className="secondary-button"
        type="button"
        aria-pressed={drawingRoute}
        disabled={Boolean(playback) || draftWaypoints !== null || isGenerating}
        onClick={() => {
          setPlacingTeam(null);
          setShotDraft(null);
          setDrawingRoute(!drawingRoute);
        }}
      >
        経路を描く
      </button>
      <button
        className="secondary-button"
        type="button"
        disabled={(!playback && !hasRoutes && !shotLines.length) || draftWaypoints !== null || isGenerating}
        onClick={() => {
          if (playback) {
            stopPlayback();
          } else {
            startScenePlayback([sceneIndex]);
          }
        }}
      >
        {playback ? "停止" : "このシーンを再生"}
      </button>
      <button
        className="secondary-button"
        type="button"
        disabled={!selectedWaypoints?.length || !canEditSelection || isGenerating}
        onClick={() => selectedPlayer && updatePlayer({ ...selectedPlayer, waypoints: undefined })}
      >
        経路を消す
      </button>
    </div>
  );

  const shotControls = mode === "move" && (
    <div className="route-controls" aria-label="射線">
      {(["ally", "enemy"] as const).map((team) => (
        <button
          key={team}
          className="secondary-button"
          type="button"
          aria-pressed={shotDraft?.team === team}
          disabled={Boolean(playback) || draftWaypoints !== null || isGenerating}
          onClick={() => {
            setDrawingRoute(false);
            setPlacingTeam(null);
            setSelectedId(null);
            setShotDraft(shotDraft?.team === team ? null : { team, start: null });
          }}
        >
          {TEAM_LABELS[team]}の射線
        </button>
      ))}
      <button
        className="secondary-button"
        type="button"
        disabled={!shotLines.length || Boolean(playback) || isGenerating}
        onClick={() => setShotLines((current) => current.slice(0, -1))}
      >
        射線を1本戻す
      </button>
    </div>
  );

  const addControls = mode === "move" ? (
    <>
      {(["ally", "enemy"] as const).map((team) => (
        <button
          key={team}
          type="button"
          aria-pressed={placingTeam === team}
          disabled={Boolean(playback) || draftWaypoints !== null || isGenerating}
          onClick={() => {
            if (placingTeam === team) {
              setPlacingTeam(null);
            } else {
              setPlacingTeam(team);
              setDrawingRoute(false);
              setShotDraft(null);
              setSelectedId(null);
            }
          }}
        >
          {team === "ally" ? "味方（緑）を追加" : "敵（赤）を追加"}
        </button>
      ))}
    </>
  ) : (
    <>
      <select
        aria-label="追加するバリケード"
        value={addShape}
        onChange={(event) => setAddShape(event.target.value as ShapeType)}
      >
        {ADD_SHAPE_OPTIONS.map((shape) => (
          <option key={shape} value={shape}>{getShapeLabel(shape)}</option>
        ))}
      </select>
      <button type="button" onClick={addBarrier}>追加</button>
    </>
  );

  const counts = generated.barriers.reduce<Record<string, number>>((total, barrier) => {
    total[barrier.shape] = (total[barrier.shape] ?? 0) + 1;
    return total;
  }, {});
  const fieldViewportStyle = isEditing ? getFieldViewportStyle(generated.field) : undefined;

  return (
    <main className={`app-shell${isEditing ? " editing-layout" : ""}`}>
      <header className="app-header">
        <div>
          <h1>UABマップ自動生成ツール</h1>
          <p>点対称・頂点グリッド合わせ対応の2D競技マップ自動生成ツール</p>
        </div>
        <div className="score-block">
          <span>設定一致度</span>
          <strong>{generated.evaluation.score}</strong>
        </div>
      </header>

      <div className="mobile-action-bar">
        <button
          className="menu-button mobile-menu-action"
          type="button"
          aria-label="設定を開く"
          aria-expanded={settingsOpen}
          disabled={isGenerating}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <button className="primary-button mobile-generate-action" type="button" onClick={handleGenerate} disabled={isGenerating}>
          {isGenerating ? "生成中..." : "生成"}
        </button>
        <button className="secondary-button mobile-save-action" type="button" onClick={handleDownload} disabled={isGenerating}>
          PNG保存
        </button>
        <button className={`secondary-button mobile-edit-action ${mode === "edit" ? "active-button" : ""}`} type="button" aria-pressed={mode === "edit"} onClick={() => toggleMode("edit")} disabled={isGenerating}>
          編集
        </button>
        <button className={`secondary-button mobile-move-action ${mode === "move" ? "active-button" : ""}`} type="button" aria-pressed={mode === "move"} onClick={() => toggleMode("move")} disabled={isGenerating}>
          ムーブ
        </button>
      </div>

      <section className="generator-layout">
        {settingsOpen && <button className="drawer-backdrop" type="button" aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)} />}
        <aside className={`settings-panel ${settingsOpen ? "open" : ""}`} aria-label="マップ設定">
          <div className="panel-head">
            <h2>設定</h2>
            <button className="primary-button" type="button" onClick={handleGenerate} disabled={isGenerating}>
              {isGenerating ? "生成中..." : "生成"}
            </button>
          </div>

          <div className="score-settings">
            <div>
              <h2>基本設定</h2>
              <p>個別のパラメータは詳細設定から調整できます。</p>
            </div>
            <div className="settings-grid">
              <label className="input-row">
                <span>マッププリセット</span>
                <select value={selectedFieldPreset()} onChange={(event) => applyFieldPreset(event.target.value)}>
                  {FIELD_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="json-actions">
                <button className="secondary-button" type="button" onClick={() => importInputRef.current?.click()}>
                  JSON読込
                </button>
                <button className="secondary-button" type="button" onClick={handleExportJson}>
                  JSON保存
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleImportJson}
                />
              </div>
            </div>
            <div className="play-style-control">
              <label className="play-style-axis" htmlFor="play-style">
                <span>攻め</span>
                <span>守り</span>
              </label>
              <input
                id="play-style"
                type="range"
                min={0}
                max={PARAMETER_MAX}
                step={PARAMETER_STEP}
                value={config.playStyle / PARAMETER_SCALE}
                onChange={(event) => updatePlayStyle(Math.round(event.currentTarget.valueAsNumber * PARAMETER_SCALE))}
                disabled={isGenerating}
                aria-label="攻め・守り"
                aria-valuetext={`${config.playStyle / PARAMETER_SCALE} / ${PARAMETER_MAX} ${styleLabel(config.playStyle)}`}
                aria-describedby="play-style-help"
              />
              <p id="play-style-help">{styleLabel(config.playStyle)}（{config.playStyle / PARAMETER_SCALE} / {PARAMETER_MAX}）。変更すると6項目をまとめて設定します。「生成」でマップに反映します。</p>
              <details className="detail-settings">
                <summary>詳細設定</summary>
                <div className="score-settings nested">
                  <div>
                    <h2>サブパラメータ</h2>
                    <p>スライダーで目指す傾向、優先度でどれだけ重視するかを設定します（1〜6、小さいほど優先、1が最優先）。攻め・守りを動かしても優先度は維持されます。「生成」で反映します。</p>
                  </div>
                  <div className="tuning-list">
                    {scoreTuningFields.map((field) => (
                      <div className="tuning-row" key={field.key}>
                        <span className="tuning-head">
                          <span>{field.label}</span>
                          <strong>{config[field.key] / PARAMETER_SCALE}</strong>
                        </span>
                        <span className="parameter-description">{field.description}</span>
                        <input
                          aria-label={field.label}
                          type="range"
                          min={0}
                          max={PARAMETER_MAX}
                          step={PARAMETER_STEP}
                          value={config[field.key] / PARAMETER_SCALE}
                          onChange={(event) => updateConfig(field.key, Math.round(event.currentTarget.valueAsNumber * PARAMETER_SCALE))}
                        />
                        <span className="tuning-foot">
                          <span>{tuningText(field, Number(config[field.key]))}</span>
                        </span>
                        <label className="priority-row">
                          <span>優先度</span>
                          <select
                            aria-label={field.label + "の優先度"}
                            value={config[field.priorityKey]}
                            disabled={isGenerating}
                            onChange={event => updateConfig(field.priorityKey, Number(event.target.value))}
                          >
                            {PRIORITY_OPTIONS.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            </div>
          </div>

          <div className="edit-settings">
            <div className="mode-buttons">
              <button className={`secondary-button ${mode === "edit" ? "active-button" : ""}`} type="button" aria-pressed={mode === "edit"} onClick={() => toggleMode("edit")} disabled={isGenerating}>
                編集モード
              </button>
              <button className={`secondary-button ${mode === "move" ? "active-button" : ""}`} type="button" aria-pressed={mode === "move"} onClick={() => toggleMode("move")} disabled={isGenerating}>
                ムーブモード
              </button>
            </div>
            {isEditing && (
              <div className="edit-tools">
                {sceneControls}
                <p className="selected-label" aria-live="polite">{selectionLabel}</p>
                {selectedBarrier && (
                  <label className="pivot-row">
                    <span>基準頂点</span>
                    <select
                      value={selectedPivotIndex(selectedBarrier)}
                      onChange={(event) => setSelectedVertexIndex(Number(event.target.value))}
                    >
                      {selectedBarrier.polygon.map((_, index) => (
                        <option key={index} value={index}>
                          頂点 {index + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {mode === "edit" && (
                  <div className="nudge-grid">
                    <span />
                    <button type="button" onClick={() => moveSelected(0, 0.5)} disabled={!canMoveSelection}>↑</button>
                    <span />
                    <button type="button" onClick={() => moveSelected(-0.5, 0)} disabled={!canMoveSelection}>←</button>
                    <button type="button" onClick={() => moveSelected(0, -0.5)} disabled={!canMoveSelection}>↓</button>
                    <button type="button" onClick={() => moveSelected(0.5, 0)} disabled={!canMoveSelection}>→</button>
                  </div>
                )}
                <div className="edit-button-row">
                  {rotationControls}
                  <button type="button" className="danger-button" onClick={deleteSelected} disabled={!canEditSelection}>削除</button>
                </div>
                <div className={mode === "move" ? "add-row player-add-row" : "add-row"}>
                  {addControls}
                </div>
                {routeControls}
                {shotControls}
              </div>
            )}
          </div>

          <details className="detail-settings">
            <summary>マップ・生成設定</summary>
            <div className="settings-grid">
              {basicConfigFields.map((field) => (
                <label className="input-row" key={field.key}>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={config[field.key]}
                    onChange={(event) => handleConfigNumberChange(field.key, event)}
                    onBlur={(event) => handleConfigNumberBlur(field.key, event, field.step, field.min, field.max)}
                  />
                </label>
              ))}
              {detailConfigFields.map((field) => (
                <label className="input-row" key={field.key}>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={config[field.key]}
                    onChange={(event) => handleConfigNumberChange(field.key, event)}
                    onBlur={(event) => handleConfigNumberBlur(field.key, event, field.step, field.min, field.max)}
                  />
                </label>
              ))}
            </div>

          </details>

          {error && <p className="error-message">{error}</p>}
          {!generated.accepted && (
            <p className="warning-message">
              採用スコア未達です。最良候補を表示しています。
            </p>
          )}

          <button className="secondary-button" type="button" onClick={handleDownload} disabled={isGenerating}>
            PNG保存
          </button>

          <div className="summary-panel">
            <p>{generated.accepted ? "採用条件を満たしています。" : `採用スコア ${config.minScore} に未達です。`}</p>
            <h2>生成結果</h2>
            <p>各指標は生成済みマップの特徴（0〜100）です。設定一致度とは異なります。基本3対3・左右からの射撃で評価します。</p>
            <p>採用までの試行: {generated.attempt}回</p>
            <p>バリケード数: {generated.barriers.length}個</p>
            <div className="shape-counts">
              {(Object.entries(counts) as [Barrier["shape"], number][]).map(([shape, count]) => (
                <span key={shape}>
                  {getShapeLabel(shape)} {count}
                </span>
              ))}
            </div>
          </div>
        </aside>

        <section
          ref={mapPanelRef}
          className={`map-panel${isEditing ? " editing-map-panel" : ""}`}
          aria-label="生成マッププレビュー"
        >
          <div className="map-toolbar">
            <div>
              <h2>{generated.name}</h2>
              <p>
                {generated.field.width}m x {generated.field.height}m / グリッド {generated.field.gridSize}m
              </p>
            </div>
            {!generated.accepted && <p className="toolbar-warning">採用スコア未達: 最良候補を表示中</p>}
            <div className="metric-list">
              {Object.entries(generated.evaluation.details).map(([label, value]) => (
                <span key={label}>
                  {label} {value}
                </span>
              ))}
            </div>
          </div>
          <div className="canvas-frame">
            {isGenerating && (
              <div className="generating-overlay" role="status" aria-live="polite">
                <div className="spinner" />
                <strong>生成中...</strong>
                <span>条件に合うマップを探しています</span>
              </div>
            )}
            <div className="field-viewport" style={fieldViewportStyle}>
              <canvas
                key={isEditing ? "edit" : "preview"}
                ref={canvasRef}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                onClick={handleCanvasClick}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={endPlayerDrag}
                onPointerCancel={endPlayerDrag}
                onLostPointerCapture={endPlayerDrag}
                className={mode === "move" && !placingTeam && !shotDraft
                  ? `player-move-canvas${drawingRoute ? " route-drawing-canvas" : ""}`
                  : isEditing ? "editable-canvas" : ""}
              />
            </div>
          </div>
        </section>
      </section>

      {isEditing && (
        <div className={`mobile-edit-bar${mode === "move" ? " mobile-move-controls" : ""}`}>
          {sceneControls}
          <div className="mobile-edit-status">
            <strong aria-live="polite">{selectionLabel}</strong>
            {selectedBarrier && (
              <select
                value={selectedPivotIndex(selectedBarrier)}
                onChange={(event) => setSelectedVertexIndex(Number(event.target.value))}
              >
                {selectedBarrier.polygon.map((_, index) => (
                  <option key={index} value={index}>
                    頂点 {index + 1}
                  </option>
                ))}
              </select>
            )}
          </div>
          {mode === "edit" && (
            <div className="mobile-edit-controls">
              <button type="button" onClick={() => moveSelected(-0.5, 0)} disabled={!canMoveSelection}>←</button>
              <button type="button" onClick={() => moveSelected(0, 0.5)} disabled={!canMoveSelection}>↑</button>
              <button type="button" onClick={() => moveSelected(0, -0.5)} disabled={!canMoveSelection}>↓</button>
              <button type="button" onClick={() => moveSelected(0.5, 0)} disabled={!canMoveSelection}>→</button>
              {rotationControls}
              <button type="button" className="danger-button" onClick={deleteSelected} disabled={!canEditSelection}>削除</button>
            </div>
          )}
          <div className="mobile-add-row">
            {addControls}
            {mode === "move" && (
              <button type="button" className="danger-button" onClick={deleteSelected} disabled={!canEditSelection}>削除</button>
            )}
          </div>
          {routeControls}
          {shotControls}
        </div>
      )}
    </main>
  );
}

function tuningText(field: ScoreTuningField, value: number): string {
  if (value <= 33) return field.low;
  if (value <= 66) return field.mid;
  return field.high;
}

function exportBarrier(barrier: Barrier, fieldWidth: number): ImportedBarrier {
  const size = exportBarrierSize(barrier.shape);
  const anchorIndex = normalizedAnchorIndex(barrier.shape, barrier.anchorIndex);
  const anchor = barrier.polygon[anchorIndex] ?? { x: barrier.x, y: barrier.y };
  return {
    id: barrier.id,
    shape: exportShape(barrier.shape),
    anchorIndex,
    x: worldXToScenarioX(anchor.x, fieldWidth),
    y: anchor.y * SCENARIO_SCALE,
    width: size.width,
    height: size.height,
    rotation: barrier.angle,
    obstacleHeight: 2.5,
  };
}

function importBarrier(barrier: ImportedBarrier, fieldWidth: number): Barrier | null {
  const shape = importShape(barrier.shape);
  if (!shape || !Number.isFinite(barrier.x) || !Number.isFinite(barrier.y) || !Number.isFinite(barrier.rotation)) return null;
  const anchorIndex = normalizedAnchorIndex(shape, barrier.anchorIndex);
  return createBarrierFromAnchor(
    shape,
    scenarioXToWorldX(barrier.x, fieldWidth),
    barrier.y / SCENARIO_SCALE,
    barrier.rotation,
    barrier.id,
    anchorIndex,
  );
}

function importPlayer(entry: unknown, field: GeneratedMap["field"]): MapPlayer | null {
  if (!entry || typeof entry !== "object") return null;
  const { id, team, x, y, angle, waypoints, inherited } = entry as Partial<MapPlayer>;
  if (team !== "ally" && team !== "enemy") return null;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
  return fitPlayerToField({
    id: typeof id === "string" && id ? id : crypto.randomUUID(),
    team,
    inherited: inherited === true ? true : undefined,
    x: scenarioXToWorldX(x, field.width),
    y: y / SCENARIO_SCALE,
    angle: typeof angle === "number" && Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : team === "ally" ? 90 : 270,
    waypoints: Array.isArray(waypoints) ? waypoints
      .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => fitPlayerPointToField({
        x: scenarioXToWorldX(point.x, field.width),
        y: point.y / SCENARIO_SCALE,
      }, field)) : undefined,
  }, field);
}

function resolveSceneStarts(scenes: Scene[]): Scene[] {
  const resolved: Scene[] = [];
  for (const scene of scenes) {
    const previous = resolved.at(-1);
    if (!previous) {
      resolved.push(scene);
      continue;
    }
    const overrides = new Map(scene.players.map((player) => [player.id, player]));
    const removed = new Set(scene.removedPlayerIds);
    const previousIds = new Set(previous.players.map((player) => player.id));
    const players = previous.players.filter((player) => !removed.has(player.id)).map((player) => {
      const endpoint = player.waypoints?.at(-1) ?? player;
      return {
        ...player,
        x: endpoint.x,
        y: endpoint.y,
        waypoints: overrides.get(player.id)?.waypoints,
        inherited: true,
      };
    });
    const newPlayers = scene.players.filter((player) => !player.inherited && !previousIds.has(player.id) && !removed.has(player.id));
    resolved.push({ ...scene, players: [...players, ...newPlayers] });
  }
  return resolved;
}

function exportScene(scene: Scene, fieldWidth: number) {
  return {
    removedPlayerIds: scene.removedPlayerIds,
    players: scene.players.map((player) => ({
      ...player,
      ...exportMapPoint(player, fieldWidth),
      waypoints: player.waypoints?.map((point) => exportMapPoint(point, fieldWidth)),
    })),
    shotLines: scene.shotLines.map(({ team, start, end }) => ({
      team,
      start: exportMapPoint(start, fieldWidth),
      end: exportMapPoint(end, fieldWidth),
    })),
  };
}

function importScene(scene: ImportedScene, field: GeneratedMap["field"]): Scene {
  const players = Array.isArray(scene?.players) ? scene.players.flatMap((entry) => {
    const player = importPlayer(entry, field);
    return player ? [player] : [];
  }) : [];
  const shotLines = Array.isArray(scene?.shotLines) ? scene.shotLines.flatMap((entry) => {
    const line = importShotLine(entry, field);
    return line ? [line] : [];
  }) : [];
  const removedPlayerIds = Array.isArray(scene?.removedPlayerIds)
    ? scene.removedPlayerIds.filter((id): id is string => typeof id === "string")
    : undefined;
  return { players, shotLines, removedPlayerIds };
}

function importShotLine(entry: unknown, field: GeneratedMap["field"]): ShotLine | null {
  if (!entry || typeof entry !== "object") return null;
  const { team, start, end } = entry as Partial<ShotLine>;
  if (team !== "ally" && team !== "enemy") return null;
  if (!start || !end || ![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;

  const points = [start, end].map((point) => ({
    x: clampNumber(scenarioXToWorldX(point.x, field.width), 0, field.width),
    y: clampNumber(point.y / SCENARIO_SCALE, 0, field.height),
  }));
  if (pointDistance(points[0], points[1]) <= 1e-6) return null;
  return { team, start: points[0], end: points[1] };
}

function exportShape(shape: ShapeType): string {
  if (shape === "triangle") return "small_triangle";
  return shape;
}

function importShape(shape: string): ShapeType | null {
  if (shape === "small_triangle" || shape === "triangle") return "triangle";
  if (shape === "large_triangle") return "large_triangle";
  if (shape === "diamond") return "diamond";
  if (shape === "trapezoid") return "trapezoid";
  return null;
}

function defaultAnchorIndex(shape: ShapeType): number {
  if (shape === "triangle" || shape === "large_triangle") return 1;
  return 0;
}

function normalizedAnchorIndex(shape: ShapeType, anchorIndex: number | undefined): number {
  const maxIndex = shape === "triangle" || shape === "large_triangle" ? 2 : 3;
  const index = typeof anchorIndex === "number" && Number.isInteger(anchorIndex) ? anchorIndex : defaultAnchorIndex(shape);
  return clampValue(index, 0, maxIndex);
}

function createBarrierFromAnchor(
  shape: ShapeType,
  anchorX: number,
  anchorY: number,
  angle: number,
  id: string | undefined,
  anchorIndex: number,
): Barrier {
  const draft = createBarrier(shape, 0, 0, angle, id, anchorIndex);
  const anchor = draft.polygon[anchorIndex] ?? draft.polygon[0] ?? { x: 0, y: 0 };
  return createBarrier(shape, anchorX - anchor.x, anchorY - anchor.y, angle, id, anchorIndex);
}

function worldXToScenarioX(x: number, fieldWidth: number): number {
  return (x - fieldWidth / 2) * SCENARIO_SCALE;
}

function exportMapPoint(point: Point, fieldWidth: number): Point {
  return { x: worldXToScenarioX(point.x, fieldWidth), y: point.y * SCENARIO_SCALE };
}

function scenarioXToWorldX(x: number, fieldWidth: number): number {
  return x / SCENARIO_SCALE + fieldWidth / 2;
}

function exportBarrierSize(shape: ShapeType): { width: number; height: number } {
  const smallHeight = 1.5588457268119895;
  const largeHeight = 3.117691453623979;
  if (shape === "large_triangle") return { width: 3.6, height: largeHeight };
  if (shape === "trapezoid") return { width: 3.6, height: smallHeight };
  if (shape === "diamond") return { width: 1.8, height: largeHeight };
  return { width: 1.8, height: smallHeight };
}

function drawMap(
  canvas: HTMLCanvasElement,
  generated: GeneratedMap,
  players: MapPlayer[],
  selectedBarrierId: string | null,
  selectedPlayerId: string | null,
  selectedVertexIndex: number,
  routes: PlayerRoute[],
  shotLines: ShotLine[],
  shotDraft: ShotDraft | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const metrics = getMetrics(generated.field.width, generated.field.height);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f4f7f8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawTitle(ctx, generated);
  drawField(ctx, generated, metrics);
  drawGrid(ctx, generated, metrics);
  drawStartBoxes(ctx, generated, metrics);
  drawStarts(ctx, generated, metrics);
  generated.barriers.forEach((barrier) => drawBarrier(
    ctx,
    barrier,
    metrics,
    barrier.id === selectedBarrierId,
    barrier.id === selectedBarrierId ? Math.min(selectedVertexIndex, barrier.polygon.length - 1) : null,
  ));
  for (const route of routes) {
    if (route.playerId !== selectedPlayerId) drawPlayerRoute(ctx, route, metrics, false);
  }
  const selectedRoute = routes.find((route) => route.playerId === selectedPlayerId);
  if (selectedRoute) drawPlayerRoute(ctx, selectedRoute, metrics, true);
  for (const { team, start, end } of shotLines) {
    drawMapLine(ctx, [start, end], metrics, shotColor(team), 8, 12);
  }
  players.forEach((player) => drawPlayer(ctx, player, metrics, player.id === selectedPlayerId));
  if (shotDraft?.start) {
    const start = worldToCanvas(shotDraft.start, metrics);
    ctx.beginPath();
    ctx.arc(start.x, start.y, 9, 0, 2 * Math.PI);
    ctx.fillStyle = shotColor(shotDraft.team);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function getPlayerRoutes(players: MapPlayer[], selectedId?: string, draftWaypoints: Point[] | null = null): PlayerRoute[] {
  return players.flatMap((player) => {
    const waypoints = player.id === selectedId && draftWaypoints !== null ? draftWaypoints : player.waypoints;
    return waypoints?.length ? [{ playerId: player.id, team: player.team, points: [player, ...waypoints] }] : [];
  });
}

function animateRoutes(routes: PlayerRoute[], endHoldMs: number, onFrame: (frame: PlaybackFrame) => void, onFinish: () => void): () => void {
  const tracks = routes.map(({ playerId, points }) => {
    const distances = [0];
    for (let index = 1; index < points.length; index += 1) {
      distances.push(distances[index - 1] + pointDistance(points[index - 1], points[index]));
    }
    return { playerId, points, distances, nextIndex: 1 };
  });
  const longestDistance = Math.max(0, ...tracks.map(({ distances }) => distances[distances.length - 1]));
  const duration = longestDistance / ROUTE_SPEED * 1000;
  let startTime: number | undefined;

  function tick(now: number) {
    startTime ??= now;
    const elapsed = now - startTime;
    if (elapsed >= duration + endHoldMs) {
      onFinish();
      return;
    }
    const distance = elapsed / 1000 * ROUTE_SPEED;
    const positions = new Map<string, Point>();
    for (const track of tracks) {
      const { playerId, points, distances } = track;
      while (track.nextIndex < points.length && distances[track.nextIndex] <= distance) track.nextIndex += 1;
      const nextIndex = track.nextIndex;
      if (nextIndex === points.length) {
        positions.set(playerId, points[points.length - 1]);
        continue;
      }
      const previous = points[nextIndex - 1];
      const next = points[nextIndex];
      const fraction = (distance - distances[nextIndex - 1]) / (distances[nextIndex] - distances[nextIndex - 1]);
      positions.set(playerId, { x: previous.x + (next.x - previous.x) * fraction, y: previous.y + (next.y - previous.y) * fraction });
    }
    onFrame({ positions, movementFinished: elapsed >= duration });
    frame = requestAnimationFrame(tick);
  }

  let frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

function getMetrics(fieldWidth: number, fieldHeight: number): Metrics {
  const availableWidth = CANVAS_WIDTH - PADDING * 2;
  const availableHeight = CANVAS_HEIGHT - PADDING * 2 - 72;
  const scale = Math.min(availableWidth / fieldWidth, availableHeight / fieldHeight);
  return {
    scale,
    offsetX: (CANVAS_WIDTH - fieldWidth * scale) / 2,
    offsetY: PADDING + 72,
    fieldHeight,
  };
}

function getFieldViewportStyle(field: GeneratedMap["field"]): CSSProperties {
  const { scale, offsetX, offsetY } = getMetrics(field.width, field.height);
  const width = field.width * scale;
  const height = field.height * scale;
  return {
    "--field-ratio": width / height,
    "--map-canvas-width": `${CANVAS_WIDTH / width * 100}%`,
    "--map-canvas-left": `${-offsetX / width * 100}%`,
    "--map-canvas-top": `${-offsetY / height * 100}%`,
  } as CSSProperties;
}

function worldToCanvas(point: Point, metrics: Metrics): Point {
  return {
    x: metrics.offsetX + point.x * metrics.scale,
    y: metrics.offsetY + (metrics.fieldHeight - point.y) * metrics.scale,
  };
}

function canvasToWorld(point: Point, metrics: Metrics): Point {
  return {
    x: (point.x - metrics.offsetX) / metrics.scale,
    y: metrics.fieldHeight - (point.y - metrics.offsetY) / metrics.scale,
  };
}

function rotateAround(point: Point, pivot: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return {
    x: pivot.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: pivot.y + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

function fitPlayerToField(player: MapPlayer, field: GeneratedMap["field"]): MapPlayer {
  return { ...player, ...fitPlayerPointToField(player, field) };
}

function fitPlayerPointToField(point: Point, field: GeneratedMap["field"]): Point {
  return {
    x: clampNumber(point.x, PLAYER_RADIUS, field.width - PLAYER_RADIUS),
    y: clampNumber(point.y, PLAYER_RADIUS, field.height - PLAYER_RADIUS),
  };
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nextPivotGridPoint(
  pivot: Point,
  dx: number,
  dy: number,
  field: GeneratedMap["field"],
): Point {
  const grid = field.gridSize;
  const onGridX = isOnGrid(pivot.x, grid);
  const onGridY = isOnGrid(pivot.y, grid);
  const nearestX = snapToGrid(pivot.x, grid);
  const nearestY = snapToGrid(pivot.y, grid);

  if (dx > 0) {
    return {
      x: clampValue(onGridX && onGridY ? pivot.x + grid : Math.ceil((pivot.x + 1e-9) / grid) * grid, 0, field.width),
      y: clampValue(nearestY, 0, field.height),
    };
  }
  if (dx < 0) {
    return {
      x: clampValue(onGridX && onGridY ? pivot.x - grid : Math.floor((pivot.x - 1e-9) / grid) * grid, 0, field.width),
      y: clampValue(nearestY, 0, field.height),
    };
  }
  if (dy > 0) {
    return {
      x: clampValue(nearestX, 0, field.width),
      y: clampValue(onGridX && onGridY ? pivot.y + grid : Math.ceil((pivot.y + 1e-9) / grid) * grid, 0, field.height),
    };
  }
  return {
    x: clampValue(nearestX, 0, field.width),
    y: clampValue(onGridX && onGridY ? pivot.y - grid : Math.floor((pivot.y - 1e-9) / grid) * grid, 0, field.height),
  };
}

function snapToGrid(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function isOnGrid(value: number, grid: number): boolean {
  return Math.abs(value - snapToGrid(value, grid)) < 1e-6;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function formatStepValue(value: number, step: number): string {
  const decimals = Math.max(0, String(step).split(".")[1]?.length ?? 0);
  return value.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function fitMovedBarrierToPlacementBounds(
  barrier: Barrier,
  field: GeneratedMap["field"],
): Barrier {
  const bounds = polygonBounds(barrier.polygon);
  const x = barrier.x + clampValue(0, -bounds.minX, field.width - bounds.maxX);
  const y = barrier.y + clampValue(0, -bounds.minY, field.height - bounds.maxY);
  return x === barrier.x && y === barrier.y ? barrier : rebuildBarrier(barrier, x, y, barrier.angle);
}

function polygonBounds(polygon: Point[]) {
  return polygon.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function pointInPolygonLocal(point: Point, polygon: Point[]): boolean {
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

function drawTitle(ctx: CanvasRenderingContext2D, generated: GeneratedMap) {
  ctx.fillStyle = "#162631";
  ctx.font = "700 34px 'Yu Gothic', Meiryo, Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${generated.name} | 設定一致度: ${generated.evaluation.score}/100`, CANVAS_WIDTH / 2, 58);

  ctx.font = "500 18px 'Yu Gothic', Meiryo, Inter, system-ui, sans-serif";
  ctx.fillStyle = "#526775";
  const details = Object.entries(generated.evaluation.details).map(([label, value]) => `${label} ${value}`).join("   ");
  ctx.fillText(details, CANVAS_WIDTH / 2, 94);
}

function drawField(ctx: CanvasRenderingContext2D, generated: GeneratedMap, metrics: Metrics) {
  const topLeft = worldToCanvas({ x: 0, y: generated.field.height }, metrics);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(topLeft.x, topLeft.y, generated.field.width * metrics.scale, generated.field.height * metrics.scale);
  ctx.strokeStyle = "#0f171d";
  ctx.lineWidth = 7;
  ctx.strokeRect(topLeft.x, topLeft.y, generated.field.width * metrics.scale, generated.field.height * metrics.scale);
}

function drawGrid(ctx: CanvasRenderingContext2D, generated: GeneratedMap, metrics: Metrics) {
  for (let x = 0; x <= generated.field.width + 1e-9; x += generated.field.gridSize) {
    const a = worldToCanvas({ x, y: 0 }, metrics);
    const b = worldToCanvas({ x, y: generated.field.height }, metrics);
    const major = Math.abs(x - Math.round(x)) < 1e-9;
    ctx.strokeStyle = major ? "#6f8391" : "#bcc8d1";
    ctx.lineWidth = major ? 1.8 : 1.1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let y = 0; y <= generated.field.height + 1e-9; y += generated.field.gridSize) {
    const a = worldToCanvas({ x: 0, y }, metrics);
    const b = worldToCanvas({ x: generated.field.width, y }, metrics);
    const major = Math.abs(y - Math.round(y)) < 1e-9;
    ctx.strokeStyle = major ? "#6f8391" : "#bcc8d1";
    ctx.lineWidth = major ? 1.8 : 1.1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  drawCenterLines(ctx, generated, metrics);
}

function drawCenterLines(ctx: CanvasRenderingContext2D, generated: GeneratedMap, metrics: Metrics) {
  ctx.strokeStyle = "#324b59";
  ctx.lineWidth = 3.8;

  const verticalA = worldToCanvas({ x: generated.field.width / 2, y: 0 }, metrics);
  const verticalB = worldToCanvas({ x: generated.field.width / 2, y: generated.field.height }, metrics);
  ctx.beginPath();
  ctx.moveTo(verticalA.x, verticalA.y);
  ctx.lineTo(verticalB.x, verticalB.y);
  ctx.stroke();

  const horizontalA = worldToCanvas({ x: 0, y: generated.field.height / 2 }, metrics);
  const horizontalB = worldToCanvas({ x: generated.field.width, y: generated.field.height / 2 }, metrics);
  ctx.beginPath();
  ctx.moveTo(horizontalA.x, horizontalA.y);
  ctx.lineTo(horizontalB.x, horizontalB.y);
  ctx.stroke();
}

function drawStartBoxes(ctx: CanvasRenderingContext2D, generated: GeneratedMap, metrics: Metrics) {
  const { width: boxWidth, height: boxHeight } = startBoxSizeForField(generated.field.width, generated.field.height);
  const boxes = [
    { x: clampNumber(generated.field.bottomStart.x - boxWidth / 2, 0, generated.field.width - boxWidth), y: 0 },
    { x: clampNumber(generated.field.topStart.x - boxWidth / 2, 0, generated.field.width - boxWidth), y: generated.field.height - boxHeight },
  ];

  ctx.strokeStyle = "#324b59";
  ctx.lineWidth = 3.8;
  boxes.forEach((box) => {
    const topLeft = worldToCanvas({ x: box.x, y: box.y + boxHeight }, metrics);
    ctx.strokeRect(topLeft.x, topLeft.y, boxWidth * metrics.scale, boxHeight * metrics.scale);
  });
}

function drawStarts(ctx: CanvasRenderingContext2D, generated: GeneratedMap, metrics: Metrics) {
  [
    { x: generated.field.bottomStart.x, y: 0 },
    { x: generated.field.topStart.x, y: generated.field.height },
  ].forEach((point) => {
    const canvasPoint = worldToCanvas(point as Point, metrics);
    ctx.beginPath();
    ctx.arc(canvasPoint.x, canvasPoint.y, 0.16 * metrics.scale, 0, Math.PI * 2);
    ctx.fillStyle = "#d93a35";
    ctx.fill();
  });
}

function drawPlayerRoute(ctx: CanvasRenderingContext2D, route: PlayerRoute, metrics: Metrics, selected: boolean) {
  const { points, team } = route;
  drawMapLine(ctx, points, metrics, team === "ally" ? "#24313b" : "#d00000", selected ? 6 : 4, selected ? 10 : 7);
}

function shotColor(team: Team): string {
  return team === "ally" ? "#008037" : "#e02620";
}

function drawMapLine(ctx: CanvasRenderingContext2D, points: Point[], metrics: Metrics, color: string, width: number, outlineWidth: number) {
  ctx.save();
  ctx.beginPath();
  const start = worldToCanvas(points[0], metrics);
  ctx.moveTo(start.x, start.y);
  for (const point of points.slice(1)) {
    const position = worldToCanvas(point, metrics);
    ctx.lineTo(position.x, position.y);
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = outlineWidth;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(ctx: CanvasRenderingContext2D, player: MapPlayer, metrics: Metrics, selected: boolean) {
  const center = worldToCanvas(player, metrics);
  ctx.beginPath();
  ctx.arc(center.x, center.y, PLAYER_RADIUS * metrics.scale, 0, 2 * Math.PI);
  ctx.fillStyle = player.team === "ally" ? "#008037" : "#d00000";
  ctx.fill();
  ctx.strokeStyle = selected ? "#f5a400" : "#ffffff";
  ctx.lineWidth = selected ? 4 : 2;
  ctx.stroke();
}

function drawBarrier(
  ctx: CanvasRenderingContext2D,
  barrier: Barrier,
  metrics: Metrics,
  selected = false,
  pivotIndex: number | null = null,
) {
  ctx.beginPath();
  barrier.polygon.forEach((point, index) => {
    const canvasPoint = worldToCanvas(point, metrics);
    if (index === 0) ctx.moveTo(canvasPoint.x, canvasPoint.y);
    else ctx.lineTo(canvasPoint.x, canvasPoint.y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(47, 115, 216, 0.9)";
  ctx.fill();
  ctx.strokeStyle = selected ? "#f5a400" : "#123d80";
  ctx.lineWidth = selected ? 8 : 4;
  ctx.stroke();

  if (selected) {
    const center = worldToCanvas({ x: barrier.x, y: barrier.y }, metrics);
    ctx.beginPath();
    ctx.arc(center.x, center.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = "#f5a400";
    ctx.fill();
    if (pivotIndex !== null) {
      const pivot = worldToCanvas(barrier.polygon[pivotIndex], metrics);
      ctx.beginPath();
      ctx.arc(pivot.x, pivot.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#f5a400";
      ctx.lineWidth = 5;
      ctx.stroke();
    }
  }

  barrier.seams.forEach(([a, b]) => {
    const ca = worldToCanvas(a, metrics);
    const cb = worldToCanvas(b, metrics);
    ctx.strokeStyle = "#4cc9df";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(ca.x, ca.y);
    ctx.lineTo(cb.x, cb.y);
    ctx.stroke();
  });
}
