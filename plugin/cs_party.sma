/*
 * CS Party - Mario Party structure, Counter-Strike 1.6 everything.
 *
 * Runs on ReHLDS + ReGameDLL_CS + Metamod-R + AMX Mod X 1.10 + ReAPI.
 * Vanilla CS 1.6 clients; nothing to install client-side.
 *
 * Board: configs/cs_party/boards/<map>.ini, generated from the zBot nav mesh
 *        by tools/board_compiler.py.
 * Game rules lean on ReGameDLL wherever it already has a cvar:
 *   mp_round_infinite (board phase), mp_freeforall (FFA minigames),
 *   mp_*_default_weapons_* (loadouts), bot_stop (freeze zBots on the board).
 * CS's own money HUD shows board money; TAB scoreboard frags show stars.
 *
 * Console:
 *   csp_start          start a match with whoever is in the server (bots fill)
 *   csp_stop           abort
 *   csp_state          dump state to console
 * Players: /party (start), /buy menu opens on your turn automatically.
 */
#include <amxmodx>
#include <amxmisc>
#include <engine>
#include <fakemeta>
#include <hamsandwich>
#include <reapi>
#include <json>

#define PLUGIN  "CS Party"
#define VERSION "0.2.0"
#define AUTHOR  "PHATT Tech"

#define MAX_NODES   96
#define SEATS       4
#define INV_MAX     3
#define MONEY_CAP   16000

#define TASK_FLOW   41000
#define TASK_CAM    42000
#define TASK_RINGS  43000
#define TASK_HUD    44000
#define TASK_NADE   45000
#define TASK_DICE   46000
#define TASK_RACE   47000
#define TASK_LOBBY  48000
#define TASK_SEATWATCH 50000
#define TASK_VOICE  51000

// ---------------------------------------------------------------- data --
enum { NT_BLUE = 0, NT_RED, NT_EVENT, NT_SITE, NT_START, NT_SHOP, NT_CAMPER, NT_ARMORY, NT_VIP, NT_DUEL, NT_NEGOT };
enum { ST_IDLE = 0, ST_BOARD, ST_MG_INTRO, ST_MINIGAME, ST_MG_RESULT, ST_END, ST_REMOTE_WAIT, ST_REMOTE_RACE, ST_RESUME };
enum { SIDE_NONE = -1, SIDE_CT = 0, SIDE_T = 1 };
enum { FMT_FFA = 1, FMT_2V2 = 2, FMT_1V3 = 4, FMT_DUEL = 8 };
enum { CONT_NEXT_SEAT = 0, CONT_NEXT_TURN };

// Board items (Mario Party style). You get these from Black Markets, the Armory, and ? events,
// then use them at the start of your turn before jumping at the crate.
enum { IT_KNIFE = 0, IT_BHOP, IT_RIGGED, IT_FAKE, IT_SMOKE, IT_C4, IT_ROTATE, IT_INTEL, IT_COUNT };
new const ITEM_NAME[IT_COUNT][]  = { "Knife Out", "Bhop Script", "Rigged Crate", "Fake Call", "Smoke", "C4", "Rotate", "Hostage Intel" };
new const ITEM_PRICE[IT_COUNT]   = { 500, 1200, 900, 300, 400, 800, 1000, 4000 };
new const ITEM_HINT[IT_COUNT][]  = { "hit two crates", "hit three crates", "pick your number", "a rival rolls -3", "C4, campers, steals skip you",
                                     "trap your space", "swap places with a rival", "go straight to the hostages" };
new const SHOP_T[]  = { IT_KNIFE, IT_BHOP, IT_FAKE, IT_C4, IT_ROTATE, IT_RIGGED };
new const SHOP_CT[] = { IT_KNIFE, IT_RIGGED, IT_SMOKE, IT_FAKE, IT_ROTATE, IT_INTEL };
new const ARMORY_DROP[] = { IT_KNIFE, IT_KNIFE, IT_KNIFE, IT_FAKE, IT_FAKE, IT_SMOKE, IT_SMOKE, IT_C4, IT_C4, IT_RIGGED, IT_BHOP, IT_ROTATE };

// CS gear (the real 1.6 buy menu, real 1.6 prices, paid with board money). It goes into the
// gear minigames. Survive the round and you keep it; die and it's gone. You can loot the dead.
#define GEAR_N 22
new const GEAR_ENT[GEAR_N][] = { "weapon_glock18", "weapon_usp", "weapon_p228", "weapon_deagle", "weapon_fiveseven", "weapon_elite",
	"weapon_m3", "weapon_xm1014", "weapon_tmp", "weapon_mac10", "weapon_mp5navy", "weapon_ump45", "weapon_p90",
	"weapon_galil", "weapon_famas", "weapon_ak47", "weapon_m4a1", "weapon_sg552", "weapon_aug", "weapon_scout", "weapon_awp", "weapon_m249" };
new const GEAR_NAME[GEAR_N][] = { "Glock-18", "USP", "P228", "Desert Eagle", "Five-SeveN", "Dual Elites", "M3", "XM1014", "TMP", "MAC-10",
	"MP5", "UMP45", "P90", "Galil", "FAMAS", "AK-47", "M4A1", "SG 552", "AUG", "Scout", "AWP", "M249" };
new const GEAR_PRICE[GEAR_N] = { 400, 500, 600, 650, 750, 800, 1700, 3000, 1250, 1400, 1500, 1700, 2350, 2000, 2250, 2500, 3100, 3500, 3500, 2750, 4750, 5750 };
// buy menu categories, as in 1.6: 1 pistols, 2 shotguns, 3 SMGs, 4 rifles, 5 machine gun, 8 equipment
new const GEAR_CAT[GEAR_N] = { 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5 };
#define GEAR_SECONDARY_MAX 5      // indices 0..5 are pistols
enum { EQ_KEVLAR = 0, EQ_HELMET, EQ_FLASH, EQ_HE, EQ_SMOKE, EQ_KIT, EQ_COUNT };
new const EQ_NAME[EQ_COUNT][] = { "Kevlar", "Kevlar + Helmet", "Flashbang", "HE Grenade", "Smoke Grenade", "Defuse Kit" };
new const EQ_PRICE[EQ_COUNT] = { 650, 1000, 200, 300, 300, 200 };

enum { SK_PHOENIX = 0, SK_ELITE, SK_ARCTIC, SK_GUERILLA, SK_SEAL, SK_GSG9, SK_SAS, SK_GIGN, SK_COUNT };
new const SKIN_NAME[SK_COUNT][]  = { "Phoenix Connexion", "Elite Crew", "Arctic Avengers", "Guerilla Warfare", "SEAL Team 6", "GSG-9", "SAS", "GIGN" };
new const SKIN_MODEL[SK_COUNT][] = { "terror", "leet", "arctic", "guerilla", "urban", "gsg9", "sas", "gign" };
enum { VO_BLUE, VO_RED, VO_GOOD, VO_BAD, VO_WON, VO_LOST }
new const VO_LINES[][][] = {
	{ "radio/letsgo.wav", "radio/locknload.wav", "radio/moveout.wav", "radio/roger.wav", "radio/bot/alright_lets_do_this.wav", "radio/bot/ok_cmdr_lets_go.wav", "radio/bot/sounds_like_a_plan.wav", "radio/bot/on_my_way.wav", "radio/bot/yesss.wav", "radio/bot/oh_yea.wav", "radio/bot/im_coming.wav", "radio/bot/whoo.wav" },
	{ "radio/bot/uh_oh.wav", "radio/bot/oh_no.wav", "radio/bot/aww_man.wav", "radio/bot/yikes.wav", "radio/bot/ouch.wav", "radio/bot/thats_not_good.wav", "radio/bot/aw_hell.wav", "radio/ct_imhit.wav", "radio/negative.wav", "radio/fallback.wav", "radio/bot/oh_man.wav", "radio/bot/noo.wav" },
	{ "radio/bot/whoo.wav", "radio/bot/whoo2.wav", "radio/bot/yesss.wav", "radio/bot/yesss2.wav", "radio/bot/oh_yea.wav", "radio/bot/yea_baby.wav", "radio/bot/nice.wav", "radio/bot/great.wav", "radio/bot/whos_the_man.wav", "radio/bot/good_one.wav", "radio/enemydown.wav", "radio/bot/thats_the_way_this_is_done.wav" },
	{ "radio/bot/oh_no.wav", "radio/bot/aww_man.wav", "radio/bot/ouch.wav", "radio/bot/ow.wav", "radio/bot/yikes.wav", "radio/bot/uh_oh.wav", "radio/bot/thats_not_good.wav", "radio/bot/im_in_trouble.wav", "radio/bot/what_have_you_done.wav", "radio/bot/ow_its_me.wav", "radio/getout.wav", "radio/bot/noo.wav" },
	{ "radio/bot/whoo.wav", "radio/bot/yesss.wav", "radio/bot/whos_the_man.wav", "radio/bot/we_owned_them.wav", "radio/bot/and_thats_how_its_done.wav", "radio/bot/owned.wav", "radio/bot/yea_baby.wav", "radio/enemydown.wav", "radio/bot/ruined_his_day.wav", "radio/bot/made_him_cry.wav", "radio/ctwin.wav", "radio/terwin.wav" },
	{ "radio/bot/aww_man.wav", "radio/bot/oh_no_sad.wav", "radio/bot/aw_hell.wav", "radio/bot/noo.wav", "radio/bot/that_was_a_close_one.wav", "radio/bot/oh_man.wav", "radio/bot/thats_not_good.wav", "radio/bot/i_got_nothing.wav", "radio/negative.wav", "radio/bot/uh_oh.wav", "radio/bot/ow.wav", "radio/bot/no.wav" }
};
new const SKIN_DICE[SK_COUNT][6] = { {1,2,3,4,5,6}, {0,0,3,5,6,7}, {2,2,3,3,5,6}, {1,1,1,6,6,6},
                                     {3,3,3,4,4,4}, {0,2,2,5,5,7}, {1,3,3,3,5,6}, {2,2,2,2,6,7} };

enum { MG_PLANT = 0, MG_PISTOL, MG_FULLBUY, MG_DEAGLE, MG_KNIFE, MG_SCOUTZ, MG_NADES, MG_HNS, MG_SURF, MG_BHOP, MG_CLIMB, MG_MAZE, MG_TOWERS, MG_COUNT };
new const MG_NAME[MG_COUNT][] = { "Plant the Bomb", "Pistol Round", "Full Buy", "Deagle Only", "Knife Fight", "Scoutzknivez", "Nades Only", "Hide and Seek", "Surf Race", "Bhop Course", "Climb", "Maze Run", "Two Towers" };
new const MG_DESC[MG_COUNT][] = {
	"T side plants. CT side stops them. Bring your gear.",
	"Your pistol, armor and nades only. Standard round rules.",
	"Everything you bought. Last side standing.",
	"Deagles only. Last one standing.",
	"35 HP. Knives only.",
	"Scouts and knives, low gravity.",
	"Unlimited HE grenades. Nothing else.",
	"CT seeks with a knife after 20 seconds in the dark. T hides. Any hider alive at the buzzer wins.",
	"First to the end of the surf course. Fall and you go back to the stage start.",
	"First across the bhop course. Lava sends you back to the last checkpoint.",
	"First to the top. Jumps, a ladder, beams. Fall in the pit and you go back to the last checkpoint.",
	"First out of the maze wins. The walls are too tall to jump.",
	"AWPs and Deagles on Two Towers. Last side standing." };
// How-to card for minigames that need a CS movement trick. Shown while everyone loads in, through the
// countdown and the first seconds of the race. Short on purpose; "" = no card.
new const MG_TUT[MG_COUNT][] = { "", "", "", "", "", "", "", "", 
	"HOW TO SURF^n^n- Land on the side of a ramp, not the top.^n- Hold A or D (stick left/right) toward the ramp.^n- Never press W. Turn the mouse to steer.^n- Fall off and you restart this stage.",
	"HOW TO BHOP^n^n- Hold JUMP. You hop again every time you land.^n- Steer in the air with A / D and the mouse together.^n- Don't hold W while in the air.^n- Lava sends you back to the last checkpoint.",
	"HOW TO CLIMB^n^n- Ladders: look up and hold W. Jump off with JUMP.^n- High ledges: JUMP, then hold DUCK in the air.^n- Beams are narrow: walk, don't run (hold SHIFT).^n- Fall and you go back to the last checkpoint.",
	"", "" };
new const MG_FORMATS[MG_COUNT] = { FMT_2V2|FMT_1V3, FMT_2V2|FMT_1V3, FMT_FFA|FMT_2V2|FMT_1V3|FMT_DUEL, FMT_FFA|FMT_2V2|FMT_DUEL, FMT_FFA|FMT_2V2|FMT_1V3|FMT_DUEL, FMT_FFA|FMT_DUEL, FMT_FFA|FMT_2V2, FMT_2V2|FMT_1V3, FMT_FFA|FMT_2V2|FMT_DUEL, FMT_FFA|FMT_DUEL, FMT_FFA|FMT_2V2|FMT_DUEL, FMT_FFA|FMT_2V2|FMT_1V3|FMT_DUEL, FMT_FFA|FMT_2V2|FMT_1V3|FMT_DUEL };
// 0 = fixed loadout (gear untouched), 1 = all your gear, 2 = pistol, armor and nades only
new const MG_GEAR[MG_COUNT] = { 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
// minigames played on CS Party's own maps (changelevel and back)
new const MG_MAP[MG_COUNT][] = { "", "", "", "", "", "", "", "", "csp_surf", "csp_bhop", "csp_climb", "csp_maze", "csp_towers" };
// zBots can't surf, bhop, climb or solve a maze: on race maps they "finish" at a random time in this window (seconds)
new const Float:MG_BOT_TIME[MG_COUNT][2] = { {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0},
	{40.0, 75.0}, {35.0, 65.0}, {40.0, 70.0}, {30.0, 60.0}, {0.0, 0.0} };
// own-map minigames that are a fight (board elimination rules) instead of a race
bool:mg_fight(m) { return m == MG_TOWERS; }

// board
new Float:g_nodePos[MAX_NODES][3], g_nodeType[MAX_NODES], g_nodeLetter[MAX_NODES], g_nodeArea[MAX_NODES][24];
new g_nodeNext[MAX_NODES][2], g_nodeNextN[MAX_NODES], g_nodeCount, g_startNode, g_nodeShopSide[MAX_NODES], g_propEnt[MAX_NODES];
new g_dist[MAX_NODES][MAX_NODES];
new g_candidates[MAX_NODES], g_candCount;

// seats
new g_seatPlayer[SEATS], g_seatName[SEATS][32], bool:g_seatBot[SEATS], g_seatSkin[SEATS];
new g_seatOwner[SEATS][32];
#define NAV_MAX 10
new g_navMenu[33], g_navPos[33], g_navN[33], g_navOld[33], Float:g_navNext[33];   // cursor menus; g_navMenu = handle + 1
new g_navName[33][NAV_MAX][96], bool:g_navThawed[33], bool:g_navRedraw[33], g_navHandler[33][32], bool:g_navPicking;
enum { W_NONE = 0, W_TURN, W_BRANCH, W_HOSTAGE, W_SHOP, W_NEGOT, W_TARGET };
new g_waitKind[SEATS], g_waitLast[SEATS], Float:g_waitAt[SEATS];   // what the board waits for a human to decide, since when
new bool:g_wdCancel;                       // menu_cancel() from the timer or an abort: handlers must not advance the flow
new Float:g_navMove[33];                    // forwardmove from the last usercmd: sticks and the touch stick set this, not IN_FORWARD
new bool:g_lateSpec[33];                    // joined mid-match and was parked in spectator
new c_turntime, c_hudscale;
new bool:g_xhHidden[33];
new g_boardMap[32];   // the map the board lives on (restored from saved state on race maps)   // name key of the human who owns the seat ("" = a bot seat). Survives bots standing in.
new g_money[SEATS], g_stars[SEATS], g_items[SEATS][INV_MAX], g_itemN[SEATS], g_streak[SEATS], g_mgWins[SEATS], g_reds[SEATS], g_maxMoney[SEATS];
// award stats
new g_spent[SEATS], g_moved[SEATS], g_c4Take[SEATS];
// bonus stars: categories drawn at match start and shown all game
enum { AW_FRAGGER = 0, AW_MAXMONEY, AW_ECO, AW_SPENDER, AW_RUSHER, AW_BOMBSQUAD, AW_COUNT };
new const AW_NAME[AW_COUNT][] = { "Top Fragger", "Max Money", "Eco Round", "Big Spender", "Rusher", "Bomb Squad" };
new const AW_WHY[AW_COUNT][]  = { "most minigame wins", "highest balance held", "most red spaces", "most money spent", "most spaces moved", "most C4 payouts collected" };
new g_awardCat[3], g_awardN;
new g_pos[SEATS], g_lastColor[SEATS], g_flashed[SEATS], bool:g_smoke[SEATS], g_extraCrates[SEATS], g_rigged[SEATS];
new g_gPrim[SEATS], g_gSec[SEATS], g_gArmor[SEATS], g_gFlash[SEATS], g_gHE[SEATS], g_gSmoke[SEATS], bool:g_gKit[SEATS];
new g_mgSide[SEATS], bool:g_mgIn[SEATS];
new bool:g_finished[SEATS], Float:g_finishTime[SEATS], Float:g_botFinish[SEATS], Float:g_raceStart, g_finishN, g_countdown, Float:g_waitStart;

// match
new g_state = ST_IDLE, g_turn, g_maxTurns, g_cur, g_hostage, g_traps[MAX_NODES];
new g_stepsLeft, g_moveDepth, g_cont, g_mg, g_mgFmt, g_mgWager, g_duelA;
new bool:g_mgDone, g_mgWinners[SEATS], g_mgWinnerN;

// entities / misc
new c_autostart, bool:g_lobby, g_lobbyLeft, c_autobhop, g_hudTut;
new g_tileEnt[MAX_NODES], bool:g_boardHidden, Float:g_ringsAt;
new g_mgPrim[16], g_mgSec[16], g_mgGren[16];
#define HOP_TIME 0.3
new Float:g_hopFrom[3], Float:g_hopTo[3], g_hopNode, Float:g_hopStart, bool:g_hopActive;
new g_cam, g_hostageEnt, g_trapEnt[MAX_NODES], g_beamSpr, g_hudSync, g_hudSync2;
// map overlay (toggle_map_view): its entities, the per-space draw height and the planned overhead shot
new g_mapEnt[MAX_NODES * 6], g_mapEntN, bool:g_mapEntFlag[2048], bool:g_mapHide[2048], g_mapMark[SEATS + 2], Float:g_nodeDrawZ[MAX_NODES];
new Float:g_mapCam[3], Float:g_mapLook[3], Float:g_mapH;
new Float:g_camPos[3], Float:g_camAng[3];
new g_msgScoreInfo;
#define DICE_HALF   18.0
#define DICE_LIFT   82.0      // crate center above player origin; standing hull top is +36, a jump reaches ~+81
new g_diceEnt[3], g_diceN, bool:g_diceHit[3], g_diceVal[3], g_diceFace[3], bool:g_diceArmed, Float:g_diceStart, Float:g_diceBotJump, bool:g_diceOpen;


// cvars
new c_autojoin, c_turns, c_start, c_hostage, c_blue, c_red, c_mgwin, c_lbase, c_lstep, c_lcap, c_trap, c_ot, c_awards, c_speed, c_debug, c_buyany, c_voice;
new g_targetPurpose, g_shopSide;

// ------------------------------------------------------------- plugin --
public plugin_precache()
{
	precache_model("models/rpgrocket.mdl");
	precache_model("models/hostage.mdl");
	precache_model("models/w_c4.mdl");
	precache_model("models/csp_dice.mdl");
	new const PROPS[][] = { "models/w_ak47.mdl", "models/w_m4a1.mdl", "models/w_awp.mdl", "models/w_kevlar.mdl", "models/w_deagle.mdl", "models/w_backpack.mdl", "models/player/vip/vip.mdl" };
	for (new i = 0; i < sizeof PROPS; i++) precache_model(PROPS[i]);
	precache_sound("items/gunpickup1.wav"); precache_sound("weapons/awp1.wav"); precache_sound("buttons/blip1.wav");
	precache_sound("weapons/c4_beep1.wav");
	precache_sound("items/gunpickup2.wav");
	for (new i = 1; i <= 4; i++) { new f[40]; formatex(f, charsmax(f), "player/pl_step%d.wav", i); precache_sound(f); }
	precache_sound("events/task_complete.wav");
	for (new k = 0; k < sizeof VO_LINES; k++) for (new i = 0; i < sizeof VO_LINES[]; i++) precache_sound(VO_LINES[k][i]);
	g_beamSpr = precache_model("sprites/laserbeam.spr");
	precache_model("sprites/dot.spr"); precache_model("sprites/iplayer.spr"); precache_model("sprites/ihostage.spr");   // map overlay markers
	precache_model("models/csp_tile.mdl");
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);
	RegisterHookChain(RG_CBasePlayer_PreThink, "hc_nav_prethink", false);   // cursor menus (controllers, phones)
	register_forward(FM_StartFrame, "fw_startframe");                        // camera + pawn hops, every server frame
	register_forward(FM_CmdStart, "fw_nav_cmdstart");                      // analog forward/back for the cursor
	register_forward(FM_CheckVisibility, "fw_checkvis");                   // map overlay: keep the camera and pieces sent

	c_turns   = register_cvar("csp_turns", "15");
	c_start   = register_cvar("csp_startmoney", "800");
	c_hostage = register_cvar("csp_hostage_cost", "5000");
	c_blue    = register_cvar("csp_blue", "750");
	c_red     = register_cvar("csp_red", "750");
	c_mgwin   = register_cvar("csp_mg_win", "2500");
	c_lbase   = register_cvar("csp_loss_base", "250");
	c_lstep   = register_cvar("csp_loss_step", "250");
	c_lcap    = register_cvar("csp_loss_cap", "1250");
	c_trap    = register_cvar("csp_trap", "1500");
	c_ot      = register_cvar("csp_overtime", "3");
	c_awards  = register_cvar("csp_awards", "1");     // 0 off, 1 two announced bonus stars (default), 2 classic hidden three, 3 two announced cash prizes
	c_speed   = register_cvar("csp_speed", "1.0");    // delay multiplier; 0.2 for fast bot tests
	c_debug   = register_cvar("csp_debug", "1");
	c_buyany  = register_cvar("csp_buy_anywhere", "0");
	c_voice   = register_cvar("csp_voice", "50");     // % chance a character barks a voice line on spaces, events and minigame results
	register_cvar("csp_rings", "1");
	c_hudscale = register_cvar("csp_hud_scale", "2");   // client hud_scale pushed to humans (Xash3D browser clients; 0 = leave alone)
	c_turntime = register_cvar("csp_turn_timeout", "45");   // s a human can sit on a board decision before the bot logic decides (0 = wait forever)                        // board space markers (TE_BEAMPOINTS); 0 for testing
	c_autobhop = register_cvar("csp_autobhop", "1");   // Bhop Course: hold jump to hop (ReGameDLL sv_autobunnyhopping)
	c_autostart = register_cvar("csp_autostart", "20");   // s of frozen lobby after the first human joins, then the match starts by itself (0 = wait for /party)
	c_autojoin = register_cvar("csp_autojoin", "1");   // put new humans on a team without the team/class menus   // 1 = old every-turn buy menu as well as the buy zones

	register_srvcmd("csp_start", "cmd_start");
	register_srvcmd("csp_stop", "cmd_stop");
	register_srvcmd("csp_state", "cmd_state");
	register_srvcmd("csp_spec", "cmd_spec");
	register_srvcmd("csp_probe", "cmd_probe");
	register_srvcmd("csp_nocam", "cmd_nocam");
	register_srvcmd("csp_mapview", "cmd_mapview");   // dev: toggle the map overlay without a turn menu; "csp_mapview v" lists what's sent
	register_srvcmd("csp_force_mg", "cmd_force_mg");
	register_srvcmd("csp_botname", "cmd_botname");
	register_srvcmd("csp_stuff", "cmd_stuff");       // dev: csp_stuff <player> <command...> runs a command on that client   // dev: csp_botname <name> renames a bot (name-collision tests)
	register_srvcmd("csp_test_remote", "cmd_test_remote");
	register_srvcmd("csp_board", "cmd_board_srv");          // csp_board <map>: switch to another board (between matches)   // dev: csp_force_mg <minigame index> for the next pick (-1 clears)   // dev: drop the director camera to compare   // dev: movement state of the active player     // dev: move every human to spectator (camera client, streams)
	register_clcmd("say /party", "cmd_start_client");
	register_clcmd("say /help", "cmd_help");
	register_clcmd("say /menu", "cmd_menu");
	register_clcmd("say /board", "cmd_board");   // pick the board map before a match     // reopen your turn menu if you closed it
	register_clcmd("say_team /help", "cmd_help");

	RegisterHookChain(RG_RoundEnd, "hc_round_end", false);
	RegisterHookChain(RG_CBasePlayer_Spawn, "hc_spawn_post", true);
	RegisterHookChain(RG_CBasePlayer_Killed, "hc_killed_post", true);
	RegisterHookChain(RG_CSGameRules_FPlayerCanTakeDamage, "hc_can_take_damage", false);
	RegisterHookChain(RG_ThrowHeGrenade, "hc_throw_he_post", true);
	RegisterHookChain(RG_CBasePlayer_ResetMaxSpeed, "hc_reset_maxspeed_post", true);
	RegisterHookChain(RG_ShowVGUIMenu, "hc_show_vgui_menu", false);

	g_hudSync = CreateHudSyncObj();
	g_hudSync2 = CreateHudSyncObj();
	g_hudTut = CreateHudSyncObj();
	g_msgScoreInfo = get_user_msgid("ScoreInfo");

	load_board();
	spawn_board_entities();
	set_task(1.0, "task_rings", TASK_RINGS, _, _, "b");
	set_task(0.5, "task_hud", TASK_HUD, _, _, "b");
	set_task(2.0, "task_seat_watch", TASK_SEATWATCH, _, _, "b");
}

public plugin_end()
{
	if (g_state != ST_IDLE) restore_cvars();
}

Float:spd(Float:t) { return t * floatmax(0.05, get_pcvar_float(c_speed)); }

dbg(const fmt[], any:...)
{
	new msg[256]; vformat(msg, charsmax(msg), fmt, 2);
	if (get_pcvar_num(c_debug)) server_print("[CSP] %s", msg);
	log_amx("%s", msg);
}

announce(const fmt[], any:...)
{
	new msg[192]; vformat(msg, charsmax(msg), fmt, 2);
	client_print_color(0, print_team_default, "^4[Party]^1 %s", msg);
	dbg("%s", msg);
}

// --------------------------------------------------------------- board --
load_board()
{
	new map[32], path[160], cfg[96];
	get_mapname(map, charsmax(map));
	get_configsdir(cfg, charsmax(cfg));
	formatex(path, charsmax(path), "%s/cs_party/boards/%s.ini", cfg, map);
	g_nodeCount = 0;
	new f = fopen(path, "rt");
	if (!f) { log_amx("No board for %s (%s). Generate one with board_compiler.py.", map, path); return; }

	new line[192], bool:inNodes = false;
	new sid[8], stype[16], sx[16], sy[16], sz[16], snext[24], sarea[32];
	while (!feof(f))
	{
		fgets(f, line, charsmax(line)); trim(line);
		if (!line[0] || line[0] == ';') continue;
		if (line[0] == '[') { inNodes = bool:equal(line, "[nodes]"); continue; }
		if (!inNodes) { if (equal(line, "start=", 6)) g_startNode = str_to_num(line[6]); continue; }
		parse(line, sid, charsmax(sid), stype, charsmax(stype), sx, charsmax(sx), sy, charsmax(sy), sz, charsmax(sz), snext, charsmax(snext), sarea, charsmax(sarea));
		new id = str_to_num(sid);
		if (id < 0 || id >= MAX_NODES) continue;
		g_nodePos[id][0] = str_to_float(sx); g_nodePos[id][1] = str_to_float(sy); g_nodePos[id][2] = str_to_float(sz);
		g_nodeLetter[id] = 0;
		g_nodeShopSide[id] = SIDE_NONE;
		if (equal(stype, "start")) g_nodeType[id] = NT_START;
		else if (equal(stype, "shop", 4)) { g_nodeType[id] = NT_SHOP; g_nodeShopSide[id] = (stype[5] == 'T') ? SIDE_T : SIDE_CT; }
		else if (equal(stype, "camper")) g_nodeType[id] = NT_CAMPER;
		else if (equal(stype, "armory")) g_nodeType[id] = NT_ARMORY;
		else if (equal(stype, "vip")) g_nodeType[id] = NT_VIP;
		else if (equal(stype, "duel")) g_nodeType[id] = NT_DUEL;
		else if (equal(stype, "negotiator")) g_nodeType[id] = NT_NEGOT;
		else if (equal(stype, "red")) g_nodeType[id] = NT_RED;
		else if (equal(stype, "event")) g_nodeType[id] = NT_EVENT;
		else if (equal(stype, "site", 4)) { g_nodeType[id] = NT_SITE; g_nodeLetter[id] = stype[5]; }
		else g_nodeType[id] = NT_BLUE;
		if (g_nodeType[id] == NT_START) g_startNode = id;
		copy(g_nodeArea[id], charsmax(g_nodeArea[]), sarea);
		new a[8], b[8];
		g_nodeNextN[id] = 1;
		if (contain(snext, ",") != -1) { strtok(snext, a, charsmax(a), b, charsmax(b), ','); g_nodeNext[id][0] = str_to_num(a); g_nodeNext[id][1] = str_to_num(b); g_nodeNextN[id] = 2; }
		else g_nodeNext[id][0] = str_to_num(snext);
		if (id + 1 > g_nodeCount) g_nodeCount = id + 1;
	}
	fclose(f);

	// all-pairs forward distance (BFS)
	new q[MAX_NODES];
	for (new s = 0; s < g_nodeCount; s++)
	{
		for (new i = 0; i < g_nodeCount; i++) g_dist[s][i] = 999;
		g_dist[s][s] = 0;
		new qh = 0, qt = 0; q[qt++] = s;
		while (qh < qt)
		{
			new u = q[qh++];
			for (new k = 0; k < g_nodeNextN[u]; k++)
			{
				new v = g_nodeNext[u][k];
				if (g_dist[s][v] == 999) { g_dist[s][v] = g_dist[s][u] + 1; q[qt++] = v; }
			}
		}
	}
	g_candCount = 0;
	for (new i = 0; i < g_nodeCount; i++)
		if (g_nodeType[i] == NT_BLUE && g_dist[g_startNode][i] >= 4 && g_nodeNextN[i] == 1)
			g_candidates[g_candCount++] = i;
	dbg("Board %s loaded: %d spaces, %d hostage spots.", map, g_nodeCount, g_candCount);
}

