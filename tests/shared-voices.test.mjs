import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { assetHandler } from '../server/asset-tree';
import { sharedVoicePaths } from '../src/scenario/shared-voices';

test('scenario voices use only the appearing characters shared packs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-voice-'));
  const put = (p, data) => { const f = path.join(root,p); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,data); };
  put('master/character2ds.json', JSON.stringify([{id:306,characterId:22,characterType:'game_character',assetName:'v2_22rin',unit:'idol'}]));
  put('master/gameCharacters.json', JSON.stringify([{id:22,unit:'piapro'}]));
  put('jobs/story/scenario.json', JSON.stringify({AppearCharacters:[{Character2dId:306}]}));
  put('startapp/sound/scenario/voice/part_voice_v2_22rin_idol/partvoice_96_022_band.mp3','shared');
  put('startapp/sound/scenario/voice/part_voice_v2_22rin_idol/partvoice_09_022.mp3','shared');
  put('ondemand/sound/card_scenario/voice/story/partvoice_09_022.mp3','episode');
  put('startapp/sound/scenario/voice/part_voice_v2_25meiko_idol/partvoice_unrelated.mp3','unrelated');
  const handler = assetHandler({root,master:path.join(root,'master'),scenarioRoot:path.join(root,'jobs')});
  const server = createServer((req,res) => handler(req,res,()=>{res.statusCode=404;res.end();}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(base+'/sound/voice/story/partvoice_96_022_band.mp3')).text(),'shared');
    assert.equal(await (await fetch(base+'/sound/voice/story/partvoice_09_022.mp3')).text(),'episode');
    assert.equal((await fetch(base+'/sound/voice/story/partvoice_unrelated.mp3')).status,404);
    assert.equal((await fetch(base+'/sound/voice/story/fullvoice_missing.mp3')).status,404);
  } finally {server.closeAllConnections(); await new Promise(r=>server.close(()=>r())); fs.rmSync(root,{recursive:true});}
});

test('shared packs exclude mobs and non-piapro game characters; sub-characters use assetName', () => {
  const characters = [
    {id:1,characterId:22,characterType:'game_character',assetName:'v2_22rin',unit:'idol'},
    {id:2,characterId:1,characterType:'game_character',assetName:'ichika',unit:'light_sound'},
    {id:3,characterType:'sub_character',assetName:'sub01'},
    {id:4,characterType:'mob',assetName:'mob01'},
  ];
  const scenario = { AppearCharacters: [1,2,3,4,1].map(Character2dId => ({Character2dId})) };
  const paths = sharedVoicePaths(scenario, 'partvoice_band', characters, [{id:22,unit:'piapro'},{id:1,unit:'light_sound'}]);
  assert.deepEqual(paths, [
    'tutorial/sound/scenario/part_voice/v2_22rin_idol/partvoice_band.mp3',
    'startapp/sound/scenario/voice/part_voice_v2_22rin_idol/partvoice_band.mp3',
    'startapp/sound/scenario/voice/part_voice_sub01/partvoice_band.mp3',
  ]);
  assert.deepEqual(sharedVoicePaths(scenario, '../partvoice_bad', characters, []), []);
});

test('missing or unsafe character metadata cannot invent shared-pack paths', () => {
  assert.deepEqual(sharedVoicePaths({}, 'partvoice_1', [], []), []);
  const characters = [
    {id: 1, characterType: 'game_character', characterId: 999, assetName: 'rin', unit: 'idol'},
    {id: 2, characterType: 'sub_character', assetName: '../other'},
  ];
  assert.deepEqual(sharedVoicePaths({ AppearCharacters: [1,2,3].map(Character2dId => ({Character2dId})) }, 'partvoice_1', characters, []), []);
});

test('sub characters are found by their own type, whatever their characterId collides with', () => {
  // The master data's rows: a sub character's characterId counts sub characters,
  // so 1 and 22 here are not Ichika and Rin.
  const characters = [
    {id: 900, characterType: 'sub_game_character', characterId: 1, unit: 'none', assetName: 'v2_sub_sanrio_kitty'},
    {id: 901, characterType: 'sub_game_character', characterId: 22, unit: 'none', assetName: 'v2_sub_sanrio_pompompurin'},
    {id: 902, characterType: 'sub_game_character', characterId: 204, unit: 'none'},
  ];
  const games = [{id: 1, unit: 'light_sound'}, {id: 22, unit: 'piapro'}];
  const scenario = { AppearCharacters: [900, 901, 902].map(Character2dId => ({Character2dId})) };
  assert.deepEqual(sharedVoicePaths(scenario, 'partvoice_01_900', characters, games), [
    'startapp/sound/scenario/voice/part_voice_v2_sub_sanrio_kitty/partvoice_01_900.mp3',
    'startapp/sound/scenario/voice/part_voice_v2_sub_sanrio_pompompurin/partvoice_01_900.mp3',
  ]);
});

test('a virtual singer row without an asset name or a unit names no pack', () => {
  const characters = [
    {id: 1, characterType: 'game_character', characterId: 21, unit: 'piapro'},
    {id: 2, characterType: 'game_character', characterId: 21, assetName: '21miku'},
    {id: 3, characterType: 'game_character', characterId: 21, assetName: '21miku', unit: 'street'},
  ];
  const scenario = { AppearCharacters: [1, 2, 3].map(Character2dId => ({Character2dId})) };
  assert.deepEqual(sharedVoicePaths(scenario, 'partvoice_1', characters, [{id: 21, unit: 'piapro'}]), [
    'tutorial/sound/scenario/part_voice/21miku_street/partvoice_1.mp3',
    'startapp/sound/scenario/voice/part_voice_21miku_street/partvoice_1.mp3',
  ]);
});

test('a scenario file that cannot be read is a missing voice, not a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-voice-'));
  const put = (p, data) => { const f = path.join(root,p); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,data); };
  put('jobs/story/scenario.json', '{ not json');
  const handler = assetHandler({root, master: path.join(root,'master'), scenarioRoot: path.join(root,'jobs')});
  const server = createServer((req,res) => handler(req,res,()=>{res.statusCode=404;res.end();}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/sound/voice/story/partvoice_1.mp3`)).status, 404);
  } finally {server.closeAllConnections(); await new Promise(r=>server.close(()=>r())); fs.rmSync(root,{recursive:true});}
});
