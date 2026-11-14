// PHATT ID hats (PHA-5163): a member's equipped trinket floats over their pawn.
//
// The arcade decides who wears what (items/<key>.json render.csparty.hat, ownership checked on read). The lobby asks it
// when the match server is up and the pool-agent passes each member on by rcon:
//   csp_look <game pid> hat <sprite>      e.g. csp_look Xy3k9_aQ hat sprites/csp/hat_benny.spr
//   csp_look <game pid> hat -             takes it off
// The game pid is the lobby's setinfo _csp_pid, so guests and bots never match and wear nothing. A sprite not in HATS[]
// is ignored (not precached = can't be drawn). Looks are written to data/csp_state/looks.ini, so they survive the map
// changes of race minigames.
//
// Drawing: TE_PLAYERATTACHMENT, the temp entity CS uses for the radio icon over a head. The client keeps it on the
// player, so nothing moves server-side. It's sent on spawn, to each client that joins, and again every 30 s (a client
// still loading when a hat went out never got it; kill + attach in one frame, so nothing flickers); a death or a
// disconnect takes it off. tools/build_hats.py builds the sprites (S units across).

#define TASK_HATS   57000      // + player id: catch a new client up on everyone's hat; TASK_HATS + 99: the refresh
#define HAT_REFRESH 30.0       // s between re-sends
#define HAT_LOOKS   16
#define HAT_Z       62         // units above the player origin: the sprite's centre, clear of the head
#define HAT_LIFE    6000       // tenths of a second (10 min); re-sent long before it runs out

new const HATS[][] = { "sprites/csp/hat_benny.spr", "sprites/csp/hat_snowglobe.spr", "sprites/csp/hat_cabinet.spr", "sprites/csp/hat_owl.spr" };
new g_hatSpr[sizeof HATS];
new g_lookPid[HAT_LOOKS][24], g_lookHat[HAT_LOOKS], g_lookN;
new bool:g_hatOn[33];   // we attached a hat to this player (so taking it off can't clear CS's own attachments on anyone else)

hats_precache() { for (new i = 0; i < sizeof HATS; i++) g_hatSpr[i] = precache_model(HATS[i]); }

hats_init()
{
	register_srvcmd("csp_look", "cmd_look");
	hats_load();
	set_task(HAT_REFRESH, "hats_refresh", TASK_HATS + 99, _, _, "b");
}

looks_path(out[], len) { new d[96]; get_datadir(d, charsmax(d)); formatex(out, len, "%s/csp_state", d); if (!dir_exists(out)) mkdir(out); formatex(out, len, "%s/csp_state/looks.ini", d); }

hats_load()
{
	new path[160]; looks_path(path, charsmax(path));
	g_lookN = 0;
	new f = fopen(path, "rt"); if (!f) return;
	new line[160], pid[24], spr[96];
	while (g_lookN < HAT_LOOKS && fgets(f, line, charsmax(line)))
	{
		trim(line);
		if (parse(line, pid, charsmax(pid), spr, charsmax(spr)) < 2) continue;
		new h = hat_index(spr); if (h < 0 || !pid[0]) continue;
		copy(g_lookPid[g_lookN], charsmax(g_lookPid[]), pid); g_lookHat[g_lookN] = h; g_lookN++;
	}
	fclose(f);
}

hats_save()
{
	new path[160]; looks_path(path, charsmax(path));
	new f = fopen(path, "wt"); if (!f) return;
	for (new i = 0; i < g_lookN; i++) fprintf(f, "%s %s^n", g_lookPid[i], HATS[g_lookHat[i]]);
	fclose(f);
}

hat_index(const spr[]) { for (new i = 0; i < sizeof HATS; i++) if (equal(spr, HATS[i])) return i; return -1; }

// the hat this player wears, as an index into HATS[], or -1
hat_of(id)
{
	if (!is_user_connected(id) || is_user_bot(id)) return -1;
	new pid[24]; pid_of(id, pid, charsmax(pid)); if (!pid[0]) return -1;
	for (new i = 0; i < g_lookN; i++) if (equal(pid, g_lookPid[i])) return g_lookHat[i];
	return -1;
}

