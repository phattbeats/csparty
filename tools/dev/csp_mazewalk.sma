// ISSUE test helper (never ships): drives the first human along a maze's solution so a browser client can
// finish a Maze Run race unattended. Waypoints: configs/cs_party/minigames/<map>.walk, one "x y" per line.
// csp_mazewalk 1 turns it on; the walker moves at csp_mazewalk_speed u/s (250 = knife run speed, so the race time it logs
// is the shortest-route time). The race ends 5 s after the first finisher and bots finish on a 30-60 s clock, so set
// it higher (400) when the walker only has to prove the route reaches the finish.
#include <amxmodx>
#include <fakemeta>
#include <engine>
#include <amxmisc>

new Float:g_wp[600][2], g_n, g_i, bool:g_on, Float:g_t0, Float:g_last[3], Float:g_stuck;

public plugin_init()
{
	register_plugin("csp_mazewalk", "1", "phattbeats");
	register_cvar("csp_mazewalk", "0");
	register_cvar("csp_mazewalk_speed", "250");
	register_forward(FM_PlayerPreThink, "fw_prethink");
}

public plugin_cfg() { load_walk(); }

load_walk()
{
	g_n = 0; g_i = 0;
	new map[32], path[128], cfg[96], line[64], x[16], y[16];
	get_mapname(map, charsmax(map)); get_configsdir(cfg, charsmax(cfg));
	formatex(path, charsmax(path), "%s/cs_party/minigames/%s.walk", cfg, map);
	new f = fopen(path, "rt"); if (!f) return;
	while (!feof(f) && g_n < 600) { fgets(f, line, charsmax(line)); parse(line, x, charsmax(x), y, charsmax(y)); if (!x[0]) continue; g_wp[g_n][0] = str_to_float(x); g_wp[g_n][1] = str_to_float(y); g_n++; }
	fclose(f);
	server_print("[WALK] %d waypoints for %s", g_n, map);
}

public fw_prethink(id)
{
	if (is_user_bot(id)) return FMRES_IGNORED;
	if (!get_cvar_num("csp_mazewalk")) { g_on = false; return FMRES_IGNORED; }
	if (!g_n || !is_user_alive(id)) return FMRES_IGNORED;
	new Float:o[3]; pev(id, pev_origin, o);
	if (!g_on) { g_on = true; g_t0 = get_gametime(); g_i = 0; g_stuck = get_gametime(); server_print("[WALK] start at %.0f %.0f", o[0], o[1]); }
	// far from the lobby: the race hasn't put us at the start yet (e.g. still on the board map)
	if (o[0] > g_wp[g_n - 1][0] + 600.0) return FMRES_IGNORED;
	new Float:dx = g_wp[g_i][0] - o[0], Float:dy = g_wp[g_i][1] - o[1], Float:d = floatsqroot(dx * dx + dy * dy);
	if (d < 40.0)
	{
		if (g_i < g_n - 1) g_i++;
		else { server_print("[WALK] reached the last waypoint after %.1f s", get_gametime() - g_t0); g_on = false; set_cvar_num("csp_mazewalk", 0); return FMRES_IGNORED; }
		return FMRES_IGNORED;
	}
	new Float:v[3]; pev(id, pev_velocity, v);
	new Float:spd = get_cvar_float("csp_mazewalk_speed");
	v[0] = dx / d * spd; v[1] = dy / d * spd;
	set_pev(id, pev_velocity, v);
	new Float:a[3]; a[0] = 0.0; a[1] = floatatan2(dy, dx, radian) * 57.29578; a[2] = 0.0;
	set_pev(id, pev_v_angle, a); set_pev(id, pev_angles, a); set_pev(id, pev_fixangle, 1);
	// stuck check: no progress for 3 s (a wall, or the countdown freeze before the race): start the route again
	if (floatabs(o[0] - g_last[0]) + floatabs(o[1] - g_last[1]) >= 4.0) { g_last[0] = o[0]; g_last[1] = o[1]; g_stuck = get_gametime(); }
	else if (g_stuck > 0.0 && get_gametime() - g_stuck > 3.0) { server_print("[WALK] STUCK at %.0f %.0f going to wp %d (%.0f %.0f)", o[0], o[1], g_i, g_wp[g_i][0], g_wp[g_i][1]); g_stuck = 0.0; }
	return FMRES_IGNORED;
}
