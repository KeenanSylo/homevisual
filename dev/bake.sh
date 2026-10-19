#!/bin/sh
# Full light bake for one apartment + layout:  sh dev/bake.sh <apartment-id> [layout | @items.json] [hour] [samples]
# (needs the dev server on :5190 and Blender in /Applications). Everything is staged in dev/bake-work and only
# copied into public/ at the very end, so the app never sees a half-finished bake.
set -e
cd "$(dirname "$0")/.."
ID=${1:-apartment-1}; LAYOUT=${2:-mine}; HOUR=${3:-15}; SAMPLES=${4:-1024}
B=/Applications/Blender.app/Contents/MacOS/Blender
W=dev/bake-work; OUT=public/apartments/$ID/bake
node dev/bake.mjs "$ID" "$LAYOUT" "$HOUR"
$B -b --factory-startup -P dev/bake.py -- "$ID" "$SAMPLES" 2048 2>&1 | grep --line-buffered -E "sky irr|baking|saved|white bal|Error|Traceback"
$B -b --factory-startup -P dev/denoise.py -- "$PWD/$W/$ID.lightmap.exr" 2>&1 | grep --line-buffered -E "denoised|Error|Traceback"
# one folder per hour (bake/h09, bake/h15 ...), listed in bake/index.json
D="$OUT/h$(printf %02d "$HOUR")"
mkdir -p "$D"
cp "$W/$ID.lightmap.exr" "$D/lightmap.exr"; cp "$W/$ID.bake.bin" "$D/bake.bin"; cp "$W/$ID.bake.json" "$D/bake.json"
node -e 'const fs=require("fs"),f=process.argv[1],h=+process.argv[2];let j={hours:[]};try{j=JSON.parse(fs.readFileSync(f))}catch{};j.hours=[...new Set([...j.hours,h])].sort((a,b)=>a-b);fs.writeFileSync(f,JSON.stringify(j)+"\n")' "$OUT/index.json" "$HOUR"
echo "published $D"