spawn_board_entities()
{
	g_cam = create_entity("info_target");
	if (g_cam)
	{
		entity_set_string(g_cam, EV_SZ_classname, "csp_camera");
		entity_set_model(g_cam, "models/rpgrocket.mdl");
		entity_set_size(g_cam, Float:{0.0,0.0,0.0}, Float:{0.0,0.0,0.0});
		entity_set_int(g_cam, EV_INT_movetype, MOVETYPE_NOCLIP);
		entity_set_int(g_cam, EV_INT_solid, SOLID_NOT);
		entity_set_int(g_cam, EV_INT_rendermode, kRenderTransColor);
		entity_set_float(g_cam, EV_FL_renderamt, 0.0);
	}
	g_hostageEnt = create_entity("info_target");
	if (g_hostageEnt)
	{
		entity_set_string(g_hostageEnt, EV_SZ_classname, "csp_hostage");
		entity_set_model(g_hostageEnt, "models/hostage.mdl");
		entity_set_int(g_hostageEnt, EV_INT_solid, SOLID_NOT);
		entity_set_int(g_hostageEnt, EV_INT_movetype, MOVETYPE_NONE);
		entity_set_int(g_hostageEnt, EV_INT_effects, EF_NODRAW);
		entity_set_int(g_hostageEnt, EV_INT_sequence, 0);
		entity_set_float(g_hostageEnt, EV_FL_framerate, 1.0);
		entity_set_float(g_hostageEnt, EV_FL_animtime, get_gametime());
		entity_set_int(g_hostageEnt, EV_INT_renderfx, kRenderFxGlowShell);
		entity_set_vector(g_hostageEnt, EV_VEC_rendercolor, Float:{255.0, 210.0, 90.0});
		entity_set_float(g_hostageEnt, EV_FL_renderamt, 8.0);
	}
	for (new i = 0; i < MAX_NODES; i++) g_trapEnt[i] = 0;
	for (new i = 0; i < g_nodeCount; i++)
	{
		new mdl[48], Float:lift = 30.0, bool:spin = true;
		switch (g_nodeType[i])
		{
			case NT_SHOP:   copy(mdl, charsmax(mdl), g_nodeShopSide[i] == SIDE_T ? "models/w_ak47.mdl" : "models/w_m4a1.mdl");
			case NT_CAMPER: { copy(mdl, charsmax(mdl), "models/w_awp.mdl"); lift = 4.0; spin = false; }
			case NT_ARMORY: copy(mdl, charsmax(mdl), "models/w_kevlar.mdl");
			case NT_DUEL:   copy(mdl, charsmax(mdl), "models/w_deagle.mdl");
			case NT_NEGOT:  copy(mdl, charsmax(mdl), "models/w_backpack.mdl");
			case NT_VIP:    { copy(mdl, charsmax(mdl), "models/player/vip/vip.mdl"); lift = 36.0; spin = false; }
			default: continue;
		}
		new e = create_entity("info_target");
		if (!e) continue;
		entity_set_string(e, EV_SZ_classname, "csp_prop");
		entity_set_model(e, mdl);
		entity_set_int(e, EV_INT_solid, SOLID_NOT);
		entity_set_int(e, EV_INT_movetype, MOVETYPE_NOCLIP);
		new Float:o[3]; o = g_nodePos[i]; o[2] += lift;
		// park props a little off the space so pawns don't stand inside them
		new m = g_nodeNext[i][0], Float:d[3]; xs_vec_sub_simple(g_nodePos[m], g_nodePos[i], d);
		new Float:l = vector_length(d); if (l > 1.0) { o[0] -= d[1] / l * 34.0; o[1] += d[0] / l * 34.0; }
		entity_set_origin(e, o);
		if (spin) entity_set_vector(e, EV_VEC_avelocity, Float:{0.0, 60.0, 0.0});
		if (g_nodeType[i] == NT_VIP) { entity_set_float(e, EV_FL_framerate, 1.0); entity_set_float(e, EV_FL_animtime, get_gametime()); }
		entity_set_int(e, EV_INT_renderfx, kRenderFxGlowShell);
		new Float:col[3]; col[0] = 255.0; col[1] = 255.0; col[2] = 255.0;
		if (g_nodeType[i] == NT_SHOP) { col[0] = 127.0; col[1] = 211.0; col[2] = 107.0; }
		if (g_nodeType[i] == NT_CAMPER) { col[0] = 200.0; col[1] = 30.0; col[2] = 20.0; }
		entity_set_vector(e, EV_VEC_rendercolor, col);
		entity_set_float(e, EV_FL_renderamt, 4.0);
		g_propEnt[i] = e;
	}
	// a solid hex tile on the floor of every space: one skin per space type (models/csp_tile.mdl, NT_* order),
	// fullbright so map lighting can't wash it out, label turned to read along the path
	for (new i = 0; i < g_nodeCount; i++)
	{
		g_tileEnt[i] = 0;
		new e = create_entity("info_target");
		if (!e) continue;
		entity_set_string(e, EV_SZ_classname, "csp_tile");
		entity_set_model(e, "models/csp_tile.mdl");
		entity_set_int(e, EV_INT_solid, SOLID_NOT);
		entity_set_int(e, EV_INT_movetype, MOVETYPE_NONE);
		new Float:o[3]; o = g_nodePos[i]; o[2] += 0.5;
		entity_set_origin(e, o);
		new m = g_nodeNext[i][0], Float:d[3], Float:ang[3]; xs_vec_sub_simple(g_nodePos[m], g_nodePos[i], d); d[2] = 0.0;
		if (vector_length(d) > 1.0) { vector_to_angle(d, ang); ang[0] = 0.0; ang[2] = 0.0; entity_set_vector(e, EV_VEC_angles, ang); }
		entity_set_int(e, EV_INT_skin, g_nodeType[i]);
		g_tileEnt[i] = e;
	}
	for (new k = 0; k < 3; k++)
	{
		new e = create_entity("info_target");
		if (!e) continue;
		entity_set_string(e, EV_SZ_classname, "csp_dice");
		entity_set_model(e, "models/csp_dice.mdl");
		entity_set_size(e, Float:{-18.0, -18.0, -18.0}, Float:{18.0, 18.0, 18.0});
		entity_set_int(e, EV_INT_solid, SOLID_NOT);
		entity_set_int(e, EV_INT_movetype, MOVETYPE_NOCLIP);
		entity_set_int(e, EV_INT_effects, EF_NODRAW);
		g_diceEnt[k] = e;
	}
	map_overlay_spawn();
}

// colored hexagon on the floor of every space, redrawn before it fades
public task_rings()
{
	new Float:now = get_gametime();
	if (g_nodeCount == 0 || g_boardHidden || !get_cvar_num("csp_rings") || (now - g_ringsAt) < ring_every() && g_ringsAt > 0.0) return;
	g_ringsAt = now;
	// one space per 0.1 s (AMXX's real timer resolution; "0.03 apart" bunched ~45 beams into each frame).
	// A client that renders slowly gets few server packets, and a burst like that overflows its 4 KB datagram.
	for (new i = 0; i < g_nodeCount; i++) set_task(0.1 * float(i + 1), "task_ring_one", TASK_RINGS + 1 + i);
}

public task_ring_one(taskid)
{
	new n = taskid - TASK_RINGS - 1;
	if (n < 0 || n >= g_nodeCount) return;
	new Float:a[3], Float:c[3];   // the tiles mark the spaces; beams only draw the path between them
	// dotted link toward the next space(s)
	for (new k = 0; k < g_nodeNextN[n]; k++)
	{
		new m = g_nodeNext[n][k];
		new Float:d[3]; xs_vec_sub_simple(g_nodePos[m], g_nodePos[n], d);
		new Float:len = vector_length(d);
		if (len < 1.0) continue;
		for (new j = 1; j < 4; j++)
		{
			new Float:f0 = (float(j) / 4.0) - (6.0 / len), Float:f1 = (float(j) / 4.0) + (6.0 / len);
			a[0] = g_nodePos[n][0] + d[0] * f0; a[1] = g_nodePos[n][1] + d[1] * f0; a[2] = g_nodePos[n][2] + d[2] * f0 + 1.0;
			c[0] = g_nodePos[n][0] + d[0] * f1; c[1] = g_nodePos[n][1] + d[1] * f1; c[2] = g_nodePos[n][2] + d[2] * f1 + 1.0;
			beam(a, c, 185, 159, 108, 6);
		}
	}
}

// redraw period: every space gets one 0.1 s slot, plus slack; beams live a little longer than that
Float:ring_every() { new Float:t = 0.1 * float(g_nodeCount) + 1.5; return t < 6.0 ? 6.0 : t; }

xs_vec_sub_simple(const Float:a[3], const Float:b[3], Float:out[3]) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; }

beam(const Float:a[3], const Float:b[3], r, g, bl, width)
{
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_BEAMPOINTS);
	engfunc(EngFunc_WriteCoord, a[0]); engfunc(EngFunc_WriteCoord, a[1]); engfunc(EngFunc_WriteCoord, a[2]);
	engfunc(EngFunc_WriteCoord, b[0]); engfunc(EngFunc_WriteCoord, b[1]); engfunc(EngFunc_WriteCoord, b[2]);
	write_short(g_beamSpr); write_byte(0); write_byte(0);
	write_byte(floatround(ring_every() * 10.0) + 20);   // a bit longer than the redraw period
	write_byte(width); write_byte(0);
	write_byte(r); write_byte(g); write_byte(bl);
	write_byte(255); write_byte(0);
	message_end();
}

// ------------------------------------------------------------- seating --
public cmd_menu(id) { new s = seat_of(id); if (s >= 0 && s == g_cur && g_state == ST_BOARD && !g_diceOpen) show_turn_menu(s); return PLUGIN_HANDLED; }
public cmd_help(id) { show_motd(id, "motd.txt", "CS Party"); return PLUGIN_HANDLED; }
public cmd_start_client(id) { if (g_state == ST_IDLE) { lobby_close(); match_start(); } return PLUGIN_HANDLED; }
public cmd_start() { lobby_close(); match_start(); return PLUGIN_HANDLED; }

// ---------------------------------------------------------------- board picker --
// Every map with a board .ini (and the .bsp to go with it) can host a match. Between matches anyone
// can switch: say /board, or csp_board <map> from the server.
list_boards(names[][32], max)
{
	new cfg[96], dir[128], file[64], n = 0;
	get_configsdir(cfg, charsmax(cfg));
	formatex(dir, charsmax(dir), "%s/cs_party/boards", cfg);
	new h = open_dir(dir, file, charsmax(file));
	if (!h) return 0;
	do {
		new len = strlen(file);
		if (len < 5 || !equali(file[len - 4], ".ini") || n >= max) continue;
		file[len - 4] = 0;
		new bsp[80]; formatex(bsp, charsmax(bsp), "maps/%s.bsp", file);
		if (!file_exists(bsp)) continue;
		new at = n++;                                        // keep the list sorted
		while (at > 0 && strcmp(names[at - 1], file) > 0) { copy(names[at], 31, names[at - 1]); at--; }
		copy(names[at], 31, file);
	} while (next_file(h, file, charsmax(file)));
	close_dir(h);
	return n;
}

bool:switch_board(const map[])
{
	if (g_state != ST_IDLE) return false;
	new cur[32]; get_mapname(cur, charsmax(cur));
	if (equali(cur, map)) return true;
	new names[NAV_MAX - 1][32], n = list_boards(names, sizeof names), ok = false;
	for (new i = 0; i < n; i++) if (equali(names[i], map)) ok = true;
	if (!ok) return false;
	announce("Next board: %s. Changing map...", map);
	new arg[32]; copy(arg, charsmax(arg), map);
	set_task(3.0, "task_changelevel_board", TASK_FLOW, arg, sizeof arg);
	return true;
}
public task_changelevel_board(const map[]) { server_cmd("changelevel %s", map); }

public cmd_board_srv()
{
	new map[32]; read_argv(1, map, charsmax(map));
	if (!switch_board(map)) server_print("[CSP] can't switch to %s (match running, or no board/bsp for it)", map);
	return PLUGIN_HANDLED;
}

public cmd_board(id)
{
	if (g_state != ST_IDLE) { client_print(id, print_chat, "[CS Party] The board can only change between matches."); return PLUGIN_HANDLED; }
	new names[NAV_MAX - 1][32], n = list_boards(names, sizeof names), cur[32], line[64];
	get_mapname(cur, charsmax(cur));
	new m = menu_create("\yPick a board", "mh_board");
	for (new i = 0; i < n; i++)
	{
		formatex(line, charsmax(line), equali(names[i], cur) ? "%s \d(this one)" : "%s", names[i]);
		menu_additem(m, line, names[i]);
	}
	menu_additem(m, "Done", "0");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_board");
	return PLUGIN_HANDLED;
}

public mh_board(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;
	new info[32], acc, name[2], cb;
	if (item >= 0) menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb);
	menu_destroy(m);
	if (item >= 0 && !equal(info, "0")) switch_board(info);
	return PLUGIN_HANDLED;
}
public cmd_stop() { match_abort(); return PLUGIN_HANDLED; }

public cmd_probe()
{
	server_print("[CSP] probe state=%d freeze=%d", g_state, get_member_game(m_bFreezePeriod));
	for (new s = 0; s < SEATS; s++)
	{
		new id = g_seatPlayer[s];
		if (!is_user_connected(id)) { server_print("[CSP] probe seat%d %s: not connected", s, g_seatName[s]); continue; }
		new Float:o[3]; entity_get_vector(id, EV_VEC_origin, o);
		new Float:v[3]; entity_get_vector(id, EV_VEC_velocity, v);
		server_print("[CSP] probe seat%d %s: id=%d team=%d join=%d menu=%d obs=%d dead=%d spawns=%d", s, g_seatName[s], id, get_member(id, m_iTeam), get_member(id, m_iJoiningState), get_member(id, m_iMenu), entity_get_int(id, EV_INT_iuser1), entity_get_int(id, EV_INT_deadflag), get_member(id, m_iNumSpawns));
		server_print("[CSP] probe seat%d %s: alive=%d solid=%d onground=%d frozen=%d maxspd=%.0f vel=%.0f %.0f clear=%d pos=%.0f %.0f %.0f", s, g_seatName[s], is_user_alive(id),
			entity_get_int(id, EV_INT_solid), (entity_get_int(id, EV_INT_flags) & FL_ONGROUND) != 0, (entity_get_int(id, EV_INT_flags) & FL_FROZEN) != 0,
			get_entvar(id, var_maxspeed), v[0], v[1], spot_clear(o), o[0], o[1], o[2]);
	}
	return PLUGIN_HANDLED;
}

new g_forceMg = -1;
public cmd_force_mg() { new a[8]; read_argv(1, a, charsmax(a)); g_forceMg = str_to_num(a); server_print("[CSP] next minigame forced to %d", g_forceMg); return PLUGIN_HANDLED; }

public cmd_nocam() { remove_task(TASK_CAM); release_cameras(); server_print("[CSP] camera released"); return PLUGIN_HANDLED; }

// dev: skip the board and go straight to a minigame map. csp_test_remote <mg index> [1v3]
// 1v3 puts seat 0 alone on T against the other three.
public cmd_test_remote()
{
	new a[8]; read_argv(1, a, charsmax(a)); new mg = str_to_num(a);
	if (mg < 0 || mg >= MG_COUNT || !MG_MAP[mg][0]) { server_print("[CSP] not a map minigame"); return PLUGIN_HANDLED; }
	if (g_state == ST_IDLE) { match_start(); remove_task(TASK_FLOW); }
	if (g_state == ST_IDLE) return PLUGIN_HANDLED;
	new f[8]; read_argv(2, f, charsmax(f)); new bool:solo = bool:equal(f, "1v3");
	g_mg = mg; g_mgFmt = solo ? FMT_1V3 : FMT_FFA; g_cont = CONT_NEXT_TURN;
	for (new s = 0; s < SEATS; s++) { g_mgIn[s] = true; g_mgSide[s] = (solo && s == 0) ? SIDE_T : SIDE_CT; }
	go_remote();
	return PLUGIN_HANDLED;
}

public cmd_spec()
{
	for (new id = 1; id <= MaxClients; id++)
		if (is_user_connected(id) && !is_user_bot(id)) client_cmd(id, "jointeam 6");
	return PLUGIN_HANDLED;
}

public cmd_stuff()
{
	new who[32], line[128]; read_argv(1, who, charsmax(who)); read_args(line, charsmax(line));
	new id = find_player("bl", who); if (!id) { server_print("[CSP] no player %s", who); return PLUGIN_HANDLED; }
	replace(line, charsmax(line), who, ""); trim(line); remove_quotes(line);
	client_cmd(id, "%s", line); server_print("[CSP] stuffed %s: %s", who, line);
	return PLUGIN_HANDLED;
}

public cmd_botname()
{
	new nm[32]; read_argv(1, nm, charsmax(nm));
	for (new id = 1; id <= MaxClients; id++) if (is_user_connected(id) && is_user_bot(id) && seat_of(id) < 0) { set_user_info(id, "name", nm); return PLUGIN_HANDLED; }
	for (new id = 1; id <= MaxClients; id++) if (is_user_connected(id) && is_user_bot(id)) { set_user_info(id, "name", nm); break; }
	return PLUGIN_HANDLED;
}

public cmd_state()
{
	server_print("[CSP] state=%d turn=%d/%d cur=%d hostage=%d", g_state, g_turn, g_maxTurns, g_cur, g_hostage);
	for (new s = 0; s < SEATS; s++)
	{
		new who[32] = "-"; if (g_seatPlayer[s] && is_user_connected(g_seatPlayer[s])) get_user_name(g_seatPlayer[s], who, charsmax(who));
		server_print("[CSP]  seat%d %s (%s) owner=%s player=%s%s pos=%d $%d *%d W%d items=%d streak=%d", s, g_seatName[s], SKIN_NAME[g_seatSkin[s]],
			g_seatOwner[s][0] ? g_seatOwner[s] : "-", who, (g_seatPlayer[s] && is_user_connected(g_seatPlayer[s]) && is_user_bot(g_seatPlayer[s])) ? "[bot]" : "",
			g_pos[s], g_money[s], g_stars[s], g_mgWins[s], g_itemN[s], g_streak[s]);
	}
	return PLUGIN_HANDLED;
}

match_start()
{
	if (g_nodeCount == 0) { server_print("[CSP] No board for this map."); return; }
	if (g_state != ST_IDLE) { server_print("[CSP] Match already running."); return; }
	new players[32], n; get_players(players, n, "h");     // humans first, then bots
	new seat = 0;
	for (new pass = 0; pass < 2 && seat < SEATS; pass++)
	{
		for (new i = 0; i < n && seat < SEATS; i++)
		{
			new id = players[i];
			if (!is_user_connected(id)) continue;
			if ((pass == 0) == bool:is_user_bot(id))   // pass 0 humans, pass 1 bots
				continue;
			new TeamName:tm = get_member(id, m_iTeam);
			if (tm != TEAM_TERRORIST && tm != TEAM_CT) continue;   // spectators watch, they don't get a seat
			g_seatPlayer[seat] = id; g_seatBot[seat] = bool:is_user_bot(id);
			get_user_name(id, g_seatName[seat], charsmax(g_seatName[]));
			if (is_user_bot(id)) g_seatOwner[seat][0] = 0;
			else { name_key(g_seatName[seat], g_seatOwner[seat], charsmax(g_seatOwner[])); copy(g_seatName[seat], charsmax(g_seatName[]), g_seatOwner[seat]); }
			seat++;
		}
	}
	if (seat < SEATS) { server_print("[CSP] Need %d players (bots count). Have %d. Try bot_quota 4.", SEATS, seat); return; }

	// Characters: a human's pick from the join screen (setinfo _csp_char 0-7) is honoured first come, first
	// served in seat order; everyone else, and anyone whose pick was taken, draws from what's left.
	new skins[SK_COUNT]; for (new i = 0; i < SK_COUNT; i++) skins[i] = i;
	for (new i = SK_COUNT - 1; i > 0; i--) { new j = random(i + 1), t = skins[i]; skins[i] = skins[j]; skins[j] = t; }
	new bool:taken[SK_COUNT], want[SEATS];
	for (new s = 0; s < SEATS; s++)
	{
		want[s] = g_seatBot[s] ? -1 : char_pick(g_seatPlayer[s]);
		if (want[s] >= 0 && taken[want[s]]) { client_print(g_seatPlayer[s], print_chat, "[CS Party] %s was already picked. You got a random character.", SKIN_NAME[want[s]]); want[s] = -1; }
		if (want[s] >= 0) taken[want[s]] = true;
	}
	for (new s = 0, k = 0; s < SEATS; s++)
	{
		if (want[s] < 0) { while (taken[skins[k]]) k++; want[s] = skins[k]; taken[want[s]] = true; }
	}
	for (new s = 0; s < SEATS; s++)
	{
		g_seatSkin[s] = want[s];
		g_money[s] = get_pcvar_num(c_start); g_maxMoney[s] = g_money[s]; g_spent[s] = 0; g_moved[s] = 0; g_c4Take[s] = 0;
		g_stars[s] = 0; g_itemN[s] = 0; g_streak[s] = 0; g_mgWins[s] = 0; g_reds[s] = 0;
		g_pos[s] = g_startNode; g_lastColor[s] = SIDE_NONE; g_flashed[s] = 0; g_smoke[s] = false; g_extraCrates[s] = 0; g_rigged[s] = 0;
		g_gPrim[s] = -1; g_gSec[s] = -1; g_gArmor[s] = 0; g_gFlash[s] = 0; g_gHE[s] = 0; g_gSmoke[s] = 0; g_gKit[s] = false;
	}
	for (new i = 0; i < MAX_NODES; i++) g_traps[i] = -1;
	g_turn = 1; g_maxTurns = get_pcvar_num(c_turns); g_cur = 0;
	for (new k = 0; k < SEATS; k++) { g_waitKind[k] = W_NONE; g_waitLast[k] = W_NONE; }
	move_hostage();
	save_cvars();
	apply_match_cvars();
	announce("Match start. %d turns. Hostages are in %s.", g_maxTurns, g_nodeArea[g_hostage]);
	client_cmd(0, "echo CSP_THEME_STOP");
	draw_awards();
	for (new s = 0; s < SEATS; s++) announce("%s plays %s.", g_seatName[s], SKIN_NAME[g_seatSkin[s]]);
	enter_board();
	set_task(spd(4.0), "flow_begin_seat", TASK_FLOW);
}

apply_match_cvars()
{
	set_cvar_num("mp_autoteambalance", 0); set_cvar_num("mp_limitteams", 0);   // or zBot kicks seated bots to "balance" our sides
	set_cvar_num("mp_autokick", 0);                                          // watching the board is "idle" to CS
	set_cvar_num("mp_freezetime", 0); set_cvar_num("mp_freezetime_jump", 1);  // crates need jumps; minigames get an intro card instead
	set_cvar_num("bot_join_after_player", 0);
	set_cvar_num("mp_timelimit", 0); set_cvar_num("mp_maxrounds", 0);         // game.cfg's 20-minute rotation would eat the board mid-party
	set_cvar_num("mp_winlimit", 0);
	set_cvar_num("sv_maxupdaterate", 60); set_cvar_num("sv_minupdaterate", 30);   // the director camera is an entity: smooth needs updates
}

match_abort()
{
	if (g_state == ST_IDLE) return;
	remove_task(TASK_FLOW); remove_task(TASK_CAM); remove_task(TASK_DICE); remove_task(TASK_RACE); g_hopActive = false;
	remove_task(TASK_RACE + 1); remove_task(TASK_RACE + 2);   // a running race and its changelevel
	for (new k = 0; k < SEATS; k++) { g_waitKind[k] = W_NONE; g_waitLast[k] = W_NONE; }
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id)) continue;
		if (g_navMenu[id]) { g_wdCancel = true; menu_cancel(id); g_wdCancel = false; }
		nav_end(id); show_menu(id, 0, " ", 0);
		if (g_lateSpec[id]) set_task(2.0, "task_autojoin", TASK_RACE + 100 + id);   // the match they waited out is over
	}
	delete_state();
	for (new k = 0; k < 3; k++) if (is_valid_ent(g_diceEnt[k])) entity_set_int(g_diceEnt[k], EV_INT_effects, EF_NODRAW);
	g_state = ST_IDLE;
	board_music(false);
	restore_cvars();
	clear_traps();
	entity_set_int(g_hostageEnt, EV_INT_effects, EF_NODRAW);
	for (new s = 0; s < SEATS; s++) if (is_user_connected(g_seatPlayer[s])) { attach_view(g_seatPlayer[s], g_seatPlayer[s]); unfreeze(g_seatPlayer[s]); }
	announce("Match stopped.");
	// stopped on a race map: there's no board here, so the next /party would fail. Go back to the board.
	if (g_nodeCount == 0) set_task(3.0, "task_abort_home", TASK_FLOW);
}
public task_abort_home()
{
	new home[32] = "de_dust2";
	if (g_boardMap[0] && !equal(g_boardMap, "csp_", 4)) copy(home, charsmax(home), g_boardMap);
	announce("Back to %s.", home);
	server_cmd("changelevel %s", home);
}

// Board music: the browser page loops the board tracks on CSP_MUSIC_BOARD and fades them out on CSP_MUSIC_OFF
// (minigames, the results, a stopped match). Anyone joining while the board is up gets the cue again; that
// includes everyone reconnecting across the changelevel back from an own-map minigame.
new bool:g_boardMusic;
board_music(bool:on)
{
	g_boardMusic = on;
	if (on) client_cmd(0, "echo CSP_MUSIC_BOARD");
	else client_cmd(0, "echo CSP_MUSIC_OFF");
}
public task_music_cue(taskid)
{
	new id = taskid - TASK_RACE - 220;
	if (g_boardMusic && is_user_connected(id)) client_cmd(id, "echo CSP_MUSIC_BOARD");
}

new Float:g_seatLeftAt[SEATS];
// new humans skip the team and class menus: a party server just seats you
public client_putinserver(id)
{
	g_xhHidden[id] = false;
	if (is_user_bot(id)) return;
	set_task(0.5, "task_name_fix", id + TASK_RACE + 140);
	set_task(2.0, "task_hudscale", id);
	set_task(4.0, "task_music_cue", id + TASK_RACE + 220);
	if (!get_pcvar_num(c_autojoin)) return;
	set_task(3.0, "task_autojoin", id + TASK_RACE + 100);
}

// zBot's name list has real names in it. If a bot already wears yours when you join, the engine makes you
// "(1)Alex". Humans win: the bot gets renamed and you get your name back (and your seat, by name).
public task_name_fix(taskid)
{
	new id = taskid - TASK_RACE - 140;
	if (!is_user_connected(id)) return;
	new nm[32], key[32]; get_user_name(id, nm, charsmax(nm)); name_key(nm, key, charsmax(key));
	if (equal(nm, key) || !key[0]) return;
	for (new p = 1; p <= MaxClients; p++)
	{
		if (p == id || !is_user_connected(p)) continue;
		new pn[32]; get_user_name(p, pn, charsmax(pn));
		if (!equal(pn, key)) continue;
		if (!is_user_bot(p)) return;                       // another human really is called that
		new alt[32]; formatex(alt, charsmax(alt), "%.27s II", key);
		set_user_info(p, "name", alt);
		new s = seat_of(p); if (s >= 0 && !g_seatOwner[s][0]) copy(g_seatName[s], charsmax(g_seatName[]), alt);
	}
	set_user_info(id, "name", key);
	dbg("%s had their name taken by a bot; renamed back.", key);
}

