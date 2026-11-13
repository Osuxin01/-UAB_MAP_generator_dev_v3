import { generateMap, type GeneratorConfig } from "./mapGenerator";

export type GenerationMessage =
  | { type: "progress"; attempt: number }
  | { type: "success"; map: ReturnType<typeof generateMap> }
  | { type: "error"; error: string };

self.onmessage = (event: MessageEvent<GeneratorConfig>) => {
  try {
    let lastUpdate = -Infinity;
    const map = generateMap(event.data, 1, (attempt) => {
      const now = performance.now();
      if (now - lastUpdate < 100 && attempt !== event.data.maxAttempts) return;
      lastUpdate = now;
      self.postMessage({ type: "progress", attempt } satisfies GenerationMessage);
    });
    self.postMessage({ type: "success", map } satisfies GenerationMessage);
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "生成に失敗しました。",
    } satisfies GenerationMessage);
  }
};
