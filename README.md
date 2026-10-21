# homevisual

Put in your floor plan and walk through it in 3D: real sunlight for any date and time, Blender-baked
lighting, and a furniture planner.

```bash
pnpm install
pnpm dev        # http://localhost:5190
pnpm build      # static site in dist/
```

## Views
- **Overview**: orbit around the model with the walls cut away.
- **Plan**: a top-down drawing, optionally with the original floor plan laid on the floor.
- **Walk**: first person. Drag to look, click the floor to walk there, WASD / arrows to move
  (Shift runs), click a door to open it. The **Start walking** panel opens this view directly.
- **Phones and tablets**: use portrait normally. A small translucent thumb pad moves you; drag the
  scene to look around or tap the floor to walk there. Start walking always opens Your eyes, even
  after using Behind you. Mobile rendering uses smaller shadows,
  fewer AO samples, no bloom, and an adaptive 1.5–2 pixel ratio (limited by screen density).
  Portrait walking renders directly with a vertical field of view capped at 95°, avoiding wide-view upscaling. Furniture thumbnails render when
  Furnish is opened, and hidden tabs pause scene updates.

## Furniture
- Add items from the catalogue, drag to move (snaps to 1 cm and to walls), **R** rotates, arrows nudge,
  Del deletes, Cmd+D duplicates. Things standing on a piece move with it.
- The orange labels show the distance from each side to the nearest wall or object.
- Layouts save in the browser. Export / Import keeps them as JSON.

## Light
- The sun follows the real date and time. Lamps switch on after sunset.
- **Baked light**: Blender Cycles bakes the room's bounce light for a few times of day
  (`public/apartments/<id>/bake/hNN/`). Furniture is lit by light probes, so it can move freely.
  Re-bake needs `pnpm dev` and Blender in `/Applications` (`sh dev/bake.sh <id> <layout> <hour>`).
- **Photoreal**: in-browser path tracing for still shots.

## Apartments
Each apartment is `public/apartments/<id>/spec.json` plus its plan image, listed in
`public/apartments/index.json`. `editor.html` traces a new one from a floor plan image.