// A human who (re)joins mid-match, after a map change, an alt-tab or a dropped connection, must get a seat
// whether or not the engine ever shows the team panel (browser clients often don't). Without one the spawn
// hook slays them and they sit in a spectator view that can't see their own pawn.
bool:seat_returning(id)
{
	if (g_state == ST_IDLE || is_user_bot(id) || !is_user_connected(id) || seat_of(id) >= 0) return false;
	for (new k = 0; k < SEATS; k++) if (seat_owner_back(k) == id)
	{
		new cur = g_seatPlayer[k];
		if (!cur || !is_user_connected(cur)) reclaim_seat(k, id);
		else seat_join(id, k);
		return true;
	}
	return false;
}

public task_seat_watch()
{
	if (g_state != ST_IDLE) for (new id = 1; id <= MaxClients; id++) seat_settle(id);
	if (g_state == ST_IDLE || g_state == ST_MINIGAME || g_state == ST_MG_INTRO || g_state == ST_MG_RESULT) return;
	static Float:lastFix[33];
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id)) continue;
		new s = seat_of(id);
		if (s < 0)
		{
			if (seat_returning(id)) { dbg("%n was unseated: gave their seat back.", id); continue; }
			new TeamName:tm = get_member(id, m_iTeam);
			if (!g_lateSpec[id] && tm != TEAM_SPECTATOR && !task_exists(TASK_RACE + 180 + id)) set_task(0.3, "task_late_spectate", TASK_RACE + 180 + id);
			else if (g_lateSpec[id]) reclaim_ready();
			continue;
		}
		new TeamName:tm = get_member(id, m_iTeam);
		if (tm != TEAM_TERRORIST && tm != TEAM_CT) { dbg("%n has a seat but no team: joining.", id); seat_join(id, s); continue; }
		if (!is_user_alive(id) && (g_state == ST_BOARD || g_state == ST_RESUME || g_state == ST_REMOTE_WAIT) && get_gametime() - lastFix[id] > 3.0)
		{
			lastFix[id] = get_gametime();
			dbg("%n (seat %d) is dead outside a fight: respawning.", id, s);
			rg_round_respawn(id);
		}
	}
}

public task_autojoin(taskid)
{
	new id = taskid - TASK_RACE - 100;
	if (!is_user_connected(id)) return;
	if (seat_returning(id)) return;
	new TeamName:tm = get_member(id, m_iTeam);
	if (tm == TEAM_TERRORIST || tm == TEAM_CT) return;
	if (tm == TEAM_SPECTATOR && !(g_lateSpec[id] && g_state == ST_IDLE)) return;   // real spectators stay put
	g_lateSpec[id] = false;
	new t = 0, ct = 0;
	for (new p = 1; p <= MaxClients; p++)
	{
		if (!is_user_connected(p) || p == id) continue;
		new TeamName:pt = get_member(p, m_iTeam);
		if (pt == TEAM_TERRORIST) t++; else if (pt == TEAM_CT) ct++;
	}
	rg_join_team(id, t <= ct ? TEAM_TERRORIST : TEAM_CT);
	rg_internal_cmd(id, "joinclass", "5");
	log_amx("%n auto-joins %s", id, t <= ct ? "TERRORIST" : "CT");   // rg_join_team doesn't write the usual "joined team" line
	set_member(id, m_iMenu, 0);
	show_menu(id, 0, " ", 0);
	if (g_state == ST_IDLE && get_pcvar_num(c_autostart) > 0) lobby_open();
	else client_print(id, print_center, "You're in. Say /party to start, or wait for the host.");
}

// a party server never plays plain CS: the first human opens a frozen lobby that counts down into the match
lobby_open()
{
	if (g_lobby) return;
	g_lobby = true; g_lobbyLeft = get_pcvar_num(c_autostart);
	set_cvar_num("bot_stop", 1);
	set_task(1.0, "task_lobby", TASK_LOBBY, _, _, "b");
	task_lobby();
}
lobby_close()
{
	if (!g_lobby) return;
	g_lobby = false; remove_task(TASK_LOBBY);
	set_cvar_num("bot_stop", 0);
	for (new id = 1; id <= MaxClients; id++) if (is_user_alive(id)) unfreeze(id);
}
public task_lobby()
{
	if (g_state != ST_IDLE) { g_lobby = false; remove_task(TASK_LOBBY); return; }
	for (new id = 1; id <= MaxClients; id++) if (is_user_alive(id)) freeze(id);
	if (g_lobbyLeft > 0)
	{
		set_hudmessage(255, 211, 107, -1.0, 0.3, 0, 0.0, 1.1, 0.0, 0.0, -1);
		show_hudmessage(0, "CS PARTY^nThe board starts in %d", g_lobbyLeft);
		g_lobbyLeft--;
		return;
	}
	lobby_close();
	match_start();
	if (g_state == ST_IDLE) lobby_open();   // not enough seats yet: keep everyone frozen and try again
}

public task_hudscale(id)
{
	new v = get_pcvar_num(c_hudscale);
	if (v > 0 && is_user_connected(id)) client_cmd(id, "hud_scale %d", v);
}

// Crosshair is only shown to whoever is acting; everyone else watches the board without it
update_crosshair()
{
	static msg; if (!msg) msg = get_user_msgid("HideWeapon");
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id)) continue;
		new bool:hide = (g_state == ST_BOARD && seat_of(id) != g_cur);
		if (hide == g_xhHidden[id] && !hide) continue;
		g_xhHidden[id] = hide;
		message_begin(MSG_ONE, msg, _, id); write_byte(hide ? (1 << 6) : 0); message_end();
	}
}

// Anyone who drops out of a fight while alive leaves their side a player short: a spare bot takes their place,
// where they stood, with their health. When a human leaves this LAN server, Steam answers with a "deny" that
// ReHLDS (API 3.10, too old to hook SV_DropClient) turns into dropping every bot too ("Client dropped by server").
// Mid-fight that emptied both sides: nobody won and the map changed back. bot_quota refills within a second.
new bool:g_standin[SEATS], g_standinTries[SEATS], Float:g_dropAt[SEATS][3], Float:g_dropAng[SEATS][3], Float:g_dropHp[SEATS];

public client_disconnected(id)
{
	g_xhHidden[id] = false;
	g_navMenu[id] = 0; g_navThawed[id] = false; g_navMove[id] = 0.0; g_lateSpec[id] = false;
	for (new s = 0; s < SEATS; s++)
	{
		if (g_seatPlayer[s] != id) continue;
		g_seatPlayer[s] = 0;
		g_seatLeftAt[s] = get_gametime();
		if (!g_seatBot[s]) dbg("%s dropped; holding seat %d for them.", g_seatName[s], s);
		if (g_state == ST_MINIGAME && !g_mgDone && g_mgIn[s] && is_user_alive(id))
		{
			entity_get_vector(id, EV_VEC_origin, g_dropAt[s]); entity_get_vector(id, EV_VEC_v_angle, g_dropAng[s]);
			g_dropHp[s] = Float:get_entvar(id, var_health);
			g_standin[s] = true; g_standinTries[s] = 0;
			set_task(0.5, "task_fight_standin", TASK_RACE + 320 + s, _, _, "b");
		}
	}
}

public task_fight_standin(taskid)
{
	new s = taskid - TASK_RACE - 320;
	new id = g_seatPlayer[s];
	if (id && is_user_connected(id) && !is_user_bot(id)) id = -1;   // its human is back: they sit this fight out
	if (g_state != ST_MINIGAME || g_mgDone || id < 0 || ++g_standinTries[s] > 20)
	{
		g_standin[s] = false; remove_task(taskid);
		if (g_state == ST_MINIGAME && !g_mgDone) rg_check_win_conditions();   // a round end held for the stand-in can happen now
		return;
	}
	// refill_seats may have seated a fresh bot already; it doesn't put it in the fight
	if (!id || !is_user_connected(id))
	{
		id = 0;
		for (new k = 1; k <= MaxClients && !id; k++)
		{
			if (!is_user_connected(k) || !is_user_bot(k) || seat_of(k) >= 0) continue;
			new TeamName:tm = get_member(k, m_iTeam);
			if (tm == TEAM_TERRORIST || tm == TEAM_CT) id = k;
		}
		if (!id) return;
		g_seatPlayer[s] = id;
	}
	new nm[32]; stand_in_name(s, nm, charsmax(nm));
	set_user_info(id, "name", nm);
	new TeamName:team = (g_mgFmt == FMT_FFA || g_mgFmt == FMT_DUEL) ? ((s % 2) ? TEAM_TERRORIST : TEAM_CT) : (g_mgSide[s] == SIDE_CT ? TEAM_CT : TEAM_TERRORIST);
	rg_set_user_team(id, team, MODEL_UNASSIGNED, true, false);
	g_standin[s] = false; remove_task(taskid);
	rg_round_respawn(id);   // the spawn hook hands out the minigame's model and loadout
	// a side that emptied for a moment makes CS wait for players again; the next kill would then "commence" the game as a draw
	set_member_game(m_bNeededPlayers, false); set_member_game(m_bGameStarted, true);
	if (is_user_alive(id))
	{
		entity_set_origin(id, g_dropAt[s]);
		entity_set_vector(id, EV_VEC_angles, g_dropAng[s]); entity_set_vector(id, EV_VEC_v_angle, g_dropAng[s]); entity_set_int(id, EV_INT_fixangle, 1);
		set_entvar(id, var_health, g_dropHp[s]);
	}
	if (!g_seatBot[s]) announce("%s fights on for %s.", nm, g_seatName[s]);
	else dbg("%s is back in the fight (seat %d).", nm, s);
}

// a human seat is held for 60 seconds before a bot can take it over
bool:seat_held(s) { return !g_seatBot[s] && g_seatLeftAt[s] > 0.0 && get_gametime() - g_seatLeftAt[s] < 60.0; }

// a seated player coming back from a map change never sees the team/class panels: they're seated already
public hc_show_vgui_menu(const id, VGUIMenu:menuType, const bitsSlots, szOldMenu[])
{
	if (menuType != VGUI_Menu_Team && menuType != VGUI_Menu_Class_T && menuType != VGUI_Menu_Class_CT) return HC_CONTINUE;
	if (get_pcvar_num(c_debug) > 1) dbg("vgui menu %d for %n (state %d, seat %d)", menuType, id, g_state, seat_of(id));
	// With auto-join on, nobody ever sees the team/class panels. Besides being pointless here, on the
	// browser client they're dialogs in the menu DLL that keep the keyboard after the server has already
	// placed the player, so the turn menu's number keys go nowhere.
	if (get_pcvar_num(c_autojoin) && !is_user_bot(id) && g_state == ST_IDLE)
	{
		if (menuType == VGUI_Menu_Team && !task_exists(TASK_RACE + 100 + id)) set_task(0.5, "task_autojoin", TASK_RACE + 100 + id);
		return HC_SUPERCEDE;   // class panels: whoever joined them follows up with joinclass
	}
	if (g_state == ST_IDLE) return HC_CONTINUE;
	new s = seat_of(id);
	if (s < 0) for (new k = 0; k < SEATS; k++) if (seat_owner_back(k) == id)
	{
		new cur = g_seatPlayer[k];
		if (!cur || !is_user_connected(cur)) reclaim_seat(k, id);   // nobody in it: take it back now
		else seat_join(id, k);                                        // a stand-in bot has it: reclaim_ready swaps at a safe moment
		return HC_SUPERCEDE;
	}
	if (s < 0)
	{
		if (!get_pcvar_num(c_autojoin) || is_user_bot(id)) return HC_CONTINUE;
		// Joined mid-match with no seat to come back to: watch the board. (The team panel would only let
		// them pick a side to stand around on, and the browser client draws it clipped.)
		if (menuType == VGUI_Menu_Team) set_task(0.3, "task_late_spectate", TASK_RACE + 180 + id);
		return HC_SUPERCEDE;
	}
	set_task(0.1, "task_seat_join", TASK_RACE + 60 + s);
	return HC_SUPERCEDE;
}
public task_late_spectate(taskid)
{
	new id = taskid - TASK_RACE - 180;
	if (!is_user_connected(id) || seat_of(id) >= 0) return;
	rg_join_team(id, TEAM_SPECTATOR);
	g_lateSpec[id] = true;
	set_member(id, m_iMenu, 0); show_menu(id, 0, " ", 0);
	client_print(id, print_center, "A match is on. You'll take over a bot's seat in a moment.");
	reclaim_ready();
}

// A late joiner takes a seat a bot is playing for itself (never one it keeps warm for a human who dropped).
bool:take_bot_seat(id)
{
	for (new s = 0; s < SEATS; s++)
	{
		if (!g_seatBot[s] || g_seatOwner[s][0]) continue;
		if (g_state == ST_BOARD && s == g_cur) continue;   // not in the middle of that bot's turn
		new nm[32]; get_user_name(id, nm, charsmax(nm));
		announce("%s takes over %s's seat.", nm, g_seatName[s]);
		player_key(id, g_seatOwner[s], charsmax(g_seatOwner[]));
		g_lateSpec[id] = false;
		reclaim_seat(s, id, false);
		return true;
	}
	return false;
}
public task_seat_join(taskid) { new s = taskid - TASK_RACE - 60; if (s >= 0 && s < SEATS && is_user_connected(g_seatPlayer[s])) seat_join(g_seatPlayer[s], s); }

// put a returning player straight onto a team with their character, no menus
seat_join(id, s)
{
	rg_join_team(id, (s % 2) ? TEAM_TERRORIST : TEAM_CT);
	rg_internal_cmd(id, "joinclass", "5");
	set_member(id, m_iMenu, 0);
	show_menu(id, 0, " ", 0);
	if (!is_user_alive(id) && (g_state == ST_REMOTE_WAIT || g_state == ST_REMOTE_RACE)) rg_round_respawn(id);
	set_task(0.2, "task_seat_settle", TASK_RACE + 260 + id);
}

// Returning players are seated from inside the team panel hook, and CS goes back to "picking a team" once
// that hook returns. The player then stands on their side with maxspeed 1 (can't walk) and round respawns
// skip them (stuck dead on the board). Anyone with a seat and a side has finished joining: say so.
public task_seat_settle(taskid) { seat_settle(taskid - TASK_RACE - 260); }
seat_settle(id)
{
	if (!is_user_connected(id) || is_user_bot(id) || seat_of(id) < 0) return;
	new TeamName:tm = get_member(id, m_iTeam);
	if (tm != TEAM_TERRORIST && tm != TEAM_CT) return;
	if (get_member(id, m_iJoiningState) == JOINED && get_member(id, m_iMenu) != Menu_ChooseTeam) return;
	dbg("%n was still joining (state %d, menu %d): settled.", id, get_member(id, m_iJoiningState), get_member(id, m_iMenu));
	set_member(id, m_iJoiningState, JOINED); set_member(id, m_iMenu, Menu_OFF);
	if (is_user_alive(id) && !g_navThawed[id]) rg_reset_maxspeed(id);
}

// the human who owns this seat by name, if they're back
seat_owner_back(s)
{
	if (!g_seatOwner[s][0]) return 0;
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id) || seat_of(id) >= 0) continue;
		new key[32]; player_key(id, key, charsmax(key));
		if (equal(key, g_seatOwner[s])) return id;
	}
	return 0;
}

// Names, as seats see them. The engine renames a second "Alex" to "(1)Alex", and bots standing in
// for someone are "Alex (bot)"; both are still Alex's seat.
name_key(const name[], out[], len)
{
	new i = 0;
	if (name[0] == '(')
	{
		new j = 1; while (name[j] >= '0' && name[j] <= '9') j++;
		if (j > 1 && name[j] == ')') i = j + 1;
	}
	copy(out, len, name[i]);
	new n = strlen(out);
	if (n > 6 && equal(out[n - 6], " (bot)")) out[n - 6] = 0;
	trim(out);
}
player_key(id, out[], len) { new nm[32]; get_user_name(id, nm, charsmax(nm)); name_key(nm, out, len); }

// a bot keeping someone's seat warm wears their name with a tag, so the owner can always come back as themselves
stand_in_name(s, out[], len)
{
	if (g_seatOwner[s][0]) formatex(out, len, "%.24s (bot)", g_seatOwner[s]);
	else copy(out, len, g_seatName[s]);
}

// The owner of seat s is connected again: give them the seat back, whoever is keeping it.
reclaim_seat(s, id, bool:back = true)
{
	new old = g_seatPlayer[s];
	g_seatPlayer[s] = id; g_seatBot[s] = false; g_seatLeftAt[s] = 0.0;
	copy(g_seatName[s], charsmax(g_seatName[]), g_seatOwner[s]);
	if (old && old != id && is_user_connected(old) && is_user_bot(old)) set_user_info(old, "name", "Stand-in");
	if (back) announce("%s is back.", g_seatName[s]);
	set_task(0.2, "task_seat_settle", TASK_RACE + 260 + id);
	new TeamName:tm = get_member(id, m_iTeam);
	new TeamName:want = (g_state == ST_BOARD || g_state == ST_END) ? ((g_seatSkin[s] >= SK_SEAL) ? TEAM_CT : TEAM_TERRORIST) : ((s % 2) ? TEAM_TERRORIST : TEAM_CT);
	if (tm != TEAM_TERRORIST && tm != TEAM_CT) seat_join(id, s);
	if (TeamName:get_member(id, m_iTeam) != want) rg_set_user_team(id, want, MODEL_UNASSIGNED, true, false);
	if (g_state == ST_BOARD)
	{
		if (!is_user_alive(id)) rg_round_respawn(id);
		if (is_user_alive(id)) { rg_remove_all_items(id); rg_set_user_model(id, SKIN_MODEL[g_seatSkin[s]]); place_pawn(s); freeze(id); }
		if (old && is_user_alive(old) && is_user_bot(old)) user_silentkill(old);   // the stand-in leaves the board
		sync_money(s); sync_score(s);
	}
	else if (g_state == ST_REMOTE_RACE && g_mgIn[s])
	{
		// late to the race: start from the line, the clock doesn't wait
		if (!is_user_alive(id)) rg_round_respawn(id);
		race_place(s); unfreeze(id);
		if (old && is_user_alive(old) && is_user_bot(old)) user_silentkill(old);
		client_print(id, print_center, "You're in the race. The clock is already running. GO!");
	}
}

// Returning owners take their seats back at safe moments: on the board between turns, and on race maps.
// Mid-round (board-map minigames) and mid-turn they wait.
reclaim_ready()
{
	if (g_state != ST_BOARD && g_state != ST_END && g_state != ST_REMOTE_WAIT && g_state != ST_REMOTE_RACE && g_state != ST_RESUME) return;
	for (new s = 0; s < SEATS; s++)
	{
		if (!g_seatOwner[s][0]) continue;
		new cur = g_seatPlayer[s];
		if (cur && is_user_connected(cur) && !is_user_bot(cur)) continue;    // a human has it
		if (g_state == ST_BOARD && s == g_cur) continue;                     // not in the middle of their stand-in's turn
		new back = seat_owner_back(s);
		if (back) reclaim_seat(s, back);
	}
	for (new id = 1; id <= MaxClients; id++)
		if (g_lateSpec[id] && is_user_connected(id) && !is_user_bot(id) && seat_of(id) < 0) take_bot_seat(id);
}

seat_of(id) { for (new s = 0; s < SEATS; s++) if (g_seatPlayer[s] == id) return s; return -1; }

// a seat whose player left keeps its money, stars and items; the next unseated player on a team takes it over
refill_seats()
{
	for (new s = 0; s < SEATS; s++)
	{
		if (g_seatPlayer[s] && is_user_connected(g_seatPlayer[s])) continue;
		new back = seat_owner_back(s);
		if (back) { reclaim_seat(s, back); continue; }
		if (seat_held(s)) continue;
		if (!g_seatBot[s]) { g_seatBot[s] = true; dbg("%s didn't come back; seat %d goes to a bot.", g_seatName[s], s); }
		for (new id = 1; id <= MaxClients; id++)
		{
			if (!is_user_connected(id) || seat_of(id) >= 0) continue;
			new TeamName:tm = get_member(id, m_iTeam);
			if (tm != TEAM_TERRORIST && tm != TEAM_CT) continue;
			g_seatPlayer[s] = id; g_seatBot[s] = bool:is_user_bot(id);
			// a bot keeps the seat's name, like after a map change (bots get dropped and re-added mid-map too)
			new nm[32];
			if (is_user_bot(id)) { stand_in_name(s, nm, charsmax(nm)); set_user_info(id, "name", nm); }
			else get_user_name(id, nm, charsmax(nm));
			if (!equal(nm, g_seatName[s])) announce("%s takes over %s's seat.", nm, g_seatName[s]);
			copy(g_seatName[s], charsmax(g_seatName[]), nm);
			if (!is_user_bot(id)) player_key(id, g_seatOwner[s], charsmax(g_seatOwner[]));   // a human taking over owns it now
			if (g_state == ST_BOARD && is_user_alive(id)) { rg_remove_all_items(id); rg_set_user_model(id, SKIN_MODEL[g_seatSkin[s]]); place_pawn(s); freeze(id); sync_money(s); sync_score(s); }
			break;
		}
	}
}

// ------------------------------------------------------------- cvars --
new g_saved[12][16];
new const SAVE_CVARS[12][] = { "mp_round_infinite", "mp_freeforall", "bot_stop", "mp_buytime", "mp_roundtime",
	"mp_t_default_weapons_secondary", "mp_ct_default_weapons_secondary", "mp_t_default_weapons_primary",
	"mp_ct_default_weapons_primary", "mp_t_default_grenades", "sv_gravity", "mp_give_player_c4" };

save_cvars() { for (new i = 0; i < sizeof SAVE_CVARS; i++) get_cvar_string(SAVE_CVARS[i], g_saved[i], charsmax(g_saved[])); }
restore_cvars() { for (new i = 0; i < sizeof SAVE_CVARS; i++) set_cvar_string(SAVE_CVARS[i], g_saved[i]); set_cvar_string("mp_ct_default_grenades", ""); }

// ---------------------------------------------------------- board phase --
enter_board()
{
	g_state = ST_BOARD;
	set_cvar_string("mp_round_infinite", "1");
	set_cvar_string("mp_freeforall", "0");
	set_cvar_string("bot_stop", "1");
	set_cvar_string("mp_buytime", "0");
	set_cvar_string("mp_give_player_c4", "0");
	set_cvar_string("sv_gravity", "800");
	for (new s = 0; s < SEATS; s++)
	{
		new id = g_seatPlayer[s];
		if (!is_user_connected(id)) continue;
		new TeamName:team = (g_seatSkin[s] >= SK_SEAL) ? TEAM_CT : TEAM_TERRORIST;
		rg_set_user_team(id, team, MODEL_UNASSIGNED, true, false);
	}
	rg_restart_round();                       // spawn hook puts everyone on their space
	board_show(true);
	board_music(true);
	refresh_traps();
	remove_task(TASK_CAM);
	set_task(1.0, "task_cam", TASK_CAM, _, _, "b");   // "camera on" flag; fw_startframe does the moving
}

public hc_spawn_post(id)
{
	if (!is_user_alive(id)) return;
	new s = seat_of(id);
	if (g_state == ST_BOARD || g_state == ST_END)
	{
		if (s < 0) { user_silentkill(id); return; }
		rg_remove_all_items(id);
		rg_set_user_model(id, SKIN_MODEL[g_seatSkin[s]]);
		place_pawn(s);
		freeze(id);
		sync_money(s); sync_score(s);
	}
	else if (g_state == ST_REMOTE_WAIT || g_state == ST_REMOTE_RACE)
	{
		if (s < 0 || !g_mgIn[s]) { set_task(0.1, "task_slay", id); return; }
		rg_set_user_model(id, SKIN_MODEL[g_seatSkin[s]]);
		rg_remove_all_items(id); rg_give_item(id, "weapon_knife");
		if (!mg_fight(g_mg)) race_place(s);
		if (g_state == ST_REMOTE_WAIT) freeze(id); else unfreeze(id);
		sync_money(s); sync_score(s);
	}
	else if (g_state == ST_MINIGAME || g_state == ST_MG_INTRO)
	{
		if (s < 0 || !g_mgIn[s]) { set_task(0.1, "task_slay", id); return; }
		rg_set_user_model(id, SKIN_MODEL[g_seatSkin[s]]);
		unfreeze(id);
		apply_loadout(s);
		sync_money(s); sync_score(s);
	}
}

// (a bot that spawned unseated may have been seated since, as a stand-in in a fight: it stays)
public task_slay(id) { new s = seat_of(id); if (is_user_alive(id) && (s < 0 || !g_mgIn[s])) user_silentkill(id); }

freeze(id)
{
	entity_set_int(id, EV_INT_flags, entity_get_int(id, EV_INT_flags) | FL_FROZEN);
	entity_set_vector(id, EV_VEC_velocity, Float:{0.0, 0.0, 0.0});
}
unfreeze(id)
{
	if (!is_user_connected(id)) return;
	entity_set_int(id, EV_INT_flags, entity_get_int(id, EV_INT_flags) & ~FL_FROZEN);
}

place_pawn(s)
{
	new id = g_seatPlayer[s];
	if (!is_user_alive(id)) return;
	static const Float:OFF[SEATS][2] = { {-14.0, -14.0}, {14.0, -14.0}, {-14.0, 14.0}, {14.0, 14.0} };
	new Float:o[3];
	safe_spot(o, g_nodePos[g_pos[s]], OFF[s]);
	// pawns share a space on a 28-unit grid but player hulls are 32 wide; overlapping players are "stuck"
	// and the movement code won't even let them jump, so pawns don't collide on the board
	entity_set_int(id, EV_INT_solid, SOLID_NOT);
	entity_set_origin(id, o);
	entity_set_vector(id, EV_VEC_velocity, Float:{0.0, 0.0, 0.0});
	// face the next space
	new n = g_nodeNext[g_pos[s]][0], Float:d[3], Float:ang[3];
	xs_vec_sub_simple(g_nodePos[n], g_nodePos[g_pos[s]], d); vector_to_angle(d, ang); ang[0] = 0.0;
	entity_set_vector(id, EV_VEC_angles, ang); entity_set_vector(id, EV_VEC_v_angle, ang);
	entity_set_int(id, EV_INT_fixangle, 1);
}

public hc_can_take_damage(const victim, const attacker)
{
	if (g_lobby || g_state == ST_BOARD || g_state == ST_MG_INTRO || g_state == ST_END || g_state == ST_REMOTE_WAIT || g_state == ST_REMOTE_RACE || g_state == ST_RESUME)
		{ SetHookChainReturn(ATYPE_INTEGER, false); return HC_SUPERCEDE; }
	if (g_state == ST_MINIGAME && g_mg == MG_HNS && is_user_connected(attacker))
	{
		new a = seat_of(attacker);
		if (a >= 0 && g_mgSide[a] == SIDE_T) { SetHookChainReturn(ATYPE_INTEGER, false); return HC_SUPERCEDE; }
	}
	return HC_CONTINUE;
}

// camera: hovers behind and above whoever's turn it is; every human watches it on the board
// ------------------------------------------------------------- camera director --
// One broadcast camera everybody watches during the board phase, like a TV director
// following whoever's turn it is. Shots: intro (front-on at the character), follow (behind,
// looking down the path), dice (low angle up at the crate), land, hostage cutaway, wide.
enum { CAM_FOLLOW = 0, CAM_INTRO, CAM_DICE, CAM_LAND, CAM_HOSTAGE, CAM_WIDE, CAM_MAP };
new g_camMode, Float:g_camUntil, bool:g_camSnap, Float:g_camLook[3], Float:g_camFwd[3];

cam_shot(mode, Float:hold = 0.0)
{
	// into or out of the map view: cut, don't fly through the walls and the sky
	if ((g_camMode == CAM_MAP) != (mode == CAM_MAP)) { g_camSnap = true; map_overlay_show(mode == CAM_MAP); }
	g_camMode = mode;
	g_camUntil = hold > 0.0 ? get_gametime() + hold : 0.0;
}

pawn_origin(s, Float:o[3])
{
	new id = g_seatPlayer[s];
	if (is_user_alive(id)) entity_get_vector(id, EV_VEC_origin, o);
	else { o = g_nodePos[g_pos[s]]; o[2] += 37.0; }
}

// Camera and pawn hops run every server frame (capped near 60 Hz). AMXX timers only fire about every
// 0.1 s, so the old 0.04 s camera task and 0.03 s hop task really moved 10 times a second: visibly steppy.
public fw_startframe()
{
	static Float:last;
	new Float:now = get_gametime(), Float:dt = now - last;
	if (dt < 0.0 || dt > 1.0) { last = now; return FMRES_IGNORED; }   // map change resets the clock
	if (dt < 0.016) return FMRES_IGNORED;
	last = now;
	if (g_hopActive) hop_step();
	if (task_exists(TASK_CAM)) cam_step(dt);
	return FMRES_IGNORED;
}

