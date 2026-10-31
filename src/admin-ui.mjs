// 管理 UI の HTML(単一ファイル、依存なし)。admin.mjs が GET / で返す。
export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>llm-proxy 管理</title>
<style>
:root{--bg:#f6f7f9;--fg:#1f2328;--muted:#6b7280;--line:#d0d7de;--accent:#0969da;--danger:#cf222e;--ok:#1a7f37;--card:#fff}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:16px;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}header .sp{flex:1}header button{font-size:12px}
main{max-width:1200px;margin:0 auto;padding:16px 20px;display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.card h2{font-size:14px;margin:0 0 10px;display:flex;align-items:center;gap:10px}.card h2 .sp{flex:1}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
th{color:var(--muted);font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f0f2f5;padding:1px 4px;border-radius:4px}
.tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--line);color:var(--muted);margin-right:4px}
.tag.ok{color:var(--ok);border-color:#9ad3a7}.tag.off{color:var(--danger);border-color:#f1aeb5}.tag.exp{color:#9a6700;border-color:#e3c56b}
button{font:inherit;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}button:hover{background:#f3f4f6}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}button.sm{padding:2px 7px;font-size:12px}
input,select,textarea{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;width:100%}
form.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}form.grid label{display:grid;gap:3px;font-size:12px;color:var(--muted)}
form.grid .wide{grid-column:1/-1}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.kpi div{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.kpi b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:12px}
.muted{color:var(--muted)}.err{color:var(--danger)}.hidden{display:none}
td.actions{white-space:nowrap}td.actions button{margin-right:4px}td.models code{margin-right:4px}
dialog{border:1px solid var(--line);border-radius:10px;padding:18px 20px;max-width:720px;width:92vw}dialog::backdrop{background:rgba(0,0,0,.3)}
pre.key{background:#111827;color:#f9fafb;padding:10px 12px;border-radius:6px;overflow:auto;user-select:all}
.bar{height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar i.over{background:var(--danger)}
</style></head>
<body>
<header><h1>llm-proxy 管理</h1><span id="whoami" class="muted"></span><span id="role" class="tag"></span><span class="sp"></span><button id="refresh">更新</button><button id="logout">トークンを消す</button></header>
<main>
  <section id="login" class="card hidden">
    <h2>管理トークン</h2>
    <p class="muted">管理者が <code>keyctl.py admin-token</code> で発行したトークンを入力します。ブラウザの sessionStorage にだけ保存され、タブを閉じると消えます。</p>
    <form id="loginForm" class="row"><input id="token" type="password" placeholder="llmpa_..." style="max-width:520px" autocomplete="off"><button class="primary">接続</button><span id="loginErr" class="err"></span></form>
  </section>
  <section id="app" class="hidden">
    <div class="kpi" id="kpi"></div>
    <section class="card"><h2>API キー <span class="sp"></span><button id="newKey" class="primary">キーを発行</button></h2>
      <div style="overflow:auto"><table id="keys"><thead><tr><th>keyId</th><th>名前</th><th>チーム</th><th>状態</th><th>モデル</th><th>ツール</th><th>CIDR</th><th>制限</th><th class="num">今月 req</th><th class="num">今月 tokens</th><th class="num">今月 USD</th><th>予算消化</th><th>期限</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>
    <section class="card"><h2>チーム <span class="sp"></span><button id="newTeam" class="primary">チームを作成</button></h2>
      <p class="muted">チームに予算・RPM・TPM を持たせると、所属するキー全体の合計で判定します。キー側の制限と両方効きます。</p>
      <div style="overflow:auto"><table id="teams"><thead><tr><th>teamId</th><th>名前</th><th>状態</th><th>制限</th><th class="num">キー数</th><th class="num">今月 req</th><th class="num">今月 tokens</th><th class="num">今月 USD</th><th>予算消化</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>
    <section class="card"><h2>監査ログ <span class="sp"></span><input id="auditMonth" type="month" style="width:160px"><button id="loadAudit" class="sm">表示</button></h2>
      <div style="overflow:auto"><table id="audit"><thead><tr><th>時刻(UTC)</th><th>操作者</th><th>操作</th><th>対象</th><th>内容</th></tr></thead><tbody></tbody></table></div>
    </section>
    <section class="card"><h2>モデル単価(USD / 100 万トークン) <span class="sp"></span><button id="savePrices">保存</button></h2>
      <p class="muted">費用計算と予算判定に使います。行を空にすると削除されます。</p>
      <table id="prices"><thead><tr><th>Bedrock モデル ID</th><th class="num">入力</th><th class="num">出力</th><th></th></tr></thead><tbody></tbody></table>
      <div class="row" style="margin-top:8px"><button id="addPrice" class="sm">行を追加</button><span id="pricesMsg" class="muted"></span></div>
    </section>
  </section>
</main>

<dialog id="keyDialog"><form method="dialog" id="keyForm" class="grid">
  <h2 class="wide" id="keyDialogTitle">キーを発行</h2>
  <label>名前 <input name="name" required placeholder="team-a"></label>
  <label>有効期限(日数、空なら無期限) <input name="expiresInDays" type="number" min="0" placeholder="90"></label>
  <label>チーム <select name="teamId"><option value="">(なし)</option></select></label>
  <label>Bedrock Guardrails(id:version、空なら使わない) <input name="guardrail" placeholder="abcd1234efgh:1"></label>
  <label class="wide">モデル(1 行 1 件、alias=BedrockモデルID) <textarea name="models" rows="3" required placeholder="claude-haiku-4-5=jp.anthropic.claude-haiku-4-5-20251001-v1:0"></textarea></label>
  <label>ツール制限の種類 <select name="toolsMode"><option value="">制限なし</option><option value="deny">deny(列挙を拒否)</option><option value="allow">allow(列挙だけ許可)</option></select></label>
  <label>ツール名(カンマ区切り) <input name="toolsList" placeholder="Bash,exec_command"></label>
  <label class="wide">送信元 CIDR(カンマ区切り、空なら制限なし) <input name="cidrs" placeholder="203.0.113.0/24"></label>
  <label>予算(USD) <input name="budgetUsd" type="number" step="0.000001" min="0" placeholder="50"></label>
  <label>予算の期間 <select name="budgetPeriod"><option value="monthly">月次</option><option value="daily">日次</option></select></label>
  <label>RPM <input name="rpm" type="number" min="0" placeholder="60"></label>
  <label>TPM <input name="tpm" type="number" min="0" placeholder="200000"></label>
  <div class="wide row"><span id="keyErr" class="err"></span><span class="sp"></span><button type="button" id="keyCancel">キャンセル</button><button class="primary" id="keySubmit">保存</button></div>
</form></dialog>

<dialog id="teamDialog"><form method="dialog" id="teamForm" class="grid">
  <h2 class="wide" id="teamDialogTitle">チームを作成</h2>
  <label class="wide">名前 <input name="name" required placeholder="platform-team"></label>
  <label>予算(USD) <input name="budgetUsd" type="number" step="0.000001" min="0" placeholder="100"></label>
  <label>予算の期間 <select name="budgetPeriod"><option value="monthly">月次</option><option value="daily">日次</option></select></label>
  <label>RPM <input name="rpm" type="number" min="0" placeholder="300"></label>
  <label>TPM <input name="tpm" type="number" min="0" placeholder="1000000"></label>
  <div class="wide row"><span id="teamErr" class="err"></span><span class="sp"></span><button type="button" id="teamCancel">キャンセル</button><button class="primary">保存</button></div>
</form></dialog>

<dialog id="secretDialog"><h2>API キーを発行しました</h2>
  <p>このキーはこの画面を閉じると二度と表示できません。利用者に安全な経路で渡してください。</p>
  <pre class="key" id="secretKey"></pre>
  <div class="row"><button id="copyKey">コピー</button><span id="copyMsg" class="muted"></span><span class="sp"></span><button id="secretClose" class="primary">閉じました</button></div>
</dialog>

<dialog id="usageDialog"><h2 id="usageTitle">利用量</h2><div id="usageBody"></div><div class="row" style="margin-top:10px"><span class="sp"></span><button id="usageClose">閉じる</button></div></dialog>

<script>
const $=(s,r=document)=>r.querySelector(s);const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=(n,d=0)=>Number(n??0).toLocaleString("ja-JP",{minimumFractionDigits:d,maximumFractionDigits:d});
const usd=n=>"$"+Number(n??0).toFixed(n<0.01?6:4);const date=t=>t?new Date(t*1000).toISOString().slice(0,10):"-";
let token=sessionStorage.getItem("adminToken")||"";let state={keys:[],teams:[],month:"",prices:{},role:"admin"};let editing=null;let editingTeam=null;
async function api(method,path,body){const r=await fetch(path,{method,headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.error||("HTTP "+r.status));e.status=r.status;throw e;}return j;}
function show(id,on){$(id).classList.toggle("hidden",!on)}
async function load(){try{const [k,p,t,w]=await Promise.all([api("GET","/api/keys"),api("GET","/api/prices"),api("GET","/api/teams"),api("GET","/api/whoami")]);state.keys=k.keys;state.month=k.month;state.prices=p.models;state.teams=t.teams;state.role=w.role;show("#login",false);show("#app",true);$("#whoami").textContent=w.name+" として接続中 / "+state.month+" の集計";$("#role").textContent=w.role;document.body.classList.toggle("viewer",w.role!=="admin");render();}catch(e){if(e.status===401||e.status===503){show("#login",true);show("#app",false);$("#loginErr").textContent=e.message;}else alert(e.message);}}
function teamName(id){if(!id)return "-";const t=state.teams.find(x=>x.teamId===id);return t?t.name:id;}
function statusTag(k){const now=Date.now()/1000;if(k.disabled)return '<span class="tag off">無効</span>';if(k.expiresAt&&k.expiresAt<now)return '<span class="tag exp">期限切れ</span>';return '<span class="tag ok">有効</span>';}
function limitsText(l){const a=[];if(l.budgetUsd)a.push(usd(l.budgetUsd)+"/"+(l.budgetPeriod==="daily"?"日":"月"));if(l.rpm)a.push("rpm "+l.rpm);if(l.tpm)a.push("tpm "+fmt(l.tpm));return a.join(" · ")||"-";}
function budgetBar(k){const l=k.limits||{};if(!l.budgetUsd)return "-";const spent=k.usage?.costUsd||0;const ratio=Math.min(1,spent/l.budgetUsd);const note=l.budgetPeriod==="daily"?'<span class="muted">(月次集計表示)</span>':"";return '<div class="bar" title="'+usd(spent)+' / '+usd(l.budgetUsd)+'"><i class="'+(ratio>=1?"over":"")+'" style="width:'+(ratio*100)+'%"></i></div><span class="muted">'+Math.round(ratio*100)+'%</span> '+note;}
function render(){const tb=$("#keys tbody");tb.innerHTML=state.keys.map(k=>'<tr>'+
 '<td><code>'+esc(k.keyId)+'</code><br><span class="muted">'+esc(k.prefix)+'</span></td><td>'+esc(k.name)+(k.guardrail?'<br><span class="tag">guardrail</span>':'')+'</td><td>'+esc(teamName(k.teamId))+'</td><td>'+statusTag(k)+'</td>'+
 '<td class="models">'+Object.keys(k.models).map(a=>'<code>'+esc(a)+'</code>').join("")+'</td>'+
 '<td>'+(k.tools?('<span class="tag">'+(k.tools.allow?"allow":"deny")+'</span>'+esc((k.tools.allow||k.tools.deny).join(", "))):"-")+'</td>'+
 '<td>'+(k.cidrs.length?esc(k.cidrs.join(", ")):"-")+'</td><td>'+esc(limitsText(k.limits))+'</td>'+
 '<td class="num">'+fmt(k.usage?.requests)+'</td><td class="num">'+fmt((k.usage?.inputTokens||0)+(k.usage?.outputTokens||0))+'</td><td class="num">'+usd(k.usage?.costUsd)+'</td>'+
 '<td style="min-width:120px">'+budgetBar(k)+'</td><td>'+date(k.expiresAt)+'</td>'+
 '<td class="actions"><button class="sm" data-act="usage" data-id="'+k.keyId+'">利用量</button><button class="sm" data-act="edit" data-id="'+k.keyId+'">編集</button>'+
 '<button class="sm" data-act="toggle" data-id="'+k.keyId+'">'+(k.disabled?"有効化":"無効化")+'</button><button class="sm" data-act="regen" data-id="'+k.keyId+'">再発行</button><button class="sm danger" data-act="revoke" data-id="'+k.keyId+'">失効</button></td></tr>').join("")||'<tr><td colspan="14" class="muted">キーはまだありません</td></tr>';
 const total=state.keys.reduce((a,k)=>({req:a.req+(k.usage?.requests||0),tok:a.tok+(k.usage?.inputTokens||0)+(k.usage?.outputTokens||0),usd:a.usd+(k.usage?.costUsd||0)}),{req:0,tok:0,usd:0});
 const active=state.keys.filter(k=>!k.disabled&&!(k.expiresAt&&k.expiresAt<Date.now()/1000)).length;
 $("#kpi").innerHTML='<div><b>'+state.keys.length+'</b><span>キー(有効 '+active+')</span></div><div><b>'+fmt(total.req)+'</b><span>今月のリクエスト</span></div><div><b>'+fmt(total.tok)+'</b><span>今月のトークン(入力+出力)</span></div><div><b>'+usd(total.usd)+'</b><span>今月の推定費用(単価テーブル基準)</span></div>';
 const pb=$("#prices tbody");pb.innerHTML=Object.entries(state.prices).map(([id,v])=>priceRow(id,v.inputPerM,v.outputPerM)).join("");
 const tb2=$("#teams tbody");tb2.innerHTML=state.teams.map(t=>{const n=state.keys.filter(k=>k.teamId===t.teamId).length;return '<tr><td><code>'+esc(t.teamId)+'</code></td><td>'+esc(t.name)+'</td><td>'+(t.disabled?'<span class="tag off">無効</span>':'<span class="tag ok">有効</span>')+'</td><td>'+esc(limitsText(t.limits))+'</td><td class="num">'+n+'</td><td class="num">'+fmt(t.usage?.requests)+'</td><td class="num">'+fmt((t.usage?.inputTokens||0)+(t.usage?.outputTokens||0))+'</td><td class="num">'+usd(t.usage?.costUsd)+'</td><td style="min-width:120px">'+budgetBar(t)+'</td><td class="actions"><button class="sm" data-tact="edit" data-id="'+t.teamId+'">編集</button><button class="sm" data-tact="toggle" data-id="'+t.teamId+'">'+(t.disabled?"有効化":"無効化")+'</button><button class="sm danger" data-tact="delete" data-id="'+t.teamId+'">削除</button></td></tr>';}).join("")||'<tr><td colspan="10" class="muted">チームはまだありません</td></tr>';
 const sel=$('#keyForm [name=teamId]');sel.innerHTML='<option value="">(なし)</option>'+state.teams.map(t=>'<option value="'+esc(t.teamId)+'">'+esc(t.name)+'</option>').join("");
 const ro=state.role!=="admin";for(const b of document.querySelectorAll("#keys .actions button:not([data-act=usage]),#teams .actions button,#newKey,#newTeam,#savePrices,#addPrice"))b.disabled=ro;}
function priceRow(id="",i="",o=""){return '<tr><td><input class="pid" value="'+esc(id)+'" placeholder="jp.anthropic.claude-haiku-4-5-20251001-v1:0"></td><td><input class="pin" type="number" step="0.0001" value="'+esc(i)+'"></td><td><input class="pout" type="number" step="0.0001" value="'+esc(o)+'"></td><td><button class="sm" onclick="this.closest(\'tr\').remove()">削除</button></td></tr>';}
$("#addPrice").onclick=()=>$("#prices tbody").insertAdjacentHTML("beforeend",priceRow());
$("#savePrices").onclick=async()=>{const models={};for(const tr of $("#prices tbody").children){const id=$(".pid",tr).value.trim();if(!id)continue;models[id]={inputPerM:Number($(".pin",tr).value),outputPerM:Number($(".pout",tr).value)};}try{await api("PUT","/api/prices",{models});$("#pricesMsg").textContent="保存しました";await load();}catch(e){$("#pricesMsg").textContent=e.message;}};
$("#loginForm").onsubmit=e=>{e.preventDefault();token=$("#token").value.trim();sessionStorage.setItem("adminToken",token);$("#loginErr").textContent="";load();};
$("#logout").onclick=()=>{sessionStorage.removeItem("adminToken");token="";location.reload();};$("#refresh").onclick=load;
function openKeyDialog(k){editing=k;const f=$("#keyForm");f.reset();$("#keyDialogTitle").textContent=k?("編集: "+k.name+" ("+k.keyId+")"):"キーを発行";$("#keyErr").textContent="";
 if(k){f.teamId.value=k.teamId||"";f.guardrail.value=k.guardrail?(k.guardrail.id+":"+(k.guardrail.version||"DRAFT")):"";f.name.value=k.name;f.models.value=Object.entries(k.models).map(([a,m])=>a+"="+m).join("\n");f.toolsMode.value=k.tools?(k.tools.allow?"allow":"deny"):"";f.toolsList.value=k.tools?(k.tools.allow||k.tools.deny).join(","):"";f.cidrs.value=k.cidrs.join(",");f.budgetUsd.value=k.limits.budgetUsd??"";f.budgetPeriod.value=k.limits.budgetPeriod||"monthly";f.rpm.value=k.limits.rpm??"";f.tpm.value=k.limits.tpm??"";f.expiresInDays.placeholder=k.expiresAt?("現在: "+date(k.expiresAt)+"(空欄なら変更なし)"):"空欄なら無期限のまま";}
 $("#keyDialog").showModal();}
$("#newKey").onclick=()=>openKeyDialog(null);$("#keyCancel").onclick=()=>$("#keyDialog").close();
$("#keyForm").onsubmit=async e=>{e.preventDefault();const f=e.target;const models={};for(const line of f.models.value.split(/\n/)){const t=line.trim();if(!t)continue;const i=t.indexOf("=");if(i<0){$("#keyErr").textContent="モデルは alias=modelId の形式で入力してください";return;}models[t.slice(0,i).trim()]=t.slice(i+1).trim();}
 const body={name:f.name.value,models,cidrs:f.cidrs.value.split(",").map(s=>s.trim()).filter(Boolean),limits:{budgetUsd:f.budgetUsd.value||null,budgetPeriod:f.budgetPeriod.value,rpm:f.rpm.value||null,tpm:f.tpm.value||null}};
 body.tools=f.toolsMode.value?{[f.toolsMode.value]:f.toolsList.value.split(",").map(s=>s.trim()).filter(Boolean)}:null;
 body.teamId=f.teamId.value||null;const g=f.guardrail.value.trim();body.guardrail=g?{id:g.split(":")[0],version:g.split(":")[1]||"DRAFT"}:null;
 if(f.expiresInDays.value!=="")body.expiresInDays=Number(f.expiresInDays.value);else if(!editing)body.expiresInDays=null;
 try{if(editing){await api("PATCH","/api/keys/"+editing.keyId,body);}else{const r=await api("POST","/api/keys",body);$("#secretKey").textContent=r.key;$("#copyMsg").textContent="";$("#secretDialog").showModal();}$("#keyDialog").close();await load();}catch(err){$("#keyErr").textContent=err.message;}};
$("#copyKey").onclick=async()=>{try{await navigator.clipboard.writeText($("#secretKey").textContent);$("#copyMsg").textContent="コピーしました";}catch{$("#copyMsg").textContent="手動で選択してコピーしてください";}};
$("#secretClose").onclick=()=>{$("#secretKey").textContent="";$("#secretDialog").close();};$("#usageClose").onclick=()=>$("#usageDialog").close();
$("#keys").onclick=async e=>{const b=e.target.closest("button[data-act]");if(!b)return;const k=state.keys.find(x=>x.keyId===b.dataset.id);try{
 if(b.dataset.act==="edit")openKeyDialog(k);
 else if(b.dataset.act==="toggle"){await api("PATCH","/api/keys/"+k.keyId,{disabled:!k.disabled});await load();}
 else if(b.dataset.act==="regen"){if(!confirm(k.name+" ("+k.keyId+") の平文を作り直します。今の平文は使えなくなります。設定と利用量は引き継ぎます。"))return;const r=await api("POST","/api/keys/"+k.keyId+"/regenerate");$("#secretKey").textContent=r.key;$("#copyMsg").textContent="";$("#secretDialog").showModal();await load();}
 else if(b.dataset.act==="revoke"){if(!confirm(k.name+" ("+k.keyId+") を失効します。元に戻せません。利用量の履歴は残ります。"))return;await api("DELETE","/api/keys/"+k.keyId);await load();}
 else if(b.dataset.act==="usage"){const d=await api("GET","/api/keys/"+k.keyId);$("#usageTitle").textContent="利用量: "+k.name+" ("+k.keyId+")";
  $("#usageBody").innerHTML=d.usageHistory.length?'<table><thead><tr><th>期間</th><th class="num">リクエスト</th><th class="num">入力</th><th class="num">出力</th><th class="num">USD</th></tr></thead><tbody>'+d.usageHistory.map(u=>'<tr><td><code>'+esc(u.period)+'</code></td><td class="num">'+fmt(u.requests)+'</td><td class="num">'+fmt(u.inputTokens)+'</td><td class="num">'+fmt(u.outputTokens)+'</td><td class="num">'+usd(u.costUsd)+'</td></tr>').join("")+'</tbody></table>':'<p class="muted">まだ利用がありません</p>';$("#usageDialog").showModal();}
}catch(err){alert(err.message);}};
function openTeamDialog(t){editingTeam=t;const f=$("#teamForm");f.reset();$("#teamDialogTitle").textContent=t?("編集: "+t.name):"チームを作成";$("#teamErr").textContent="";if(t){f.name.value=t.name;f.budgetUsd.value=t.limits.budgetUsd??"";f.budgetPeriod.value=t.limits.budgetPeriod||"monthly";f.rpm.value=t.limits.rpm??"";f.tpm.value=t.limits.tpm??"";}$("#teamDialog").showModal();}
$("#newTeam").onclick=()=>openTeamDialog(null);$("#teamCancel").onclick=()=>$("#teamDialog").close();
$("#teamForm").onsubmit=async e=>{e.preventDefault();const f=e.target;const body={name:f.name.value,limits:{budgetUsd:f.budgetUsd.value||null,budgetPeriod:f.budgetPeriod.value,rpm:f.rpm.value||null,tpm:f.tpm.value||null}};try{if(editingTeam)await api("PATCH","/api/teams/"+editingTeam.teamId,body);else await api("POST","/api/teams",body);$("#teamDialog").close();await load();}catch(err){$("#teamErr").textContent=err.message;}};
$("#teams").onclick=async e=>{const b=e.target.closest("button[data-tact]");if(!b)return;const t=state.teams.find(x=>x.teamId===b.dataset.id);try{
 if(b.dataset.tact==="edit")openTeamDialog(t);
 else if(b.dataset.tact==="toggle"){await api("PATCH","/api/teams/"+t.teamId,{disabled:!t.disabled});await load();}
 else if(b.dataset.tact==="delete"){if(!confirm(t.name+" を削除します。所属キーがある場合は削除できません。"))return;await api("DELETE","/api/teams/"+t.teamId);await load();}
}catch(err){alert(err.message);}};
$("#auditMonth").value=new Date().toISOString().slice(0,7);
$("#loadAudit").onclick=async()=>{try{const r=await api("GET","/api/audit/"+$("#auditMonth").value);$("#audit tbody").innerHTML=r.events.map(ev=>'<tr><td>'+esc(ev.ts.replace("T"," ").slice(0,19))+'</td><td>'+esc(ev.actor)+' <span class="tag">'+esc(ev.role)+'</span></td><td><code>'+esc(ev.action)+'</code></td><td>'+esc(ev.target||"-")+'</td><td class="muted" style="white-space:normal;max-width:480px">'+esc(ev.detail||"")+'</td></tr>').join("")||'<tr><td colspan="5" class="muted">この月の操作はありません</td></tr>';}catch(err){alert(err.message);}};
if(token)load();else{show("#login",true);}
</script></body></html>`;
