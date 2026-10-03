// ------------------------------------------------------------- map overlay --
// Overhead "whole board" view. The camera goes straight above the board, outside the map: the BSP has no
// faces on its outer side, so from up there you look down into every street like a cut-away model. Nothing
// here uses temp-entity beams: the ground path dashes already fill the client's beam pool, and anything
// over the limit just doesn't draw. The path, the arrows and the pieces are real entities instead, shown
// only while the map view is up.
// Seat colours, also tagged on the score table while the map is up.
stock const MAP_COL[SEATS][3] = { {80, 160, 255}, {255, 90, 90}, {90, 230, 120}, {255, 220, 70} };
stock const MAP_COLNAME[SEATS][] = { "blue", "red", "green", "yellow" };

// The camera entity leaves the world in this view, so it touches no BSP leaf and the engine's PVS check
// would stop sending it: clients kept its last in-world position (a tilted, too-close view). Same for the
// overlay pieces drawn over roofs. While the map is up, these and every player are always sent.
public fw_checkvis(ent, pset)
{
	if (g_camMode != CAM_MAP || ent < 1 || ent >= sizeof g_mapEntFlag) return FMRES_IGNORED;
	if (ent <= MaxClients || ent == g_cam || g_mapEntFlag[ent]) { forward_return(FMV_CELL, 1); return FMRES_SUPERCEDE; }
	return FMRES_IGNORED;
}

// Height to draw things at a space so the view from above sees them: just over the space in the open,
// just over the roof when it's in a tunnel or indoors (climbs through up to 3 floors).
Float:map_draw_z(n)
{
	new Float:p[3]; p = g_nodePos[n]; p[2] += 24.0;
	for (new pass = 0; pass < 4; pass++)
	{
		new Float:e[3]; e = p; e[2] += 4096.0;
		new tr = create_tr2();
		engfunc(EngFunc_TraceLine, p, e, IGNORE_MONSTERS, 0, tr);
		new Float:frac, Float:hit[3]; get_tr2(tr, TR_flFraction, frac); get_tr2(tr, TR_vecEndPos, hit);
		free_tr2(tr);
		if (frac >= 1.0) break;
		new Float:q[3]; q = hit; q[2] += 2.0;
		if (engfunc(EngFunc_PointContents, q) != CONTENTS_SOLID) break;   // open sky above: seen from up there
		new bool:out = false;
		for (new k = 0; k < 128; k++)                                      // through the roof (8 units a step)
		{
			q[2] += 8.0;
			new c = engfunc(EngFunc_PointContents, q);
			if (c == CONTENTS_SKY) { out = true; break; }                  // roof meets the sky: no top face, the room shows through
			if (c != CONTENTS_SOLID) break;
		}
		if (out || q[2] - hit[2] > 1020.0) break;
		p = q; p[2] += 16.0;
	}
	return p[2];
}

beam_ent(const Float:a[3], const Float:b[3], r, g, bl, Float:width, Float:bright)
{
	new e = create_entity("beam");
	if (!e) return 0;
	// what CBeam::BeamInit + PointsInit do: a custom entity the client draws as a beam between origin and angles
	entity_set_string(e, EV_SZ_classname, "csp_mapbeam");
	entity_set_int(e, EV_INT_flags, entity_get_int(e, EV_INT_flags) | FL_CUSTOMENTITY);
	entity_set_string(e, EV_SZ_model, "sprites/laserbeam.spr");
	entity_set_int(e, EV_INT_modelindex, g_beamSpr);
	entity_set_int(e, EV_INT_solid, SOLID_NOT);
	entity_set_int(e, EV_INT_movetype, MOVETYPE_NONE);
	entity_set_int(e, EV_INT_rendermode, 0);                  // BEAM_POINTS, no flags
	entity_set_float(e, EV_FL_scale, width);                  // width in 0.1 units, max 255
	entity_set_int(e, EV_INT_body, 0);                        // no noise
	entity_set_int(e, EV_INT_skin, 0); entity_set_int(e, EV_INT_sequence, 0);
	new Float:col[3]; col[0] = float(r); col[1] = float(g); col[2] = float(bl);
	entity_set_vector(e, EV_VEC_rendercolor, col);
	entity_set_float(e, EV_FL_renderamt, bright);
	entity_set_float(e, EV_FL_frame, 0.0); entity_set_float(e, EV_FL_animtime, 0.0);
	entity_set_vector(e, EV_VEC_angles, b);
	new Float:mn[3], Float:mx[3];
	for (new k = 0; k < 3; k++) { mn[k] = floatmin(a[k], b[k]) - a[k]; mx[k] = floatmax(a[k], b[k]) - a[k]; }
	entity_set_size(e, mn, mx);
	entity_set_origin(e, a);
	entity_set_int(e, EV_INT_effects, EF_NODRAW);
	return e;
}