public task_cam() {}

// smoothing factor tuned per 0.04 s step, rescaled to the real frame time
Float:ease(Float:per40ms, Float:dt) { return 1.0 - floatpower(1.0 - per40ms, dt / 0.04); }

cam_step(Float:dt)
{
	if (!is_valid_ent(g_cam)) return;
	if (g_camUntil > 0.0 && get_gametime() > g_camUntil) { cam_shot(CAM_FOLLOW); }

	new s = g_cur, Float:P[3], Float:F[3], Float:R[3], Float:want[3], Float:look[3];
	pawn_origin(s, P);
	// path direction: current space toward the next one, smoothed so turns don't whip the camera
	new n = g_pos[s], m = g_nodeNext[n][0], Float:d[3];
	xs_vec_sub_simple(g_nodePos[m], g_nodePos[n], d); d[2] = 0.0;
	new Float:l = vector_length(d); if (l < 1.0) { d[0] = 1.0; d[1] = 0.0; l = 1.0; }
	for (new k = 0; k < 2; k++) g_camFwd[k] += (d[k] / l - g_camFwd[k]) * (g_camSnap ? 1.0 : ease(0.08, dt));
	g_camFwd[2] = 0.0;
	l = vector_length(g_camFwd); if (l < 0.01) { g_camFwd[0] = 1.0; l = 1.0; }
	F[0] = g_camFwd[0] / l; F[1] = g_camFwd[1] / l; F[2] = 0.0;
	R[0] = F[1]; R[1] = -F[0]; R[2] = 0.0;
	if ((g_camMode == CAM_INTRO || g_camMode == CAM_DICE) && is_user_alive(g_seatPlayer[s]))
	{
		new Float:ang[3]; entity_get_vector(g_seatPlayer[s], EV_VEC_angles, ang);
		F[0] = floatcos(ang[1], degrees); F[1] = floatsin(ang[1], degrees); F[2] = 0.0;
		R[0] = F[1]; R[1] = -F[0];
	}

	// each shot has a few candidate placements (forward, right, up); the director takes the first with a clear view
	static const Float:SHOTS[6][4][3] = {
		{ {-230.0,   0.0, 150.0}, {-170.0,  90.0, 190.0}, {-170.0, -90.0, 190.0}, { -90.0,   0.0, 260.0} },   // follow
		{ {  95.0,  35.0,  16.0}, {  95.0, -35.0,  16.0}, {  70.0,  60.0,  40.0}, {  60.0, -60.0,  60.0} },   // intro
		{ { 175.0,  60.0,  10.0}, { 175.0, -60.0,  10.0}, { 140.0, 100.0,  30.0}, { 110.0,-100.0,  50.0} },   // dice
		{ {-120.0,  65.0, 115.0}, {-120.0, -65.0, 115.0}, { -60.0,   0.0, 170.0}, {  80.0,  80.0, 120.0} },   // land
		{ {-170.0,  90.0, 120.0}, {-170.0, -90.0, 120.0}, { 170.0,  90.0, 120.0}, {   0.0,   0.0, 220.0} },   // hostage
		{ {-420.0,   0.0, 520.0}, {-300.0, 200.0, 420.0}, {-300.0,-200.0, 420.0}, {   0.0,   0.0, 500.0} } }; // wide
	static const Float:LOOK[6][3] = { {140.0, 0.0, -10.0}, {0.0, 0.0, 20.0}, {0.0, 0.0, 62.0}, {20.0, 0.0, -20.0}, {0.0, 0.0, 0.0}, {0.0, 0.0, 0.0} };
	new Float:base[3]; base = P;
	if (g_camMode == CAM_HOSTAGE) { base = g_nodePos[g_hostage]; base[2] += 40.0; }
	else if (g_camMode == CAM_WIDE)
	{
		base[0] = 0.0; base[1] = 0.0; base[2] = 0.0;
		for (new k = 0; k < SEATS; k++) { new Float:o[3]; pawn_origin(k, o); for (new j = 0; j < 3; j++) base[j] += o[j] / float(SEATS); }
	}
	new bool:mapView = (g_camMode == CAM_MAP);
	new Float:from[3], Float:bestFrac = -1.0, Float:best[3];
	if (mapView) { want = g_mapCam; look = g_mapLook; map_marks_step(); }
	else
	{
	offset(base, F, R, LOOK[g_camMode][0], LOOK[g_camMode][1], LOOK[g_camMode][2], look);
	from = look; from[2] += 20.0;
	for (new c = 0; c < 4; c++)
	{
		new Float:cand[3];
		offset(base, F, R, SHOTS[g_camMode][c][0], SHOTS[g_camMode][c][1], SHOTS[g_camMode][c][2], cand);
		new tr = create_tr2();
		engfunc(EngFunc_TraceLine, from, cand, IGNORE_MONSTERS, 0, tr);
		new Float:frac; get_tr2(tr, TR_flFraction, frac);
		new Float:endp[3]; get_tr2(tr, TR_vecEndPos, endp);
		free_tr2(tr);
		if (frac > bestFrac) { bestFrac = frac; best = endp; }
		if (frac >= 0.95) break;
	}
	want = best;
	if (bestFrac < 1.0) { xs_vec_sub_simple(from, want, d); l = vector_length(d); if (l > 1.0) for (new k = 0; k < 3; k++) want[k] += d[k] / l * 10.0; }
	}

	new Float:a = g_camSnap ? 1.0 : ease(0.16, dt), Float:b = g_camSnap ? 1.0 : ease(0.22, dt);
	for (new k = 0; k < 3; k++) { g_camPos[k] += (want[k] - g_camPos[k]) * a; g_camLook[k] += (look[k] - g_camLook[k]) * b; }
	g_camSnap = false;

	new Float:dir[3], Float:ang[3];
	xs_vec_sub_simple(g_camLook, g_camPos, dir);
	vector_to_angle(dir, ang);
	ang[0] = -ang[0];                         // view-angle convention (pitch down is positive), as the engine module does
	g_camAng = ang;
	entity_set_origin(g_cam, g_camPos);
	entity_set_vector(g_cam, EV_VEC_angles, ang);
	entity_set_vector(g_cam, EV_VEC_v_angle, ang);

	static Float:viewAt;
	if (get_gametime() - viewAt > 0.5 || get_gametime() < viewAt)
	{
		viewAt = get_gametime();
		// seated players watch the director camera; spectators' clients run their own chase cam,
		// so point that at whoever's turn it is
		new target = g_seatPlayer[g_cur];
		for (new id = 1; id <= MaxClients; id++)
		{
			if (!is_user_connected(id) || is_user_bot(id)) continue;
			if (is_user_alive(id)) attach_view(id, g_cam);
			else if (target && is_user_alive(target))
			{
				set_member(id, m_hObserverTarget, target);
				set_entvar(id, var_iuser1, OBS_CHASE_FREE);
				set_entvar(id, var_iuser2, target);
			}
		}
	}
	if (is_valid_ent(g_hostageEnt))
	{
		new Float:ha[3]; entity_get_vector(g_hostageEnt, EV_VEC_angles, ha);
		ha[1] = floatmod(ha[1] + 50.0 * dt, 360.0); entity_set_vector(g_hostageEnt, EV_VEC_angles, ha);
	}
}

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
// From up there the whole map is in view, and the engine sends at most 256 entities a frame, in index order:
// on de_inferno and de_aztec that cut off the overlay (spawned last). So the map view drops what reads as
// clutter from above: the tiles and props on the spaces, and the map's decoration (func_illusionary vines
// and awnings, light glows and foliage sprites).
public fw_checkvis(ent, pset)
{
	if (g_camMode != CAM_MAP || ent < 1 || ent >= sizeof g_mapEntFlag) return FMRES_IGNORED;
	if (ent <= MaxClients || ent == g_cam || g_mapEntFlag[ent]) { forward_return(FMV_CELL, 1); return FMRES_SUPERCEDE; }
	if (g_mapHide[ent]) { forward_return(FMV_CELL, 0); return FMRES_SUPERCEDE; }
	return FMRES_IGNORED;
}

map_hide(e) { if (e > 0 && e < sizeof g_mapHide) g_mapHide[e] = true; }

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

mark_ent(const spr[], r, g, bl)
{
	new e = create_entity("info_target");
	if (!e) return 0;
	entity_set_string(e, EV_SZ_classname, "csp_mapmark");
	entity_set_model(e, spr);
	entity_set_int(e, EV_INT_solid, SOLID_NOT);
	entity_set_int(e, EV_INT_movetype, MOVETYPE_NOCLIP);
	entity_set_int(e, EV_INT_rendermode, kRenderTransAlpha);   // solid colour: additive glows washed out to white on the sand
	entity_set_float(e, EV_FL_renderamt, 255.0);
	new Float:col[3]; col[0] = float(r); col[1] = float(g); col[2] = float(bl);
	entity_set_vector(e, EV_VEC_rendercolor, col);
	entity_set_int(e, EV_INT_effects, EF_NODRAW);
	return e;
}

map_flag(e) { if (e > 0 && e < sizeof g_mapEntFlag) { g_mapEntFlag[e] = true; g_mapEnt[g_mapEntN++] = e; } }

// Built once per board: a lit path along every link, arrowheads (two strokes each), a dot per seat, a ring for
// whose turn it is and the hostage icon. All hidden until the map view is switched on.
map_overlay_spawn()
{
	g_mapEntN = 0;
	arrayset(g_mapEntFlag, false, sizeof g_mapEntFlag);
	arrayset(g_mapHide, false, sizeof g_mapHide);
	for (new n = 0; n < g_nodeCount; n++) { map_hide(g_tileEnt[n]); map_hide(g_propEnt[n]); }
	static const CLUTTER[][] = { "func_illusionary", "env_sprite", "env_glow", "cycler_sprite" };
	for (new c = 0; c < sizeof CLUTTER; c++)
		for (new e = -1; (e = find_ent_by_class(e, CLUTTER[c])); ) map_hide(e);
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
		// the line stops short of the spaces so it doesn't run over the pieces standing on them
		new Float:p0[3], Float:p1[3];
		for (new j = 0; j < 3; j++) { p0[j] = a[j] + d[j] * 0.14; p1[j] = a[j] + d[j] * 0.86; }
		map_flag(beam_ent(p0, p1, 255, 236, 190, 200.0, 170.0));
		// arrowhead just past the middle of the link, pointing at the next space: on every other link and every
		// fork (an arrow per link put the view near the engine's 256-entities-per-packet cap)
		if (n % 2 && g_nodeNextN[n] < 2) continue;
		new Float:ux = d[0] / len, Float:uy = d[1] / len, Float:ah = floatmin(len * 0.22, 110.0);
		new Float:tip[3], Float:w1[3], Float:w2[3];
		for (new j = 0; j < 3; j++) tip[j] = a[j] + d[j] * 0.6;
		tip[2] += 4.0;
		w1[0] = tip[0] - ux * ah - uy * ah * 0.6; w1[1] = tip[1] - uy * ah + ux * ah * 0.6; w1[2] = tip[2];
		w2[0] = tip[0] - ux * ah + uy * ah * 0.6; w2[1] = tip[1] - uy * ah - ux * ah * 0.6; w2[2] = tip[2];
		map_flag(beam_ent(w1, tip, 255, 255, 255, 255.0, 255.0));
		map_flag(beam_ent(w2, tip, 255, 255, 255, 255.0, 255.0));
	}
	for (new s = 0; s < SEATS; s++) { g_mapMark[s] = mark_ent("sprites/dot.spr", MAP_COL[s][0], MAP_COL[s][1], MAP_COL[s][2]); map_flag(g_mapMark[s]); }
	g_mapMark[SEATS] = mark_ent("sprites/ihostage.spr", 0, 0, 0); map_flag(g_mapMark[SEATS]);                 // CS's own overview icons
	g_mapMark[SEATS + 1] = mark_ent("sprites/iplayer.spr", 255, 255, 255); map_flag(g_mapMark[SEATS + 1]);   // ring: whose turn
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

// every frame while the map is up: a dot in the seat colour rides on each piece (over the roof when the piece
// is indoors), a ring in the same colour marks whose turn it is, and the hostage icon sits on their space
map_marks_step()
{
	new Float:dia = g_mapH * 0.045;      // dot diameter: about 1/25 of the screen height (dot.spr fills its 16 px)
	new Float:ring[3];
	for (new s = 0; s < SEATS; s++)
	{
		new e = g_mapMark[s]; if (!is_valid_ent(e)) continue;
		new Float:o[3]; pawn_origin(s, o);
		new Float:z = g_nodeDrawZ[g_pos[s]] + 30.0; if (o[2] + 60.0 > z) z = o[2] + 60.0;
		o[2] = z;
		// pieces sharing a space: spread the dots so each colour shows
		new same = 0, before = 0;
		for (new q = 0; q < SEATS; q++) if (g_pos[q] == g_pos[s]) { same++; if (q < s) before++; }
		if (same > 1) { new Float:t = float(before) * 360.0 / float(same) + 45.0; o[0] += floatcos(t, degrees) * dia * 0.75; o[1] += floatsin(t, degrees) * dia * 0.75; }
		entity_set_origin(e, o);
		entity_set_float(e, EV_FL_scale, dia / 16.0);
		if (s == g_cur) { ring = o; ring[2] += 4.0; }
	}
	new r = g_mapMark[SEATS + 1];
	if (is_valid_ent(r))
	{
		entity_set_origin(r, ring);
		entity_set_float(r, EV_FL_scale, dia * 2.4 / 32.0);   // iplayer is 32 px: a ring about twice the dot
		new Float:col[3]; for (new k = 0; k < 3; k++) col[k] = float(MAP_COL[g_cur][k]);
		entity_set_vector(r, EV_VEC_rendercolor, col);
		entity_set_int(r, EV_INT_renderfx, kRenderFxPulseFastWide);
	}
	new h = g_mapMark[SEATS];
	if (is_valid_ent(h))
	{
		new Float:o[3]; o = g_nodePos[g_hostage]; o[2] = g_nodeDrawZ[g_hostage] + 20.0;
		entity_set_origin(h, o);
		entity_set_float(h, EV_FL_scale, dia * 2.6 / 32.0);   // ihostage is 32 px
	}
}

toggle_map_view()
{
	if (g_camMode == CAM_MAP) { cam_shot(CAM_FOLLOW); return; }
	map_view_plan();
	cam_shot(CAM_MAP);
}

// dev: csp_mapview toggles the map overlay without a turn menu (headless screenshots)
public cmd_mapview()
{
	if (g_state == ST_BOARD) toggle_map_view();
	// what a client in the map view gets sent: every drawable entity (the engine caps a packet at 256)
	new sent = 0, n = global_get(glb_maxEntities);
	for (new e = 1; e < n; e++)
		if (is_valid_ent(e) && entity_get_int(e, EV_INT_modelindex) && !(entity_get_int(e, EV_INT_effects) & EF_NODRAW) && !(g_camMode == CAM_MAP && e < sizeof g_mapHide && g_mapHide[e])) sent++;
	new arg[8]; read_argv(1, arg, charsmax(arg));
	if (arg[0] == 'v')
		for (new e = 1; e < n; e++)
			if (is_valid_ent(e) && entity_get_int(e, EV_INT_modelindex) && !(entity_get_int(e, EV_INT_effects) & EF_NODRAW))
			{ new cn[32], md[48]; entity_get_string(e, EV_SZ_classname, cn, charsmax(cn)); entity_get_string(e, EV_SZ_model, md, charsmax(md)); server_print("ENT %d %s %s", e, cn, md); }
	server_print("[CSP] map view %s (h %.0f, %d overlay entities, %d drawable entities sent, %d edicts)", g_camMode == CAM_MAP ? "on" : "off", g_mapH, g_mapEntN, sent, entity_count());
	return PLUGIN_HANDLED;
}

offset(const Float:P[3], const Float:F[3], const Float:R[3], Float:f, Float:r, Float:u, Float:out[3])
{
	for (new k = 0; k < 3; k++) out[k] = P[k] + F[k] * f + R[k] * r;
	out[2] += u;
}

// fade every human's screen. dir: 0 = fade in from black, 1 = fade out and stay black
fade(dir, Float:secs)
{
	static msg; if (!msg) msg = get_user_msgid("ScreenFade");
	new dur = floatround(secs * 4096.0);
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id)) continue;
		message_begin(MSG_ONE, msg, _, id);
		write_short(dur); write_short(dir ? 4096 : 0); write_short(dir ? (0x0001 | 0x0004) : 0x0000);
		write_byte(0); write_byte(0); write_byte(0); write_byte(255);
		message_end();
	}
}

Float:floatmod(Float:a, Float:m) { while (a >= m) a -= m; while (a < 0.0) a += m; return a; }

release_cameras()
{
	for (new id = 1; id <= MaxClients; id++)
		if (is_user_connected(id) && !is_user_bot(id)) attach_view(id, id);
}

// ----------------------------------------------------------------- HUD --
// No crosshair while the board plays: everyone watches the director camera, so it's just a dot in the
// middle of someone else's turn. Minigames and races get it back. m_iHideHUD is resent by the game on change.
#define HIDEHUD_CROSSHAIR (1<<6)
crosshair_sync()
{
	new bool:hide = (g_state == ST_BOARD || g_state == ST_END || g_state == ST_MG_INTRO || g_state == ST_MG_RESULT || g_lobby);
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id)) continue;
		new f = get_member(id, m_iHideHUD), want = hide ? (f | HIDEHUD_CROSSHAIR) : (f & ~HIDEHUD_CROSSHAIR);
		if (want != f) set_member(id, m_iHideHUD, want);
	}
}

// true when this player's table text differs from what they last got, or it's due for a refresh
bool:hud_changed(id, const text[])
{
	static hash[33], Float:at[33];
	new h = strlen(text);
	for (new i = 0; text[i]; i++) h = h * 31 + text[i];
	new Float:now = get_gametime();
	if (h == hash[id] && now - at[id] < 2.5) return false;
	hash[id] = h; at[id] = now;
	return true;
}

public task_hud()
{
	crosshair_sync();
	if (g_state == ST_IDLE) return;
	update_crosshair();
	if (g_state == ST_BOARD || g_state == ST_END || g_state == ST_MINIGAME || g_state == ST_MG_INTRO) refill_seats();
	reclaim_ready();
	turn_watchdog();
	if (g_state == ST_REMOTE_WAIT || g_state == ST_REMOTE_RACE || g_state == ST_RESUME) { hud_race(); return; }

	// Shared part: header, bonus-star leaders, one short row per seat. Gear and items used to ride on these
	// rows; with full loadouts the lines ran off the right edge and past the HUD message size limit.
	new buf[448], len;
	len = formatex(buf, charsmax(buf), "CS PARTY  turn %d/%d%s^nHostages: %s  ($%d)^n^n", g_turn, g_maxTurns, overtime() ? "  OVERTIME" : "", g_nodeArea[g_hostage], get_pcvar_num(c_hostage));
	new mode = get_pcvar_num(c_awards);
	if (mode == 1 || mode == 3)
	{
		for (new k = 0; k < g_awardN; k++)
		{
			new who[48]; award_leader(g_awardCat[k], who, charsmax(who));
			len += formatex(buf[len], charsmax(buf) - len, "%s %s: %s^n", mode == 3 ? "$" : "*", AW_NAME[g_awardCat[k]], who);
		}
		if (g_awardN) len += formatex(buf[len], charsmax(buf) - len, "^n");
	}
	// map view: each row says which dot on the map is that player
	new bool:mapTags = (g_camMode == CAM_MAP && g_state == ST_BOARD);
	for (new s = 0; s < SEATS; s++)
		len += formatex(buf[len], charsmax(buf) - len, "%s%-14.14s $%5d  *%d  W%d%s%s^n", (s == g_cur && g_state == ST_BOARD) ? "+ " : "  ", g_seatName[s], g_money[s], g_stars[s], g_mgWins[s], mapTags ? "  " : "", mapTags ? MAP_COLNAME[s] : "");

	// Compact version for touch screens: no bonus-star block, it has to fit the top-centre column
	new small[320], sl;
	sl = formatex(small, charsmax(small), "CS PARTY  turn %d/%d%s  |  hostages: %s^n", g_turn, g_maxTurns, overtime() ? " OT" : "", g_nodeArea[g_hostage]);
	for (new s = 0; s < SEATS; s++)
		sl += formatex(small[sl], charsmax(small) - sl, "%s%-12.12s $%5d *%d W%d%s%s^n", (s == g_cur && g_state == ST_BOARD) ? "+ " : "  ", g_seatName[s], g_money[s], g_stars[s], g_mgWins[s], mapTags ? " " : "", mapTags ? MAP_COLNAME[s] : "");

	// Personal part: your own gear and items, under the table.
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id)) continue;
		new bool:touch = is_touch(id);
		// top right on PCs (menus own the left side); top centre on phones (buttons own the right side)
		// held 4 s and only re-sent when the text changes (or every 2.5 s): re-sending the same table twice a
		// second made it blink on slow clients (phones, software GL) and the browser client
		if (touch) set_hudmessage(242, 163, 58, 0.37, 0.15, 0, 0.0, 4.0, 0.0, 0.0, -1);
		else set_hudmessage(242, 163, 58, 0.70, 0.12, 0, 0.0, 4.0, 0.0, 0.0, -1);
		new mine = seat_of(id), mineTxt[160] = "";
		if (mine >= 0)
		{
			new gs[64], it[96], il = 0; gear_summary(mine, gs, charsmax(gs));
			for (new k = 0; k < g_itemN[mine]; k++) il += formatex(it[il], charsmax(it) - il, "%s%s", k ? ", " : "", ITEM_NAME[g_items[mine][k]]);
			formatex(mineTxt, charsmax(mineTxt), "^nYour gear: %s^nYour items: %s", gs[0] ? gs : "none", il ? it : "none");
		}
		// (no "touch ? small : buf": Pawn's ?: between arrays of different sizes isn't safe)
		new out[640];
		if (touch) formatex(out, charsmax(out), "%s%s", small, mineTxt);
		else formatex(out, charsmax(out), "%s%s", buf, mineTxt);
		if (hud_changed(id, out)) ShowSyncHudMsg(id, g_hudSync, "%s", out);
	}
}

// ---------------------------------------------------------------- turn timer --
// A player who wanders off (or whose browser died) mid-decision used to stall the whole party. After
// csp_turn_timeout seconds (8 if they're gone) the bot logic makes that one decision; the seat stays theirs.
wait_for(s, kind) { g_waitKind[s] = kind; g_waitLast[s] = kind; g_waitAt[s] = get_gametime(); }

turn_watchdog()
{
	if (g_state != ST_BOARD) return;
	new s = g_cur, kind = g_waitKind[s];
	if (!kind) return;
	new id = g_seatPlayer[s], bool:gone = !is_user_connected(id);
	new Float:limit = gone ? 8.0 : get_pcvar_float(c_turntime);
	if (limit <= 0.0 || get_gametime() - g_waitAt[s] < limit) return;
	g_waitKind[s] = W_NONE; g_waitLast[s] = W_NONE;
	remove_task(TASK_FLOW);
	if (!gone)
	{
		g_wdCancel = true; menu_cancel(id); g_wdCancel = false;
		nav_end(id); show_menu(id, 0, " ", 0);
		client_print(id, print_center, "Too slow! The bot decided for you this time.");
	}
	announce("%s %s; the bot logic decides.", g_seatName[s], gone ? "dropped" : "is taking a while");
	switch (kind)
	{
		case W_TURN: set_task(spd(0.2), "flow_roll", TASK_FLOW);
		case W_BRANCH:
		{
			new cur = g_pos[s], a = g_nodeNext[cur][0], b = g_nodeNext[cur][1];
			step_to(s, g_dist[b][g_hostage] < g_dist[a][g_hostage] ? b : a);
		}
		case W_HOSTAGE: { rescue(s); set_task(spd(2.6), "flow_step", TASK_FLOW); }
		case W_TARGET: switch (g_targetPurpose)
		{
			case 1: { new o = -1; for (new k = 0; k < SEATS; k++) if (k != s && (o < 0 || g_money[k] > g_money[o])) o = k; begin_duel(s, o); }
			case 0, 4: set_task(spd(0.2), "flow_roll", TASK_FLOW);   // item picks come from the turn menu: roll
			default: set_task(spd(0.3), "flow_step", TASK_FLOW);
		}
		default: set_task(spd(0.3), "flow_step", TASK_FLOW);   // shop, negotiator: walk on by
	}
}

// browser clients on phones say so in their userinfo (web/public/boot.js)
// character picked on the join screen (or "setinfo _csp_char N" in a console), -1 for random
char_pick(id) { new v[4]; get_user_info(id, "_csp_char", v, charsmax(v)); if (!v[0] || !isdigit(v[0])) return -1; new n = str_to_num(v); return (n >= 0 && n < SK_COUNT) ? n : -1; }
bool:is_touch(id) { new v[4]; get_user_info(id, "_csp_touch", v, charsmax(v)); return v[0] == '1'; }

// race maps: who's racing, who's still loading, finish times
hud_race()
{
	new buf[384], len;
	new Float:t = (g_state == ST_REMOTE_RACE) ? get_gametime() - g_raceStart : 0.0;
	len = formatex(buf, charsmax(buf), "CS PARTY  %s^n%s^n^n", MG_NAME[g_mg],
		g_state == ST_REMOTE_WAIT ? "Waiting for everyone to load..." : (g_state == ST_RESUME ? "Back to the board..." : "First to the finish wins $"));
	for (new s = 0; s < SEATS; s++)
	{
		new id = g_seatPlayer[s], st[24];
		if (!g_mgIn[s] && g_state != ST_REMOTE_WAIT) copy(st, charsmax(st), "watching");
		else if (g_finished[s]) formatex(st, charsmax(st), "%.1f s", g_finishTime[s]);
		else if (!id || !is_user_connected(id)) copy(st, charsmax(st), "loading...");
		else if (g_state == ST_REMOTE_RACE) formatex(st, charsmax(st), "racing %.0f s", t);
		else copy(st, charsmax(st), "ready");
		len += formatex(buf[len], charsmax(buf) - len, "  %-14.14s %s^n", g_seatName[s], st);
	}
	set_hudmessage(242, 163, 58, 0.70, 0.12, 0, 0.0, 4.0, 0.0, 0.0, -1);
	if (hud_changed(0, buf)) ShowSyncHudMsg(0, g_hudSync, "%s", buf);
	if (MG_TUT[g_mg][0] && (g_state == ST_REMOTE_WAIT || (g_state == ST_REMOTE_RACE && t < 12.0)))
	{
		// same refresh rule as the table: long hold, resend every 2.5 s (a resend per tick made it flicker)
		static Float:tutAt;
		new Float:now = get_gametime();
		if (now - tutAt >= 2.5 || now < tutAt)
		{
			tutAt = now;
			set_hudmessage(255, 255, 255, 0.04, 0.30, 0, 0.0, 4.0, 0.0, 0.0, -1);
			ShowSyncHudMsg(0, g_hudTut, "%s", MG_TUT[g_mg]);
		}
	}
}

banner(const fmt[], any:...)
{
	new msg[192]; vformat(msg, charsmax(msg), fmt, 2);
	set_dhudmessage(242, 163, 58, -1.0, 0.25, 0, 0.0, spd(3.0), 0.1, 0.3);
	show_dhudmessage(0, "%s", msg);
	dbg("== %s", msg);
}

subline(const fmt[], any:...)
{
	new msg[192]; vformat(msg, charsmax(msg), fmt, 2);
	set_hudmessage(221, 215, 196, -1.0, 0.32, 0, 0.0, spd(3.0), 0.1, 0.3, -1);
	ShowSyncHudMsg(0, g_hudSync2, "%s", msg);
}

sync_money(s)
{
	new id = g_seatPlayer[s];
	if (is_user_connected(id)) rg_add_account(id, g_money[s], AS_SET, false);
}

sync_score(s)
{
	new id = g_seatPlayer[s];
	if (!is_user_connected(id)) return;
	entity_set_float(id, EV_FL_frags, float(g_stars[s]));
	message_begin(MSG_ALL, g_msgScoreInfo);
	write_byte(id); write_short(g_stars[s]); write_short(g_mgWins[s]); write_short(0); write_short(get_member(id, m_iTeam));
	message_end();
}

