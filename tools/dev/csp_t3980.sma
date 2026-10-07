// #3980 test helper (isolated test stack only, never live): read and set the human player's position over rcon.
#include <amxmodx>
#include <engine>
#include <fun>

public plugin_init()
{
	register_plugin("csp_t3980", "1.0", "phattbeats");
	register_srvcmd("t_pos", "cmd_pos");
	register_srvcmd("t_tp", "cmd_tp");
	set_task(0.05, "task_stream", 3980, _, _, "b");   // position into the player's own console: the test page reads it
}

public task_stream()
{
	new id = first_human(); if (!id || !is_user_alive(id)) return;
	new Float:o[3], Float:v[3]; entity_get_vector(id, EV_VEC_origin, o); entity_get_vector(id, EV_VEC_velocity, v);
	client_print(id, print_console, "T_POS %.0f %.0f %.0f vel %.0f %.0f %.0f yaw 0 alive 1 flags %d", o[0], o[1], o[2], v[0], v[1], v[2], entity_get_int(id, EV_INT_flags));
}

first_human()
{
	for (new id = 1; id <= get_maxplayers(); id++) if (is_user_connected(id) && !is_user_bot(id)) return id;
	return 0;
}

public cmd_pos()
{
	new id = first_human(); if (!id) { server_print("T_POS none"); return PLUGIN_HANDLED; }
	new Float:o[3], Float:v[3], Float:a[3]; entity_get_vector(id, EV_VEC_origin, o); entity_get_vector(id, EV_VEC_velocity, v); entity_get_vector(id, EV_VEC_v_angle, a);
	server_print("T_POS %.0f %.0f %.0f vel %.0f %.0f %.0f yaw %.0f alive %d flags %d", o[0], o[1], o[2], v[0], v[1], v[2], a[1], is_user_alive(id), entity_get_int(id, EV_INT_flags));
	return PLUGIN_HANDLED;
}

public cmd_tp()
{
	new id = first_human(); if (!id) { server_print("T_TP none"); return PLUGIN_HANDLED; }
	new s[16], Float:o[3]; for (new k = 0; k < 3; k++) { read_argv(k + 1, s, charsmax(s)); o[k] = str_to_float(s); }
	entity_set_origin(id, o); entity_set_vector(id, EV_VEC_velocity, Float:{0.0, 0.0, 0.0});
	if (read_argc() > 4)
	{
		read_argv(4, s, charsmax(s)); new Float:ang[3]; ang[1] = str_to_float(s);
		read_argv(5, s, charsmax(s)); ang[0] = str_to_float(s);
		entity_set_vector(id, EV_VEC_angles, ang); entity_set_vector(id, EV_VEC_v_angle, ang); entity_set_int(id, EV_INT_fixangle, 1);
	}
	server_print("T_TP %.0f %.0f %.0f", o[0], o[1], o[2]);
	return PLUGIN_HANDLED;
}
