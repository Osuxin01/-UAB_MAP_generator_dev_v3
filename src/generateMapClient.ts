import type { GeneratedMap, GeneratorConfig } from "./mapGenerator";
import type { GenerationMessage } from "./generateMap.worker";

export function generateMapInWorker(config: GeneratorConfig, onProgress?: (attempt: number) => void): Promise<GeneratedMap> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./generateMap.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<GenerationMessage>) => {
      if (data.type === "progress") {
        onProgress?.(data.attempt);
        return;
      }
      worker.terminate();
      if (data.type === "success") resolve(data.map);
      else reject(new Error(data.error));
    };
    worker.onerror = () => { worker.terminate(); reject(new Error("生成処理を実行できませんでした。再度お試しください。")); };
    worker.postMessage(config);
  });
}
