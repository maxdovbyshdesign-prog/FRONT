# frontier PLANET - GAME DESIGN DOCUMENT (GDD)

## 1. Executive Summary & Core Pillars
- **Title**: Frontier Planet
- **Genre**: Voxel Sci-Fi Extraction Survival RPG
- **Theme**: Dirty corporate industrial. Red silt dunes, graphitic structures, glowing amber/cyan anomalies, rusted machinery, and military tactical equipment.
- **Scale**: Standalone Desktop App (Windows/Linux)
- **Pillars**:
  - **Tactical Hostility**: S.T.A.L.K.E.R. + Tarkov atmosphere. Survival relies of route planning, inventory capacity caps, and hazard shields.
  - **Durable Voxel Grid**: Everything can be mined, constructed, or modified. Base fortresses guard salvaged goods.
  - **Contract Salvage Loops**: Drop down from orbit, raid coordinate ruins, secure humming cores, and extract safely to deposit goods for Sol-credits.

---

## 2. World Concept, Aesthetic & Concept Art Prompts
### Aesthetic Style
Low-poly voxel textures styled with custom flat-shading. Colors lean heavily on extreme high-contrast tones:
- Arid dunes composed of crimson rust silt.
- Canyons and subterranean geodes carved out of dark obsidian-like black glass.
- Relic ruins built from textured weathered ancient stone carrying cyan circuit marks.
- Industrial safehouses fabricated from gray graphite panels and orange warning stripes.

### Concept Art Prompts
1. *Voxel sci-fi mercenary outpost on a red desert planet, framed by a double solar eclipse and neon orange storage silos.*
2. *Ancient alien ruin half-buried in a black glass desert, with columns leaking high-energy cyan electrical arcs.*
3. *Artifact containment room in an underground research bunker, featuring lead-shielded cabinets and cooling vapors.*
4. *Modular armored mercenary squad wearing weathered graphite exo-suits and tactical visors, holding caseless kinetic carbines.*
5. *Acid swamp biome with glowing lime-green alien plants, deep jade waters, and toxic mist rising from voxel peat beds.*
6. *Two private military factions (Apex Mining vs. Sol-Scavengers) firing tracer rounds over a rusted mining excavator derrick.*
7. *Player survival base interior featuring custom weapon modifications racks, power conduits, and a glowing artifact lab container.*
8. *Catalog chart of strange sci-fi artifacts: crystalline gears, orbiting gravity spheres, radioactive isotopes, and pulsing liquid nodes.*

---

## 3. Core Gameplay Loop
```
[Orbital Hub: Prep / Modify Gear] -> [Deploy Descent Drop] -> [Navigate Hostile World] 
       ^                                                                   |
       |                                                                   v
[Buy upgrades / Sell Loot] <- [Escape Zone extraction] <- [Loot Ruins for Artifacts/Ores]
```

---

## 4. Systems Framework

### A. Voxel Blocks Matrix
- **Red Dust**: Easy to break, holds ground dunes.
- **Black Glass**: Hard glass. Shatters dramatically. Highly valuable obsidian.
- **Metal Floor**: Plated platform pieces used for quick ramp setups and sturdy defense structures.
- **Ancient Stone**: Weathered, slow to mine masonry that blocks heavy physical damage.
- **Glowing Artifact**: Elite field crystals causing proximity radiation hazards. Refined inside labs.

### B. Extraction mechanics
- Standard raid durations range from 15 to 30 minutes.
- Landing pod is placed at spawn coordinate `(0, 0)` which serves as the Extraction Zone.
- Dying in the wilderness drops all inventory bags. Returning safely secures credit paydays.

### C. Weapons & Modular Slots
- Firearms use kinetic caseless munitions or plasma coils.
- Attachments modify recoil, sound suppression, optics zoom, and ammunition loadcapacities.
