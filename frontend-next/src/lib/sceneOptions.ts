import { fleetApi } from "@navfleet/fleet-core";

/**
 * The 默认场景 dropdown the vehicle and formation editors share: a "none" entry, then every scene
 * by name. The scene list only fills a dropdown, so a failure to load it yields just the "none"
 * entry rather than failing the page that asked.
 */
export const loadDefaultSceneOptions = async (): Promise<
  { value: string; label: string }[]
> => {
  const scenes: { sceneId: string; sceneName?: string }[] = await fleetApi
    .getScenes()
    .then((payload) => payload.items ?? [])
    .catch(() => []);
  return [
    { value: "", label: "（不设默认场景）" },
    ...scenes.map((scene) => ({
      value: scene.sceneId,
      label: scene.sceneName || scene.sceneId,
    })),
  ];
};