mark_ent(r, g, bl)
{
	new e = create_entity("info_target");
	if (!e) return 0;
	entity_set_string(e, EV_SZ_classname, "csp_mapmark");
	entity_set_model(e, "sprites/glow01.spr");
	entity_set_int(e, EV_INT_solid, SOLID_NOT);
	entity_set_int(e, EV_INT_movetype, MOVETYPE_NOCLIP);
	entity_set_int(e, EV_INT_rendermode, kRenderTransAdd);
	entity_set_float(e, EV_FL_renderamt, 255.0);
	new Float:col[3]; col[0] = float(r); col[1] = float(g); col[2] = float(bl);
	entity_set_vector(e, EV_VEC_rendercolor, col);
	entity_set_int(e, EV_INT_effects, EF_NODRAW);
	return e;
}

map_flag(e) { if (e > 0 && e < sizeof g_mapEntFlag) { g_mapEntFlag[e] = true; g_mapEnt[g_mapEntN++] = e; } }

// Built once per board: a lit path along every link, an arrowhead on each link (two strokes), a glow per seat
// and one for the hostages. All hidden until the map view is switched on.
map_overlay_spawn()
{
	g_mapEntN = 0;
	arrayset(g_mapEntFlag, false, sizeof g_mapEntFlag);
	if (!g_nodeCount) return;
	for (new n = 0; n < g_nodeCount; n++) g_nodeDrawZ[n] = map_draw_z(n);
	for (new n = 0; n < g_nodeCount; n++)
	for (new k = 0; k < g_nodeNextN[n]; k++)
	{
		new m = g_nodeNext[n][k], Float:a[3], Float:b[3], Float:d[3];
		a = g_nodePos[n]; a[2] = g_nodeDrawZ[n];
		b = g_nodePos[m]; b[2] = g_nodeDrawZ[m];
		xs_vec_sub_simple(b, a, d);
		new Float:len = floatsqroot(d[0] * d[0] + d[1] * d[1]);
		if (len < 1.0 || g_mapEntN + 3 > sizeof g_mapEnt) continue;
		map_flag(beam_ent(a, b, 255, 236, 190, 200.0, 170.0));
		// arrowhead just past the middle of the link, pointing at the next space
		new Float:ux = d[0] / len, Float:uy = d[1] / len, Float:ah = floatmin(len * 0.22, 110.0);
		new Float:tip[3], Float:w1[3], Float:w2[3];
		for (new j = 0; j < 3; j++) tip[j] = a[j] + d[j] * 0.6;
		tip[2] += 4.0;
		w1[0] = tip[0] - ux * ah - uy * ah * 0.6; w1[1] = tip[1] - uy * ah + ux * ah * 0.6; w1[2] = tip[2];
		w2[0] = tip[0] - ux * ah + uy * ah * 0.6; w2[1] = tip[1] - uy * ah - ux * ah * 0.6; w2[2] = tip[2];
		map_flag(beam_ent(w1, tip, 255, 255, 255, 255.0, 255.0));
		map_flag(beam_ent(w2, tip, 255, 255, 255, 255.0, 255.0));
	}
	for (new s = 0; s < SEATS; s++) { g_mapMark[s] = mark_ent(MAP_COL[s][0], MAP_COL[s][1], MAP_COL[s][2]); map_flag(g_mapMark[s]); }
	g_mapMark[SEATS] = mark_ent(255, 30, 30); map_flag(g_mapMark[SEATS]);
}

