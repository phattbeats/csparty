/* CS Party design prototype. Preserves live character order, dice, and summaries. */
const CS_PARTY_CHARACTERS = [
  {id:'phoenix',name:'Phoenix Connexion',team:'T',badge:'PX',color:'#e6603f',col:0,row:0,style:'The classic',faces:[1,2,3,4,5,6],summary:'The classic die. Anything from 1 to 6.'},
  {id:'elite',name:'Elite Crew',team:'T',badge:'L',color:'#e3b52b',col:1,row:0,style:'High roller',faces:[0,0,3,5,6,7],summary:'Two blanks, but the big rolls go up to 7.'},
  {id:'arctic',name:'Arctic Avengers',team:'T',badge:'AA',color:'#a7d5e4',col:2,row:0,style:'Steady mover',faces:[2,2,3,3,5,6],summary:'Never rolls a 1. A safe, steady die.'},
  {id:'guerilla',name:'Guerilla Warfare',team:'T',badge:'GW',color:'#9bad54',col:3,row:0,style:'All or nothing',faces:[1,1,1,6,6,6],summary:'All or nothing: a 1 or a 6.'},
  {id:'seal',name:'SEAL Team 6',team:'CT',badge:'ST6',color:'#6b9fd4',col:0,row:1,style:'The planner',faces:[3,3,3,4,4,4],summary:'Always a 3 or a 4. Plan every move.'},
  {id:'gsg9',name:'GSG-9',team:'CT',badge:'G9',color:'#b5b9c1',col:1,row:1,style:'Wild card',faces:[0,2,2,5,5,7],summary:'Swingy: a blank, some 2s and 5s, one 7.'},
  {id:'sas',name:'SAS',team:'CT',badge:'SAS',color:'#b98ad9',col:2,row:1,style:'Reliable with a twist',faces:[1,3,3,3,5,6],summary:'Mostly 3s, with a shot at a 5 or 6.'},
  {id:'gign',name:'GIGN',team:'CT',badge:'GN',color:'#e2e2d4',col:3,row:1,style:'Slow, then go',faces:[2,2,2,2,6,7],summary:'Plods along at 2, then bursts for 6 or 7.'}
];
const root = document.getElementById('cs-party');
function applyPortrait(el,character){
  el.style.setProperty('--atlas-x',`${character.col * 100 / 3}%`);
  el.style.setProperty('--atlas-y',`${character.row * 100}%`);
}
for (const character of CS_PARTY_CHARACTERS){
  const label = document.createElement('label');
  label.className = 'character-tile';
  label.style.setProperty('--char-color',character.color);
  const input = document.createElement('input');
  input.type = 'radio'; input.name = 'character'; input.value = character.id;
  input.setAttribute('aria-label',`${character.name}, ${character.team==='T'?'Terrorist':'Counter-Terrorist'}, die ${character.faces.join(' ')}`);
  const art = document.createElement('span'); art.className = 'card-art'; art.setAttribute('aria-hidden','true');
  const portrait = document.createElement('span'); portrait.className = 'portrait'; portrait.style.display='block'; applyPortrait(portrait,character);
  const playerTag = document.createElement('span'); playerTag.className = 'player-tag'; playerTag.textContent='P1';
  art.append(portrait,playerTag);
  const caption = document.createElement('span'); caption.className = 'card-caption';
  const badge = document.createElement('span'); badge.className='badge'; badge.textContent=character.badge; badge.setAttribute('aria-hidden','true');
  const name = document.createElement('span'); name.className='character-name'; name.textContent=character.name;
  caption.append(badge,name); label.append(input,art,caption);
  document.getElementById(character.team==='T'?'terrorists':'counter-terrorists').append(label);
}
function selectCharacter(id){
  const character = CS_PARTY_CHARACTERS.find(c=>c.id===id);
  const detail = root.querySelector('.detail');
  const faces = document.getElementById('die-faces');
  faces.replaceChildren();
  document.getElementById('demo-status').textContent='';
  if(!character){
    detail.style.setProperty('--char-color','#f4a331');
    document.getElementById('preview-portrait').hidden=true;
    document.getElementById('preview-random').hidden=false;
    document.getElementById('preview-badge').textContent='?';
    document.getElementById('detail-team').textContent='?';
    document.getElementById('character-style').textContent='Leave it to chance';
    document.getElementById('character-name').textContent='Random';
    document.getElementById('character-summary').textContent="You get whoever's left when the match starts.";
    faces.hidden=true;
    root.querySelector('.die-heading').hidden=true;
    document.getElementById('selection-announcement').textContent="Random selected. You get whoever's left when the match starts.";
    return;
  }
  faces.hidden=false; root.querySelector('.die-heading').hidden=false;
  detail.style.setProperty('--char-color',character.color);
  const portrait=document.getElementById('preview-portrait'); portrait.hidden=false; applyPortrait(portrait,character);
  document.getElementById('preview-random').hidden=true;
  document.getElementById('preview-badge').textContent=character.badge;
  document.getElementById('detail-team').textContent=character.team;
  document.getElementById('character-style').textContent=character.style;
  document.getElementById('character-name').textContent=character.name;
  document.getElementById('character-summary').textContent=character.summary;
  for(const [i,value] of character.faces.entries()){
    const die=document.createElement('span'); die.className='die-face'+(value===0?' zero':'');
    die.setAttribute('role','listitem'); die.setAttribute('aria-label',`Face ${i+1}: ${value===0?'blank, zero':value}`); die.textContent=String(value); faces.append(die);
  }
  document.getElementById('selection-announcement').textContent=`${character.name} selected. Die faces ${character.faces.join(', ')}. ${character.summary}`;
}
document.getElementById('chars').addEventListener('change',event=>{if(event.target.name==='character')selectCharacter(event.target.value)});
// Selection and input validation work locally. Wire this event into the existing game's join handler.
document.getElementById('join-form').addEventListener('submit',event=>{
  event.preventDefault();
  const name=document.getElementById('name').value.trim();
  if(!name){document.getElementById('name').setCustomValidity('Enter your player name.');document.getElementById('name').reportValidity();return}
  const character=root.querySelector('input[name="character"]:checked').value;
  const detail={name,character};
  root.dispatchEvent(new CustomEvent('csparty:join',{bubbles:true,detail}));
  document.getElementById('demo-status').textContent=`${name}, ${character==='random'?'Random':CS_PARTY_CHARACTERS.find(c=>c.id===character).name} selected. This preview is ready for the game's join handler.`;
});
document.getElementById('name').addEventListener('input',event=>event.target.setCustomValidity(''));
// A concrete selection makes the character art and dice inspectable on first load.
root.querySelector('input[value="phoenix"]').checked=true;
selectCharacter('phoenix');
