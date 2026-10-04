// Test only (ISSUE, tools/dev/racepool_e2e.js PRESS=<map>): "csp_press_stop" makes the first human press the
// map's kreedz stop-timer button, through the same Ham_Use the button gets when a player presses it in game.
// Never load this on a live server.
#include <amxmodx>
#include <engine>
#include <hamsandwich>

public plugin_init()
{
	register_plugin("CSP test press", "1.0", "csp");
	register_srvcmd("csp_press_stop", "cmd_press");
}

public cmd_press()
{
	new id = 0;
	for (new i = 1; i <= MaxClients; i++) if (is_user_connected(i) && !is_user_bot(i)) { id = i; break; }
	new ent = -1, t[32];
	while ((ent = find_ent_by_class(ent, "func_button")) > 0)
	{
		entity_get_string(ent, EV_SZ_target, t, charsmax(t));
		if (!equal(t, "counter_off")) continue;
		ExecuteHamB(Ham_Use, ent, id, id, 2, 1.0);
		server_print("[CSP] test: player %d pressed stop button %d", id, ent);
		return PLUGIN_HANDLED;
	}
	server_print("[CSP] test: no counter_off button");
	return PLUGIN_HANDLED;
}