// --------------------------------------------------------------- money --
gain(s, amt)
{
	if (amt <= 0) return 0;
	new add = min(max(0, MONEY_CAP - g_money[s]), amt);
	g_money[s] += add;
	if (g_money[s] > g_maxMoney[s]) g_maxMoney[s] = g_money[s];
	if (add < amt) announce("%s is at max money. $%d lost.", g_seatName[s], amt - add);
	sync_money(s);
	return add;
}
lose(s, amt) { new t = min(g_money[s], max(0, amt)); g_money[s] -= t; sync_money(s); return t; }
bool:overtime() { return g_turn > g_maxTurns - get_pcvar_num(c_ot); }
bool:has_item(s, it) { for (new k = 0; k < g_itemN[s]; k++) if (g_items[s][k] == it) return true; return false; }
bool:take_item(s, it)
{
	for (new k = 0; k < g_itemN[s]; k++) if (g_items[s][k] == it)
	{
		for (new j = k; j < g_itemN[s] - 1; j++) g_items[s][j] = g_items[s][j + 1];
		g_itemN[s]--; return true;
	}
	return false;
}

leader(except)
{
	new best = -1;
	for (new s = 0; s < SEATS; s++)
	{
		if (s == except) continue;
		if (best < 0 || g_stars[s] > g_stars[best] || (g_stars[s] == g_stars[best] && g_money[s] > g_money[best])) best = s;
	}
	return best;
}

bool:can_plant(node) { return (g_nodeType[node] == NT_BLUE || g_nodeType[node] == NT_RED || g_nodeType[node] == NT_EVENT) && g_traps[node] < 0 && node != g_hostage && node != g_startNode; }

move_hostage()
{
	new tries = 0, n;
	do { n = g_candidates[random(g_candCount)]; tries++; }
	while (tries < 50 && (n == g_hostage || node_occupied(n)));
	g_hostage = n;
	update_hostage_ent();
}
bool:node_occupied(n) { for (new s = 0; s < SEATS; s++) if (g_pos[s] == n) return true; return false; }

// Minigames are fought on the board map: hide every board piece so the arena reads as a plain map.
board_show(bool:show)
{
	g_boardHidden = !show;
	for (new i = 0; i < g_nodeCount; i++)
	{
		if (g_propEnt[i] && is_valid_ent(g_propEnt[i])) entity_set_int(g_propEnt[i], EV_INT_effects, show ? 0 : EF_NODRAW);
		if (g_tileEnt[i] && is_valid_ent(g_tileEnt[i])) entity_set_int(g_tileEnt[i], EV_INT_effects, show ? 0 : EF_NODRAW);
		if (g_trapEnt[i] && is_valid_ent(g_trapEnt[i])) entity_set_int(g_trapEnt[i], EV_INT_effects, show ? 0 : EF_NODRAW);
	}
	update_hostage_ent();
	if (show) g_ringsAt = 0.0;   // redraw the rings now instead of waiting out the period
}

update_hostage_ent()
{
	if (!is_valid_ent(g_hostageEnt)) return;
	if (g_state == ST_IDLE || g_boardHidden) { entity_set_int(g_hostageEnt, EV_INT_effects, EF_NODRAW); return; }
	new Float:o[3]; o = g_nodePos[g_hostage]; o[2] += 36.0;
	entity_set_origin(g_hostageEnt, o);
	entity_set_int(g_hostageEnt, EV_INT_effects, 0);
}

refresh_traps()
{
	for (new i = 0; i < g_nodeCount; i++)
	{
		if (g_traps[i] >= 0 && !g_trapEnt[i])
		{
			new e = create_entity("info_target");
			if (!e) continue;
			entity_set_string(e, EV_SZ_classname, "csp_trap");
			entity_set_model(e, "models/w_c4.mdl");
			entity_set_int(e, EV_INT_solid, SOLID_NOT);
			new Float:o[3]; o = g_nodePos[i]; o[2] += 2.0;
			entity_set_origin(e, o);
			if (g_boardHidden) entity_set_int(e, EV_INT_effects, EF_NODRAW);
			g_trapEnt[i] = e;
		}
		else if (g_traps[i] < 0 && g_trapEnt[i])
		{
			if (is_valid_ent(g_trapEnt[i])) remove_entity(g_trapEnt[i]);
			g_trapEnt[i] = 0;
		}
	}
}
clear_traps() { for (new i = 0; i < MAX_NODES; i++) g_traps[i] = -1; refresh_traps(); }

// ---------------------------------------------------------------- turns --
public flow_begin_seat()
{
	if (g_state != ST_BOARD) return;
	fade(1, 0.25);
	set_task(0.3, "flow_turn_cut", TASK_FLOW);
}

public flow_turn_cut()
{
	new s = g_cur;
	g_smoke[s] = false;
	g_camSnap = true;
	cam_shot(CAM_INTRO);
	fade(0, 0.4);
	banner("%s's turn", g_seatName[s]);
	subline("%s  |  $%d  |  hostages %d spaces away", SKIN_NAME[g_seatSkin[s]], g_money[s], g_dist[g_pos[s]][g_hostage]);
	set_task(spd(1.8), "flow_turn_ready", TASK_FLOW);
}

public flow_turn_ready()
{
	new s = g_cur;
	cam_shot(CAM_FOLLOW);
	if (g_seatBot[s]) set_task(spd(0.9), "flow_bot_buy", TASK_FLOW);
	else set_task(spd(0.5), "flow_human_buy", TASK_FLOW);   // turn menu: use items / jump
}

public flow_bot_buy() { new s = g_cur; ai_buy_gear(s); if (get_pcvar_num(c_buyany)) ai_shop(s, SIDE_NONE); ai_use_items(s); set_task(spd(0.8), "flow_roll", TASK_FLOW); }
public flow_human_buy() { show_turn_menu(g_cur); }

// ------------------------------------------------------------- dice crates --
// One crate floats above your head (two with Knife Out). It spins and flips through your
// character's die faces; jump into it and it stops on whatever face is showing.

public flow_roll()
{
	new s = g_cur, id = g_seatPlayer[s];
	g_waitKind[s] = W_NONE;
	g_diceN = 1 + g_extraCrates[s];
	g_extraCrates[s] = 0;
	new Float:base[3]; base = g_nodePos[g_pos[s]];
	for (new k = 0; k < 3; k++)
	{
		if (!is_valid_ent(g_diceEnt[k])) continue;
		g_diceHit[k] = false; g_diceFace[k] = random(6);
		if (k >= g_diceN) { entity_set_int(g_diceEnt[k], EV_INT_effects, EF_NODRAW); continue; }
		new Float:o[3]; o = base;
		new Float:side = (float(k) - float(g_diceN - 1) / 2.0) * 44.0;          // spread along the camera's right
		o[0] += side * g_camFwd[1]; o[1] -= side * g_camFwd[0];
		new Float:po[3]; if (is_user_alive(id)) entity_get_vector(id, EV_VEC_origin, po); else { po = base; po[2] += 37.0; }
		o[2] = po[2] + DICE_LIFT;
		if (g_diceN == 1) { o[0] = po[0]; o[1] = po[1]; }
		else { o[0] += po[0] - base[0]; o[1] += po[1] - base[1]; }
		entity_set_origin(g_diceEnt[k], o);
		entity_set_int(g_diceEnt[k], EV_INT_effects, 0);
		entity_set_int(g_diceEnt[k], EV_INT_skin, 0);
		entity_set_vector(g_diceEnt[k], EV_VEC_avelocity, Float:{ 30.0, 220.0, 0.0 });
	}
	g_diceArmed = true; g_diceOpen = true;
	cam_shot(CAM_DICE);
	if (get_pcvar_num(c_debug) > 1)
	{
		new Float:c[3], Float:po[3]; entity_get_vector(g_diceEnt[0], EV_VEC_origin, c); pawn_origin(s, po);
		dbg("crate up: crate %.0f %.0f %.0f  pawn %.0f %.0f %.0f", c[0], c[1], c[2], po[0], po[1], po[2]);
	}
	g_diceStart = get_gametime();
	g_diceBotJump = get_gametime() + spd(random_float(0.9, 1.6));
	if (is_user_alive(id))
	{
		if (g_navThawed[id]) nav_end(id);
		entity_set_int(id, EV_INT_flags, entity_get_int(id, EV_INT_flags) & ~FL_FROZEN);   // free to jump; task_dice pins them to the space
	}
	emit_sound(g_diceEnt[0], CHAN_ITEM, "items/gunpickup2.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
	if (!g_seatBot[s]) { client_print(id, print_center, "JUMP into the crate!"); subline("%s: jump into the crate!", g_seatName[s]); }
	remove_task(TASK_DICE);
	set_task(0.05, "task_dice", TASK_DICE, _, _, "b");
}

public task_dice()
{
	new s = g_cur, id = g_seatPlayer[s];
	static tick; tick++;
	// flip faces
	for (new k = 0; k < g_diceN; k++)
	{
		if (g_diceHit[k] || !is_valid_ent(g_diceEnt[k])) continue;
		if (tick % 2 == 0) g_diceFace[k] = (g_diceFace[k] + 1) % 6;
		entity_set_int(g_diceEnt[k], EV_INT_skin, 1 + SKIN_DICE[g_seatSkin[s]][g_diceFace[k]]);
	}
	if (!g_diceOpen) return;
	new bool:alive = bool:is_user_alive(id);
	if (alive)
	{
		// pin the pawn to its space; only vertical movement allowed
		new Float:o[3], Float:want[3]; entity_get_vector(id, EV_VEC_origin, o);
		want = g_nodePos[g_pos[s]];
		static const Float:OFF[SEATS][2] = { {-14.0, -14.0}, {14.0, -14.0}, {-14.0, 14.0}, {14.0, 14.0} };
		want[0] += OFF[s][0]; want[1] += OFF[s][1];
		if (floatabs(o[0] - want[0]) > 3.0 || floatabs(o[1] - want[1]) > 3.0)
		{
			o[0] = want[0]; o[1] = want[1]; entity_set_origin(id, o);
			new Float:v[3]; entity_get_vector(id, EV_VEC_velocity, v); v[0] = 0.0; v[1] = 0.0; entity_set_vector(id, EV_VEC_velocity, v);
		}
		new bool:onGround = (entity_get_int(id, EV_INT_flags) & FL_ONGROUND) != 0;
		if (onGround) g_diceArmed = true;
		// bots jump on their own schedule
		if (g_seatBot[s])
		{
			// bots under bot_stop don't run player physics, so play the jump arc for them: v0 268 u/s, gravity 800
			new Float:t = get_gametime() - g_diceBotJump;
			if (t >= 0.0)
			{
				new Float:spot[3]; pawn_spot(s, g_pos[s], spot);
				new Float:z = 268.0 * t - 400.0 * t * t;
				if (z <= 0.0 && t > 0.2) { z = 0.0; g_diceBotJump = get_gametime() + spd(random_float(0.9, 1.4)); }
				spot[2] += floatmax(z, 0.0);
				entity_set_origin(id, spot);
				onGround = z <= 0.0;
				if (onGround) g_diceArmed = true;
			}
		}
		// head hits crate bottom?
		new Float:top[3]; entity_get_vector(id, EV_VEC_absmax, top);
		for (new k = 0; k < g_diceN; k++)
		{
			if (g_diceHit[k] || !g_diceArmed) continue;
			new Float:c[3]; entity_get_vector(g_diceEnt[k], EV_VEC_origin, c);
			if (get_pcvar_num(c_debug) > 1 && !onGround) dbg("air: top %.0f crate bottom %.0f", top[2], c[2] - DICE_HALF);
			if (top[2] >= c[2] - DICE_HALF - 2.0) { dice_hit(k); g_diceArmed = false; break; }
		}
	}
	// nobody jumped (AFK or dead pawn): hit it for them
	if (get_gametime() - g_diceStart > (g_seatBot[s] ? spd(8.0) : 12.0) || !alive)
		for (new k = 0; k < g_diceN; k++) if (!g_diceHit[k]) { dice_hit(k); break; }
}

dice_hit(k)
{
	new s = g_cur;
	g_diceHit[k] = true;
	g_diceVal[k] = SKIN_DICE[g_seatSkin[s]][g_diceFace[k]];
	if (k == 0 && g_rigged[s] > 0) { g_diceVal[k] = g_rigged[s]; g_rigged[s] = 0; }
	new e = g_diceEnt[k];
	entity_set_int(e, EV_INT_skin, 1 + g_diceVal[k]);
	entity_set_vector(e, EV_VEC_avelocity, Float:{ 0.0, 0.0, 0.0 });
	new Float:ang[3], Float:c[3], Float:d[3]; entity_get_vector(e, EV_VEC_origin, c);
	xs_vec_sub_simple(g_camPos, c, d); vector_to_angle(d, ang); ang[0] = 0.0; ang[2] = 0.0;   // turn a face to the camera
	entity_set_vector(e, EV_VEC_angles, ang);
	c[2] += 10.0; entity_set_origin(e, c);                                                  // bonk
	set_task(0.12, "task_dice_settle", TASK_DICE + 10 + k);
	emit_sound(e, CHAN_ITEM, "weapons/c4_beep1.wav", 1.0, ATTN_NORM, 0, PITCH_HIGH);
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_SPARKS);
	engfunc(EngFunc_WriteCoord, c[0]); engfunc(EngFunc_WriteCoord, c[1]); engfunc(EngFunc_WriteCoord, c[2] - DICE_HALF);
	message_end();
	dbg("%s hits crate %d: %d", g_seatName[s], k + 1, g_diceVal[k]);
	for (new j = 0; j < g_diceN; j++) if (!g_diceHit[j]) return;
	g_diceOpen = false;
	set_task(spd(0.9), "flow_dice_done", TASK_FLOW);
}

public task_dice_settle(taskid)
{
	new k = taskid - TASK_DICE - 10;
	if (!is_valid_ent(g_diceEnt[k])) return;
	new Float:c[3]; entity_get_vector(g_diceEnt[k], EV_VEC_origin, c); c[2] -= 10.0; entity_set_origin(g_diceEnt[k], c);
}

public flow_dice_done()
{
	new s = g_cur, id = g_seatPlayer[s];
	remove_task(TASK_DICE);
	for (new k = 0; k < 3; k++) if (is_valid_ent(g_diceEnt[k])) entity_set_int(g_diceEnt[k], EV_INT_effects, EF_NODRAW);
	if (is_user_alive(id)) { place_pawn(s); freeze(id); }
	new r = 0; for (new k = 0; k < g_diceN; k++) r += g_diceVal[k];
	new fl = g_flashed[s];
	if (fl) { r = max(0, r - fl); g_flashed[s] = 0; }
	if (g_diceN > 1 || fl) banner("%s rolls %d%s%s", g_seatName[s], r, g_diceN > 1 ? (g_diceN == 3 ? " (bhop script)" : " (knife out)") : "", fl ? " (faked out -3)" : "");
	else banner("%s rolls %d", g_seatName[s], r);
	g_stepsLeft = r; g_moveDepth = 0;
	cam_shot(CAM_FOLLOW);
	set_task(spd(1.2), "flow_step", TASK_FLOW);
}

public hc_reset_maxspeed_post(const id)
{
	// a maxspeed of 1 also kills jumping (found the hard way), so the crate phase pins position instead
	#pragma unused id
}

public flow_step()
{
	new s = g_cur;
	g_waitKind[s] = W_NONE;
	if (g_stepsLeft <= 0) { land(s); return; }
	new cur = g_pos[s];
	if (g_nodeNextN[cur] > 1)
	{
		if (g_seatBot[s])
		{
			new a = g_nodeNext[cur][0], b = g_nodeNext[cur][1];
			step_to(s, g_dist[b][g_hostage] < g_dist[a][g_hostage] ? b : a);
		}
		else { wait_for(s, W_BRANCH); show_branch_menu(s); }
		return;
	}
	step_to(s, g_nodeNext[cur][0]);
}

// pawns hop from space to space instead of teleporting

pawn_spot(s, node, Float:o[3])
{
	static const Float:OFF[SEATS][2] = { {-14.0, -14.0}, {14.0, -14.0}, {-14.0, 14.0}, {14.0, 14.0} };
	o[0] = g_nodePos[node][0] + OFF[s][0]; o[1] = g_nodePos[node][1] + OFF[s][1]; o[2] = g_nodePos[node][2] + 37.0;
}

step_sfx(s)
{
	new f[40]; formatex(f, charsmax(f), "player/pl_step%d.wav", random_num(1, 4));
	emit_sound(g_seatPlayer[s] ? g_seatPlayer[s] : 0, CHAN_BODY, f, 0.8, ATTN_NORM, 0, PITCH_NORM + random_num(-8, 8));
}

step_to(s, node)
{
	pawn_spot(s, g_pos[s], g_hopFrom);
	pawn_spot(s, node, g_hopTo);
	g_hopNode = node;
	new id = g_seatPlayer[s];
	if (is_user_alive(id))
	{
		new Float:d[3], Float:ang[3]; xs_vec_sub_simple(g_hopTo, g_hopFrom, d); vector_to_angle(d, ang); ang[0] = 0.0;
		entity_set_vector(id, EV_VEC_angles, ang); entity_set_vector(id, EV_VEC_v_angle, ang); entity_set_int(id, EV_INT_fixangle, 1);
	}
	g_hopStart = get_gametime(); g_hopActive = true;   // fw_startframe moves the pawn
	step_sfx(s);
}

hop_step()
{
	if (g_state != ST_BOARD) { g_hopActive = false; return; }
	new s = g_cur, id = g_seatPlayer[s];
	new Float:t = (get_gametime() - g_hopStart) / HOP_TIME;
	if (t > 1.0) t = 1.0;
	if (is_user_alive(id))
	{
		new Float:o[3];
		for (new k = 0; k < 3; k++) o[k] = g_hopFrom[k] + (g_hopTo[k] - g_hopFrom[k]) * t;
		o[2] += 22.0 * floatsin(t * 3.14159, radian);
		entity_set_origin(id, o);
		entity_set_vector(id, EV_VEC_velocity, Float:{0.0, 0.0, 0.0});
	}
	if (t < 1.0) return;
	g_hopActive = false;
	step_arrive(s, g_hopNode);
}

step_arrive(s, node)
{
	g_pos[s] = node; g_stepsLeft--; g_moved[s]++;
	place_pawn(s);
	step_sfx(s);
	new Float:pause = spd(0.12);
	if (node == g_hostage)
	{
		new cost = get_pcvar_num(c_hostage);
		if (g_money[s] >= cost)
		{
			if (g_seatBot[s]) { rescue(s); pause = spd(2.6); }
			else { wait_for(s, W_HOSTAGE); show_hostage_menu(s); return; }
		}
		else subline("%s reaches the hostages but can't pay $%d.", g_seatName[s], cost);
	}
	// pass-through spaces: buy zones and the negotiator stop you whether you land or not
	if (g_nodeType[node] == NT_SHOP)
	{
		g_shopSide = g_nodeShopSide[node];
		banner("%s Black Market", g_shopSide == SIDE_T ? "T" : "CT");
		if (g_seatBot[s]) { ai_shop(s, g_shopSide); pause += spd(1.4); }
		else { cam_shot(CAM_LAND); wait_for(s, W_SHOP); show_shop_menu(s); return; }
	}
	else if (g_nodeType[node] == NT_NEGOT)
	{
		banner("The Negotiator");
		if (g_seatBot[s]) { ai_negotiate(s); pause += spd(1.6); }
		else { wait_for(s, W_NEGOT); show_negotiator_menu(s); return; }
	}
	set_task(pause, "flow_step", TASK_FLOW);
}

public task_hostage_cutaway() { cam_shot(CAM_HOSTAGE, spd(1.6) + 0.4); subline("The hostages moved to %s.", g_nodeArea[g_hostage]); }

rescue(s)
{
	new cost = get_pcvar_num(c_hostage);
	g_money[s] -= cost; g_stars[s]++; sync_money(s); sync_score(s);
	client_cmd(0, "spk ^"radio/rescued.wav^"");
	banner("%s rescues the hostages!", g_seatName[s]);
	move_hostage();
	set_task(spd(1.0), "task_hostage_cutaway", TASK_CAM + 1);
	announce("%s pays $%d for a star. Hostages moved to %s.", g_seatName[s], cost, g_nodeArea[g_hostage]);
}

land(s)
{
	cam_shot(CAM_LAND);
	new n = g_pos[s], mult = overtime() ? 2 : 1;
	new owner = g_traps[n];
	if (owner >= 0 && owner != s)
	{
		g_traps[n] = -1; refresh_traps();
		if (g_gKit[s]) { g_gKit[s] = false; new g = gain(s, 500); announce("%s defuses %s's C4. +$%d", g_seatName[s], g_seatName[owner], g); client_cmd(0, "spk ^"radio/bombdef.wav^""); voice(s, VO_GOOD); }
		else if (g_smoke[s]) announce("%s walks through %s's C4 in smoke. It fizzles.", g_seatName[s], g_seatName[owner]);
		else { new t = lose(s, get_pcvar_num(c_trap)); gain(owner, t); g_c4Take[owner] += t; announce("C4! %s pays %s $%d.", g_seatName[s], g_seatName[owner], t); explosion_fx(n); voice(s, VO_BAD); }
	}
	switch (g_nodeType[n])
	{
		case NT_BLUE, NT_START, NT_SHOP, NT_NEGOT: { g_lastColor[s] = SIDE_CT; new g = gain(s, get_pcvar_num(c_blue) * mult); subline("CT space: +$%d", g); client_cmd(0, "spk ^"items/9mmclip1.wav^""); voice(s, VO_BLUE); }
		case NT_RED:
		{
			g_lastColor[s] = SIDE_T; g_reds[s]++;
			new t = lose(s, get_pcvar_num(c_red) * mult); subline("T space: -$%d", t);
			client_cmd(0, "spk ^"player/bhit_kevlar-1.wav^""); voice(s, VO_RED);
		}
		case NT_SITE:
		{
			g_lastColor[s] = SIDE_NONE;
			new g = gain(s, 300), c = n, tgt = -1;
			for (new k = 0; k < 12; k++) { c = g_nodeNext[c][0]; if (k >= 3 && can_plant(c) && !node_occupied(c)) { tgt = c; break; } }
			if (tgt >= 0) { g_traps[tgt] = s; refresh_traps(); }
			subline("Bomb planted on %c. +$%d%s", g_nodeLetter[n], g, tgt >= 0 ? ", C4 set down the road." : "");
			client_cmd(0, "spk ^"radio/bombpl.wav^"");
		}
		case NT_EVENT: { g_lastColor[s] = SIDE_NONE; if (do_event(s)) return; }
		case NT_CAMPER: { g_lastColor[s] = SIDE_T; camper(s); }
		case NT_ARMORY: { g_lastColor[s] = SIDE_CT; armory(s); }
		case NT_DUEL:
		{
			g_lastColor[s] = SIDE_NONE;
			banner("Duel space!");
			if (g_seatBot[s]) { new o = -1; for (new k = 0; k < SEATS; k++) if (k != s && (o < 0 || g_money[k] > g_money[o])) o = k; begin_duel(s, o); }
			else show_target_menu(s, 1);
			return;
		}
		case NT_VIP: { g_lastColor[s] = SIDE_NONE; vip_escort(s); return; }
	}
	sync_score(s);
	set_task(spd(2.2), "flow_end_seat", TASK_FLOW);
}

// ---------------------------------------------------------- voice lines --
// Mario Party style barks: csp_voice % chance the seat's character says something, played
// from their pawn so it sounds like them. Stock radio clips, so nothing new to download.

voice(s, kind, Float:delay = 0.7)
{
	if (s < 0 || s >= SEATS || random(100) >= get_pcvar_num(c_voice)) return;
	new pick = random(sizeof VO_LINES[]);
	if (kind == VO_WON && pick >= 10) pick = (g_seatSkin[s] >= SK_SEAL) ? 10 : 11;   // "Counter-Terrorists win" only from CTs
	new data[2]; data[0] = s; data[1] = kind * 16 + pick;
	set_task(spd(delay), "task_voice", TASK_VOICE + s, data, sizeof data);
}

public task_voice(data[])
{
	new s = data[0], kind = data[1] / 16, pick = data[1] % 16;
	new e = g_seatPlayer[s];
	if (e && is_user_connected(e) && is_user_alive(e)) emit_sound(e, CHAN_VOICE, VO_LINES[kind][pick], 1.0, ATTN_NONE, 0, PITCH_NORM + random_num(-6, 6));
	else client_cmd(0, "spk ^"%s^"", VO_LINES[kind][pick]);
}

// one winner and one loser speak up after a minigame, not the whole lobby
mg_voices()
{
	new los[SEATS], n = 0;
	for (new s = 0; s < SEATS; s++) { new bool:w = false; for (new k = 0; k < g_mgWinnerN; k++) if (g_mgWinners[k] == s) w = true; if (!w) los[n++] = s; }
	if (g_mgWinnerN) voice(g_mgWinners[random(g_mgWinnerN)], VO_WON, 0.8);
	if (n) voice(los[random(n)], VO_LOST, 2.2);
}

explosion_fx(n)
{
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	engfunc(EngFunc_WriteCoord, g_nodePos[n][0]); engfunc(EngFunc_WriteCoord, g_nodePos[n][1]); engfunc(EngFunc_WriteCoord, g_nodePos[n][2] + 30.0);
	write_short(g_beamSpr); write_byte(20); write_byte(15); write_byte(0);
	message_end();
}

// returns true if it took over the flow (bhop / duel)
bool:do_event(s)
{
	static const EV[] = { 0, 1, 2, 3, 4, 5, 6, 8, 8 };
	new e = EV[random(sizeof EV)];
	if (e == 4 && g_moveDepth > 0) e = 2;
	if (e == 1 || e == 3) voice(s, VO_BAD); else if (e != 5 && e != 6) voice(s, VO_GOOD);
	switch (e)
	{
		case 0:
		{
			if (g_gSec[s] < 3) { g_gSec[s] = 3; subline("? Found a dropped Desert Eagle. It's yours for the next round."); }
			else if (give_item(s, IT_KNIFE)) subline("? Found a Knife Out lying around.");
			else { new g = gain(s, 650); subline("? Found a Deagle, sold it. +$%d", g); }
		}
		case 1: { g_flashed[s] += 3; subline("? Flashed by your own team. Next roll -3."); }
		case 2: { for (new o = 0; o < SEATS; o++) gain(o, 300); subline("? Round bonus. Everyone +$300."); }
		case 3: { new t = lose(s, 1000); subline("? Team kill. -$%d", t); }
		case 4: { subline("? Bhop chain. Three more spaces."); g_stepsLeft = 3; g_moveDepth++; set_task(spd(1.2), "flow_step", TASK_FLOW); return true; }
		case 5:
		{
			new o; do o = random(SEATS); while (o == s);
			new t = g_pos[s]; g_pos[s] = g_pos[o]; g_pos[o] = t; place_pawn(s); place_pawn(o);
			subline("? Admin slap. %s and %s swap places.", g_seatName[s], g_seatName[o]);
		}
		case 6: { move_hostage(); subline("? The hostages moved to %s.", g_nodeArea[g_hostage]); }
		case 8:
		{
			new rich = -1;
			for (new o = 0; o < SEATS; o++) if (o != s && !g_smoke[o] && (rich < 0 || g_money[o] > g_money[rich])) rich = o;
			if (rich >= 0) { new t = lose(rich, 600); gain(s, t); subline("? %s drops %s a weapon. $%d changes hands.", g_seatName[rich], g_seatName[s], t); }
		}
	}
	return false;
}

public flow_end_seat()
{
	if (g_state != ST_BOARD) return;
	if (g_cur < SEATS - 1) { g_cur++; flow_begin_seat(); return; }
	g_cur = 0;
	start_round_minigame();
}

// ----------------------------------------------------------------- items --

bool:in_stock(side, it)
{
	if (side == SIDE_NONE) return true;
	if (side == SIDE_T) { for (new i = 0; i < sizeof SHOP_T; i++) if (SHOP_T[i] == it) return true; }
	else { for (new i = 0; i < sizeof SHOP_CT; i++) if (SHOP_CT[i] == it) return true; }
	return false;
}

bool:can_buy_item(s, it) { return g_money[s] >= ITEM_PRICE[it] && g_itemN[s] < INV_MAX; }

