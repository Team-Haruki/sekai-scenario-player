// The episode's readable lines (talk + telop captions) in timeline order, for
// hosts that show a talk log / transcript next to the stage. `index` is the
// snippet index to hand to player.jumpTo().

import { Action, ScenarioSceneData, SpecialEffectType } from "./types";

export interface ScriptLine {
  index: number;
  kind: "talk" | "telop";
  name: string; // WindowDisplayName ("" for narration / telops)
  body: string;
  character2dId?: number; // first talking character
  voiceId?: string;
}

export function scriptLines(scn: ScenarioSceneData): ScriptLine[] {
  const out: ScriptLine[] = [];
  scn.Snippets.forEach((s, index) => {
    if (s.Action === Action.Talk) {
      const t = scn.TalkData[s.ReferenceIndex];
      if (!t) return;
      out.push({
        index,
        kind: "talk",
        name: t.WindowDisplayName,
        body: t.Body,
        character2dId: t.TalkCharacters?.[0]?.Character2dId,
        voiceId: t.Voices?.[0]?.VoiceId,
      });
    } else if (s.Action === Action.SpecialEffect) {
      const e = scn.SpecialEffectData[s.ReferenceIndex];
      if (e?.EffectType === SpecialEffectType.Telop && e.StringVal)
        out.push({ index, kind: "telop", name: "", body: e.StringVal });
    }
  });
  return out;
}
