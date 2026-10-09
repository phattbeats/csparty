# Map credits

## CS Party originals (generated)

`csp_surf`, `csp_bhop`, `csp_climb`, `csp_maze` and the surf pack `csp_surf_dust`, `csp_surf_aztec`, `csp_surf_snow`,
`csp_surf_night`, `csp_surf_storm`, `csp_surf_space` are original maps written by `tools/gen_minigame_maps.py`
(phattbeats, #3867 / #3980) and compiled with sdHLT. They use only textures from the stock Counter-Strike WADs
(`cstrike.wad`, `cs_dust.wad`, `de_aztec.wad`, `cs_office.wad`, `de_storm.wad`; Valve Software / the Counter-Strike team)
and the stock skies `desert`, `grnplsnt`, `snow`, `night`, `de_storm` and `space`. The `maps/pool/*.wad` slices and the
browser packs are built from those WADs by `tools/race_map.py` and stay out of git.

## Community maps

`kz_triangles` (pool: climb) is a community kreedz map (#3979). We ship only the zone .ini
(`maps/pool/kz_triangles.ini`); the .bsp comes from the mapper's release, which carries the author credit.

Community surf maps evaluated for the surf pack but not shipped yet (#3980 follow-up): `surf_hasty`,
`surf_sahara`, `surf_vunnu_b1`, `surf_railway`, `surf_nipping` (kreedz stop-button surf maps from the public CS 1.6
map archives). They build and fit the phone budget with `tools/race_map.py`, but their nav generation and browser
race tests are not done. Credit their authors here, from their release readmes, when they ship.

### Climb pack (#3981)

Kreedz (KZ) climb maps, all rated **Easy** on [kreedz.com](https://kreedz.com/maps) (formerly xtreme-jumps.eu),
downloaded from its map archive (`https://kreedz.com/api/map/<map>`). Built by `tools/climb_pack.py`; zone files in
`maps/pool/<map>.ini`. The finish is each map's own stop-timer button. We ship only the zone .ini files; the .bsp
files come from the mappers' releases, unchanged apart from the worldspawn/button keys noted below (the map CRC skips
the entity lump).

| Map | Author(s) | Released | Kreedz.com rating | Fix |
|-----|-----------|----------|-------------------|-----|
| kz_xj_mountez | FikoN | 2005-09-25 | Easy, Short | |
| cobkz_minecraft | Cobrex | 2014-05-27 | Easy, Short | |
| kz_ea_oldgraveyard | Guardix | 2005-07-27 | Easy, Short | |
| kzbg_ytt_pyramid | ei-zmei | 2018-04-06 | Easy, Short | skyname thehell (not shipped) -> stock dusk |
| skitz_bean_valley | skitz | 2007-08-17 | Easy, Short | |
| kz_darkmine | dot, red | 2006-05-01 | Easy, Short | skyname drkg -> DrkG (stock, exact case) |
| kz_kzse_towerblock | Draw | 2006-05-01 | Easy, Short | |
| kz_j2s_summercliff_ez | s0liD | 2006-02-28 | Easy, Short | stop button master removed (works without the start button) |
| kz_cliffez | aegget | 2005-11-08 | Easy, Short | stop button master removed (works without the start button) |
| kz_xj_ezbrickjump | Chrizzy | 2005-12-24 | Easy, Short | |

Thanks to the mappers, and to the Kreedz community for keeping these maps available for twenty years.