bool:buy_item(s, it)
{
	if (!can_buy_item(s, it)) return false;
	g_money[s] -= ITEM_PRICE[it]; g_spent[s] += ITEM_PRICE[it]; sync_money(s);
	g_items[s][g_itemN[s]++] = it;
	announce("%s buys %s.", g_seatName[s], ITEM_NAME[it]);
	emit_sound(g_seatPlayer[s] ? g_seatPlayer[s] : 0, CHAN_ITEM, "items/gunpickup1.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
	return true;
}

bool:give_item(s, it)
{
	if (g_itemN[s] >= INV_MAX) return false;
	g_items[s][g_itemN[s]++] = it; return true;
}

bool:can_use(s, it)
{
	if (!has_item(s, it)) return false;
	if (it == IT_C4 && !can_plant(g_pos[s])) return false;
	if (it == IT_SMOKE && g_smoke[s]) return false;
	if ((it == IT_KNIFE || it == IT_BHOP) && g_extraCrates[s] > 0) return false;
	if (it == IT_RIGGED && g_rigged[s] > 0) return false;
	return true;
}

// target: seat for Fake Call / Rotate; value for Rigged Crate
bool:use_item(s, it, target)
{
	if (!can_use(s, it)) return false;
	if ((it == IT_FAKE || it == IT_ROTATE) && (target < 0 || target == s)) return false;
	if (it == IT_RIGGED && (target < 1 || target > 9)) return false;
	take_item(s, it);
	switch (it)
	{
		case IT_KNIFE:  { g_extraCrates[s] = 1; announce("%s pulls the knife. Two crates this roll.", g_seatName[s]); }
		case IT_BHOP:   { g_extraCrates[s] = 2; announce("%s runs a bhop script. Three crates!", g_seatName[s]); }
		case IT_RIGGED: { g_rigged[s] = target; announce("%s rigs the crate.", g_seatName[s]); }
		case IT_FAKE:   { g_flashed[target] += 3; announce("%s fakes a call. %s's next roll is -3.", g_seatName[s], g_seatName[target]); }
		case IT_SMOKE:  { g_smoke[s] = true; announce("%s pops smoke.", g_seatName[s]); }
		case IT_C4:     { g_traps[g_pos[s]] = s; refresh_traps(); announce("%s plants C4 in %s.", g_seatName[s], g_nodeArea[g_pos[s]]); }
		case IT_ROTATE:
		{
			new t = g_pos[s]; g_pos[s] = g_pos[target]; g_pos[target] = t; place_pawn(s); place_pawn(target);
			g_camSnap = true; announce("%s rotates. %s and %s swap places.", g_seatName[s], g_seatName[s], g_seatName[target]);
		}
		case IT_INTEL:
		{
			g_pos[s] = g_hostage; place_pawn(s); g_camSnap = true;
			announce("%s has intel. Straight to the hostages!", g_seatName[s]);
			if (g_money[s] >= get_pcvar_num(c_hostage)) rescue(s);
			else subline("...but can't pay $%d.", get_pcvar_num(c_hostage));
		}
	}
	return true;
}

// ------------------------------------------------------------------ gear --
gear_summary(s, out[], len)
{
	new n = 0; out[0] = 0;
	if (g_gPrim[s] >= 0) n += formatex(out[n], len - n, "%s ", GEAR_NAME[g_gPrim[s]]);
	if (g_gSec[s] >= 0) n += formatex(out[n], len - n, "%s ", GEAR_NAME[g_gSec[s]]);
	if (g_gArmor[s]) n += formatex(out[n], len - n, "%s ", g_gArmor[s] == 2 ? "K+H" : "K");
	if (g_gHE[s] || g_gFlash[s] || g_gSmoke[s]) n += formatex(out[n], len - n, "%s%s%s ", g_gHE[s] ? "H" : "", g_gFlash[s] ? (g_gFlash[s] == 2 ? "FF" : "F") : "", g_gSmoke[s] ? "S" : "");
	if (g_gKit[s]) n += formatex(out[n], len - n, "kit");
}

bool:buy_gear(s, g)
{
	if (g_money[s] < GEAR_PRICE[g]) return false;
	if (g <= GEAR_SECONDARY_MAX) { if (g_gSec[s] == g) return false; g_gSec[s] = g; }
	else { if (g_gPrim[s] == g) return false; g_gPrim[s] = g; }
	g_money[s] -= GEAR_PRICE[g]; g_spent[s] += GEAR_PRICE[g]; sync_money(s);
	announce("%s buys %s.", g_seatName[s], GEAR_NAME[g]);
	return true;
}

eq_price(s, e) { return (e == EQ_HELMET && g_gArmor[s] == 1) ? 350 : EQ_PRICE[e]; }

bool:can_buy_eq(s, e)
{
	if (g_money[s] < eq_price(s, e)) return false;
	switch (e)
	{
		case EQ_KEVLAR: return g_gArmor[s] == 0;
		case EQ_HELMET: return g_gArmor[s] < 2;
		case EQ_FLASH:  return g_gFlash[s] < 2;
		case EQ_HE:     return g_gHE[s] < 1;
		case EQ_SMOKE:  return g_gSmoke[s] < 1;
		case EQ_KIT:    return !g_gKit[s];
	}
	return false;
}

bool:buy_eq(s, e)
{
	if (!can_buy_eq(s, e)) return false;
	g_spent[s] += eq_price(s, e); g_money[s] -= eq_price(s, e); sync_money(s);
	switch (e)
	{
		case EQ_KEVLAR: g_gArmor[s] = 1;
		case EQ_HELMET: g_gArmor[s] = 2;
		case EQ_FLASH:  g_gFlash[s]++;
		case EQ_HE:     g_gHE[s]++;
		case EQ_SMOKE:  g_gSmoke[s]++;
		case EQ_KIT:    g_gKit[s] = true;
	}
	announce("%s buys %s.", g_seatName[s], EQ_NAME[e]);
	return true;
}

// ----------------------------------------------------------------- bots --
ai_reserve(s)
{
	new cost = get_pcvar_num(c_hostage), d = g_dist[g_pos[s]][g_hostage];
	if (g_money[s] >= cost && d <= 12) return cost;      // star is in reach: keep the cash
	return g_money[s] * 4 / 10;                          // otherwise save some, spend the rest
}

ai_buy_gear(s)
{
	new reserve = ai_reserve(s);
	#define SUR (g_money[s] - reserve)
	if (g_gPrim[s] < 0)
	{
		if (SUR >= 4750 && random(10) < 3) buy_gear(s, 20);                       // AWP
		else if (SUR >= 3100) buy_gear(s, random(2) ? 16 : 15);                   // M4A1 / AK-47
		else if (SUR >= 2250 && random(10) < 5) buy_gear(s, 14);                  // FAMAS
		else if (SUR >= 1500 && random(10) < 4) buy_gear(s, 10);                  // MP5
	}
	if (g_gArmor[s] < 2 && SUR >= 1000) buy_eq(s, EQ_HELMET);
	else if (g_gArmor[s] == 0 && SUR >= 650) buy_eq(s, EQ_KEVLAR);
	if (g_gSec[s] < 3 && SUR >= 650 && random(10) < 4) buy_gear(s, 3);         // Deagle
	if (SUR >= 300 && random(10) < 4) buy_eq(s, EQ_HE);
	if (SUR >= 200 && random(10) < 4) buy_eq(s, EQ_FLASH);
	#undef SUR
}

ai_use_items(s)
{
	new d = g_dist[g_pos[s]][g_hostage];
	if (has_item(s, IT_INTEL) && g_money[s] >= get_pcvar_num(c_hostage) && d > 6) { use_item(s, IT_INTEL, -1); return; }
	if (d >= 1 && d <= 6 && can_use(s, IT_RIGGED)) use_item(s, IT_RIGGED, d);
	else if (d >= 11 && can_use(s, IT_BHOP)) use_item(s, IT_BHOP, -1);
	else if (d >= 7 && d <= 12 && can_use(s, IT_KNIFE)) use_item(s, IT_KNIFE, -1);
	new L = leader(s);
	if (L >= 0 && g_dist[g_pos[L]][g_hostage] <= 8 && can_use(s, IT_FAKE)) use_item(s, IT_FAKE, L);
	if (L >= 0 && can_use(s, IT_ROTATE) && g_dist[g_pos[L]][g_hostage] + 4 < d) use_item(s, IT_ROTATE, L);
	if (can_use(s, IT_C4) && random(10) < 4) use_item(s, IT_C4, -1);
	new danger = 0;
	for (new k = 0, n = g_pos[s]; k < 7; k++) { n = g_nodeNext[n][0]; if (g_nodeType[n] == NT_CAMPER || (g_traps[n] >= 0 && g_traps[n] != s)) danger++; }
	if (danger && can_use(s, IT_SMOKE)) use_item(s, IT_SMOKE, -1);
}

// Black Market (board item shop) at a buy-zone space
ai_shop(s, side)
{
	g_shopSide = side;
	new reserve = ai_reserve(s);
	#define SUR (g_money[s] - reserve)
	if (SUR >= ITEM_PRICE[IT_INTEL] && in_stock(side, IT_INTEL) && random(10) < 5) buy_item(s, IT_INTEL);
	if (SUR >= ITEM_PRICE[IT_BHOP] && in_stock(side, IT_BHOP) && random(10) < 4) buy_item(s, IT_BHOP);
	if (SUR >= ITEM_PRICE[IT_RIGGED] && in_stock(side, IT_RIGGED) && random(10) < 4) buy_item(s, IT_RIGGED);
	if (SUR >= ITEM_PRICE[IT_KNIFE] && in_stock(side, IT_KNIFE) && random(10) < 5) buy_item(s, IT_KNIFE);
	if (SUR >= ITEM_PRICE[IT_C4] && in_stock(side, IT_C4) && random(10) < 3) buy_item(s, IT_C4);
	if (SUR >= ITEM_PRICE[IT_FAKE] && in_stock(side, IT_FAKE) && random(10) < 3) buy_item(s, IT_FAKE);
	if (SUR >= ITEM_PRICE[IT_SMOKE] && in_stock(side, IT_SMOKE) && random(10) < 3) buy_item(s, IT_SMOKE);
	if (SUR >= ITEM_PRICE[IT_ROTATE] && in_stock(side, IT_ROTATE) && random(10) < 2) buy_item(s, IT_ROTATE);
	#undef SUR
}


// ---------------------------------------------------------------- cursor menus --
// Every CS Party menu also works without number keys: move up/down (stick, D-pad, W/S, touch joystick)
// to move the cursor, Jump to pick, Use to back out. Controllers and phones need this; keyboards still
// have the digits. Read from the movement buttons in each usercmd, so it needs nothing client-side.
// ReHLDS throws away every button from an FL_FROZEN player, and board pawns are frozen. While a menu is
// open the pawn is "thawed" instead: maxspeed 1 (no walking, no jumping) but the buttons get through.

bool:nav_thaw(id)
{
	if (g_navThawed[id] || !is_user_alive(id) || !(entity_get_int(id, EV_INT_flags) & FL_FROZEN)) return false;
	g_navThawed[id] = true;
	entity_set_int(id, EV_INT_flags, entity_get_int(id, EV_INT_flags) & ~FL_FROZEN);
	set_entvar(id, var_maxspeed, 1.0);
	return true;
}

nav_end(id)
{
	g_navMenu[id] = 0;
	if (!g_navThawed[id]) return;
	g_navThawed[id] = false;
	if (!is_user_alive(id)) return;
	rg_reset_maxspeed(id);
	if ((g_state == ST_BOARD || g_state == ST_END) && !g_diceOpen) freeze(id);   // the crate phase pins pawns its own way
}

nav_show(id, m, const handler[])
{
	copy(g_navHandler[id], charsmax(g_navHandler[]), handler);
	new n = menu_items(m); if (n > NAV_MAX) n = NAV_MAX;
	g_navMenu[id] = m + 1; g_navN[id] = n; g_navPos[id] = 0;
	g_navOld[id] = get_user_button(id);   // a button already held (the Jump that opened this) doesn't count
	if (nav_thaw(id)) g_navOld[id] = -1;  // frozen pawns report no buttons at all: treat everything as held until released
	{ new sw = seat_of(id); if (sw >= 0 && sw == g_cur && g_state == ST_BOARD && g_waitLast[sw]) wait_for(sw, g_waitLast[sw]); }
	new acc, info[8], cb;
	for (new i = 0; i < n; i++) menu_item_getinfo(m, i, acc, info, charsmax(info), g_navName[id][i], charsmax(g_navName[][]), cb);
	nav_draw(id);
}

nav_draw(id)
{
	new m = g_navMenu[id] - 1;
	for (new i = 0; i < g_navN[id]; i++)
	{
		if (i == g_navPos[id]) { new line[110]; formatex(line, charsmax(line), "\y* %s", g_navName[id][i]); menu_item_setname(m, i, line); }
		else menu_item_setname(m, i, g_navName[id][i]);
	}
	g_navRedraw[id] = true;                 // re-showing a menu cancels the open one: its handler gets MENU_EXIT
	menu_display(id, m, 0);
	g_navRedraw[id] = false;
}

bool:nav_open(id)
{
	if (!g_navMenu[id]) return false;
	new menu, newmenu, page;
	player_menu_info(id, menu, newmenu, page);
	if (newmenu != g_navMenu[id] - 1) { nav_end(id); return false; }   // answered, replaced or closed
	return true;
}

nav_pick(id, i)
{
	if (get_gametime() < g_navNext[id]) return;
	g_navNext[id] = get_gametime() + 0.5;
	// AMXX keeps newmenu selection to itself: nothing server-side can press a menu key, and a stuffed
	// "menuselect" round trip proved unreliable on slow clients. So: forget the menu (the handler sees an
	// exit it ignores), clear the client's display, and call the handler with the item, exactly as a digit would.
	new m = g_navMenu[id] - 1, handler[32]; copy(handler, charsmax(handler), g_navHandler[id]);
	g_navPicking = true; menu_cancel(id); g_navPicking = false;
	show_menu(id, 0, " ", 0);
	nav_end(id);
	if (callfunc_begin(handler) == 1) { callfunc_push_int(id); callfunc_push_int(m); callfunc_push_int(i); callfunc_end(); }
	else log_amx("nav: handler %s not found", handler);
}

public fw_nav_cmdstart(id, uc)
{
	if (id >= 1 && id <= 32) get_uc(uc, UC_ForwardMove, g_navMove[id]);
	return FMRES_IGNORED;
}

public hc_nav_prethink(const id)
{
	if (g_navThawed[id] && !nav_open(id)) return HC_CONTINUE;   // closed by a digit key: freeze again
	if (!g_navMenu[id] || is_user_bot(id)) return HC_CONTINUE;
	if (g_navThawed[id]) { new Float:v[3]; entity_get_vector(id, EV_VEC_velocity, v); v[0] = 0.0; v[1] = 0.0; entity_set_vector(id, EV_VEC_velocity, v); }
	new b = get_entvar(id, var_button);
	if (g_navMove[id] > 120.0) b |= IN_FORWARD; else if (g_navMove[id] < -120.0) b |= IN_BACK;
	new pressed = b & ~g_navOld[id];
	g_navOld[id] = b;
	if (!pressed) return HC_CONTINUE;
	if (get_pcvar_num(c_debug) > 1) dbg("nav %d: pressed %x pos=%d/%d", id, pressed, g_navPos[id], g_navN[id]);
	if (!nav_open(id)) return HC_CONTINUE;
	new Float:now = get_gametime();
	if (pressed & IN_JUMP) { nav_pick(id, g_navPos[id]); return HC_CONTINUE; }
	if (pressed & IN_USE)
	{
		// "back": the item whose info is "0" (Done), if the menu has one
		for (new i = 0; i < g_navN[id]; i++)
		{
			new acc, info[8], nm[2], cb; menu_item_getinfo(g_navMenu[id] - 1, i, acc, info, charsmax(info), nm, charsmax(nm), cb);
			if (equal(info, "0")) { nav_pick(id, i); break; }
		}
		return HC_CONTINUE;
	}
	if (now < g_navNext[id]) return HC_CONTINUE;      // analog sticks chatter: one step per 0.15 s
	if (pressed & IN_FORWARD) { g_navPos[id] = (g_navPos[id] + g_navN[id] - 1) % g_navN[id]; g_navNext[id] = now + 0.15; nav_draw(id); }
	else if (pressed & IN_BACK) { g_navPos[id] = (g_navPos[id] + 1) % g_navN[id]; g_navNext[id] = now + 0.15; nav_draw(id); }
	return HC_CONTINUE;
}

// ---------------------------------------------------------------- menus --
// Your turn: buy gear, use items, jump at the crate.
show_turn_menu(s)
{
	new id = g_seatPlayer[s];
	if (!is_user_connected(id)) { g_seatBot[s] = true; flow_bot_buy(); return; }
	wait_for(s, W_TURN);
	new gs[64]; gear_summary(s, gs, charsmax(gs));
	new title[160]; formatex(title, charsmax(title), "\yYour turn  \w$%d  \dhostages %d away^n\dGear: %s", g_money[s], g_dist[g_pos[s]][g_hostage], gs[0] ? gs : "none");
	new m = menu_create(title, "mh_turn"), line[64], info[4];
	menu_additem(m, "\rJump at the crate \d(roll)", "99");
	menu_additem(m, "\wBuy gear \d(for the minigames)", "97");
	menu_additem(m, g_camMode == CAM_MAP ? "\yMap overlay: ON \d(back to the action)" : "\wMap overlay \d(pieces, flow, hostages)", "96");
	for (new k = 0; k < g_itemN[s]; k++)
	{
		new it = g_items[s][k];
		formatex(line, charsmax(line), "%sUse %s \d%s", can_use(s, it) ? "\w" : "\d", ITEM_NAME[it], ITEM_HINT[it]);
		num_to_str(it, info, charsmax(info)); menu_additem(m, line, info);
	}
	if (get_pcvar_num(c_buyany)) menu_additem(m, "\yBlack Market", "98");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_turn");
}

public mh_turn(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new info[4], acc, name[2], cb;
	if (item < 0) { menu_destroy(m); return PLUGIN_HANDLED; }
	menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb);
	menu_destroy(m);
	log_amx("%n picks turn option %s", id, info);   // 97 buy, 98 black market, 99 crate, else an item
	new s = seat_of(id), v = str_to_num(info);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	switch (v)
	{
		case 96: { toggle_map_view(); show_turn_menu(s); return PLUGIN_HANDLED; }
		case 99: { if (g_camMode == CAM_MAP) toggle_map_view(); set_task(spd(0.2), "flow_roll", TASK_FLOW); return PLUGIN_HANDLED; }
		case 98: { g_shopSide = SIDE_NONE; show_shop_menu(s, true); return PLUGIN_HANDLED; }
		case 97: { show_buy_menu(s); return PLUGIN_HANDLED; }
		case IT_FAKE:   if (can_use(s, IT_FAKE))   { show_target_menu(s, 0); return PLUGIN_HANDLED; }
		case IT_ROTATE: if (can_use(s, IT_ROTATE)) { show_target_menu(s, 4); return PLUGIN_HANDLED; }
		case IT_RIGGED: if (can_use(s, IT_RIGGED)) { show_rigged_menu(s); return PLUGIN_HANDLED; }
	}
	if (!use_item(s, v, -1)) client_print(id, print_center, "Can't use that now.");
	if (v == IT_INTEL) { set_task(spd(2.4), "flow_human_buy", TASK_FLOW); return PLUGIN_HANDLED; }
	show_turn_menu(s);
	return PLUGIN_HANDLED;
}

// the 1.6 buy menu
show_buy_menu(s)
{
	new id = g_seatPlayer[s], title[64];
	formatex(title, charsmax(title), "\yBuy  \w$%d", g_money[s]);
	new m = menu_create(title, "mh_buy");
	menu_additem(m, "Handgun", "1"); menu_additem(m, "Shotgun", "2"); menu_additem(m, "Sub-Machine Gun", "3");
	menu_additem(m, "Rifle", "4"); menu_additem(m, "Machine Gun", "5"); menu_additem(m, "Equipment", "8");
	menu_additem(m, "\rDone", "0");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_buy");
}

public mh_buy(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new info[4], acc, name[2], cb, v = 0;
	if (item >= 0) { menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb); v = str_to_num(info); }
	menu_destroy(m);
	new s = seat_of(id);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	if (v == 0) { show_turn_menu(s); return PLUGIN_HANDLED; }
	show_buy_cat(s, v);
	return PLUGIN_HANDLED;
}

show_buy_cat(s, cat)
{
	new id = g_seatPlayer[s], title[64], line[64], info[4];
	formatex(title, charsmax(title), "\yBuy  \w$%d", g_money[s]);
	new m = menu_create(title, "mh_buy_cat");
	if (cat == 8)
	{
		for (new e = 0; e < EQ_COUNT; e++)
		{
			formatex(line, charsmax(line), "%s%s \y$%d", can_buy_eq(s, e) ? "\w" : "\d", EQ_NAME[e], eq_price(s, e));
			formatex(info, charsmax(info), "e%d", e); menu_additem(m, line, info);
		}
	}
	else for (new g = 0; g < GEAR_N; g++)
	{
		if (GEAR_CAT[g] != cat) continue;
		formatex(line, charsmax(line), "%s%s \y$%d", g_money[s] >= GEAR_PRICE[g] ? "\w" : "\d", GEAR_NAME[g], GEAR_PRICE[g]);
		formatex(info, charsmax(info), "g%d", g); menu_additem(m, line, info);
	}
	menu_additem(m, "\rBack", "b");
	menu_setprop(m, MPROP_PERPAGE, 0);
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_buy_cat");
}

public mh_buy_cat(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new info[4], acc, name[2], cb;
	info[0] = 'b';
	if (item >= 0) menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb);
	menu_destroy(m);
	new s = seat_of(id);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	if (info[0] == 'g') { if (!buy_gear(s, str_to_num(info[1]))) client_print(id, print_center, "Can't buy that."); else client_cmd(id, "spk ^"items/gunpickup1.wav^""); }
	else if (info[0] == 'e') { if (!buy_eq(s, str_to_num(info[1]))) client_print(id, print_center, "Can't buy that."); else client_cmd(id, "spk ^"items/gunpickup1.wav^""); }
	show_buy_menu(s);
	return PLUGIN_HANDLED;
}

show_rigged_menu(s)
{
	new id = g_seatPlayer[s], m = menu_create("\yRigged Crate: pick your number", "mh_rigged"), info[4], line[24];
	for (new v = 1; v <= 6; v++) { formatex(line, charsmax(line), "%d %s", v, g_dist[g_pos[s]][g_hostage] == v ? "\y(hostages!)" : ""); num_to_str(v, info, charsmax(info)); menu_additem(m, line, info); }
	menu_additem(m, "\dNever mind", "0");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_rigged");
}

public mh_rigged(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new info[4], acc, name[2], cb, v = 0;
	if (item >= 0) { menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb); v = str_to_num(info); }
	menu_destroy(m);
	new s = seat_of(id);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	if (v > 0) use_item(s, IT_RIGGED, v);
	show_turn_menu(s);
	return PLUGIN_HANDLED;
}

// Black Market at a buy-zone space. fromTurn = opened from the turn menu (buy-anywhere mode)
new bool:g_shopFromTurn;
show_shop_menu(s, bool:fromTurn = false)
{
	g_shopFromTurn = fromTurn;
	new id = g_seatPlayer[s];
	new title[128]; formatex(title, charsmax(title), "\y%s  \w$%d  \ditems %d/%d", g_shopSide == SIDE_T ? "T Black Market" : (g_shopSide == SIDE_CT ? "CT Black Market" : "Black Market"), g_money[s], g_itemN[s], INV_MAX);
	new m = menu_create(title, "mh_shop"), line[96], info[4];
	for (new it = 0; it < IT_COUNT; it++)
	{
		if (!in_stock(g_shopSide, it)) continue;
		formatex(line, charsmax(line), "%s%s \y$%d \d%s", can_buy_item(s, it) ? "\w" : "\d", ITEM_NAME[it], ITEM_PRICE[it], ITEM_HINT[it]);
		num_to_str(it, info, charsmax(info)); menu_additem(m, line, info);
	}
	menu_additem(m, "\rDone", "99");
	menu_setprop(m, MPROP_PERPAGE, 0);
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_shop");
}

public mh_shop(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new info[4], acc, name[2], cb, v = 99;
	if (item >= 0) { menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb); v = str_to_num(info); }
	menu_destroy(m);
	new s = seat_of(id);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	if (v == 99) { if (g_shopFromTurn) show_turn_menu(s); else set_task(spd(0.3), "flow_step", TASK_FLOW); return PLUGIN_HANDLED; }
	if (!buy_item(s, v)) client_print(id, print_center, "Can't buy that.");
	show_shop_menu(s, g_shopFromTurn);
	return PLUGIN_HANDLED;
}

// purpose: 0 fake call, 1 duel, 2 negotiator cash, 3 negotiator star, 4 rotate
show_target_menu(s, purpose)
{
	g_targetPurpose = purpose;
	static const TITLES[5][] = { "\yFake call on who?", "\yDuel who?  \dup to $1000 each", "\yTake cash from who?", "\yTake a star from who?", "\ySwap places with who?" };
	new id = g_seatPlayer[s], m = menu_create(TITLES[purpose], "mh_target"), line[64], info[4];
	for (new o = 0; o < SEATS; o++)
	{
		if (o == s || (purpose == 3 && g_stars[o] == 0)) continue;
		formatex(line, charsmax(line), "%s \d$%d *%d %s", g_seatName[o], g_money[o], g_stars[o], g_nodeArea[g_pos[o]]); num_to_str(o, info, charsmax(info)); menu_additem(m, line, info);
	}
	if (purpose != 1) menu_additem(m, "\dNever mind", "9");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	wait_for(s, W_TARGET);   // a duel pick nobody answers would hold the party forever
	nav_show(id, m, "mh_target");
}

public mh_target(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new s = seat_of(id), t = -1;
	if (item >= 0) { new info[4], acc, name[2], cb; menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb); t = str_to_num(info); if (t == 9) t = -1; }
	menu_destroy(m);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	switch (g_targetPurpose)
	{
		case 0: { if (t >= 0) use_item(s, IT_FAKE, t); show_turn_menu(s); }
		case 1:
		{
			if (t < 0) t = (s + 1 + random(SEATS - 1)) % SEATS;
			begin_duel(s, t);
		}
		case 2, 3: { if (t >= 0) negotiate(s, t, g_targetPurpose == 3); set_task(spd(1.5), "flow_step", TASK_FLOW); }
		case 4: { if (t >= 0) use_item(s, IT_ROTATE, t); show_turn_menu(s); }
	}
	return PLUGIN_HANDLED;
}

show_branch_menu(s)
{
	new id = g_seatPlayer[s], cur = g_pos[s];
	new m = menu_create("\yFork in the road", "mh_branch"), line[80], info[4];
	for (new k = 0; k < g_nodeNextN[cur]; k++)
	{
		new n = g_nodeNext[cur][k];
		formatex(line, charsmax(line), "%s \d(%d to hostages)", g_nodeArea[n][0] ? g_nodeArea[n] : "This way", g_dist[n][g_hostage]);
		num_to_str(n, info, charsmax(info)); menu_additem(m, line, info);
	}
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_branch");
}

public mh_branch(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new s = seat_of(id), info[4], acc, name[2], cb, n;
	if (item < 0) n = g_nodeNext[g_pos[s]][0];
	else { menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb); n = str_to_num(info); }
	menu_destroy(m);
	if (s == g_cur && g_state == ST_BOARD) step_to(s, n);
	return PLUGIN_HANDLED;
}

show_hostage_menu(s)
{
	new id = g_seatPlayer[s], title[96];
	formatex(title, charsmax(title), "\yHostages!  \wPay $%d to rescue? \d(you have $%d)", get_pcvar_num(c_hostage), g_money[s]);
	new m = menu_create(title, "mh_hostage");
	menu_additem(m, "Rescue", "1"); menu_additem(m, "Keep the money", "0");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_hostage");
}

public mh_hostage(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new s = seat_of(id);
	menu_destroy(m);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	new Float:pause = spd(0.4);
	if (item == 0) { rescue(s); pause = spd(2.6); }
	set_task(pause, "flow_step", TASK_FLOW);
	return PLUGIN_HANDLED;
}

// ------------------------------------------------------------ minigames --
start_round_minigame()
{
	new ct = 0, t = 0;
	for (new s = 0; s < SEATS; s++)
	{
		new c = g_lastColor[s] == SIDE_NONE ? random(2) : g_lastColor[s];
		g_mgSide[s] = c; g_mgIn[s] = true; g_lastColor[s] = SIDE_NONE;
		if (c == SIDE_CT) ct++; else t++;
	}
	g_mgFmt = (ct == 0 || t == 0) ? FMT_FFA : (ct == 2 ? FMT_2V2 : FMT_1V3);
	g_mg = pick_minigame(g_mgFmt);
	g_cont = CONT_NEXT_TURN; g_mgWager = 0;
	begin_minigame();
}

begin_duel(s, o)
{
	g_duelA = s;
	g_mgWager = min(1000, min(g_money[s], g_money[o]));
	lose(s, g_mgWager); lose(o, g_mgWager);
	for (new k = 0; k < SEATS; k++) { g_mgIn[k] = (k == s || k == o); g_mgSide[k] = SIDE_CT; }
	g_mgFmt = FMT_DUEL; g_mg = pick_minigame(FMT_DUEL);
	g_cont = CONT_NEXT_SEAT;
	announce("Duel! %s calls out %s for $%d.", g_seatName[s], g_seatName[o], g_mgWager);
	set_task(spd(1.5), "task_begin_minigame", TASK_FLOW);
}
public task_begin_minigame() { begin_minigame(); }

