/** Master rows used by ScenarioAssetInfo.EnqueueAssetBundles (7.1.0). */
export interface VoiceCharacter2d {
  id: number;
  characterId?: number;
  characterType: string;
  assetName?: string;
  unit?: string;
}
export interface VoiceGameCharacter { id: number; unit: string }

// The master data calls them "sub_game_character"; "sub_character" is kept for older dumps.
const SUB_CHARACTER_TYPES = new Set(["sub_game_character", "sub_character"]);
const SAFE_NAME = /^[\w.-]+$/;

/**
 * The shared pack a character brings along, and whether it is a game
 * character's (those also ship a tutorial copy). `null` for a character
 * without one: mobs, the unit members (their lines are filed with the
 * scenario) and rows the master data does not name.
 */
function sharedPack(c: VoiceCharacter2d, gameCharacters: readonly VoiceGameCharacter[]): { name: string; game: boolean } | null {
  if (!c.assetName) return null;
  // A sub character's characterId counts sub characters: it is not a
  // gameCharacters id, even where the numbers coincide.
  if (SUB_CHARACTER_TYPES.has(c.characterType)) return SAFE_NAME.test(c.assetName) ? { name: c.assetName, game: false } : null;
  if (c.characterType !== "game_character" || !c.unit) return null;
  const game = gameCharacters.find((g) => g.id === c.characterId);
  if (game?.unit !== "piapro") return null;
  const name = `${c.assetName}_${c.unit}`;
  return SAFE_NAME.test(name) ? { name, game: true } : null;
}

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
    const c = characters.find((c) => c.id === appearance.Character2dId);
    const pack = c && sharedPack(c, gameCharacters);
    if (!pack) continue;
    if (pack.game) paths.add(`tutorial/sound/scenario/part_voice/${pack.name}/${voiceId}.mp3`);
    paths.add(`startapp/sound/scenario/voice/part_voice_${pack.name}/${voiceId}.mp3`);
  }
  return [...paths];
}
