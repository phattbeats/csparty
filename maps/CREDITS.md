# Map credits

## CS Party originals (generated)

`csp_surf`, `csp_bhop`, `csp_climb`, `csp_maze` and the surf pack `csp_surf_dust`, `csp_surf_aztec`, `csp_surf_snow`,
`csp_surf_night`, `csp_surf_storm`, `csp_surf_space` are original maps written by `tools/gen_minigame_maps.py`
(phattbeats, ISSUE / ISSUE) and compiled with sdHLT. They use only textures from the stock Counter-Strike WADs
(`cstrike.wad`, `cs_dust.wad`, `de_aztec.wad`, `cs_office.wad`, `de_storm.wad`; Valve Software / the Counter-Strike team)
and the stock skies `desert`, `grnplsnt`, `snow`, `night`, `de_storm` and `space`. The `maps/pool/*.wad` slices and the
browser packs are built from those WADs by `tools/race_map.py` and stay out of git.

## Community maps

`kz_triangles` (pool: climb) is a community kreedz map (ISSUE). We ship only the zone .ini
(`maps/pool/kz_triangles.ini`); the .bsp comes from the mapper's release, which carries the author credit.

Community surf maps evaluated for the surf pack but not shipped yet (ISSUE follow-up): `surf_hasty`,
`surf_sahara`, `surf_vunnu_b1`, `surf_railway`, `surf_nipping` (kreedz stop-button surf maps from the public CS 1.6
map archives). They build and fit the phone budget with `tools/race_map.py`, but their nav generation and browser
race tests are not done. Credit their authors here, from their release readmes, when they ship.
