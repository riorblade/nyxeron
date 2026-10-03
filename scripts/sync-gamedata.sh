#!/usr/bin/env sh
# The api settles the city with the game's own numbers: services/api/gamedata is a copy of these core data files
# (embedded in the Go binary, which is built without the JS workspace). Run after editing any of them;
# services/api's TestGameDataIsTheGamesData fails until you do.
set -e
cd "$(dirname "$0")/.."
for f in tokens levels city strategy payments; do
  cp "packages/core/src/data/$f.json" "services/api/gamedata/$f.json"
done
echo "services/api/gamedata synced from packages/core/src/data"
