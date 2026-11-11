/** Master rows used by ScenarioAssetInfo.EnqueueAssetBundles (7.1.0). */
export interface VoiceCharacter2d {
  id: number;
  characterId?: number;
  characterType: string;
  assetName: string;
  unit?: string;
}
export interface VoiceGameCharacter { id: number; unit: string }

/** Shared packs belong to appearing characters, not to the cue's suffix or speaker ID. */
export function sharedVoicePaths(
  scenario: { AppearCharacters?: { Character2dId: number }[] },
  voiceId: string,
  characters: readonly VoiceCharacter2d[],
  gameCharacters: readonly VoiceGameCharacter[],
): string[] {
  if (!/^partvoice_[\w.-]+$/.test(voiceId)) return [];
  const paths = new Set<string>();
  for (const appearance of scenario.AppearCharacters ?? []) {
    const c = characters.find(c => c.id === appearance.Character2dId);
    if (!c || c.characterType === 'mob') continue;
    const game = gameCharacters.find(g => g.id === c.characterId);
    if (game && game.unit !== 'piapro') continue;
    if (!game && c.characterType !== 'sub_character') continue;
    const name = game ? `${c.assetName}_${c.unit}` : c.assetName;
    if (!/^[\w.-]+$/.test(name)) continue;
    if (game) paths.add(`tutorial/sound/scenario/part_voice/${name}/${voiceId}.mp3`);
    paths.add(`startapp/sound/scenario/voice/part_voice_${name}/${voiceId}.mp3`);
  }
  return [...paths];
}