map_overlay_show(bool:on)
{
	for (new i = 0; i < g_mapEntN; i++)
		if (is_valid_ent(g_mapEnt[i])) entity_set_int(g_mapEnt[i], EV_INT_effects, on ? 0 : EF_NODRAW);
	if (on) map_marks_step();
}

// Fit the whole board on screen, straight down. Assumes the narrowest view a client might have (fov 90 on a
// 16:9 screen that keeps the horizontal fov: tan 1.0 across, 0.5625 up/down) and turns the board so its
// long side runs across the screen.
map_view_plan()
{
	new Float:lo[3], Float:hi[3];
	lo[0] = lo[1] = lo[2] = 99999.0; hi[0] = hi[1] = hi[2] = -99999.0;
	for (new n = 0; n < g_nodeCount; n++)
		for (new k = 0; k < 3; k++) { new Float:v = (k == 2) ? g_nodeDrawZ[n] : g_nodePos[n][k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
	new Float:hx = (hi[0] - lo[0]) / 2.0 + 150.0, Float:hy = (hi[1] - lo[1]) / 2.0 + 150.0;
	// across = x (north up) or across = y; take whichever needs less height
	new Float:hA = floatmax(hx / 1.0, hy / 0.5625), Float:hB = floatmax(hy / 1.0, hx / 0.5625);
	new bool:xAcross = hA <= hB;
	new Float:h = floatmin(hA, hB);
	new Float:cx = (lo[0] + hi[0]) / 2.0, Float:cy = (lo[1] + hi[1]) / 2.0;
	g_mapCam[0] = cx; g_mapCam[1] = cy; g_mapCam[2] = lo[2] + h;
	// a nudge toward "screen up" sets the yaw: +y up (x across) or +x up (y across)
	g_mapLook[0] = cx + (xAcross ? 0.0 : 2.0); g_mapLook[1] = cy + (xAcross ? 2.0 : 0.0); g_mapLook[2] = lo[2];
	g_mapH = h;
	// the far corners must be inside the clients' draw distance
	new Float:far = floatsqroot(h * h + hx * hx + hy * hy) + 600.0;
	if (get_cvar_float("sv_zmax") < far) set_cvar_float("sv_zmax", float(floatround(far / 1024.0, floatround_ceil) * 1024));
}

// every frame while the map is up: the glows ride on the pieces (over the roof when a piece is indoors)
map_marks_step()
{
	new Float:sz = g_mapH / 520.0;       // glow01 is 64 px: about 1/8 of the screen height
	for (new s = 0; s < SEATS; s++)
	{
		new e = g_mapMark[s]; if (!is_valid_ent(e)) continue;
		new Float:o[3]; pawn_origin(s, o);
		new Float:z = g_nodeDrawZ[g_pos[s]] + 30.0; if (o[2] + 60.0 > z) z = o[2] + 60.0;
		o[2] = z;
		// pieces sharing a space: spread the glows a little so each colour shows
		new same = 0, before = 0;
		for (new q = 0; q < SEATS; q++) if (g_pos[q] == g_pos[s]) { same++; if (q < s) before++; }
		if (same > 1) { new Float:t = float(before) * 360.0 / float(same) + 45.0; o[0] += floatcos(t, degrees) * sz * 14.0; o[1] += floatsin(t, degrees) * sz * 14.0; }
		entity_set_origin(e, o);
		entity_set_float(e, EV_FL_scale, s == g_cur ? sz * 1.25 : sz);
		entity_set_int(e, EV_INT_renderfx, s == g_cur ? kRenderFxPulseFastWide : kRenderFxNone);
	}
	new h = g_mapMark[SEATS];
	if (is_valid_ent(h))
	{
		new Float:o[3]; o = g_nodePos[g_hostage]; o[2] = g_nodeDrawZ[g_hostage] + 20.0;
		entity_set_origin(h, o);
		entity_set_float(h, EV_FL_scale, sz * 1.6);
		entity_set_int(h, EV_INT_renderfx, kRenderFxPulseSlowWide);
	}
}

toggle_map_view()
{
	if (g_camMode == CAM_MAP) { cam_shot(CAM_FOLLOW); return; }
	map_view_plan();
	cam_shot(CAM_MAP);
}