// ------------------------------------------------------------ special spaces --
// Camper: an AWPer in a window. Smoke is the only cover.
camper(s)
{
	emit_sound(g_seatPlayer[s] ? g_seatPlayer[s] : 0, CHAN_WEAPON, "weapons/awp1.wav", 1.0, ATTN_NORM, 0, PITCH_NORM);
	if (g_smoke[s]) { subline("Camper! %s's smoke blocks the shot.", g_seatName[s]); return; }
	new r = random(100);
	if (r < 12 && g_stars[s] > 0) { g_stars[s]--; sync_score(s); move_hostage(); banner("Headshot. %s loses a star!", g_seatName[s]); return; }
	if (r < 37 && g_gPrim[s] >= 0) { banner("Camper! %s drops their %s.", g_seatName[s], GEAR_NAME[g_gPrim[s]]); g_gPrim[s] = -1; return; }
	if (r < 37 && g_itemN[s] > 0) { g_itemN[s] = 0; banner("Camper shoots %s's items to pieces.", g_seatName[s]); return; }
	new t = lose(s, max(500, (g_money[s] * 35 / 100) / 50 * 50));
	banner("Camper! %s drops $%d.", g_seatName[s], t);
}

// Armory: free item off the rack
armory(s)
{
	new it = ARMORY_DROP[random(sizeof ARMORY_DROP)];
	if (give_item(s, it)) subline("Armory: %s grabs %s.", g_seatName[s], ITEM_NAME[it]);
	else { new g = gain(s, ITEM_PRICE[it] / 2); subline("Armory: kit's full, %s sells a %s for $%d.", g_seatName[s], ITEM_NAME[it], g); }
	emit_sound(g_seatPlayer[s] ? g_seatPlayer[s] : 0, CHAN_ITEM, "items/gunpickup1.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
}

// VIP Escort: slot reel picks who pays whom and what
new g_vipA, g_vipB, g_vipAct, g_vipTick;
new const VIP_ACT[][] = { "gives $1000 to", "gives $2000 to", "swaps money with", "swaps places with", "swaps kit with", "gives a star to" };
vip_escort(s)
{
	banner("VIP Escort! %s rolls the reel.", g_seatName[s]);
	g_vipTick = 0;
	set_task(0.12, "task_vip_reel", TASK_FLOW);
}

public task_vip_reel()
{
	g_vipTick++;
	g_vipA = random(SEATS); do g_vipB = random(SEATS); while (g_vipB == g_vipA);
	g_vipAct = random(sizeof VIP_ACT);
	if (g_vipAct == 5 && g_stars[g_vipA] == 0) g_vipAct = 1;
	set_hudmessage(255, 211, 107, -1.0, 0.36, 0, 0.0, 0.2, 0.0, 0.0, -1);
	ShowSyncHudMsg(0, g_hudSync2, "[ %s ]  %s  [ %s ]", g_seatName[g_vipA], VIP_ACT[g_vipAct], g_seatName[g_vipB]);
	client_cmd(0, "spk ^"buttons/blip1.wav^"");
	if (g_vipTick < 18) { set_task(0.06 + 0.012 * float(g_vipTick), "task_vip_reel", TASK_FLOW); return; }
	new a = g_vipA, b = g_vipB;
	switch (g_vipAct)
	{
		case 0: { new t = lose(a, 1000); gain(b, t); }
		case 1: { new t = lose(a, 2000); gain(b, t); }
		case 2: { new t = g_money[a]; g_money[a] = g_money[b]; g_money[b] = t; sync_money(a); sync_money(b); }
		case 3: { new t = g_pos[a]; g_pos[a] = g_pos[b]; g_pos[b] = t; place_pawn(a); place_pawn(b); }
		case 4:
		{
			new tmp[INV_MAX], tn = g_itemN[a];
			for (new k = 0; k < INV_MAX; k++) tmp[k] = g_items[a][k];
			for (new k = 0; k < INV_MAX; k++) g_items[a][k] = g_items[b][k];
			g_itemN[a] = g_itemN[b];
			for (new k = 0; k < INV_MAX; k++) g_items[b][k] = tmp[k];
			g_itemN[b] = tn;
		}
		case 5: { g_stars[a]--; g_stars[b]++; sync_score(a); sync_score(b); }
	}
	set_hudmessage(255, 211, 107, -1.0, 0.36, 0, 0.0, spd(3.0), 0.0, 0.4, -1);
	ShowSyncHudMsg(0, g_hudSync2, "%s %s %s!", g_seatName[a], VIP_ACT[g_vipAct], g_seatName[b]);
	announce("VIP Escort: %s %s %s.", g_seatName[a], VIP_ACT[g_vipAct], g_seatName[b]);
	set_task(spd(2.6), "flow_end_seat", TASK_FLOW);
}

// Negotiator (pass-through): pay to take cash or a star from a rival
show_negotiator_menu(s)
{
	new id = g_seatPlayer[s], title[96];
	formatex(title, charsmax(title), "\yThe Negotiator  \w$%d", g_money[s]);
	new m = menu_create(title, "mh_negot");
	menu_additem(m, g_money[s] >= 1500 ? "Take cash from a rival \y$1500" : "\dTake cash from a rival $1500", "1");
	new bool:anyStar = false; for (new o = 0; o < SEATS; o++) if (o != s && g_stars[o]) anyStar = true;
	menu_additem(m, (g_money[s] >= 5000 && anyStar) ? "Take a star from a rival \y$5000" : "\dTake a star from a rival $5000", "2");
	menu_additem(m, "Walk on by", "0");
	menu_setprop(m, MPROP_EXIT, MEXIT_NEVER);
	nav_show(id, m, "mh_negot");
}

public mh_negot(id, m, item)
{
	if (item < 0 && (g_navRedraw[id] || g_navPicking)) return PLUGIN_HANDLED;   // our own cursor redraw or pick, not a real exit
	if (item < 0 && g_wdCancel) { menu_destroy(m); return PLUGIN_HANDLED; }   // the turn timer or an abort closed it
	if (item >= 0) { new sw = seat_of(id); if (sw >= 0) g_waitKind[sw] = W_NONE; }   // answered: the timer stands down until the next menu
	new info[4], acc, name[2], cb, v = 0;
	if (item >= 0) { menu_item_getinfo(m, item, acc, info, charsmax(info), name, charsmax(name), cb); v = str_to_num(info); }
	menu_destroy(m);
	new s = seat_of(id);
	if (s != g_cur || g_state != ST_BOARD) return PLUGIN_HANDLED;
	if (v == 1 && g_money[s] >= 1500) { show_target_menu(s, 2); return PLUGIN_HANDLED; }
	if (v == 2 && g_money[s] >= 5000) { show_target_menu(s, 3); return PLUGIN_HANDLED; }
	set_task(spd(0.4), "flow_step", TASK_FLOW);
	return PLUGIN_HANDLED;
}

ai_negotiate(s)
{
	new L = leader(s);
	if (g_money[s] >= 5000 + 1000 && L >= 0 && g_stars[L] > 0 && random(10) < 6) { negotiate(s, L, true); return; }
	new rich = -1; for (new o = 0; o < SEATS; o++) if (o != s && (rich < 0 || g_money[o] > g_money[rich])) rich = o;
	if (g_money[s] >= 2500 && rich >= 0 && g_money[rich] >= 2000 && random(10) < 6) { negotiate(s, rich, false); return; }
	subline("%s walks past the Negotiator.", g_seatName[s]);
}

negotiate(s, t, bool:star)
{
	if (g_smoke[t]) { lose(s, star ? 5000 : 1500); announce("%s pays the Negotiator, but %s is in smoke. Money wasted.", g_seatName[s], g_seatName[t]); return; }
	if (star)
	{
		if (g_money[s] < 5000 || g_stars[t] == 0) return;
		lose(s, 5000); g_stars[t]--; g_stars[s]++; sync_score(s); sync_score(t);
		banner("%s takes a star from %s!", g_seatName[s], g_seatName[t]);
	}
	else
	{
		if (g_money[s] < 1500) return;
		lose(s, 1500);
		new amt = lose(t, random_num(10, 30) * 100); gain(s, amt);
		banner("%s takes $%d from %s.", g_seatName[s], amt, g_seatName[t]);
	}
}

pick_minigame(fmt)
{
	new pool[MG_COUNT], n = 0;
	if (g_forceMg >= 0 && g_forceMg < MG_COUNT) return g_forceMg;   // dev override ignores format
	for (new m = 0; m < MG_COUNT; m++)
	{
		if (!(MG_FORMATS[m] & fmt)) continue;
		if (MG_MAP[m][0]) { new bsp[64]; formatex(bsp, charsmax(bsp), "maps/%s.bsp", MG_MAP[m]); if (!file_exists(bsp)) continue; }
		pool[n++] = m;
	}
	return pool[random(n)];
}

fmt_name(fmt, out[], len)
{
	switch (fmt) { case FMT_FFA: copy(out, len, "FREE-FOR-ALL"); case FMT_2V2: copy(out, len, "2 v 2"); case FMT_1V3: copy(out, len, "1 v 3"); default: copy(out, len, "DUEL"); }
}

begin_minigame()
{
	g_state = ST_MG_INTRO;
	board_music(false);
	cam_shot(CAM_WIDE);
	new fn[16]; fmt_name(g_mgFmt, fn, charsmax(fn));
	banner("%s  |  %s", MG_NAME[g_mg], fn);
	new sides[160], len;
	if (g_mgFmt == FMT_2V2 || g_mgFmt == FMT_1V3)
	{
		len = formatex(sides, charsmax(sides), "CT:");
		for (new s = 0; s < SEATS; s++) if (g_mgSide[s] == SIDE_CT) len += formatex(sides[len], charsmax(sides) - len, " %s", g_seatName[s]);
		len += formatex(sides[len], charsmax(sides) - len, "   vs   T:");
		for (new s = 0; s < SEATS; s++) if (g_mgSide[s] == SIDE_T) len += formatex(sides[len], charsmax(sides) - len, " %s", g_seatName[s]);
	}
	else copy(sides, charsmax(sides), MG_DESC[g_mg]);
	subline("%s", sides);
	if (g_mgFmt == FMT_2V2 || g_mgFmt == FMT_1V3) dbg("Sides: %s", sides);
	announce("Minigame: %s (%s). %s", MG_NAME[g_mg], fn, MG_DESC[g_mg]);
	set_task(spd(4.0), "flow_minigame_go", TASK_FLOW);
}

public flow_minigame_go()
{
	if (MG_MAP[g_mg][0]) { go_remote(); return; }
	mg_rules();
	mg_fight_start();
}

// round rules and loadout for the current minigame; also run on own-map fights after the map change
mg_rules()
{
	new bool:ffa = (g_mgFmt == FMT_FFA || g_mgFmt == FMT_DUEL);
	set_cvar_string("mp_round_infinite", "0");
	set_cvar_string("mp_freeforall", ffa ? "1" : "0");
	set_cvar_string("bot_stop", "0");
	set_cvar_string("mp_buytime", "0");
	set_cvar_string("sv_gravity", g_mg == MG_SCOUTZ ? "300" : "800");
	set_cvar_string("mp_give_player_c4", (g_mg == MG_PLANT || g_mg == MG_PISTOL) ? "1" : "0");
	set_cvar_string("mp_roundtime", g_mg == MG_HNS ? "2.25" : (g_mg == MG_PLANT || g_mg == MG_PISTOL ? "1.75" : (g_mg == MG_TOWERS ? "2.0" : "1.5")));
	new prim[16], sec[16], gren[16];
	switch (g_mg)
	{
		case MG_PLANT, MG_PISTOL, MG_FULLBUY: { copy(sec, charsmax(sec), "usp"); }   // default pistol; gear replaces it
		case MG_DEAGLE: { copy(sec, charsmax(sec), "deagle"); }
		case MG_SCOUTZ: { copy(prim, charsmax(prim), "scout"); }
		case MG_NADES:  { copy(gren, charsmax(gren), "hegrenade"); }
		case MG_TOWERS: { copy(prim, charsmax(prim), "awp"); copy(sec, charsmax(sec), "deagle"); }
	}
	set_cvar_string("mp_t_default_weapons_primary", prim); set_cvar_string("mp_ct_default_weapons_primary", prim);
	set_cvar_string("mp_ct_default_weapons_secondary", sec);
	set_cvar_string("mp_t_default_weapons_secondary", equal(sec, "usp") ? "glock18" : sec);
	set_cvar_string("mp_t_default_grenades", gren); set_cvar_string("mp_ct_default_grenades", gren);
	copy(g_mgPrim, charsmax(g_mgPrim), prim); copy(g_mgSec, charsmax(g_mgSec), sec); copy(g_mgGren, charsmax(g_mgGren), gren);
}

// seat everyone by side and start the round
mg_fight_start()
{
	new bool:ffa = (g_mgFmt == FMT_FFA || g_mgFmt == FMT_DUEL);
	for (new s = 0; s < SEATS; s++)
	{
		new id = g_seatPlayer[s];
		if (!is_user_connected(id)) continue;
		new TeamName:team = TEAM_CT;
		if (!ffa) team = g_mgSide[s] == SIDE_CT ? TEAM_CT : TEAM_TERRORIST;
		else team = (s % 2) ? TEAM_TERRORIST : TEAM_CT;   // FFA: split so map spawns don't run out
		rg_set_user_team(id, team, MODEL_UNASSIGNED, true, false);
		seat_settle(id);
	}
	g_mgDone = false; g_mgWinnerN = 0;
	g_state = ST_MINIGAME;
	remove_task(TASK_CAM);
	release_cameras();
	if (g_nodeCount) board_show(false);
	// on a freshly loaded own map the game hasn't "commenced": the first kill would fire Game_Commencing and end the round as a draw
	set_member_game(m_bGameStarted, true);
	rg_restart_round();
	dbg("Minigame %s started (fmt %d).", MG_NAME[g_mg], g_mgFmt);
	set_task(2.0, "task_log_loadouts", TASK_FLOW + 7);
}

// Standing-hull spot that is inside the map and not embedded in brushes: tries the wanted origin, then smaller
// lateral offsets, then a lift, then the node centre. Falls back to the node centre if nothing fits.
bool:spot_clear(const Float:o[3])
{
	new tr = create_tr2(), bool:ok;
	engfunc(EngFunc_TraceHull, o, o, IGNORE_MONSTERS, HULL_HUMAN, 0, tr);
	ok = !get_tr2(tr, TR_StartSolid) && !get_tr2(tr, TR_AllSolid) && get_tr2(tr, TR_InOpen);
	if (ok)
	{
		new Float:dn[3]; dn = o; dn[2] -= 120.0;
		engfunc(EngFunc_TraceLine, o, dn, IGNORE_MONSTERS, 0, tr);
		new Float:fr; get_tr2(tr, TR_flFraction, fr);
		ok = fr < 1.0;
	}
	free_tr2(tr);
	return ok;
}

safe_spot(Float:o[3], const Float:node[3], const Float:side[2])
{
	new Float:c[3];
	for (new k = 0; k < 4; k++)
	{
		new Float:f = k == 0 ? 1.0 : (k == 1 ? 0.5 : (k == 2 ? -1.0 : 0.0));
		c[0] = node[0] + side[0] * f; c[1] = node[1] + side[1] * f; c[2] = node[2] + 37.0;
		for (new l = 0; l < 3; l++)
		{
			if (spot_clear(c)) { o = c; return;  }
			c[2] += 18.0;
		}
	}
	o[0] = node[0]; o[1] = node[1]; o[2] = node[2] + 37.0;
	dbg("No clear spawn near (%.0f %.0f %.0f); using node centre.", node[0], node[1], node[2]);
}

apply_loadout(s)
{
	new id = g_seatPlayer[s];
	// Hand out the minigame's weapons ourselves. The round's default weapons only go to players who died
	// last round; pawns standing on the board survive it with an empty inventory and would get nothing.
	rg_remove_all_items(id);
	rg_give_item(id, "weapon_knife");
	if (g_mgSec[0]) give_full(id, (equal(g_mgSec, "usp") && get_member(id, m_iTeam) == TEAM_TERRORIST) ? "glock18" : g_mgSec);
	if (g_mgPrim[0]) give_full(id, g_mgPrim);
	if (g_mgGren[0]) give_full(id, g_mgGren);
	switch (g_mg)
	{
		case MG_KNIFE: { rg_remove_all_items(id); rg_give_item(id, "weapon_knife"); set_entvar(id, var_health, 35.0); }
	}
	if (MG_GEAR[g_mg]) give_gear(s, MG_GEAR[g_mg] == 1);
	if (g_mg == MG_HNS)
	{
		rg_remove_all_items(id);
		if (g_mgSide[s] == SIDE_CT)
		{
			rg_give_item(id, "weapon_knife");
			freeze(id); set_task(20.0, "task_hns_release", TASK_RACE + 40 + s);
			static msg; if (!msg) msg = get_user_msgid("ScreenFade");
			if (!is_user_bot(id)) { message_begin(MSG_ONE, msg, _, id); write_short(4096); write_short(floatround(19.0 * 4096.0)); write_short(0x0001 | 0x0004); write_byte(0); write_byte(0); write_byte(0); write_byte(255); message_end(); }
			client_print(id, print_center, "You're seeking. Lights on in 20 seconds.");
		}
		else
		{
			rg_give_item(id, "weapon_flashbang"); rg_give_item(id, "weapon_smokegrenade");
			client_print(id, print_center, "Hide! The seeker opens their eyes in 20 seconds.");
		}
		return;
	}
	// elimination modes fight on a stretch of the board: sides at opposite ends, FFA spread along it
	if (!mg_objective() && g_mg != MG_HNS && g_nodeCount)
	{
		static arena = -1, Float:at;
		if (get_gametime() - at > 2.0) { arena = random(g_nodeCount - 8 > 0 ? g_nodeCount - 8 : 1); at = get_gametime(); }
		new n = arena, hops = 0;
		if (g_mgFmt == FMT_FFA || g_mgFmt == FMT_DUEL)
		{
			for (new k = 0; k < SEATS; k++) if (g_mgIn[k] && k < s) hops++;
		}
		else
		{
			new nth = 0; for (new k = 0; k < s; k++) if (g_mgIn[k] && g_mgSide[k] == g_mgSide[s]) nth++;
			hops = (g_mgSide[s] == SIDE_CT ? 0 : (g_mg == MG_KNIFE ? 3 : 4));
		}
		for (new j = 0; j < hops; j++) n = g_nodeNext[n][0];
		new Float:o[3], Float:sd[2];
		if (g_mgFmt != FMT_FFA && g_mgFmt != FMT_DUEL)
		{
			// teammates stand side by side, 40 units apart, across the path
			new nth = 0; for (new k = 0; k < s; k++) if (g_mgIn[k] && g_mgSide[k] == g_mgSide[s]) nth++;
			new m = g_nodeNext[n][0], Float:d[3]; xs_vec_sub_simple(g_nodePos[m], g_nodePos[n], d);
			new Float:l = vector_length(d);
			if (l > 1.0) { new Float:side = (float(nth) - 1.0) * 40.0; sd[0] = -d[1] / l * side; sd[1] = d[0] / l * side; }
		}
		safe_spot(o, g_nodePos[n], sd);
		entity_set_origin(id, o);
	}
}

// a weapon plus a full reserve of its ammo
give_full(id, const short[])
{
	new name[32]; formatex(name, charsmax(name), "weapon_%s", short);
	rg_give_item(id, name, GT_REPLACE);
	new WeaponIdType:wid = WeaponIdType:rg_get_weapon_info(name, WI_ID);
	if (wid != WEAPON_NONE && wid != WEAPON_HEGRENADE && wid != WEAPON_KNIFE)
		rg_set_user_bpammo(id, wid, rg_get_weapon_info(wid, WI_MAX_ROUNDS));
}

give_gear(s, bool:primary)
{
	new id = g_seatPlayer[s];
	if (primary && g_gPrim[s] >= 0) rg_give_item(id, GEAR_ENT[g_gPrim[s]], GT_REPLACE);
	if (g_gSec[s] >= 0) rg_give_item(id, GEAR_ENT[g_gSec[s]], GT_REPLACE);
	if (g_gArmor[s]) rg_set_user_armor(id, 100, g_gArmor[s] == 2 ? ARMOR_VESTHELM : ARMOR_KEVLAR);
	for (new k = 0; k < g_gFlash[s]; k++) rg_give_item(id, "weapon_flashbang", GT_APPEND);
	if (g_gHE[s]) rg_give_item(id, "weapon_hegrenade", GT_APPEND);
	if (g_gSmoke[s]) rg_give_item(id, "weapon_smokegrenade", GT_APPEND);
	if (g_gKit[s] && get_member(id, m_iTeam) == TEAM_CT) rg_give_defusekit(id, true);
	new gs[64]; gear_summary(s, gs, charsmax(gs));
	if (gs[0]) client_print(id, print_center, "Your gear: %s", gs);
}

// CS rules after a gear round: survivors keep what they're holding (loot included), the dead lose what they carried in
gear_after_round()
{
	if (!MG_GEAR[g_mg]) return;
	new bool:full = MG_GEAR[g_mg] == 1;
	for (new s = 0; s < SEATS; s++)
	{
		if (!g_mgIn[s]) continue;
		new id = g_seatPlayer[s];
		if (!is_user_alive(id))
		{
			if (full) g_gPrim[s] = -1;
			g_gSec[s] = -1; g_gArmor[s] = 0; g_gFlash[s] = 0; g_gHE[s] = 0; g_gSmoke[s] = 0; g_gKit[s] = false;
			continue;
		}
		new p = -1, sec = -1;
		for (new g = 0; g < GEAR_N; g++)
		{
			if (!user_has_weapon(id, get_weaponid(GEAR_ENT[g]))) continue;
			if (g <= GEAR_SECONDARY_MAX) { if (sec < 0 || GEAR_PRICE[g] > GEAR_PRICE[sec]) sec = g; }
			else if (p < 0 || GEAR_PRICE[g] > GEAR_PRICE[p]) p = g;
		}
		if (full || p >= 0) g_gPrim[s] = p >= 0 ? p : g_gPrim[s];
		if (full && p < 0) g_gPrim[s] = -1;
		g_gSec[s] = (sec == 0 || sec == 1) && g_gSec[s] < 0 ? -1 : sec;   // the free default pistol doesn't count as bought gear
		new Float:armor = Float:get_entvar(id, var_armorvalue);
		g_gArmor[s] = armor > 0.0 ? (get_member(id, m_iKevlar) == ARMOR_VESTHELM ? 2 : 1) : 0;
		g_gFlash[s] = user_has_weapon(id, CSW_FLASHBANG) ? 1 : 0;
		g_gHE[s] = user_has_weapon(id, CSW_HEGRENADE) ? 1 : 0;
		g_gSmoke[s] = user_has_weapon(id, CSW_SMOKEGRENADE) ? 1 : 0;
		g_gKit[s] = bool:get_member(id, m_bHasDefuser) || (g_gKit[s] && get_member(id, m_iTeam) != TEAM_CT);
	}
}

bool:mg_objective() { return g_mg == MG_PLANT || g_mg == MG_PISTOL; }

// what everyone actually spawned with, for "I had no gun" reports
public task_log_loadouts()
{
	if (g_state != ST_MINIGAME) return;
	for (new s = 0; s < SEATS; s++)
	{
		new id = g_seatPlayer[s];
		if (!g_mgIn[s] || !is_user_connected(id)) continue;
		new w[32], n, line[160], len;
		get_user_weapons(id, w, n);
		len = formatex(line, charsmax(line), "%s (%s):", g_seatName[s], is_user_alive(id) ? "alive" : "dead");
		for (new k = 0; k < n; k++) { new nm[32]; get_weaponname(w[k], nm, charsmax(nm)); len += formatex(line[len], charsmax(line) - len, " %s", nm[7]); }
		if (!n) len += formatex(line[len], charsmax(line) - len, " nothing");
		dbg("Loadout %s", line);
	}
}

public task_hns_release(taskid)
{
	new s = taskid - TASK_RACE - 40;
	if (s < 0 || s >= SEATS || g_state != ST_MINIGAME) return;
	new id = g_seatPlayer[s];
	if (!is_user_alive(id)) return;
	unfreeze(id);
	if (!is_user_bot(id)) fade_one(id, 0.4);
	client_print(id, print_center, "Ready or not!");
}

fade_one(id, Float:secs)
{
	static msg; if (!msg) msg = get_user_msgid("ScreenFade");
	message_begin(MSG_ONE, msg, _, id); write_short(floatround(secs * 4096.0)); write_short(0); write_short(0); write_byte(0); write_byte(0); write_byte(0); write_byte(255); message_end();
}

public hc_throw_he_post(const index)
{
	if (g_state == ST_MINIGAME && g_mg == MG_NADES) set_task(1.0, "task_regive_he", TASK_NADE + index);
}
public task_regive_he(taskid) { new id = taskid - TASK_NADE; if (is_user_alive(id) && g_state == ST_MINIGAME) rg_give_item(id, "weapon_hegrenade"); }

public hc_killed_post(const victim, const killer)
{
	if (g_state != ST_MINIGAME || g_mgDone) return;
	if (g_mgFmt != FMT_FFA && g_mgFmt != FMT_DUEL) return;
	new alive = 0, last = -1;
	for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && is_user_alive(g_seatPlayer[s])) { alive++; last = s; }
	if (alive <= 1)
	{
		g_mgWinnerN = 0;
		if (last >= 0) g_mgWinners[g_mgWinnerN++] = last;
		else g_mgWinners[g_mgWinnerN++] = seat_of(victim) >= 0 ? seat_of(victim) : g_duelA;
		g_mgDone = true;
		rg_round_end(3.0, WINSTATUS_DRAW, ROUND_END_DRAW, "", "", true);
	}
}

public hc_round_end(WinStatus:status, ScenarioEventEndRound:event, Float:delay)
{
	if (g_state != ST_MINIGAME) return HC_CONTINUE;
	// the last of a side just dropped out: their stand-in is a moment away, so the fight isn't over
	if (!g_mgDone) for (new s = 0; s < SEATS; s++) if (g_standin[s]) { SetHookChainReturn(ATYPE_BOOL, false); return HC_SUPERCEDE; }
	if (!g_mgDone && event == ROUND_GAME_COMMENCE) { set_member_game(m_bGameStarted, true); SetHookChainReturn(ATYPE_BOOL, false); return HC_SUPERCEDE; }   // not a result
	if (!g_mgDone && g_mg == MG_HNS)
	{
		g_mgWinnerN = 0;
		new hidersAlive = 0;
		for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && g_mgSide[s] == SIDE_T && is_user_alive(g_seatPlayer[s])) hidersAlive++;
		new side = hidersAlive ? SIDE_T : SIDE_CT;
		for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && g_mgSide[s] == side) g_mgWinners[g_mgWinnerN++] = s;
		g_mgDone = true;
	}
	if (!g_mgDone)
	{
		g_mgWinnerN = 0;
		if (g_mgFmt == FMT_FFA || g_mgFmt == FMT_DUEL)
		{
			// time ran out: healthiest survivor wins
			new best = -1, bh = 0;
			for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && is_user_alive(g_seatPlayer[s])) { new h = floatround(Float:get_entvar(g_seatPlayer[s], var_health)); if (h > bh) { bh = h; best = s; } }
			if (best < 0) for (new s = 0; s < SEATS; s++) if (g_mgIn[s]) { best = s; break; }
			g_mgWinners[g_mgWinnerN++] = best;
		}
		else if (!mg_objective() && (event == ROUND_TARGET_SAVED || event == ROUND_END_DRAW || event == ROUND_HOSTAGE_NOT_RESCUED || status == WINSTATUS_DRAW))
		{
			new alive[2], hp[2];
			for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && is_user_alive(g_seatPlayer[s]))
				{ alive[g_mgSide[s]]++; hp[g_mgSide[s]] += floatround(Float:get_entvar(g_seatPlayer[s], var_health)); }
			new side = -1;
			if (alive[SIDE_CT] != alive[SIDE_T]) side = alive[SIDE_CT] > alive[SIDE_T] ? SIDE_CT : SIDE_T;
			else if (hp[SIDE_CT] != hp[SIDE_T]) side = hp[SIDE_CT] > hp[SIDE_T] ? SIDE_CT : SIDE_T;
			if (side >= 0) for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && g_mgSide[s] == side) g_mgWinners[g_mgWinnerN++] = s;
		}
		else if (status == WINSTATUS_CTS || status == WINSTATUS_TERRORISTS)
		{
			new side = status == WINSTATUS_CTS ? SIDE_CT : SIDE_T;
			for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && g_mgSide[s] == side) g_mgWinners[g_mgWinnerN++] = s;
		}
		g_mgDone = true;
	}
	g_state = ST_MG_RESULT;
	gear_after_round();
	if (MG_MAP[g_mg][0])
	{
		new names[96], len;
		for (new k = 0; k < g_mgWinnerN; k++) len += formatex(names[len], charsmax(names) - len, "%s%s", k ? ", " : "", g_seatName[g_mgWinners[k]]);
		banner("%s wins %s!", g_mgWinnerN ? names : "Nobody", MG_NAME[g_mg]);
		set_task(5.0, "task_race_over", TASK_RACE + 2);
		return HC_CONTINUE;
	}
	set_task(0.1, "flow_minigame_result", TASK_FLOW);
	return HC_CONTINUE;
}

