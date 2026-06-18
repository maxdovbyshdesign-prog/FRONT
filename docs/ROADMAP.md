# FRONTIER PLANET - FEATURE ROADMAP

This roadmap charts the planned feature integration iterations starting from the completed playable first iteration (Vertical Slice).

---

## Completed Phase: Iteration 1 (Vertical Slice)
- [x] Integrate `noa-engine` and Babylon.js.
- [x] Render Red Wasteland dunes, outpost nodes, and an ancient monument.
- [x] Configure 1st person movement, pointerlocks, excavations and placements.
- [x] Populate 5 key blocks (Red Dust, Black Glass, Metal Floor, Ancient Stone, Glowing Core Voxel).
- [x] Implement Tactical HUD overlay showing biome, coordinate tracking, active objectives, and alerts.
- [x] Validate salvage recovery rules: Reach monument ruin, recover the Glowing Core block, run back to spawn landing site extraction, and trigger complete.
- [x] Design Electron wrapping packaging scripts producing fully working local ZIP archives.

---

## 🎒 Iteration 2: Inventory & Resources Mechanics
- **The Loot**: Render breakable material cubes that drop floating items on the ground.
- **The Pack**: Design the 24-slot React quick-draw bag overlay. Items carry weight which slows player walking speeds.
- **The Salvage**: Refined metal scrap, quartz plates, fuel canisters, and sulfur.

---

## 🔫 Iteration 3: Combat Prototypes & Sentry Drones
- **The Carbine**: Add a 3D hands/gun mesh. Implement raycast shooting. Firing emits kinetic tracers and shell rings.
- **The Threat**: Render basic hovering voxel sentinel drones. They patrol around ruin coordinates and fire red plasma lasers at trespassers.
- **The Vitals**: Activate damage gauges and shield regeneration filters on the tactical HUD overlay.

---

## 📋 Iteration 4: Contract Boards & PMC Alliances
- **The hub safehouse**: Establish a passive shelter outpost containing static Trader NPCs.
- **The Contracts**: Feed randomized salvage missions (e.g., "Infiltrate sector alpha", "Secure 6 obsidian plates").
- **The Factions**: Gaining trust with Apex Mining corp triggers hostilities with smuggling groups, modifying shop prices.

---

## 🏭 Iteration 5: Base Power Grids & Replicators
- **The Assemblies**: Place specialized structure blocks: Combustion Generator, Alloy Furnace, and Replicator Table.
- **The Network**: Connect machines with a wire tool block to route power units.
- **The Refining**: Cook red dust silt and iron plates together to breed high-grade armor blocks.

---

## 🛒 Iteration 6: Economy Engines & Black Markets
- **The Traders**: Open inventory screens to buy high-performance firearm optics, silencers, and safety hazard gear.
- **The Anomaly Lab**: Study glowing cores. Keep them housed in custom shielded containers to stave off radioactive radiation damage while they generate periodic credits.
