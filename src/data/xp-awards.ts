// B41 vanilla `Recipe.OnGiveXP.<name>` -> B42 `xpAward = Skill:amount`.
// Generated from reference/b41/lua/server/recipecode.lua by parsing the first
// `player:getXp():AddXP(Perks.<Skill>, <N>)` in each function body. `null` means
// the B41 function awarded no XP (e.g. Recipe.OnGiveXP.None) -> emit no xpAward.
export const VANILLA_XP_AWARDS: Readonly<Record<string, string | null>> = {
  "Blacksmith10": "Blacksmith:10",
  "Blacksmith15": "Blacksmith:15",
  "Blacksmith20": "Blacksmith:20",
  "Blacksmith25": "Blacksmith:25",
  "Cooking10": "Cooking:10",
  "Cooking3": "Cooking:3",
  "Default": "Woodwork:1",
  "DismantleElectronics": "Electricity:2",
  "DismantleRadio": "Electricity:2",
  "DynamicMovable": null,
  "MetalWelding10": "MetalWelding:10",
  "MetalWelding15": "MetalWelding:15",
  "MetalWelding20": "MetalWelding:20",
  "MetalWelding25": "MetalWelding:25",
  "None": null,
  "RadioCraft": null,
  "SawLogs": "Woodwork:3",
  "WoodWork5": "Woodwork:5",
};