public cmd_look()
{
	new pid[32], slot[16], spr[96];
	read_argv(1, pid, charsmax(pid)); read_argv(2, slot, charsmax(slot)); read_argv(3, spr, charsmax(spr));
	new n = strlen(pid); for (new i = 0; i < n; i++) if (!(isalnum(pid[i]) || pid[i] == '-' || pid[i] == '_')) n = 0;
	if (n < 6 || n > 23 || !equal(slot, "hat")) { server_print("[CS Party] usage: csp_look <game pid> hat <sprite|->"); return PLUGIN_HANDLED; }
	new h = equal(spr, "-") ? -1 : hat_index(spr);
	if (h < 0 && !equal(spr, "-")) { server_print("[CS Party] csp_look: no hat %s (not in HATS[])", spr); return PLUGIN_HANDLED; }
	new k = -1; for (new i = 0; i < g_lookN; i++) if (equal(pid, g_lookPid[i])) k = i;
	if (h < 0) { if (k >= 0) { g_lookN--; copy(g_lookPid[k], charsmax(g_lookPid[]), g_lookPid[g_lookN]); g_lookHat[k] = g_lookHat[g_lookN]; } }
	else if (k >= 0) g_lookHat[k] = h;
	else if (g_lookN < HAT_LOOKS) { copy(g_lookPid[g_lookN], charsmax(g_lookPid[]), pid); g_lookHat[g_lookN] = h; g_lookN++; }
	else { server_print("[CS Party] csp_look: full (%d looks)", HAT_LOOKS); return PLUGIN_HANDLED; }
	hats_save();
	for (new id = 1; id <= MaxClients; id++) { new p[24]; if (!is_user_connected(id)) continue; pid_of(id, p, charsmax(p)); if (equal(p, pid)) hat_show(id); }
	server_print("[CS Party] look %s hat %s", pid, h < 0 ? "-" : HATS[h]);
	return PLUGIN_HANDLED;
}

// to = 0: everyone. Takes off whatever was attached first, so a re-send never stacks two.
hat_send(id, to)
{
	new h = is_user_alive(id) ? hat_of(id) : -1;
	if (to) message_begin(MSG_ONE, SVC_TEMPENTITY, _, to); else message_begin(MSG_ALL, SVC_TEMPENTITY);
	write_byte(TE_KILLPLAYERATTACHMENTS); write_byte(id); message_end();
	if (!to) g_hatOn[id] = h >= 0;
	if (h < 0) return;
	if (to) message_begin(MSG_ONE, SVC_TEMPENTITY, _, to); else message_begin(MSG_ALL, SVC_TEMPENTITY);
	write_byte(TE_PLAYERATTACHMENT); write_byte(id); write_coord(HAT_Z); write_short(g_hatSpr[h]); write_short(HAT_LIFE); message_end();
}
// spawned, or their look changed: put it on (or take it off)
hat_show(id) { if (g_hatOn[id] || hat_of(id) >= 0) hat_send(id, 0); }
// died or left
hat_hide(id)
{
	if (!g_hatOn[id]) return;
	g_hatOn[id] = false;
	message_begin(MSG_ALL, SVC_TEMPENTITY); write_byte(TE_KILLPLAYERATTACHMENTS); write_byte(id); message_end();
}

// a client that just joined (or rejoined after a map change) has never seen anyone's hat
hats_catch_up(id) { if (!is_user_bot(id)) set_task(5.0, "hats_catch_up_t", TASK_HATS + id); }   // looks may arrive after they join
public hats_catch_up_t(t)
{
	new to = t - TASK_HATS; if (!is_user_connected(to)) return;
	for (new id = 1; id <= MaxClients; id++) if (g_hatOn[id]) hat_send(id, to);
}

public hats_refresh() { for (new id = 1; id <= MaxClients; id++) if (g_hatOn[id]) hat_send(id, 0); }
