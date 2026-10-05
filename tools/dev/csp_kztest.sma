// ISSUE test helper, never shipped: puts a racer in front of a kreedz map's stop button, aimed at it,
// so a browser client can press +use and finish the race through the real button path.
//   csp_kz_goto <name> [n]  teleport + aim, to the n-th free spot (two racers mustn't share one)
//   csp_kz_info            list the start/stop buttons
#include <amxmodx>
#include <engine>
#include <fakemeta>

new const KZ_STOP[][] = { "counter_off", "clockstopbutton", "clockstop", "but_stop", "counter_stop_button", "multi_stop", "stop_counter", "m_counter_end_emi" };

public plugin_init()
{
	register_plugin("CSP KZ test", "1.0", "csparty");
	register_srvcmd("csp_kz_goto", "cmd_goto");
	register_srvcmd("csp_kz_info", "cmd_info");
}

bool:is_stop(ent)
{
	new t[32]; entity_get_string(ent, EV_SZ_target, t, charsmax(t));
	for (new i = 0; i < sizeof KZ_STOP; i++) if (equali(t, KZ_STOP[i])) return true;
	return false;
}

center(ent, Float:c[3])
{
	new Float:mn[3], Float:mx[3]; entity_get_vector(ent, EV_VEC_absmin, mn); entity_get_vector(ent, EV_VEC_absmax, mx);
	for (new k = 0; k < 3; k++) c[k] = (mn[k] + mx[k]) / 2.0;
}

public cmd_info()
{
	new ent = -1;
	while ((ent = find_ent_by_class(ent, "func_button")) > 0)
	{
		new t[32], tn[32]; entity_get_string(ent, EV_SZ_target, t, charsmax(t)); entity_get_string(ent, EV_SZ_targetname, tn, charsmax(tn));
		if (!t[0] && !tn[0]) continue;
		new Float:c[3]; center(ent, c);
		server_print("[KZT] button %d target=%s name=%s stop=%d at %.0f %.0f %.0f", ent, t, tn, is_stop(ent), c[0], c[1], c[2]);
	}
	return PLUGIN_HANDLED;
}

bool:hull_free(const Float:o[3])
{
	new tr = create_tr2();
	engfunc(EngFunc_TraceHull, o, o, 0, HULL_HUMAN, 0, tr);
	new bool:ok = !get_tr2(tr, TR_StartSolid) && !get_tr2(tr, TR_AllSolid);
	free_tr2(tr);
	return ok;
}

Float:line_frac(const Float:a[3], const Float:b[3], &hit)
{
	new tr = create_tr2();
	engfunc(EngFunc_TraceLine, a, b, IGNORE_MONSTERS, 0, tr);
	new Float:f; get_tr2(tr, TR_flFraction, f); hit = get_tr2(tr, TR_pHit);
	free_tr2(tr);
	return f;
}

public cmd_goto()
{
	new name[32]; read_argv(1, name, charsmax(name));
	new id = find_player("bl", name), a2[8]; read_argv(2, a2, charsmax(a2)); new skip = str_to_num(a2);
	if (!id || !is_user_alive(id)) { server_print("[KZT] no live player %s", name); return PLUGIN_HANDLED; }
	new ent = -1, best = 0;
	while ((ent = find_ent_by_class(ent, "func_button")) > 0) if (is_stop(ent)) { best = ent; break; }
	if (!best) { server_print("[KZT] no stop button"); return PLUGIN_HANDLED; }
	new Float:c[3]; center(best, c);
	// a free standing spot within +use reach (64 units, origin to button centre), with a clear line to it
	for (new Float:dist = 24.0; dist <= 56.0; dist += 8.0)
		for (new a = 0; a < 16; a += 3)
			for (new Float:dz = -24.0; dz <= 24.0; dz += 12.0)
			{
				new Float:o[3]; o[0] = c[0] + dist * floatcos(float(a) * 22.5, degrees); o[1] = c[1] + dist * floatsin(float(a) * 22.5, degrees); o[2] = c[2] - 17.0 + dz;
				if (!hull_free(o) || get_distance_f(o, c) > 60.0) continue;
				new Float:eye[3]; eye = o; eye[2] += 17.0;
				new hit; new Float:f = line_frac(eye, c, hit);
				if (f < 1.0 && hit != best) continue;
				if (skip-- > 0) continue;
				new Float:d[3]; for (new k = 0; k < 3; k++) d[k] = c[k] - eye[k];
				new Float:ang[3]; vector_to_angle(d, ang); ang[0] = -ang[0];
				entity_set_origin(id, o);
				entity_set_vector(id, EV_VEC_velocity, Float:{0.0, 0.0, 0.0});
				entity_set_vector(id, EV_VEC_angles, ang); entity_set_vector(id, EV_VEC_v_angle, ang); entity_set_int(id, EV_INT_fixangle, 1);
				server_print("[KZT] %s at %.0f %.0f %.0f facing button %d (%.0f %.0f %.0f), pitch %.0f yaw %.0f", name, o[0], o[1], o[2], best, c[0], c[1], c[2], ang[0], ang[1]);
				return PLUGIN_HANDLED;
			}
	server_print("[KZT] no free spot near button %d", best);
	return PLUGIN_HANDLED;
}