public flow_minigame_result()
{
	new names[96], len;
	for (new k = 0; k < g_mgWinnerN; k++) len += formatex(names[len], charsmax(names) - len, "%s%s", k ? ", " : "", g_seatName[g_mgWinners[k]]);
	if (g_mgFmt == FMT_DUEL)
	{
		new w = g_mgWinnerN ? g_mgWinners[0] : g_duelA;
		new g = g_mgWager > 0 ? gain(w, g_mgWager * 2) : gain(w, 500);
		banner("%s wins the duel. +$%d", g_seatName[w], g);
		client_cmd(0, "spk ^"events/task_complete.wav^"");
		voice(w, VO_WON, 0.8); for (new k = 0; k < SEATS; k++) if (g_mgIn[k] && k != w) voice(k, VO_LOST, 2.2);
	}
	else
	{
		for (new s = 0; s < SEATS; s++)
		{
			new bool:won = false;
			for (new k = 0; k < g_mgWinnerN; k++) if (g_mgWinners[k] == s) won = true;
			if (won) { gain(s, get_pcvar_num(c_mgwin)); g_mgWins[s]++; g_streak[s] = 0; }
			else
			{
				new b = min(get_pcvar_num(c_lbase) + get_pcvar_num(c_lstep) * g_streak[s], get_pcvar_num(c_lcap));
				g_streak[s]++; if (b > 0) gain(s, b);
			}
			sync_score(s);
		}
		if (g_mgWinnerN) banner("%s win%s! +$%d", names, g_mgWinnerN > 1 ? "" : "s", get_pcvar_num(c_mgwin));
		if (g_mgWinnerN) client_cmd(0, "spk ^"events/task_complete.wav^"");
		else banner("Draw. Loss bonus for everyone.");
		mg_voices();
	}
	announce("Result: %s", g_mgWinnerN ? names : "draw");
	set_task(spd(4.5), "flow_after_minigame", TASK_FLOW);
}

public flow_after_minigame()
{
	enter_board();
	if (g_cont == CONT_NEXT_SEAT) { set_task(spd(2.0), "flow_end_seat", TASK_FLOW); return; }
	if (g_turn >= g_maxTurns) { set_task(spd(2.0), "flow_finish", TASK_FLOW); return; }
	g_turn++;
	if (get_pcvar_num(c_ot) > 0 && g_turn == g_maxTurns - get_pcvar_num(c_ot) + 1) announce("Overtime. Spaces pay and cost double for the last %d turns.", get_pcvar_num(c_ot));
	g_cur = 0;
	set_task(spd(2.5), "flow_begin_seat", TASK_FLOW);
}

// ---------------------------------------------------------------- finish --
public flow_finish()
{
	g_state = ST_END;
	board_music(false);   // the theme takes over at the winner banner
	for (new k = 0; k < g_awardN; k++) award(g_awardCat[k], get_pcvar_num(c_awards) == 3);
	new order[SEATS]; for (new s = 0; s < SEATS; s++) order[s] = s;
	for (new i = 0; i < SEATS; i++) for (new j = i + 1; j < SEATS; j++)
	{
		new a = order[i], b = order[j];
		if (g_stars[b] > g_stars[a] || (g_stars[b] == g_stars[a] && g_money[b] > g_money[a])) { order[i] = b; order[j] = a; }
	}
	g_cur = order[0];
	banner("%s wins CS Party!", g_seatName[order[0]]);
	client_cmd(0, "echo CSP_THEME_PLAY");   // the browser page plays the theme over the results
	for (new i = 0; i < SEATS; i++) { new s = order[i]; announce("%d. %s  %d stars  $%d  (%d minigame wins)", i + 1, g_seatName[s], g_stars[s], g_money[s], g_mgWins[s]); sync_score(s); }
	set_task(spd(15.0), "flow_reset", TASK_FLOW);
}

draw_awards()
{
	new mode = get_pcvar_num(c_awards);
	g_awardN = 0;
	if (mode == 2) { g_awardCat[0] = AW_FRAGGER; g_awardCat[1] = AW_MAXMONEY; g_awardCat[2] = AW_ECO; g_awardN = 3; return; }   // classic, revealed at the end
	if (mode != 1 && mode != 3) return;
	new pool[AW_COUNT]; for (new i = 0; i < AW_COUNT; i++) pool[i] = i;
	for (new i = AW_COUNT - 1; i > 0; i--) { new j = random(i + 1), t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
	g_awardCat[0] = pool[0]; g_awardCat[1] = pool[1]; g_awardN = 2;
	announce("Bonus %s this match: %s (%s) and %s (%s).", mode == 3 ? "cash" : "stars", AW_NAME[pool[0]], AW_WHY[pool[0]], AW_NAME[pool[1]], AW_WHY[pool[1]]);
}

award_value(cat, s)
{
	switch (cat)
	{
		case AW_FRAGGER:   return g_mgWins[s];
		case AW_MAXMONEY:  return g_maxMoney[s];
		case AW_ECO:       return g_reds[s];
		case AW_SPENDER:   return g_spent[s];
		case AW_RUSHER:    return g_moved[s];
		case AW_BOMBSQUAD: return g_c4Take[s];
	}
	return 0;
}

// current leader text for the HUD: "Greg 4" / "Greg, Pat 4" / "nobody yet"
award_leader(cat, out[], len)
{
	new best = 0; for (new s = 0; s < SEATS; s++) best = max(best, award_value(cat, s));
	if (best <= 0) { copy(out, len, "nobody yet"); return; }
	new n = 0; out[0] = 0;
	for (new s = 0; s < SEATS; s++) if (award_value(cat, s) == best) n += formatex(out[n], len - n, "%s%.10s", n ? ", " : "", g_seatName[s]);
	formatex(out[n], len - n, " %d", best);
}

award(cat, bool:cash)
{
	new best = 0; for (new s = 0; s < SEATS; s++) best = max(best, award_value(cat, s));
	if (best <= 0) { announce("%s goes unclaimed.", AW_NAME[cat]); return; }
	new names[96], len;
	for (new s = 0; s < SEATS; s++) if (award_value(cat, s) == best)
	{
		if (cash) gain(s, 3000); else g_stars[s]++;
		len += formatex(names[len], charsmax(names) - len, "%s%s", len ? ", " : "", g_seatName[s]);
	}
	banner("%s: %s", AW_NAME[cat], names);
	announce("Bonus %s - %s (%s): %s", cash ? "$3000" : "star", AW_NAME[cat], AW_WHY[cat], names);
}

public flow_reset() { match_abort(); }

// ================================================================ own-map minigames ==
// The board map hands off to a CS Party map (csp_surf, csp_bhop, csp_climb, csp_maze) for a race and gets the
// result back. Everything about the match is written to data/cs_party_state.json, which
// survives the map change. phase 1 = race pending on the minigame map, 2 = result pending on the board.

new Float:g_zStart[2][3], Float:g_zFinish[2][3], bool:g_zonesOk;

state_path(out[], len) { new d[96]; get_datadir(d, charsmax(d)); formatex(out, len, "%s/cs_party_state.json", d); }
delete_state() { new p[128]; state_path(p, charsmax(p)); if (file_exists(p)) delete_file(p); }

// game.cfg also sets bot_join_after_player 1, and with it the bot quota drops to zero whenever no human is on a team
public task_no_rotation() { set_cvar_num("mp_timelimit", 0); set_cvar_num("mp_maxrounds", 0); set_cvar_num("mp_winlimit", 0); set_cvar_num("bot_join_after_player", 0); }

public plugin_cfg()
{
	get_mapname(g_boardMap, charsmax(g_boardMap));
	set_task(2.0, "task_no_rotation");   // after game.cfg, which ReGameDLL runs late and sets mp_timelimit 20
	new p[128]; state_path(p, charsmax(p));
	if (!file_exists(p)) return;
	new phase = load_state();
	new map[32]; get_mapname(map, charsmax(map));
	new bool:onMinigameMap = bool:equal(map, "csp_", 4) && g_nodeCount == 0;
	if (phase == 1 && onMinigameMap) { start_remote_wait(); return; }
	if (phase == 2 && !onMinigameMap) { start_resume(); return; }
	dbg("Stale state file (phase %d on %s); discarding.", phase, map);
	delete_state();
}

// ---------------------------------------------------------------- save / load --
jnum(JSON:o, const k[], v) { json_object_set_number(o, k, v); }

save_state(phase)
{
	new JSON:o = json_init_object();
	jnum(o, "phase", phase);
	json_object_set_string(o, "board", g_boardMap);
	jnum(o, "turn", g_turn); jnum(o, "maxTurns", g_maxTurns); jnum(o, "cur", g_cur); jnum(o, "hostage", g_hostage);
	jnum(o, "cont", g_cont); jnum(o, "mg", g_mg); jnum(o, "mgFmt", g_mgFmt); jnum(o, "wager", g_mgWager); jnum(o, "duelA", g_duelA);
	jnum(o, "awardN", g_awardN); for (new k = 0; k < 3; k++) { new key[8]; formatex(key, charsmax(key), "aw%d", k); jnum(o, key, g_awardCat[k]); }
	new JSON:seats = json_init_array();
	for (new s = 0; s < SEATS; s++)
	{
		new JSON:q = json_init_object();
		json_object_set_string(q, "name", g_seatName[s]); json_object_set_bool(q, "bot", g_seatBot[s]); json_object_set_string(q, "owner", g_seatOwner[s]);
		jnum(q, "skin", g_seatSkin[s]); jnum(q, "money", g_money[s]); jnum(q, "stars", g_stars[s]); jnum(q, "streak", g_streak[s]);
		jnum(q, "mgWins", g_mgWins[s]); jnum(q, "reds", g_reds[s]); jnum(q, "maxMoney", g_maxMoney[s]); jnum(q, "pos", g_pos[s]);
		jnum(q, "lastColor", g_lastColor[s]); jnum(q, "flashed", g_flashed[s]); json_object_set_bool(q, "smoke", g_smoke[s]);
		jnum(q, "extra", g_extraCrates[s]); jnum(q, "rigged", g_rigged[s]);
		jnum(q, "gPrim", g_gPrim[s]); jnum(q, "gSec", g_gSec[s]); jnum(q, "gArmor", g_gArmor[s]); jnum(q, "gFlash", g_gFlash[s]);
		jnum(q, "gHE", g_gHE[s]); jnum(q, "gSmoke", g_gSmoke[s]); json_object_set_bool(q, "gKit", g_gKit[s]);
		jnum(q, "mgSide", g_mgSide[s]); json_object_set_bool(q, "mgIn", g_mgIn[s]);
		jnum(q, "spent", g_spent[s]); jnum(q, "moved", g_moved[s]); jnum(q, "c4Take", g_c4Take[s]);
		new JSON:it = json_init_array(); for (new k = 0; k < g_itemN[s]; k++) json_array_append_number(it, g_items[s][k]);
		json_object_set_value(q, "items", it); json_free(it);
		json_array_append_value(seats, q); json_free(q);
	}
	json_object_set_value(o, "seats", seats); json_free(seats);
	new JSON:tr = json_init_array(); for (new i = 0; i < g_nodeCount; i++) json_array_append_number(tr, g_traps[i]);
	json_object_set_value(o, "traps", tr); json_free(tr);
	new JSON:w = json_init_array(); for (new k = 0; k < g_mgWinnerN; k++) json_array_append_number(w, g_mgWinners[k]);
	json_object_set_value(o, "winners", w); json_free(w);
	new p[128]; state_path(p, charsmax(p));
	json_serial_to_file(o, p, true);
	json_free(o);
}

load_state()
{
	new p[128]; state_path(p, charsmax(p));
	new JSON:o = json_parse(p, true);
	if (o == Invalid_JSON) return 0;
	new phase = json_object_get_number(o, "phase");
	json_object_get_string(o, "board", g_boardMap, charsmax(g_boardMap));
	g_turn = json_object_get_number(o, "turn"); g_maxTurns = json_object_get_number(o, "maxTurns"); g_cur = json_object_get_number(o, "cur");
	g_hostage = json_object_get_number(o, "hostage"); g_cont = json_object_get_number(o, "cont"); g_mg = json_object_get_number(o, "mg");
	g_mgFmt = json_object_get_number(o, "mgFmt"); g_mgWager = json_object_get_number(o, "wager"); g_duelA = json_object_get_number(o, "duelA");
	g_awardN = json_object_get_number(o, "awardN");
	for (new k = 0; k < 3; k++) { new key[8]; formatex(key, charsmax(key), "aw%d", k); g_awardCat[k] = json_object_get_number(o, key); }
	new JSON:seats = json_object_get_value(o, "seats");
	for (new s = 0; s < SEATS && s < json_array_get_count(seats); s++)
	{
		new JSON:q = json_array_get_value(seats, s);
		json_object_get_string(q, "name", g_seatName[s], charsmax(g_seatName[])); g_seatBot[s] = json_object_get_bool(q, "bot");
		g_seatOwner[s][0] = 0; if (json_object_has_value(q, "owner")) json_object_get_string(q, "owner", g_seatOwner[s], charsmax(g_seatOwner[]));
		if (g_seatOwner[s][0]) copy(g_seatName[s], charsmax(g_seatName[]), g_seatOwner[s]);
		g_seatSkin[s] = json_object_get_number(q, "skin"); g_money[s] = json_object_get_number(q, "money"); g_stars[s] = json_object_get_number(q, "stars");
		g_streak[s] = json_object_get_number(q, "streak"); g_mgWins[s] = json_object_get_number(q, "mgWins"); g_reds[s] = json_object_get_number(q, "reds");
		g_maxMoney[s] = json_object_get_number(q, "maxMoney"); g_pos[s] = json_object_get_number(q, "pos"); g_lastColor[s] = json_object_get_number(q, "lastColor");
		g_flashed[s] = json_object_get_number(q, "flashed"); g_smoke[s] = json_object_get_bool(q, "smoke");
		g_extraCrates[s] = json_object_get_number(q, "extra"); g_rigged[s] = json_object_get_number(q, "rigged");
		g_gPrim[s] = json_object_get_number(q, "gPrim"); g_gSec[s] = json_object_get_number(q, "gSec"); g_gArmor[s] = json_object_get_number(q, "gArmor");
		g_gFlash[s] = json_object_get_number(q, "gFlash"); g_gHE[s] = json_object_get_number(q, "gHE"); g_gSmoke[s] = json_object_get_number(q, "gSmoke");
		g_gKit[s] = json_object_get_bool(q, "gKit"); g_mgSide[s] = json_object_get_number(q, "mgSide"); g_mgIn[s] = json_object_get_bool(q, "mgIn");
		g_spent[s] = json_object_get_number(q, "spent"); g_moved[s] = json_object_get_number(q, "moved"); g_c4Take[s] = json_object_get_number(q, "c4Take");
		new JSON:it = json_object_get_value(q, "items");
		g_itemN[s] = min(INV_MAX, json_array_get_count(it));
		for (new k = 0; k < g_itemN[s]; k++) g_items[s][k] = json_array_get_number(it, k);
		json_free(it); json_free(q);
		g_seatPlayer[s] = 0;
	}
	json_free(seats);
	new JSON:tr = json_object_get_value(o, "traps");
	for (new i = 0; i < MAX_NODES; i++) g_traps[i] = (i < json_array_get_count(tr)) ? json_array_get_number(tr, i) : -1;
	json_free(tr);
	new JSON:w = json_object_get_value(o, "winners");
	g_mgWinnerN = min(SEATS, json_array_get_count(w));
	for (new k = 0; k < g_mgWinnerN; k++) g_mgWinners[k] = json_array_get_number(w, k);
	json_free(w);
	json_free(o);
	return phase;
}

// another empty seat's bot would wear this name
bool:name_wanted(const name[], except)
{
	for (new k = 0; k < SEATS; k++)
	{
		if (k == except || (g_seatPlayer[k] && is_user_connected(g_seatPlayer[k]))) continue;
		new nm[32]; stand_in_name(k, nm, charsmax(nm));
		if (equal(nm, name)) return true;
	}
	return false;
}

// after a map change: humans by name (and put back on a team), bots fill the remaining seats
bool:rebind_seats()
{
	new bool:all = true;
	for (new s = 0; s < SEATS; s++)
	{
		if (g_seatPlayer[s] && is_user_connected(g_seatPlayer[s])) continue;
		g_seatPlayer[s] = 0;
		if (!g_seatBot[s])
		{
			new back = seat_owner_back(s);
			if (back)
			{
				g_seatPlayer[s] = back;
				new TeamName:tm = get_member(back, m_iTeam);
				if (tm != TEAM_TERRORIST && tm != TEAM_CT) seat_join(back, s);
			}
			if (!g_seatPlayer[s] && get_gametime() - g_waitStart < 45.0) { all = false; continue; }   // still loading the map
		}
		if (!g_seatPlayer[s])
		{
			// the bot plays as the seat's character; rename it so the scoreboard doesn't reshuffle every map change.
			// A human's seat gets "Name (bot)", never the bare name: that would make the owner "(1)Name" on return.
			// A fresh bot may already wear that name (zBot profiles include Dan, Rick...): it gets the seat first. Renaming
			// it away doesn't free the name in time for another bot, which would come out as "(1)Dan".
			new nm[32]; stand_in_name(s, nm, charsmax(nm));
			for (new pass = 0; pass < 3 && !g_seatPlayer[s]; pass++) for (new id = 1; id <= MaxClients; id++)
			{
				if (!is_user_connected(id) || !is_user_bot(id) || seat_of(id) >= 0) continue;
				new TeamName:tm = get_member(id, m_iTeam);
				if (tm != TEAM_TERRORIST && tm != TEAM_CT) continue;
				new cur[32]; get_user_name(id, cur, charsmax(cur));
				if (pass == 0 && !equal(cur, nm)) continue;
				if (pass == 1 && name_wanted(cur, s)) continue;   // leave it for the empty seat of that name
				g_seatPlayer[s] = id;
				if (pass) set_user_info(id, "name", nm);
				break;
			}
		}
		if (!g_seatPlayer[s]) all = false;
	}
	return all;
}

// ---------------------------------------------------------------- hand-off --
go_remote()
{
	g_mgWinnerN = 0;
	save_state(1);
	banner("%s", MG_NAME[g_mg]);
	subline("Loading %s...", MG_MAP[g_mg]);
	announce("%s is on its own map. Back on the board after the %s.", MG_NAME[g_mg], mg_fight(g_mg) ? "fight" : "race");
	set_task(3.0, "task_changelevel_remote", TASK_FLOW);
}
public task_changelevel_remote() { server_cmd("changelevel %s", MG_MAP[g_mg]); }

load_zones()
{
	new map[32], path[160], cfg[96]; get_mapname(map, charsmax(map)); get_configsdir(cfg, charsmax(cfg));
	formatex(path, charsmax(path), "%s/cs_party/minigames/%s.ini", cfg, map);
	g_zonesOk = false;
	new f = fopen(path, "rt"); if (!f) { log_amx("No zones for %s (%s).", map, path); return; }
	new line[160], key[16], v[6][16];
	while (!feof(f))
	{
		fgets(f, line, charsmax(line)); trim(line);
		if (!line[0] || line[0] == ';') continue;
		parse(line, key, charsmax(key), v[0], 15, v[1], 15, v[2], 15, v[3], 15, v[4], 15, v[5], 15);
		new Float:lo[3], Float:hi[3];
		for (new k = 0; k < 3; k++) { lo[k] = str_to_float(v[k]); hi[k] = str_to_float(v[k + 3]); }
		if (equal(key, "start")) { g_zStart[0] = lo; g_zStart[1] = hi; }
		else if (equal(key, "finish")) { g_zFinish[0] = lo; g_zFinish[1] = hi; g_zonesOk = true; }
	}
	fclose(f);
}

bool:in_box(const Float:o[3], const Float:b[2][3]) { return o[0] >= b[0][0] && o[0] <= b[1][0] && o[1] >= b[0][1] && o[1] <= b[1][1] && o[2] >= b[0][2] - 40.0 && o[2] <= b[1][2] + 40.0; }

race_place(s)
{
	new id = g_seatPlayer[s]; if (!is_user_alive(id)) return;
	new slot = 0; for (new k = 0; k < s; k++) if (g_mgIn[k]) slot++;
	new Float:o[3];
	// one row across the start, facing down the course (+x), 70 units apart
	o[0] = g_zStart[0][0] + 60.0;
	o[1] = (g_zStart[0][1] + g_zStart[1][1]) / 2.0 - 105.0 + float(slot) * 70.0;
	o[2] = g_zStart[0][2] + 40.0;
	if (g_mg == MG_MAZE)
	{
		// the lobby is a huge room whose only exit is a gap in its far corner: line up in front of it, facing it
		o[0] = g_zStart[1][0] - 70.0 - float(slot / 2) * 60.0;
		o[1] = g_zStart[0][1] + 50.0 + float(slot % 2) * 60.0;
	}
	// racers stay solid: SOLID_NOT players never touch triggers, and the course teleports are triggers.
	// start slots are 60 units apart, wider than a 32-unit hull.
	// bots finish on a clock and never use the course, so they can't block anyone
	entity_set_int(id, EV_INT_solid, is_user_bot(id) ? SOLID_NOT : SOLID_SLIDEBOX);
	entity_set_origin(id, o);
	entity_set_vector(id, EV_VEC_velocity, Float:{0.0, 0.0, 0.0});
	new Float:ang[3]; entity_set_vector(id, EV_VEC_angles, ang); entity_set_vector(id, EV_VEC_v_angle, ang); entity_set_int(id, EV_INT_fixangle, 1);
}

// ---------------------------------------------------------------- race (on the minigame map) --
start_remote_wait()
{
	load_zones();
	g_state = ST_REMOTE_WAIT;
	apply_match_cvars();
	set_cvar_num("mp_round_infinite", 1); set_cvar_num("mp_freeforall", 1); set_cvar_num("bot_stop", 1);
	set_cvar_num("sv_airaccelerate", 100);                      // surf and bhop need real air control
	set_cvar_num("sv_autobunnyhopping", (g_mg == MG_BHOP && get_pcvar_num(c_autobhop)) ? 1 : 0);
	set_cvar_num("mp_buytime", 0);
	g_waitStart = get_gametime();
	dbg("Remote minigame %s: waiting for players.", MG_NAME[g_mg]);
	set_task(1.0, "task_remote_wait", TASK_RACE, _, _, "b");
}

public task_remote_wait()
{
	new bool:all = rebind_seats();
	new Float:waited = get_gametime() - g_waitStart;
	if (!all && waited < 50.0) return;   // humans can take a while to load the map
	if (waited < 4.0) return;            // let bots finish joining
	remove_task(TASK_RACE);
	if (mg_fight(g_mg))
	{
		set_cvar_num("sv_airaccelerate", 10); set_cvar_num("sv_autobunnyhopping", 0);
		mg_rules();
		mg_fight_start();
		return;
	}
	for (new s = 0; s < SEATS; s++)
	{
		g_finished[s] = false; g_finishTime[s] = 0.0;
		g_botFinish[s] = random_float(MG_BOT_TIME[g_mg][0], MG_BOT_TIME[g_mg][1]);
		new id = g_seatPlayer[s];
		if (!is_user_connected(id)) continue;
		rg_set_user_team(id, (s % 2) ? TEAM_TERRORIST : TEAM_CT, MODEL_UNASSIGNED, true, false);
	}
	g_finishN = 0; g_mgWinnerN = 0;
	rg_restart_round();
	g_countdown = 4;
	set_task(1.0, "task_countdown", TASK_RACE, _, _, "a", 4);
}

public task_countdown()
{
	g_countdown--;
	if (g_countdown > 0)
	{
		banner("%s  |  %d", MG_NAME[g_mg], g_countdown);
		client_cmd(0, "spk ^"buttons/blip1.wav^"");
		return;
	}
	banner("GO!");
	client_cmd(0, "spk ^"radio/go.wav^"");
	g_state = ST_REMOTE_RACE;
	g_raceStart = get_gametime();
	for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && is_user_alive(g_seatPlayer[s])) unfreeze(g_seatPlayer[s]);
	set_task(0.1, "task_race", TASK_RACE + 1, _, _, "b");
}

// A human on a race map must be able to run: not frozen, not crawling at menu speed, not dead on the start line.
race_unstick(s, id, Float:t)
{
	static Float:lastFix[33];
	if (!is_user_alive(id))
	{
		if (t > 1.5 && get_gametime() - lastFix[id] > 2.0) { lastFix[id] = get_gametime(); dbg("%s is dead in the race: respawning.", g_seatName[s]); rg_round_respawn(id); }
		return;
	}
	if (g_navThawed[id] && !nav_open(id)) nav_end(id);
	if ((entity_get_int(id, EV_INT_flags) & FL_FROZEN) && !g_navMenu[id]) { unfreeze(id); dbg("%s was frozen in the race: released.", g_seatName[s]); }
	if (get_entvar(id, var_maxspeed) < 100.0 && !g_navMenu[id]) { rg_reset_maxspeed(id); dbg("%s was slowed in the race: restored.", g_seatName[s]); }
}

public task_race()
{
	new Float:t = get_gametime() - g_raceStart;
	static dbgOnce; if (get_pcvar_num(c_debug) > 1 && dbgOnce++ % 50 == 0)
	{
		new alive = 0; for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && is_user_alive(g_seatPlayer[s])) alive++;
		dbg("race t=%.1f start=%.1f now=%.1f alive=%d zones=%d", t, g_raceStart, get_gametime(), alive, g_zonesOk);
	}
	for (new s = 0; s < SEATS; s++)
	{
		if (!g_mgIn[s] || g_finished[s]) continue;
		new id = g_seatPlayer[s];
		new bool:done = false;
		if (is_user_connected(id) && !is_user_bot(id)) race_unstick(s, id, t);
		if (is_user_alive(id))
		{
			new Float:o[3]; entity_get_vector(id, EV_VEC_origin, o);
			if (g_zonesOk && in_box(o, g_zFinish)) done = true;
			if (is_user_bot(id) && t >= g_botFinish[s] && g_zonesOk)
			{
				new Float:f[3]; for (new k = 0; k < 3; k++) f[k] = (g_zFinish[0][k] + g_zFinish[1][k]) / 2.0;
				f[2] = g_zFinish[0][2] + 40.0; entity_set_origin(id, f); done = true;
			}
		}
		if (!done) continue;
		g_finished[s] = true; g_finishTime[s] = t; g_finishN++;
		announce("%s finishes in %.1f s.", g_seatName[s], t);
		if (g_mgWinnerN == 0)
		{
			if (g_mgFmt == FMT_2V2) { for (new k = 0; k < SEATS; k++) if (g_mgIn[k] && g_mgSide[k] == g_mgSide[s]) g_mgWinners[g_mgWinnerN++] = k; }
			else g_mgWinners[g_mgWinnerN++] = s;
			banner("%s wins the %s!", g_seatName[s], MG_NAME[g_mg]);
			set_task(5.0, "task_race_over", TASK_RACE + 2);
		}
	}
	// HUD: race clock
	set_hudmessage(242, 163, 58, -1.0, 0.08, 0, 0.0, 0.2, 0.0, 0.0, -1);
	ShowSyncHudMsg(0, g_hudSync2, "%s  %.1f", MG_NAME[g_mg], t);
	if (t > 120.0 && g_mgWinnerN == 0)
	{
		// nobody made it: furthest along the course (+x) wins
		new best = -1, Float:bx = -99999.0;
		for (new s = 0; s < SEATS; s++) if (g_mgIn[s] && is_user_alive(g_seatPlayer[s])) { new Float:o[3]; entity_get_vector(g_seatPlayer[s], EV_VEC_origin, o); if (o[0] > bx) { bx = o[0]; best = s; } }
		if (best >= 0) g_mgWinners[g_mgWinnerN++] = best;
		banner("Time! %s got the furthest.", best >= 0 ? g_seatName[best] : "Nobody");
		set_task(4.0, "task_race_over", TASK_RACE + 2);
	}
}

public task_race_over()
{
	remove_task(TASK_RACE + 1);
	set_cvar_num("sv_airaccelerate", 10); set_cvar_num("sv_autobunnyhopping", 0);
	save_state(2);
	announce("Back to the board.");
	server_cmd("changelevel %s", g_boardMap);
}

// ---------------------------------------------------------------- resume (back on the board map) --
start_resume()
{
	g_state = ST_RESUME;
	apply_match_cvars();
	set_cvar_num("sv_airaccelerate", 10); set_cvar_num("sv_autobunnyhopping", 0);
	g_waitStart = get_gametime();
	set_task(1.0, "task_resume_wait", TASK_RACE, _, _, "b");
}

public task_resume_wait()
{
	new bool:all = rebind_seats();
	new Float:waited = get_gametime() - g_waitStart;
	if ((!all && waited < 50.0) || waited < 4.0) return;
	remove_task(TASK_RACE);
	delete_state();
	dbg("Resumed on %s after %s.", g_boardMap, MG_NAME[g_mg]);
	enter_board();
	g_state = ST_MG_RESULT;
	set_task(2.0, "flow_minigame_result", TASK_FLOW);
}
