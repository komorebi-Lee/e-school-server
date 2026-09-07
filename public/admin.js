const savedAdminUser=JSON.parse(localStorage.getItem('shishan_admin_user')||'null');
const state={data:null,view:'dashboard',query:'',status:'ALL',token:localStorage.getItem('shishan_admin_token')||'',user:savedAdminUser};
const lowStockThreshold=Number((state.data.settings||{}).lowStockThreshold??10);
const titles={dashboard:'经营概览',merchants:'商家入驻',products:'商品中心',promos:'话费活动',reviews:'商品评价',orders:'电瓶车订单',payments:'支付单',phones:'电话卡订单',recharges:'话费权益',finance:'财务流水',broadband:'宽带资格',plates:'牌照辅助',afterSales:'售后工单',notifications:'站内通知',logs:'操作日志',settings:'运营设置',settlements:'商家结算',payouts:'商家提现',patrol:'超时预警',scores:'商家服务分'};
titles.serviceCollabs='服务单协同';
const statuses={PENDING_PAYMENT:'待支付',PAID:'已支付',FULFILLING:'配送中',COMPLETED:'已完成',CANCELLED:'已取消',PENDING:'待支付',EXPIRED:'支付超时',REFUNDED:'已退款',PENDING_REALNAME:'待实名',ACTIVATED:'已激活',PENDING_CREDIT:'待到账',CREDITED:'已到账',PENDING_VERIFY:'待核验',APPROVED:'已通过',REJECTED:'未通过',MATERIAL_PENDING:'待材料',REVIEWING:'处理中',SUBMITTED:'待审核',CLOSED:'已关闭',AFTER_SALE:'售后中',PUBLISHED:'已展示',HIDDEN:'已隐藏',PENDING_SETTLE:'可结算',SETTLED:'已结算',PENDING_DELIVERY:'待交付核验',IN_ACCOUNT_PERIOD:'账期中',FROZEN:'售后冻结',PAYOUT_REQUESTED:'提现待审核',PENDING_REVIEW:'待审核',OPEN:'待认领',ACKNOWLEDGED:'已认领',RESOLVED:'已关闭',OVERDUE:'已超时',WARNING:'即将超时',NORMAL:'正常经营',LIMITED:'限流整改',RESTRICTED:'暂停上新',EXCELLENT:'优秀',GOOD:'良好',WATCH:'观察',RISK:'高风险',AUTO:'自动上架'};
const endpointTypes={orders:'orders',phones:'phone-card-orders',recharges:'recharge-orders',broadband:'broadband-applications',plates:'plate-applications',afterSales:'after-sales'};
const collections={orders:'orders',payments:'paymentOrders',phones:'phoneCardOrders',recharges:'rechargeOrders',broadband:'broadbandApplications',plates:'plateApplications',afterSales:'afterSales',finance:'financeEvents',settlements:'settlements',payouts:'payoutRequests',patrol:'slaAlerts',scores:'merchantScores'};
const financeTypeLabels={PAYMENT:'支付收入',REFUND:'退款支出',PAYOUT:'商家打款'};
const merchantCategoryLabels={E_BIKE:'电动车/维修',DIGITAL:'数码配件',FOOD:'食品生鲜',LIFE_SERVICE:'生活服务'};
const productCategoryLabels={E_BIKE_NEW:'电瓶车',PHONE_PLAN:'电话套餐',RECHARGE_PROMO:'话费权益',SERVICE:'服务'};
const merchantTypeLabels={INDIVIDUAL:'个体工商户',ENTERPRISE:'企业/公司',PERSONAL:'个人身份'};
const options={orders:['PENDING_PAYMENT','PAID','FULFILLING','COMPLETED','CANCELLED'],phones:['PENDING_PAYMENT','PENDING_REALNAME','ACTIVATED','CANCELLED','REJECTED'],recharges:['PENDING_PAYMENT','PENDING_CREDIT','CREDITED','CANCELLED','REJECTED'],broadband:['PENDING_VERIFY','APPROVED','REJECTED'],plates:['PENDING_PAYMENT','MATERIAL_PENDING','REVIEWING','COMPLETED','REJECTED'],afterSales:['SUBMITTED','REVIEWING','CLOSED']};
const money=c=>`¥${((c||0)/100).toLocaleString('zh-CN',{minimumFractionDigits:2})}`;const fmtDate=v=>v?new Date(v).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';const label=v=>statuses[v]||v||'—';const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function badgeClass(v){return/COMPLETED|ACTIVATED|CREDITED|APPROVED/.test(v)?'green':/PENDING|MATERIAL|SUBMITTED/.test(v)?'orange':/PAID|FULFILLING|REVIEWING/.test(v)?'blue':/CANCELLED|REJECTED/.test(v)?'red':''}
function authHeaders(extra={}){return{...extra,authorization:`Bearer ${state.token}`}}
async function api(url,opts={}){const response=await fetch(url,{...opts,headers:authHeaders(opts.headers||{})});if(response.status===401){logout();throw new Error('登录已失效')}const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'操作失败');return body.data}
async function login(username,password){const response=await fetch('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'登录失败');state.token=body.data.token;state.user=body.data.user;localStorage.setItem('shishan_admin_token',state.token);localStorage.setItem('shishan_admin_user',JSON.stringify(state.user));showApp();await load()}
function logout(){localStorage.removeItem('shishan_admin_token');localStorage.removeItem('shishan_admin_user');state.token='';state.user=null;document.querySelector('#appShell').classList.add('hidden');document.querySelector('#loginPage').classList.remove('hidden')}
function showApp(){renderAdminIdentity();document.querySelector('#loginPage').classList.add('hidden');document.querySelector('#appShell').classList.remove('hidden')}
function renderAdminIdentity(){const user=state.user||{name:'运营管理员',roleLabel:'管理员'};const box=document.querySelector('.sidebar-user');if(!box)return;box.querySelector('strong').textContent=user.name||user.username||'运营管理员';box.querySelector('small').textContent=user.roleLabel||user.role||'管理员';box.querySelector('.avatar').textContent=(user.name||user.username||'运').slice(0,1)}
async function load(){document.querySelector('#syncState').textContent='正在同步';state.data=await api('/api/admin/overview');const settings=state.data.settings||{};const school=document.querySelector('#sidebarSchool');const campus=document.querySelector('#sidebarCampus');if(school)school.textContent=settings.schoolName||'华中农业大学';if(campus)campus.textContent=settings.campusName||'狮山校区';document.querySelector('#syncState').textContent=`已同步 ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;render()}

const metric=(name,value,note,primary=false)=>`<div class="metric ${primary?'primary-metric':''}"><div class="metric-label">${name}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;
const task=(name,note,count,view)=>`<div class="task" data-goto="${view}"><div><strong>${name}</strong><p>${note}</p></div><div class="task-count">${count}</div></div>`;
function operationsReportPanel(){
  const report=state.data.operationsReport||{reports:[],totals:{}};
  const t=report.totals||{};
  const insights=state.data.operationsInsights||{comparisons:[],alerts:[]};
  const compareRows=insights.comparisons||[];
  const changeBadge=value=>`<span class="badge ${value>0?'green':value<0?'red':''}">${value>0?'+':''}${value}%</span>`;
  const comparisonHtml=compareRows.length?`<div class="table-wrap"><table><thead><tr><th>指标</th><th>近 7 天</th><th>上一个 7 天</th><th>环比</th></tr></thead><tbody>${compareRows.map(row=>`<tr><td>${esc(row.label)}</td><td>${row.key==='paymentInCents'?money(row.current):row.current}</td><td>${row.key==='paymentInCents'?money(row.previous):row.previous}</td><td>${changeBadge(row.changePercent)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted-empty">暂无可对比数据</p>';
  const alerts=(insights.alerts||[]);
  const alertHtml=alerts.length?alerts.map(item=>`<div class="alert-item"><strong>${item.level==='HIGH'?'高优先':'建议关注'}</strong><p>${esc(item.message)}</p></div>`).join(''):'<p class="muted-empty">近 7 天暂无运营风险</p>';
  const rows=(report.reports||[]).slice(0,7).map(item=>`<tr>
    <td><strong>${esc(String(item.date).slice(5))}</strong></td>
    <td>${item.ebikeOrders + item.phoneCardOrders + item.rechargeOrders + item.plateApplications}<small>电瓶车 ${item.ebikeOrders} · 电话卡 ${item.phoneCardOrders} · 话费 ${item.rechargeOrders} · 牌照 ${item.plateApplications}</small></td>
    <td>${item.completedEbikeOrders}<small>售后完成 ${item.afterSalesClosed}</small></td>
    <td>${item.autoDelists}<small>恢复 ${item.complianceRestores} · 整改 ${item.rectifyCasesCreated}</small></td>
    <td>${item.paymentTimeouts}</td>
    <td>${money(item.paymentInCents)}<small>净额 ${money(item.netInCents)}</small></td>
  </tr>`).join('');
  return `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>经营日报</h2><span>业务量 · 环比 · 风险</span><button id="exportOperations" class="table-button">导出 14 天 CSV</button></div>
    <div class="metric-grid">${metric('7天支付收入',money(t.paymentInCents||0),'微信支付确认入账')}${metric('7天新增业务',(t.ebikeOrders||0)+(t.phoneCardOrders||0)+(t.rechargeOrders||0)+(t.plateApplications||0),'电瓶车/电话卡/话费/牌照')}${metric('7天完成电瓶车订单',t.completedEbikeOrders||0,'交付码核验完成')}${metric('7天售后完成',t.afterSalesClosed||0,`新增售后 ${t.afterSalesCreated||0} 笔`)}${metric('7天自动下架',t.autoDelists||0,`恢复 ${t.complianceRestores||0} · 整改 ${t.rectifyCasesCreated||0}`)}${metric('7天支付超时',t.paymentTimeouts||0,'下单后未支付自动关闭')}</div>
    <div class="dashboard-grid" style="margin-top:16px"><section class="panel"><div class="panel-head"><h3>环比变化</h3><span>本周对比上周</span></div>${comparisonHtml}</section><section class="panel"><div class="panel-head"><h3>经营预警</h3><span>按优先级处理</span></div>${alertHtml}</section></div>
    <div class="table-wrap"><table><thead><tr><th>日期</th><th>新增业务</th><th>完成</th><th>风控</th><th>超时</th><th>资金</th></tr></thead><tbody>${rows||'<tr><td colspan="6" class="empty">暂无日报数据</td></tr>'}</tbody></table></div>
  </section>`;
}
function dashboard(){const m=state.data.metrics;const d=state.data;return`<div class="welcome"><div><h2>上午好，运营管理员</h2><p>这里汇总了今天最需要关注的交易与履约事项。</p></div><div class="date-chip">${new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})}</div></div><div class="metric-grid">${metric('累计成交额',money(m.revenueInCents),'仅统计已支付业务',true)}${metric('已支付订单',m.paidOrders,'电瓶车、电话卡与牌照')}${metric('待处理事项',m.pending,'不含待支付和已取消')}${metric('可售偏低商品',m.lowStock,'可售库存已达到补货阈值')}${metric('售后超时',m.afterSaleOverdue||0,'超过承诺响应时限')}${metric('履约超时预警',(state.data.slaSummary?.overdueCount||0),`即将超时 ${state.data.slaSummary?.warningCount||0} 条`)}${metric('商家服务分均值',(state.data.merchantScoreSummary?.averageScore||0),`限流 ${state.data.merchantScoreSummary?.limitedCount||0} · 暂停上新 ${state.data.merchantScoreSummary?.restrictedCount||0}`)}</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2>运营待办</h2><span>点击进入业务列表</span></div><div class="task-list">${task('商家入驻审核','审核新入驻商家资质',(d.merchants||[]).filter(x=>x.status==='REVIEWING').length,'merchants')}${task('电瓶车履约跟进','处理已支付和售后订单',(d.orders||[]).filter(x=>['PAID','FULFILLING','AFTER_SALE'].includes(x.status)).length,'orders')}${task('电话卡实名激活','核对运营商实名结果',(d.phoneCardOrders||[]).filter(x=>x.status==='PENDING_REALNAME').length,'phones')}${task('校园牌照辅助','跟进材料与审核进度',(d.plateApplications||[]).filter(x=>['MATERIAL_PENDING','REVIEWING'].includes(x.status)).length,'plates')}${task('双人宽带资格','核验两位同学购卡状态',(d.broadbandApplications||[]).filter(x=>x.status==='PENDING_VERIFY').length,'broadband')}${task('话费权益到账','确认充值优惠到账',(d.rechargeOrders||[]).filter(x=>x.status==='PENDING_CREDIT').length,'recharges')}${task('超时预警认领','巡检发现的逾期与临期事项',(state.data.slaSummary?.openCount||0),'patrol')}${task('商家提现审核','核对收款账户后确认打款',(d.payoutRequests||[]).filter(x=>x.status==='PENDING_REVIEW').length,'payouts')}${task('服务分整改跟进','限流或暂停上新的商家',((state.data.merchantScoreSummary?.limitedCount||0)+(state.data.merchantScoreSummary?.restrictedCount||0)),'scores')}${task('商品复核','限流商家新增商品待复核',(state.data.pendingPublishProducts||[]).length,'scores')}</div></section><section class="panel"><div class="panel-head"><h2>库存预警</h2><span>阈值 ${lowStockThreshold} 件</span></div><div class="stock-list">${(d.products||[]).filter(p=>p.active!==false&&Number(p.availableStock??p.stock??0)<=lowStockThreshold).sort((a,b)=>Number(a.availableStock??a.stock??0)-Number(b.availableStock??b.stock??0)).slice(0,8).map(p=>{const available=Number(p.availableStock??p.stock??0);return`<div class="stock-item"><span>${esc(p.name)}</span><strong class="${available<=lowStockThreshold?'low':''}">${available}件</strong></div>`}).join('')||'<p class="muted-empty">暂无达到阈值的商品</p>'}</div></section></div><section class="panel" style="margin-top:16px"><div class="panel-head"><h2>最近操作</h2><span>系统留痕</span></div><div class="log-list">${(d.auditLogs||[]).slice(0,5).map(log=>`<div class="log-item"><div><strong>${esc(log.action)}</strong><p>${esc(log.operator)} · ${esc(log.target)}</p></div><small>${fmtDate(log.createdAt)}</small></div>`).join('')}</div></section>`}

const baseDashboard=dashboard;
dashboard=function(){return baseDashboard().replace('<div class="dashboard-grid">',operationsReportPanel()+'<div class="dashboard-grid">')};
function toolbar(count,{add=false,statusesList=[]}={}){return`<div class="page-actions"><p>共 ${count} 条记录</p><div>${add?'<button id="addProduct" class="primary">＋ 新增商品</button>':''}</div></div><div class="filterbar"><div class="filters"><input id="listSearch" class="search" value="${esc(state.query)}" placeholder="搜索当前列表">${statusesList.length?`<select id="statusFilter" class="filter-select"><option value="ALL">全部状态</option>${statusesList.map(x=>`<option value="${x}" ${state.status===x?'selected':''}>${label(x)}</option>`).join('')}</select>`:''}</div><button id="exportButton" class="export-button">导出 CSV</button></div>`}
function table(headers,rows,count){return`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${headers.length}" class="empty">没有符合条件的记录</td></tr>`}</tbody></table><div class="pagination"><span>显示 1-${Math.min(count,20)}，共 ${count} 条</span><div><button disabled>上一页</button> <button disabled>下一页</button></div></div></div>`}
function match(item){return!state.query||JSON.stringify(item).toLowerCase().includes(state.query.toLowerCase())}function statusMatch(item){return state.status==='ALL'||item.status===state.status}
function statusControl(view,item){
  const isOrder=view==='orders';
  const values=options[view].filter(x=>!isOrder||x!=='PAID');
  const select=values.map(x=>`<option value="${x}" ${x===item.status?'selected':''}>${label(x)}</option>`).join('');
  return `<select class="status-select" data-id="${item.id}" data-view="${view}">${select}</select><button class="table-button save-status" data-id="${item.id}" data-view="${view}">保存</button>`;
}
function products(){const items=state.data.products.filter(match);const rows=items.map(p=>{const available=Number(p.availableStock ?? p.stock ?? 0);const reserved=Number(p.reservedStock||0);return `<tr><td><strong>${esc(p.name)}</strong><small>${esc(p.description)}</small></td><td><span class="category">${esc(productCategoryLabels[p.category]||p.category)}</span></td><td>${money(p.priceInCents)}</td><td class="${available<=lowStockThreshold?'low':''}">${available}<small>总库存 ${p.stock}${reserved?` · 待支付占用 ${reserved}`:''}</small></td><td><span class="badge ${p.active?'green':'red'}">${p.active?'已上架':'已下架'}</span></td><td><div class="row-actions"><button class="text-button detail-button" data-view="products" data-id="${p.id}">详情</button><button class="table-button edit-product" data-id="${p.id}">编辑</button></div></td></tr>`});return toolbar(items.length,{add:true})+table(['商品','分类','售价','可售/总库存','状态','操作'],rows,items.length)}
function promos(){const items=state.data.rechargePromos||[];const rows=items.map(p=>`<tr><td><strong>充${p.pay}送${p.receive-p.pay}</strong><small>${esc(p.id)}</small></td><td>${money(p.pay*100)}</td><td>${money(p.receive*100)}</td><td><span class="badge ${p.active?'green':'red'}">${p.active?'已上架':'已下架'}</span></td><td><div class="row-actions"><button class="table-button edit-promo" data-id="${p.id}">编辑</button><button class="table-button toggle-promo" data-id="${p.id}" data-active="${!p.active}">${p.active?'下架':'上架'}</button></div></td></tr>`);return toolbar(items.length,{add:true})+table(['活动','充值','到账','状态','操作'],rows,items.length)}
function reviews(){const reviews=state.data.productReviews||[];const items=reviews.filter(match).filter(statusMatch).map(review=>({...review,productName:(state.data.products||[]).find(product=>product.id===review.productId)?.name||review.productId,visibility:review.visibility||'PUBLISHED'}));const rows=items.map(review=>`<tr><td><strong>${esc(review.productName)}</strong><small>${esc(review.id)}</small></td><td>${'★'.repeat(review.rating)}</td><td>${esc(review.content)}</td><td>${fmtDate(review.createdAt)}</td><td><span class="badge ${review.visibility==='HIDDEN'?'red':'green'}">${label(review.visibility)}</span></td><td><button class="table-button toggle-review" data-id="${review.id}" data-visibility="${review.visibility==='HIDDEN'?'PUBLISHED':'HIDDEN'}">${review.visibility==='HIDDEN'?'恢复展示':'隐藏'}</button></td></tr>`);return toolbar(items.length,{statusesList:['PUBLISHED','HIDDEN']})+table(['商品','评分','内容','时间','状态','操作'],rows,items.length)}
function orders(){const items=state.data.orders.filter(match).filter(statusMatch);const rows=items.map(o=>{const collab=o.collaboration||{};const intervention=collab.intervention?.status==='REQUESTED';const merchant=(state.data.merchants||[]).find(x=>x.id===collab.merchantId)?.name||'平台自营';const deliveryLabel={PENDING_PAYMENT:'待支付',PAID:'待配送',FULFILLING:'配送中',COMPLETED:'已送达',CANCELLED:'已取消',AFTER_SALE:'售后处理中'}[o.status]||'—';const paymentStatus={UNPAID:'未支付',PAID:'模拟支付成功',CANCELLED:'支付已取消',EXPIRED:'支付超时',REFUNDED:'已退款'}[o.paymentStatus]||'未支付';const deliveryCode=o.deliveryCode||'—';return `<tr><td><strong>${esc(o.orderNo)}</strong><small>${fmtDate(o.createdAt)}</small></td><td>${o.items.map(x=>esc(x.name)).join('、')}</td><td>${esc(merchant)}</td><td>${money(o.totalInCents)}<small>${esc(paymentStatus)}</small></td><td><span class="badge ${badgeClass(o.status)}">${label(o.status)}</span><small>${esc(deliveryLabel)}</small><small>交付码 ${esc(deliveryCode)}</small></td><td>${intervention?'<span class="badge red">待平台处理</span>':'<span class="badge green">正常流转</span>'}</td><td>${statusControl('orders',o)}</td><td><div class="row-actions"><button class="text-button detail-button" data-view="orders" data-id="${o.id}">查看详情</button><button class="text-button platform-collab" data-id="${o.id}" data-action="${intervention?'RESOLVE':'INTERVENE'}">${intervention?'平台处理':'介入'}</button></div></td></tr>`});return toolbar(items.length,{statusesList:options.orders})+table(['订单号','商品','商家','实付','支付/配送','协同','状态流转','操作'],rows,items.length)}
function serviceCollabRow(item,collection,typeLabel){const collab=item.collaboration||{};const intervention=collab.intervention?.status==='REQUESTED';const pendingMessage=(collab.messages||[]).some(message=>message.role==='USER');return `<tr><td><strong>${esc(item.customerName||item.ownerPhone||item.phone||'用户')}</strong><small>${esc(item.id)}</small></td><td>${esc(typeLabel)}<small>${esc(item.planName||item.vehicleModel||'双人购卡宽带')}</small></td><td>${esc(item.phone||item.ownerPhone||'—')}</td><td><span class="badge ${badgeClass(item.status)}">${label(item.status)}</span></td><td>${intervention?'<span class="badge red">待平台处理</span>':pendingMessage?'<span class="badge orange">待回复咨询</span>':'<span class="badge green">正常流转</span>'}</td><td><div class="row-actions"><button class="text-button service-detail" data-id="${item.id}">对话</button><button class="text-button service-collab" data-collection="${collection}" data-id="${item.id}" data-action="${intervention?'RESOLVE':'INTERVENE'}">${intervention?'平台处理':'介入'}</button></div></td></tr>`}
function serviceCollabs(){const rows=[...(state.data.phoneCardOrders||[]).map(item=>serviceCollabRow(item,'phoneCardOrders','电话卡')),...(state.data.rechargeOrders||[]).map(item=>serviceCollabRow(item,'rechargeOrders','话费权益')),...(state.data.broadbandApplications||[]).map(item=>serviceCollabRow(item,'broadbandApplications','宽带资格')),...(state.data.plateApplications||[]).map(item=>serviceCollabRow(item,'plateApplications','校园牌照'))].filter(match).sort((a,b)=>{
  const priority=(item)=>{const collab=item.collaboration||{};return collab.intervention?.status==='REQUESTED'?0:(collab.messages||[]).some(message=>message.role==='USER')?1:2};
  return priority(a)-priority(b)||String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''));
});return toolbar(rows.length)+table(['用户','业务','联系方式','状态','协同','操作'],rows,rows.length)}
function payments(){const items=(state.data.paymentOrders||[]).filter(match).filter(statusMatch);const merchantName=(id)=>(state.data.merchants||[]).find(x=>x.id===id)?.name||'平台自营';const rows=items.map(x=>{const linked=(state.data.settlements||[]).filter(s=>s.paymentId===x.id);const settleText=linked.length?linked.map(s=>`${merchantName(s.merchantId)}：${money(s.payableAmountInCents)} / ${label(s.settlementStatus)}`).join('；'):'平台自营';const firstPending=linked.find(s=>s.settlementStatus==='PENDING_SETTLE');return `<tr><td><strong>${esc(x.paymentNo)}</strong><small>${esc(x.orderNo)}</small></td><td>${money(x.amountInCents)}</td><td>${esc(x.channel)}</td><td><span class="badge ${badgeClass(x.status)}">${label(x.status)}</span><small>${fmtDate(x.paidAt||x.createdAt)}</small></td><td>${esc(settleText)}</td><td><div class="row-actions"><button class="text-button detail-button" data-view="payments" data-id="${x.id}">查看详情</button>${firstPending?`<button class="text-button settle-merchant" data-merchant="${firstPending.merchantId}">确认结算</button>`:''}${x.status==='PAID'?`<button class="text-button danger refund-payment" data-id="${x.id}">退款</button>`:''}</div></td></tr>`});return toolbar(items.length,{statusesList:['PENDING','PAID','CANCELLED','REFUNDED']})+table(['支付单','金额','渠道','状态','商家分账','操作'],rows,items.length)}
function findServiceCollab(id){
  const collections=[
    {key:'phoneCardOrders',typeLabel:'电话卡订单',titleKey:'planName'},
    {key:'rechargeOrders',typeLabel:'话费权益',titleKey:'promoId'},
    {key:'broadbandApplications',typeLabel:'双人宽带',titleKey:()=>'双人购卡宽带'},
    {key:'plateApplications',typeLabel:'校园牌照',titleKey:'vehicleModel'}
  ];
  for(const collection of collections){
    const item=(state.data[collection.key]||[]).find(row=>row.id===id);
    if(item)return{...collection,item};
  }
  return null;
}
function serviceCollabTitle(match){
  const title=typeof match.titleKey==='function'?match.titleKey(match.item):match.item[match.titleKey];
  return title||match.typeLabel;
}
function serviceCollabMessages(collab){
  const roleLabels={USER:'用户',MERCHANT:'商家',PLATFORM:'平台'};
  const messages=[...(collab?.messages||[])].reverse().slice(-12);
  if(!messages.length)return '<p class="muted-empty">暂无对话记录</p>';
  return `<div class="timeline">${messages.map(message=>`<div class="timeline-item"><strong>${esc(roleLabels[message.role]||'平台')} · ${esc(message.text||message.note||'消息')}</strong><span>${fmtDate(message.createdAt)}</span></div>`).join('')}</div>`;
}
function serviceCollabBusinessFields(item){
  if(item.planName)return detailItem('套餐',item.planName)+detailItem('金额',money(item.amountInCents))+detailItem('联系电话',item.phone||'—')+detailItem('支付状态',label(item.paymentStatus));
  if(item.receiveInCents)return detailItem('充值金额',money(item.paidInCents))+detailItem('应到账',money(item.receiveInCents))+detailItem('联系电话',item.phone||'—')+detailItem('支付状态',label(item.paymentStatus));
  if(item.ownerPhone)return detailItem('本人号码',item.ownerPhone||'—')+detailItem('同伴号码',item.companionPhone||'—')+detailItem('创建时间',fmtDate(item.createdAt));
  return detailItem('车辆型号',item.vehicleModel||'—')+detailItem('联系电话',item.phone||'—')+detailItem('学号',item.studentNo||'—')+detailItem('材料数量',`${(item.materials||[]).length}/9`);
}
function openServiceCollab(id){
  const match=findServiceCollab(id);
  if(!match)return;
  const {item,typeLabel}=match;
  const collab=item.collaboration||{};
  const intervention=collab.intervention?.status==='REQUESTED';
  document.querySelector('#drawerTitle').textContent=serviceCollabTitle(match);
  document.querySelector('#drawerBody').innerHTML=`
    <div class="detail-section"><h3>服务单信息</h3><div class="detail-grid">
      ${detailItem('业务',typeLabel)}
      ${detailItem('当前状态',label(item.status))}
      ${serviceCollabBusinessFields(item)}
      ${detailItem('创建时间',fmtDate(item.createdAt))}
      ${detailItem('更新时间',fmtDate(item.updatedAt||item.createdAt))}
    </div></div>
    <div class="detail-section"><h3>协同状态</h3><div class="detail-grid">
      ${detailItem('平台协助',intervention?'待平台处理':'无需介入')}
      ${detailItem('处理说明',collab.intervention?.note||'—')}
      ${detailItem('最后更新',fmtDate(collab.intervention?.updatedAt||item.updatedAt||item.createdAt))}
    </div></div>
    <div class="detail-section"><h3>用户与平台对话</h3>${serviceCollabMessages(collab)}</div>
    <div class="detail-section"><h3>处置动作</h3><div class="row-actions">
      <button class="text-button service-collab" data-id="${esc(item.id)}" data-action="NOTE">回复用户</button>
      <button class="text-button service-collab" data-id="${esc(item.id)}" data-action="${intervention?'RESOLVE':'INTERVENE'}">${intervention?'完成处理':'平台介入'}</button>
    </div></div>`;
  toggleDrawer(true);
}
function notifications(){
  const items=(state.data.notifications||[]).filter(match);
  const rows=items.slice(0,80).map(x=>`<tr><td><strong>${esc(x.title)}</strong><small>${esc(x.type)}</small></td><td>${esc(x.content)}</td><td><span class="badge ${x.read?'green':'orange'}">${x.read?'已读':'未读'}</span></td><td>${fmtDate(x.createdAt)}</td></tr>`).join('');
  const stats=state.data.subscribeStats||{queued:0,sent:0,failed:0};
  const messages=(state.data.subscribeMessages||[]).filter(match).slice(0,50);
  const queueRows=messages.map(x=>`<tr><td><strong>${esc(x.title)}</strong><small>${esc(x.templateId)}</small></td><td>${esc(x.content)}</td><td><span class="badge ${x.status==='SENT'?'green':x.status==='FAILED'?'red':'orange'}">${x.status==='SENT'?'已发送':x.status==='FAILED'?'发送失败':'待发送'}</span>${x.error?`<small>${esc(x.error)}</small>`:''}</td><td>${fmtDate(x.createdAt)}</td><td>${fmtDate(x.sentAt)}</td><td>${x.status==='FAILED'?`<button class="text-button retry-subscribe" data-id="${esc(x.id)}">重试</button>`:''}</td></tr>`).join('');
  return `<div class="metric-grid">${metric('待发送',stats.queued||0,'商家与用户提醒队列')}${metric('已发送',stats.sent||0,'微信已确认')}${metric('失败',stats.failed||0,'可修正配置后重试')}${metric('订阅用户',(state.data.orderMessageSubscribers||0)+(state.data.serviceMessageSubscribers||0),'订单与服务分提醒')}</div>
  <section class="panel"><div class="panel-head"><h2>订阅消息队列</h2><span>服务分、预警与订单进度提醒</span></div>
    <div class="page-actions"><p>仅发送已配置模板的消息，失败原因会保留在队列中。</p><div><button id="dispatchSubscribe" class="primary">派发前 20 条</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>消息</th><th>内容</th><th>发送状态</th><th>创建时间</th><th>发送时间</th><th>操作</th></tr></thead><tbody>${queueRows||'<tr><td colspan="6" class="empty">暂无订阅消息</td></tr>'}</tbody></table></div>
  </section>` + toolbar(items.length)+table(['通知','内容','状态','时间'],rows,items.length);
}
function finance(){const f=state.data.financeSummary||{paymentInCents:0,refundOutCents:0,payoutOutCents:0,netInCents:0};const items=(state.data.financeEvents||[]).filter(match).filter(x=>state.status==='ALL'||x.eventType===state.status).slice(0,100);const rows=items.map(x=>`<tr><td><strong>${esc(financeTypeLabels[x.eventType]||x.eventType)}</strong><small>${esc(x.referenceId)}</small></td><td>${money(x.amountInCents)}</td><td>${esc(x.merchantName||'平台自营')}</td><td>${esc(x.orderNo||x.paymentNo||'—')}</td><td>${esc(x.settlementReference||'—')}</td><td>${fmtDate(x.createdAt)}</td></tr>`);return `<div class="metric-grid">${metric('支付收入',money(f.paymentInCents),'累计支付单入账')}${metric('退款支出',money(f.refundOutCents),'累计退款冲减')}${metric('商家打款',money(f.payoutOutCents),'累计结算出账')}${metric('资金净额',money(f.netInCents),'支付 - 退款 - 打款',true)}</div>`+toolbar(items.length,{statusesList:['PAYMENT','REFUND','PAYOUT']})+table(['类型','金额','商家','关联单据','打款凭证','时间'],rows,items.length)}
function phones(){const items=state.data.phoneCardOrders.filter(match).filter(statusMatch);const rows=items.map(x=>`<tr><td><strong>${esc(x.customerName)}</strong><small>${esc(x.phone)}</small></td><td>${esc(x.planName)}</td><td>${money(x.amountInCents)}</td><td><span class="badge ${badgeClass(x.status)}">${label(x.status)}</span><small>${label(x.paymentStatus)}</small></td><td>${statusControl('phones',x)}</td><td><button class="text-button detail-button" data-view="phones" data-id="${x.id}">办理详情</button></td></tr>`);return toolbar(items.length,{statusesList:options.phones})+table(['用户','套餐','金额','状态/支付','办理操作','详情'],rows,items.length)}
function recharges(){const items=state.data.rechargeOrders.filter(match).filter(statusMatch);const rows=items.map(x=>`<tr><td><strong>${esc(x.id)}</strong><small>${esc(x.phone)}</small></td><td>${money(x.paidInCents)}</td><td>${money(x.receiveInCents)}</td><td><span class="badge ${badgeClass(x.status)}">${label(x.status)}</span><small>${label(x.paymentStatus)}</small></td><td>${statusControl('recharges',x)}</td><td><button class="text-button detail-button" data-view="recharges" data-id="${x.id}">查看</button></td></tr>`);return toolbar(items.length,{statusesList:options.recharges})+table(['权益订单','实付','应到账','状态/支付','到账处理','详情'],rows,items.length)}
function broadband(){const items=state.data.broadbandApplications.filter(match).filter(statusMatch);const rows=items.map(x=>`<tr><td><strong>${esc(x.ownerPhone)}</strong></td><td>${esc(x.companionPhone)}</td><td>${fmtDate(x.createdAt)}</td><td><span class="badge ${badgeClass(x.status)}">${label(x.status)}</span></td><td>${statusControl('broadband',x)}</td><td><button class="text-button detail-button" data-view="broadband" data-id="${x.id}">资格详情</button></td></tr>`);return toolbar(items.length,{statusesList:options.broadband})+table(['主申请号码','同伴号码','申请时间','状态','资格审核','详情'],rows,items.length)}
function plates(){const items=state.data.plateApplications.filter(match).filter(statusMatch);const rows=items.map(x=>{const payStatus={UNPAID:'未支付',PAID:'模拟支付成功',CANCELLED:'支付已取消',EXPIRED:'支付超时',REFUNDED:'已退款'}[x.paymentStatus]||'—';return `<tr><td><strong>${esc(x.customerName)}</strong><small>学号 ${esc(x.studentNo||'未填写')} · ${esc(x.id)}</small></td><td>${esc(x.vehicleModel)}<small>材料 ${(x.materials||[]).length}/9</small></td><td>${x.source==='PLATFORM_ORDER'?'平台购车':'自带车辆'}</td><td>${x.feeInCents?money(x.feeInCents):'免费'}<small>${esc(payStatus)}</small></td><td>${statusControl('plates',x)}</td><td><button class="text-button detail-button" data-view="plates" data-id="${x.id}">办理详情</button></td></tr>`});return toolbar(items.length,{statusesList:options.plates})+table(['用户/学号','车辆/材料','来源','服务费/支付','办理进度','详情'],rows,items.length)}
function afterSales(){const items=state.data.afterSales.filter(match).filter(statusMatch);const rows=items.map(x=>`<tr><td><strong>${esc(x.id)}</strong><small>${esc(x.orderId)}</small></td><td>${esc(x.typeLabel||x.type)}<small>图片 ${(x.images||[]).length}/9</small></td><td>${esc(x.reason)}</td><td>${fmtDate(x.createdAt)}</td><td>${statusControl('afterSales',x)}</td><td><button class="text-button detail-button" data-view="afterSales" data-id="${x.id}">工单详情</button></td></tr>`);return toolbar(items.length,{statusesList:options.afterSales})+table(['售后单','类型','原因','创建时间','处理状态','详情'],rows,items.length)}
function logs(){const items=state.data.auditLogs.filter(match);const rows=items.map(x=>`<tr><td><strong>${esc(x.action)}</strong><small>${esc(x.id)}</small></td><td>${esc(x.operator)}</td><td>${esc(x.target)}</td><td>${fmtDate(x.createdAt)}</td></tr>`);return toolbar(items.length)+table(['操作','操作人','对象','时间'],rows,items.length)}
const settingFieldLabels={brandName:'品牌名称',schoolName:'学校名称',campusName:'校区名称',servicePhone:'客服电话',serviceWechat:'客服微信',externalPlateFeeInCents:'自带车上牌服务费',deliveryFeeInCents:'校内配送费',commissionRatePercent:'平台佣金比例',deliveryResponseHours:'配送响应承诺',plateResponseHours:'上牌响应承诺',afterSaleResponseHours:'售后响应承诺',afterSaleResolutionHours:'售后处理时限',phoneCardActivationHours:'电话卡激活时限',rechargeCreditHours:'话费到账时限',broadbandVerifyHours:'宽带核验时限',payoutReviewHours:'提现审核时限',leadResponseHours:'线索跟进时限',patrolIntervalMinutes:'运营巡检间隔',lowStockThreshold:'低库存提醒阈值',serviceScoreLimitedThreshold:'服务分限流阈值',serviceScoreRestrictedThreshold:'服务分暂停上新阈值',productComplianceLowReviewThreshold:'低分下架阈值',productComplianceReviewSampleThreshold:'均分样本量阈值',productComplianceAverageRatingThreshold:'均分下架阈值',paymentTimeoutMinutes:'待支付自动关闭',settlementPeriodDays:'商家结算账期',payoutMinimumInCents:'商家起提金额',deliveryTimeSlots:'配送时段',platformNotice:'平台提示语'};
function formatSettingValue(field,value){if(value===undefined||value===null||value==='')return '未设置';if(field.endsWith('InCents'))return money(Number(value));if(field==='commissionRatePercent')return `${value}%`;if(field.endsWith('Hours'))return `${value}小时`;if(field.endsWith('Minutes'))return `${value}分钟`;if(field.endsWith('Days'))return `${value}天`;if(Array.isArray(value))return value.join(' / ');return value}
function renderSettingChangeText(log){const changes=log.changes||[];const visible=changes.slice(0,3).map(change=>`${settingFieldLabels[change.field]||change.field}：${formatSettingValue(change.field,change.before)} → ${formatSettingValue(change.field,change.after)}`);return visible.join('；')+(changes.length>3?`；等 ${changes.length} 项变更`:'')}
function settings(){const s=state.data.settings;const slots=Array.isArray(s.deliveryTimeSlots)?s.deliveryTimeSlots.join('\n'):'';return`<div class="settings-grid"><form id="settingsForm" class="settings-form"><h2>基础运营配置</h2><div class="form-grid"><label>品牌名称<input id="settingBrand" value="${esc(s.brandName)}"></label><label>学校名称<input id="settingSchool" value="${esc(s.schoolName)}"></label><label>校区名称<input id="settingCampus" value="${esc(s.campusName)}"></label><label>客服电话<input id="settingPhone" value="${esc(s.servicePhone)}"></label><label>客服微信<input id="settingWechat" value="${esc(s.serviceWechat)}"></label><label>平台佣金比例（%）<input id="settingCommission" type="number" min="0" max="50" step="1" value="${s.commissionRatePercent ?? 2}"></label><label>自带车上牌服务费（元）<input id="settingPlateFee" type="number" value="${s.externalPlateFeeInCents/100}"></label><label>校内配送费（元）<input id="settingDeliveryFee" type="number" value="${(s.deliveryFeeInCents || 0)/100}"></label><label>配送响应承诺（小时）<input id="settingDeliveryHours" type="number" value="${s.deliveryResponseHours || 24}"></label><label>上牌响应承诺（小时）<input id="settingPlateHours" type="number" value="${s.plateResponseHours || 48}"></label><label>售后响应承诺（小时）<input id="settingAfterSaleHours" type="number" value="${s.afterSaleResponseHours || 24}"></label><label>售后处理时限（小时）<input id="settingAfterSaleResolutionHours" type="number" value="${s.afterSaleResolutionHours || 72}"></label><label>待支付自动关闭（分钟）<input id="settingPaymentTimeout" type="number" min="5" max="1440" value="${s.paymentTimeoutMinutes || 30}"></label><label>商家结算账期（天）<input id="settingSettlementPeriod" type="number" min="0" max="60" value="${s.settlementPeriodDays ?? 7}"></label><label>商家起提金额（元）<input id="settingPayoutMinimum" type="number" min="0" max="10000" step="1" value="${((s.payoutMinimumInCents ?? 10000)/100)}"></label><label>电话卡激活时限（小时）<input id="settingPhoneCardHours" type="number" min="1" max="168" value="${s.phoneCardActivationHours || 24}"></label><label>话费到账时限（小时）<input id="settingRechargeHours" type="number" min="1" max="168" value="${s.rechargeCreditHours || 12}"></label><label>宽带核验时限（小时）<input id="settingBroadbandHours" type="number" min="1" max="168" value="${s.broadbandVerifyHours || 48}"></label><label>提现审核时限（小时）<input id="settingPayoutReviewHours" type="number" min="1" max="168" value="${s.payoutReviewHours || 48}"></label><label>线索跟进时限（小时）<input id="settingLeadHours" type="number" min="1" max="168" value="${s.leadResponseHours || 24}"></label><label>运营巡检间隔（分钟）<input id="settingPatrolInterval" type="number" min="1" max="1440" value="${s.patrolIntervalMinutes || 10}"></label><label>低库存提醒阈值（件）<input id="settingLowStock" type="number" min="0" max="999" value="${s.lowStockThreshold ?? 10}"></label><label>服务分限流阈值（分）<input id="settingScoreLimited" type="number" min="50" max="100" value="${s.serviceScoreLimitedThreshold ?? 80}"></label><label>服务分暂停上新阈值（分）<input id="settingScoreRestricted" type="number" min="0" max="100" value="${s.serviceScoreRestrictedThreshold ?? 60}"></label><label>低分下架阈值（条）<input id="settingLowReviewLimit" type="number" min="1" max="20" value="${s.productComplianceLowReviewThreshold ?? 3}"></label><label>均分样本量阈值（条）<input id="settingReviewSampleLimit" type="number" min="2" max="20" value="${s.productComplianceReviewSampleThreshold ?? 3}"></label><label>均分下架阈值（分）<input id="settingAverageRatingLimit" type="number" min="1" max="4.5" step="0.1" value="${s.productComplianceAverageRatingThreshold ?? 3.5}"></label></div><label>平台提示语<textarea id="settingNotice" rows="2">${esc(s.platformNotice || '')}</textarea></label><label>配送时段（每行一个）<textarea id="settingSlots" rows="5">${esc(slots)}</textarea></label><div class="settings-actions"><button class="primary" type="submit">保存配置</button></div></form><aside class="settings-help"><h2>上线前配置提醒</h2><p>业务规则保存后立即影响用户端承诺与订单结算。</p><ul><li>佣金比例只影响新支付订单，历史分账费率保持留痕</li><li>微信支付商户与退款权限</li><li>运营商真实套餐和活动期限</li><li>校园车辆登记材料清单</li><li>配送范围、时段和售后SLA</li><li>隐私政策与数据保存期限</li></ul></aside></div>`}

function merchants(){const q=state.query.toLowerCase();const items=(state.data.merchants||[]).filter(x=>!q||`${x.name} ${x.ownerName} ${x.phone}`.toLowerCase().includes(q));const rows=items.map(x=>`<tr><td><strong>${esc(x.name)}</strong><small>${fmtDate(x.createdAt)}</small></td><td>${esc(x.ownerName)}<small>${esc(x.phone)}</small></td><td>${esc(merchantTypeLabels[x.merchantType]||'个体工商户')}</td><td>${esc(merchantCategoryLabels[x.category]||x.category)}<small>${esc(x.serviceArea||'')}</small></td><td><span class="badge ${badgeClass(x.status)}">${label(x.status)}</span><small>${x.settlementAccountMasked?'收款账户已登记':'收款账户缺失'}</small>${x.licenseUrl?`<a class="license-link" href="${esc(x.licenseUrl)}" target="_blank">查看执照</a>`:''}</td><td><div class="row-actions"><button class="text-button detail-button" data-view="merchants" data-id="${x.id}">审核详情</button><button class="text-button" data-merchant="${x.id}" data-status="APPROVED" ${x.status==='APPROVED'?'disabled':''}>通过</button><button class="text-button danger" data-merchant="${x.id}" data-status="REJECTED" ${x.status==='REJECTED'?'disabled':''}>驳回</button></div></td></tr>`);return toolbar(items.length)+table(['商家','联系人','主体类型','类目/区域','资质','操作'],rows,items.length)}
function render(){document.querySelector('#pageTitle').textContent=titles[state.view];document.querySelector('#breadcrumb').textContent=titles[state.view];const views={dashboard,merchants,leads,products,promos,reviews,orders,payments,phones,recharges,finance,serviceCollabs,settlements:settlementsView,payouts:payoutsView,patrol:patrolView,scores:scoresView,broadband,plates,afterSales,notifications,logs,settings};document.querySelector('#content').innerHTML=views[state.view]();bindView()}
function bindView(){document.querySelector('#listSearch')?.addEventListener('input',e=>{state.query=e.target.value;render();document.querySelector('#listSearch')?.focus()});document.querySelector('#statusFilter')?.addEventListener('change',e=>{state.status=e.target.value;render()});document.querySelector('#addProduct')?.addEventListener('click',()=>openProduct());document.querySelectorAll('.edit-product').forEach(b=>b.addEventListener('click',()=>openProduct(state.data.products.find(p=>p.id===b.dataset.id))));document.querySelector('#addPromo')?.addEventListener('click',()=>openPromo());document.querySelectorAll('.edit-promo').forEach(b=>b.addEventListener('click',()=>openPromo((state.data.rechargePromos||[]).find(p=>p.id===b.dataset.id))));document.querySelectorAll('.toggle-promo').forEach(b=>b.addEventListener('click',async()=>{const promo=(state.data.rechargePromos||[]).find(p=>p.id===b.dataset.id);if(!promo)return;await api('/api/admin/recharge-promos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...promo,payInCents:promo.pay*100,receiveInCents:promo.receive*100,active:b.dataset.active==='true'})});showToast('活动状态已更新');await load()}));document.querySelectorAll('.save-status').forEach(b=>b.addEventListener('click',()=>saveStatus(b)));document.querySelectorAll('[data-merchant]').forEach(b=>b.addEventListener('click',async()=>{const status=b.dataset.status;const note=status==='REJECTED'?prompt('请填写驳回原因')||'资质材料不符合要求':prompt('请填写审核备注','资质信息已核对')||'';await api(`/api/admin/merchants/${b.dataset.merchant}/status`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status,reviewNote:note})});showToast('商家状态已更新');await load()}));document.querySelectorAll('.detail-button').forEach(b=>b.addEventListener('click',()=>openDetail(b.dataset.view,b.dataset.id)));document.querySelector('#exportButton')?.addEventListener('click',exportCurrent);document.querySelector('#settingsForm')?.addEventListener('submit',saveSettings);document.querySelectorAll('[data-goto]').forEach(x=>x.addEventListener('click',()=>goView(x.dataset.goto)))}
function bindCollab(){document.querySelectorAll('.platform-collab').forEach(b=>b.addEventListener('click',async()=>{const action=b.dataset.action;const note=prompt(action==='INTERVENE'?'请填写平台介入说明':'请填写平台处理结果',action==='INTERVENE'?'已联系商家和用户，核实订单问题。':'已确认解决方案，订单继续履约。');if(!note)return;await api('/api/order-collab',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'PLATFORM',action,orderId:b.dataset.id,note})});showToast('平台协同已记录');await load()}))}
const baseBindServiceCollab=bindView;
bindView=function(){baseBindServiceCollab();document.querySelectorAll('.service-detail').forEach(b=>b.addEventListener('click',()=>openServiceCollab(b.dataset.id)));document.querySelectorAll('.service-collab').forEach(b=>b.addEventListener('click',async()=>{const action=b.dataset.action;const note=prompt(action==='INTERVENE'?'填写平台处理说明，将同步给用户':action==='NOTE'?'回复用户内容，将同步到服务单对话':'填写处理结论，将通知用户',action==='INTERVENE'?'已收到服务单咨询，正在与用户确认办理信息。':action==='NOTE'?'已收到您的咨询，正在为您跟进。':'已与用户确认，服务单继续跟进。');if(!note)return;await api('/api/order-collab',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'PLATFORM',action,orderId:b.dataset.id,note})});showToast('服务单协同已记录');await load();if(state.view==='serviceCollabs')openServiceCollab(b.dataset.id)}))};
const originalBindView=bindView;
function bindPayments(){document.querySelectorAll('.refund-payment').forEach(b=>b.addEventListener('click',async()=>{const note=prompt('请填写退款备注','已与用户确认退款');if(note===null)return;await api(`/api/admin/payment-orders/${b.dataset.id}/refund`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note})});showToast('退款已完成');await load()}))}
bindPayments=function(parent=document){document.querySelectorAll('.refund-payment').forEach(b=>b.addEventListener('click',async()=>{const note=prompt('请填写退款备注','已与用户确认退款');if(note===null)return;await api(`/api/admin/payment-orders/${b.dataset.id}/refund`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note})});showToast('退款已完成');await load()}));parent.querySelectorAll('.settle-merchant').forEach(b=>b.addEventListener('click',async()=>{const merchant=(state.data.merchants||[]).find(x=>x.id===b.dataset.merchant);const account=merchant?.settlementAccount?`${merchant.settlementBank||''} ${merchant.settlementAccountName||merchant.name} ${merchant.settlementAccount}`:'请人工核对商家收款信息';const reference=prompt(`请确认已完成线下打款：\n${account}\n\n填写打款凭证/备注`,account==='请人工核对商家收款信息'?'':'平台线下打款');if(reference===null)return;await api(`/api/admin/merchants/${b.dataset.merchant}/settle`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reference})});showToast('商家分账已确认结算');await load()}))};
bindView=function(){originalBindView();bindCollab();bindPayments()};
async function saveStatus(button){
  const select=document.querySelector(`select[data-view="${button.dataset.view}"][data-id="${button.dataset.id}"]`);
  const payload={status:select.value};
  if(button.dataset.view==='orders'){
    const order=(state.data.orders||[]).find((row)=>row.id===button.dataset.id);
    if(select.value==='COMPLETED'&&!order?.deliveryCode){
      const completionNote=prompt('平台代履约需留痕。请填写核验依据（至少 8 字），例如：线下确认已收车并核对车辆编号','平台线下核验完成');
      if(!completionNote||completionNote.trim().length<8)return showToast('请填写至少 8 字核验依据');
      payload.completionNote=completionNote.trim();
    }else if(select.value==='COMPLETED'){
      const deliveryCode=prompt('请输入用户 6 位交付码');
      if(!deliveryCode)return showToast('已取消，请输入交付码');
      payload.deliveryCode=deliveryCode.trim();
    }
  }
  if(button.dataset.view==='afterSales'&&select.value==='CLOSED'){
    const resolutionNote=prompt('请填写售后处理结论（必填）','已与用户确认并完成处理');
    if(!resolutionNote?.trim())return showToast('请先填写处理结论');
    payload.resolutionNote=resolutionNote.trim();
  }
  await api(`/api/admin/${endpointTypes[button.dataset.view]}/${button.dataset.id}/status`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  showToast('业务状态已更新');await load();
}
function goView(view){state.view=view;state.query='';state.status='ALL';document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===view));render()}
function detailItem(labelText,value){return value===undefined||value===null||value===''?'':`<div class="detail-item"><small>${esc(labelText)}</small><strong>${esc(value)}</strong></div>`}
function renderCollabTimeline(collab){
  const events=(collab?.handoffs||[]).slice(0,8);
  if(!events.length)return '<p class="muted-empty">暂无履约轨迹</p>';
  const roleLabels={USER:'用户',MERCHANT:'商家',PLATFORM:'平台'};
  return `<div class="timeline">${events.map(event=>`<div class="timeline-item"><strong>${esc(roleLabels[event.role]||'平台')} · ${esc(event.note||event.action||'状态更新')}</strong><span>${fmtDate(event.createdAt)}</span></div>`).join('')}</div>`;
}
function orderDeliveryRows(order){
  if(order.fulfillment?.type!=='DELIVERY')return '';
  return `<div class="detail-section"><h3>配送资料</h3><div class="detail-grid">${detailItem('联系人',order.fulfillment.contactName||'未填写')}${detailItem('联系电话',order.fulfillment.contactPhone||'未填写')}${detailItem('期望时间',order.fulfillment.date||'尽快配送')}${detailItem('校内地址',order.fulfillment.address||'未填写')}</div></div>`;
}
function plateMaterialGallery(view,item){
  if(view!=="plates"||!Array.isArray(item.materials)||!item.materials.length)return '';
  return `<div class="detail-section"><h3>牌照材料</h3><div class="material-grid">${item.materials.map(material=>`<a href="${esc(material.url)}" target="_blank"><img src="${esc(material.url)}" alt="牌照材料"><small>${fmtDate(material.uploadedAt)}</small></a>`).join('')}</div></div>`;
}
function openDetail(view,id){const key=view==="products"?"products":collections[view];const item=view==="merchants"?(state.data.merchants||[]).find(x=>x.id===id):state.data[key]?.find(x=>x.id===id);if(!item)return;const labels={application:"入驻申请",merchantName:"商家名称",applicationNo:"申请编号",type:"主体类型",category:"经营类目",contact:"联系人",phone:"联系电话",area:"服务区域",intro:"店铺简介",qualification:"资质材料",licenseNo:"营业执照编号",personalNoLicense:"个人身份入驻无需执照",licenseImage:"执照图片",settlement:"结算收款账户",accountName:"收款人",bank:"开户银行",account:"账号",accountReady:"已登记",accountMissing:"未登记",identity:"实名核验",status:"核验状态",verified:"已通过模拟实名核验",unverified:"未完成实名核验",owner:"申请人姓名",id:"身份证号",time:"核验时间",conclusion:"核验结论",verifiedNote:"身份证号格式与校验码有效，且与申请人姓名匹配",unverifiedNote:"未取得有效实名凭证，不能通过审核",review:"审核信息",currentStatus:"当前状态",reviewNote:"审核备注",timeline:"处理记录",created:"记录创建",baseInfo:"基础信息",openLicense:"打开执照材料"};document.querySelector("#drawerTitle").textContent=view==="products"?item.name:view==="merchants"?(item.applicationNo||item.id):(item.orderNo||item.id);let body="";if(view==="merchants"){const identity=item.identityVerification;const identityVerified=identity?.status==="VERIFIED";const licenseLink=item.licenseUrl?`<a class="license-link" href="${esc(item.licenseUrl)}" target="_blank">${esc(labels.openLicense)}</a>`:"";body=`<div class="detail-section"><h3>${esc(labels.application)}</h3><div class="detail-grid">${detailItem(labels.merchantName,item.name)}${detailItem(labels.applicationNo,item.applicationNo)}${detailItem(labels.type,merchantTypeLabels[item.merchantType]||item.merchantType)}${detailItem(labels.category,merchantCategoryLabels[item.category]||item.category)}${detailItem(labels.contact,item.ownerName)}${detailItem(labels.phone,item.phone)}${detailItem(labels.area,item.serviceArea)}${detailItem(labels.intro,item.description)}${detailItem(labels.accountName,item.settlementAccountName)}${detailItem(labels.bank,item.settlementBank)}${detailItem(labels.account,item.settlementAccountMasked||labels.accountMissing)}</div></div><div class="detail-section"><h3>${esc(labels.qualification)}</h3><div class="detail-grid">${detailItem(labels.licenseNo,item.licenseNo||labels.personalNoLicense)}${item.licenseUrl?`<div class="detail-item"><small>${esc(labels.licenseImage)}</small><strong>${licenseLink}</strong></div>`:""}</div></div><div class="detail-section"><h3>${esc(labels.identity)}</h3><div class="detail-grid"><div class="detail-item"><small>${esc(labels.status)}</small><strong class="${identityVerified?"green":""}">${esc(identityVerified?labels.verified:labels.unverified)}</strong></div>${detailItem(labels.owner,identity?.ownerNameMasked)}${detailItem(labels.id,identity?.idNumberMasked)}${detailItem(labels.time,identity?.verifiedAt?fmtDate(identity.verifiedAt):"")}<div class="detail-item"><small>${esc(labels.conclusion)}</small><strong>${esc(identityVerified?labels.verifiedNote:labels.unverifiedNote)}</strong></div></div></div>`;}else{body=`<div class="detail-section"><h3>${esc(labels.baseInfo)}</h3><div class="detail-grid">${Object.entries(item).filter(([,v])=>typeof v!=="object").slice(0,10).map(([k,v])=>`<div class="detail-item"><small>${esc(k)}</small><strong>${esc(k.toLowerCase().includes("cents")?money(v):k.toLowerCase().includes("at")?fmtDate(v):label(v))}</strong></div>`).join("")}</div></div>`;}const review=`<div class="detail-section"><h3>${esc(labels.review)}</h3><div class="detail-grid">${detailItem(labels.currentStatus,label(item.status))}${detailItem(labels.reviewNote,item.reviewNote||"")}</div></div>`;const timeline=(item.timeline||[]).length?`<div class="detail-section"><h3>${esc(labels.timeline)}</h3><div class="timeline">${item.timeline.map(entry=>`<div class="timeline-item"><strong>${esc(label(entry.status))} / ${esc(entry.note)}</strong><span>${fmtDate(entry.createdAt)}</span></div>`).join("")}</div></div>`:`<div class="detail-section"><h3>${esc(labels.timeline)}</h3><div class="timeline"><div class="timeline-item"><strong>${esc(labels.created)}</strong><span>${fmtDate(item.createdAt)}</span></div><div class="timeline-item"><strong>${esc(labels.currentStatus)}\uFF1A${esc(label(item.status))}</strong><span>${fmtDate(item.updatedAt||item.createdAt)}</span></div></div></div>`;document.querySelector("#drawerBody").innerHTML=body+plateMaterialGallery(view,item)+review+timeline;toggleDrawer(true)}
function toggleDrawer(show){document.querySelector('#drawer').classList.toggle('hidden',!show);document.querySelector('#drawerBackdrop').classList.toggle('hidden',!show)}
function openProduct(product){document.querySelector('#modalTitle').textContent=product?'编辑商品':'新增商品';document.querySelector('#productId').value=product?.id||'';document.querySelector('#productName').value=product?.name||'';document.querySelector('#productCategory').value=product?.category||'E_BIKE_NEW';document.querySelector('#productPrice').value=product?product.priceInCents/100:'';document.querySelector('#productStock').value=product?.stock??'';document.querySelector('#productDescription').value=product?.description||'';document.querySelector('#productImageUrl').value=product?.imageUrl||'';document.querySelector('#productActive').checked=product?.active!==false;toggleModal(true)}
function toggleModal(show){document.querySelector('#productModal').classList.toggle('hidden',!show);document.querySelector('#modalBackdrop').classList.toggle('hidden',!show)}
function openPromo(promo){document.querySelector('#promoModalTitle').textContent=promo?'编辑活动':'新增活动';document.querySelector('#promoId').value=promo?.id||'';document.querySelector('#promoPay').value=promo?.pay||'';document.querySelector('#promoReceive').value=promo?.receive||'';document.querySelector('#promoBadge').value=promo?.badge||'限时优惠';document.querySelector('#promoActive').checked=promo?promo.active!==false:true;togglePromoModal(true)}
function togglePromoModal(show){document.querySelector('#promoModal').classList.toggle('hidden',!show);document.querySelector('#modalBackdrop').classList.toggle('hidden',!show)}
async function savePromo(event){event.preventDefault();const id=document.querySelector('#promoId').value;const payload={id:id||undefined,payInCents:Math.round(Number(document.querySelector('#promoPay').value)*100),receiveInCents:Math.round(Number(document.querySelector('#promoReceive').value)*100),badge:document.querySelector('#promoBadge').value,active:document.querySelector('#promoActive').checked};await api('/api/admin/recharge-promos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});togglePromoModal(false);showToast(id?'活动已更新':'活动已创建');await load()}
async function saveProduct(event){event.preventDefault();const id=document.querySelector('#productId').value;const payload={name:document.querySelector('#productName').value,category:document.querySelector('#productCategory').value,priceInCents:Math.round(Number(document.querySelector('#productPrice').value)*100),stock:Number(document.querySelector('#productStock').value),description:document.querySelector('#productDescription').value,imageUrl:document.querySelector('#productImageUrl').value.trim(),active:document.querySelector('#productActive').checked};await api(id?`/api/admin/products/${id}`:'/api/admin/products',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});toggleModal(false);showToast(id?'商品已更新':'商品已创建');await load()}
async function saveSettings(event){event.preventDefault();await api('/api/admin/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brandName:document.querySelector('#settingBrand').value,schoolName:document.querySelector('#settingSchool').value,campusName:document.querySelector('#settingCampus').value,servicePhone:document.querySelector('#settingPhone').value,serviceWechat:document.querySelector('#settingWechat').value,commissionRatePercent:Number(document.querySelector('#settingCommission').value),externalPlateFeeInCents:Math.round(Number(document.querySelector('#settingPlateFee').value)*100),deliveryFeeInCents:Math.round(Number(document.querySelector('#settingDeliveryFee').value)*100),deliveryResponseHours:Number(document.querySelector('#settingDeliveryHours').value),plateResponseHours:Number(document.querySelector('#settingPlateHours').value),afterSaleResponseHours:Number(document.querySelector('#settingAfterSaleHours').value),afterSaleResolutionHours:Number(document.querySelector('#settingAfterSaleResolutionHours').value),paymentTimeoutMinutes:Number(document.querySelector('#settingPaymentTimeout').value),settlementPeriodDays:Number(document.querySelector('#settingSettlementPeriod').value),payoutMinimumInCents:Math.round(Number(document.querySelector('#settingPayoutMinimum').value)*100),phoneCardActivationHours:Number(document.querySelector('#settingPhoneCardHours').value),rechargeCreditHours:Number(document.querySelector('#settingRechargeHours').value),broadbandVerifyHours:Number(document.querySelector('#settingBroadbandHours').value),payoutReviewHours:Number(document.querySelector('#settingPayoutReviewHours').value),leadResponseHours:Number(document.querySelector('#settingLeadHours').value),patrolIntervalMinutes:Number(document.querySelector('#settingPatrolInterval').value),lowStockThreshold:Number(document.querySelector('#settingLowStock').value),serviceScoreLimitedThreshold:Number(document.querySelector('#settingScoreLimited').value),serviceScoreRestrictedThreshold:Number(document.querySelector('#settingScoreRestricted').value),productComplianceLowReviewThreshold:Number(document.querySelector('#settingLowReviewLimit').value),productComplianceReviewSampleThreshold:Number(document.querySelector('#settingReviewSampleLimit').value),productComplianceAverageRatingThreshold:Number(document.querySelector('#settingAverageRatingLimit').value),deliveryTimeSlots:document.querySelector('#settingSlots').value.split(/\r?\n/),platformNotice:document.querySelector('#settingNotice').value})});showToast('运营配置已保存');await load()}
function exportCurrent(){const key=state.view==='products'?'products':collections[state.view];if(!key){showToast('当前页面无需导出');return}const items=state.data[key];if(!items?.length){showToast('暂无可导出数据');return}const headers=[...new Set(items.flatMap(Object.keys))];const csv=[headers.join(','),...items.map(item=>headers.map(h=>`"${String(typeof item[h]==='object'?JSON.stringify(item[h]):item[h]??'').replace(/"/g,'""')}"`).join(','))].join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`狮山智生活-${titles[state.view]}-${Date.now()}.csv`;a.click();URL.revokeObjectURL(a.href);showToast('CSV 已导出')}
async function exportOperationsReport(){try{const response=await fetch('/api/admin/operations-report/export',{headers:authHeaders()});if(response.status===401){logout();return}if(!response.ok)throw new Error('导出失败');const blob=await response.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`狮山智生活-经营日报-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href);showToast('经营日报已导出')}catch(error){showToast(error.message)}}
function showToast(msg){const t=document.querySelector('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}

document.querySelector('#loginForm').addEventListener('submit',e=>{e.preventDefault();login(document.querySelector('#username').value,document.querySelector('#password').value).catch(err=>showToast(err.message))});document.querySelector('#logoutButton').addEventListener('click',logout);document.querySelector('#nav').addEventListener('click',e=>{const b=e.target.closest('.nav-item');if(b)goView(b.dataset.view)});document.querySelector('#refreshButton').addEventListener('click',()=>load().catch(e=>showToast(e.message)));document.querySelector('#globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){state.query=e.target.value;render()}});document.querySelector('#closeDrawer').addEventListener('click',()=>toggleDrawer(false));document.querySelector('#drawerBackdrop').addEventListener('click',()=>toggleDrawer(false));document.querySelector('#closeModal').addEventListener('click',()=>toggleModal(false));document.querySelector('#cancelModal').addEventListener('click',()=>toggleModal(false));document.querySelector('#modalBackdrop').addEventListener('click',()=>toggleModal(false));document.querySelector('#productForm').addEventListener('submit',e=>saveProduct(e).catch(err=>showToast(err.message)));
const baseSettingsView=settings;
settings=function(){
  const history=(state.data.settingChangeLogs||[]).slice(0,10);
  const historyPanel=`<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>配置变更记录</h2><span>最近 ${history.length} 次有效保存</span></div><div class="log-list">${history.length?history.map(log=>`<div class="log-item"><div><strong>${esc(log.operator?.displayName||log.operator?.username||'系统')}</strong><p>${esc(renderSettingChangeText(log))}</p></div><small>v${log.version} · ${fmtDate(log.createdAt)}</small></div>`).join(''):'<p class="muted-empty">暂无配置变更</p>'}</div></section>`;
  return baseSettingsView()+historyPanel;
};
if(state.token){showApp();load().catch(()=>logout())}
document.addEventListener('click',(event)=>{if(event.target.closest('#exportOperations'))exportOperationsReport()});

titles.leads='咨询线索';
// 咨询线索只保留四个真实运营阶段；历史状态在展示层归并为“跟进中”。
Object.assign(statuses, { SUBMITTED:'待联系', FOLLOW_UP:'跟进中', COMPLETED:'已完成', INVALID:'无效线索' });
const leadStatuses = ['SUBMITTED','FOLLOW_UP','COMPLETED','INVALID'];
const leadStatusLabels = { SUBMITTED:'待联系', FOLLOW_UP:'跟进中', COMPLETED:'已完成', INVALID:'无效线索' };
const normalizeLeadStatus = s => ['SUBMITTED','FOLLOW_UP','COMPLETED','INVALID'].includes(s) ? s : 'FOLLOW_UP';
const leadStatusClass = s => ({ SUBMITTED:'orange', FOLLOW_UP:'blue', COMPLETED:'green', INVALID:'red' }[normalizeLeadStatus(s)]);
const leadNextStep = lead => {
  const type = `${lead.businessType || ''}${lead.interest || ''}`;
  if (/车|E_BIKE|牌/.test(type)) return '确认车型、报价和宿舍地址；核对合格证、购买凭证，并说明校园牌照材料。';
  if (/话费|充值/.test(type)) return '确认充值号码、金额和活动到账时间，提醒保留客服回复截图。';
  if (/宽带/.test(type)) return '收集两人购卡号码、宿舍楼栋和安装时间，同步宽带安装条件。';
  if (/卡|套餐|电话/.test(type)) return '确认运营商、套餐、月费和实名要求，预约校园办理时间。';
  return '电话确认真实需求、预算和预计办理时间，并记录下一步材料。';
};

function leads(){
  const items = (state.data.leads || []).map(x => ({ ...x, status: normalizeLeadStatus(x.status) })).filter(match).filter(statusMatch);
  const rows = items.map(x => {
    const status = normalizeLeadStatus(x.status);
    const overdue = x.slaDueAt < new Date().toISOString();
    return `<tr><td><strong>${esc(x.leadNo)}</strong><small>${fmtDate(x.createdAt)}</small></td><td><strong>${esc(x.name)}</strong><small>${esc(x.phone)}</small></td><td>${esc(x.businessType)}</td><td>${esc(x.interest)}</td><td><span class="badge ${overdue ? 'red' : 'orange'}">${overdue ? '已超时' : '24小时内'}</span></td><td><span class="badge ${leadStatusClass(status)}">${leadStatusLabels[status]}</span></td><td><div class="row-actions"><button class="text-button lead-open" data-id="${x.id}">跟进</button></div></td></tr>`;
  });
  return toolbar(items.length, { statusesList: leadStatuses }) + table(['编号','客户','业务','意向','时效','状态','操作'], rows, items.length);
}

function openLeadPanel(id){
  const lead = (state.data.leads || []).find(x => x.id === id);
  if (!lead) return;
  const status = normalizeLeadStatus(lead.status);
  const followUps = (lead.followUps || []).slice(0, 5);
  document.querySelector('#drawerTitle').textContent = lead.leadNo || lead.id;
  document.querySelector('#drawerBody').innerHTML = `
    <div class="detail-section"><h3>客户概要</h3><div class="detail-grid">
      <div class="detail-item"><small>客户</small><strong>${esc(lead.name)}</strong></div>
      <div class="detail-item"><small>电话</small><strong>${esc(lead.phone)}</strong></div>
      <div class="detail-item"><small>业务</small><strong>${esc(lead.businessType)}</strong></div>
      <div class="detail-item"><small>意向</small><strong>${esc(lead.interest)}</strong></div>
    </div></div>
    <div class="detail-section"><h3>当前状态</h3>
      <div class="lead-status-line"><span class="badge ${leadStatusClass(status)}">${leadStatusLabels[status]}</span><small>更新于 ${fmtDate(lead.updatedAt || lead.createdAt)}</small></div>
      <div class="lead-status-actions">
        ${leadStatuses.map(s => `<button class="lead-action ${s === status ? 'active' : ''}" data-status="${s}" data-id="${lead.id}" ${s === status ? 'disabled' : ''} title="切换到${leadStatusLabels[s]}">${leadStatusLabels[s]}</button>`).join('')}
      </div>
    </div>
    <div class="detail-section"><h3>下一步建议</h3><div class="next-step">${esc(leadNextStep(lead))}</div>
      <div class="quick-contact"><a href="tel:${esc(lead.phone)}">拨打客户电话</a><button id="copyLeadInfo">复制客户信息</button></div>
    </div>
    <div class="detail-section"><h3>新增跟进记录</h3>
      <textarea id="leadNote" class="lead-note" placeholder="例如：已确认轻风通勤版和校内配送，明天上午回复报价"></textarea>
      <div class="lead-submit-row"><button id="saveContacted" class="lead-action primary">保存跟进记录</button></div>
    </div>
    <div class="detail-section"><h3>最近跟进</h3>${followUps.length ? `<div class="timeline">${followUps.map(f => `<div class="timeline-item"><strong>${esc(f.content)}</strong><span>${esc(f.operator || '运营管理员')} · ${fmtDate(f.createdAt)}</span></div>`).join('')}</div>` : '<p class="muted-empty">暂无跟进记录</p>'}</div>`;
  document.querySelectorAll('.lead-action[data-status]').forEach(btn => btn.addEventListener('click', () => updateLeadStatus(btn.dataset.id, btn.dataset.status)));
  document.querySelector('#saveContacted')?.addEventListener('click', () => saveLeadFollow(lead.id));
  document.querySelector('#copyLeadInfo')?.addEventListener('click', async () => {
    const text = `${lead.name} ${lead.phone}\n${lead.businessType}：${lead.interest || ''}`;
    await navigator.clipboard.writeText(text); showToast('客户信息已复制');
  });
  toggleDrawer(true);
}

async function updateLeadStatus(id, status){
  await api(`/api/admin/leads/${id}`, { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({ status }) });
  showToast('线索状态已更新'); await load(); openLeadPanel(id);
}

async function saveLeadFollow(id){
  const note = document.querySelector('#leadNote')?.value.trim() || '';
  if (!note) return showToast('请先填写联系结果');
  await api(`/api/admin/leads/${id}/follow-ups`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ content:note }) });
  showToast('跟进结果已保存'); await load(); openLeadPanel(id);
}

const leadRenderBeforeActionPanel = render;
render = function(){
  leadRenderBeforeActionPanel();
  document.querySelectorAll('.lead-open').forEach(btn => btn.addEventListener('click', () => openLeadPanel(btn.dataset.id)));
};

const baseOpenDetail = openDetail;
openDetail = function(view, id){
  if(view !== 'orders') return baseOpenDetail(view, id);
  const item = (state.data.orders || []).find(x => x.id === id);
  if(!item) return;
  const merchant = (state.data.merchants || []).find(x => x.id === item.collaboration?.merchantId)?.name || '平台自营';
  const orderItems = (item.items || []).map(orderItem => `${esc(orderItem.name)} × ${orderItem.quantity}`).join('、');
  document.querySelector('#drawerTitle').textContent = item.orderNo || item.id;
  const body = `<div class="detail-section"><h3>订单信息</h3><div class="detail-grid">
    ${detailItem('订单编号', item.orderNo)}
    ${detailItem('商品', orderItems)}
    ${detailItem('商家', merchant)}
    ${detailItem('实付金额', money(item.totalInCents))}
  ${detailItem('支付状态', item.paymentStatus === 'MOCK_SUCCESS' ? '模拟支付成功' : '未支付')}
  ${detailItem('交付码', item.deliveryCode || '—')}
    ${detailItem('创建时间', fmtDate(item.createdAt))}
  </div></div>${orderDeliveryRows(item)}
  <div class="detail-section"><h3>履约轨迹</h3>${renderCollabTimeline(item.collaboration)}</div>`;
  const review = `<div class="detail-section"><h3>审核信息</h3><div class="detail-grid">
    ${detailItem('当前状态', label(item.status))}
    ${detailItem('审核备注', item.reviewNote || '')}
  </div></div>`;
  const timeline = (item.timeline || []).length ? `<div class="detail-section"><h3>处理记录</h3><div class="timeline">
    ${item.timeline.map(entry => `<div class="timeline-item"><strong>${esc(label(entry.status))} / ${esc(entry.note)}</strong><span>${fmtDate(entry.createdAt)}</span></div>`).join('')}
  </div></div>` : `<div class="detail-section"><h3>处理记录</h3><div class="timeline">
    <div class="timeline-item"><strong>记录创建</strong><span>${fmtDate(item.createdAt)}</span></div>
    <div class="timeline-item"><strong>当前状态：${esc(label(item.status))}</strong><span>${fmtDate(item.updatedAt || item.createdAt)}</span></div>
  </div></div>`;
  document.querySelector('#drawerBody').innerHTML = body + review + timeline;
  toggleDrawer(true);
};

const generalOpenDetail = openDetail;
openDetail = function(view, id){
  if(view !== 'afterSales') return generalOpenDetail(view, id);
  const item=(state.data.afterSales || []).find(x=>x.id===id);
  if(!item)return;
  const evidence=Array.isArray(item.images)?item.images:[];
  document.querySelector('#drawerTitle').textContent=item.id;
  const body=`<div class="detail-section"><h3>售后信息</h3><div class="detail-grid">
    ${detailItem('售后单号', item.id)}
    ${detailItem('关联订单', item.orderId)}
    ${detailItem('业务类型', item.typeLabel || item.type)}
    ${detailItem('处理状态', label(item.status))}
    ${detailItem('创建时间', fmtDate(item.createdAt))}
  </div></div>
  <div class="detail-section"><h3>问题描述</h3><p>${esc(item.reason)}</p></div>
  ${evidence.length?`<div class="detail-section"><h3>售后证据（${evidence.length}/9）</h3><div class="material-grid">${evidence.map(url=>`<a href="${esc(url)}" target="_blank"><img src="${esc(url)}" alt="售后证据"></a>`).join('')}</div></div>`:'<div class="detail-section"><h3>售后证据</h3><p class="muted-empty">用户暂未上传图片</p></div>'}
  ${item.resolutionNote?`<div class="detail-section"><h3>处理结论</h3><p>${esc(item.resolutionNote)}</p></div>`:''}`;
  const timeline=`<div class="detail-section"><h3>处理记录</h3><div class="timeline">
    <div class="timeline-item"><strong>工单创建</strong><span>${fmtDate(item.createdAt)}</span></div>
    <div class="timeline-item"><strong>当前状态：${esc(label(item.status))}</strong><span>${fmtDate(item.updatedAt || item.createdAt)}</span></div>
  </div></div>`;
  document.querySelector('#drawerBody').innerHTML=body+timeline;
  toggleDrawer(true);
};

const baseBindViewWithReviewActions = bindView;
bindView = function(){
  baseBindViewWithReviewActions();
  document.querySelectorAll('.toggle-review').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/admin/product-reviews/${button.dataset.id}/visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: button.dataset.visibility })
    });
    showToast('评价状态已更新');
    await load();
  }));
};

document.querySelector('#closePromoModal').addEventListener('click', () => togglePromoModal(false));
document.querySelector('#cancelPromoModal').addEventListener('click', () => togglePromoModal(false));
document.querySelector('#modalBackdrop').addEventListener('click', () => togglePromoModal(false));
document.querySelector('#promoForm').addEventListener('submit', (event) => savePromo(event).catch((error) => showToast(error.message)));

// 商家结算视图：把资金停留在哪个环节讲清楚，避免未交付就打款。
const settlementStageNotes = {
  PENDING_DELIVERY: '等待交付码核验',
  IN_ACCOUNT_PERIOD: '账期内，到期后自动转为可结算',
  PENDING_SETTLE: '可发起线下打款',
  PAYOUT_REQUESTED: '商家已申请提现，等待平台审核',
  FROZEN: '售后处理中，暂停打款',
  SETTLED: '已完成打款',
  REFUNDED: '订单已退款，分账冲销'
};

function settlementsView() {
  const merchantName = (id) => (state.data.merchants || []).find((item) => item.id === id)?.name || '平台自营';
  const summary = state.data.settlementSummary || {};
  const items = (state.data.settlements || [])
    .filter(match)
    .filter((item) => state.status === 'ALL' || item.settlementStatus === state.status);
  const payableByMerchant = new Map();
  for (const item of state.data.settlements || []) {
    if (item.settlementStatus !== 'PENDING_SETTLE') continue;
    payableByMerchant.set(item.merchantId, (payableByMerchant.get(item.merchantId) || 0) + (item.payableAmountInCents || 0));
  }
  const cards = `<div class="metric-grid">
    ${metric('待交付核验', money(summary.pendingDeliveryInCents), '支付完成但未核验交付')}
    ${metric('账期中', money(summary.inAccountPeriodInCents), `账期 ${summary.settlementPeriodDays ?? 7} 天`)}
    ${metric('售后冻结', money(summary.frozenInCents), '售后关闭后自动恢复')}
    ${metric('可结算', money(summary.payableInCents), '可发起线下打款', true)}
    ${metric('提现待审核', money(summary.payoutRequestedInCents), '商家已申请，等待审核')}
    ${metric('已结算', money(summary.settledInCents), '历史累计打款')}
  </div>`;
  const payoutBar = payableByMerchant.size
    ? `<div class="page-actions"><p>以下商家已有可结算金额</p><div>${[...payableByMerchant.entries()].map(([id, amount]) => `<button class="primary settle-merchant" data-merchant="${esc(id)}">${esc(merchantName(id))} ${money(amount)}</button>`).join(' ')}</div></div>`
    : '';
  const rows = items.map((item) => `<tr>
    <td><strong>${esc(item.orderNo || item.orderId)}</strong><small>${esc(item.id)}</small></td>
    <td>${esc(merchantName(item.merchantId))}</td>
    <td>${money(item.amountInCents)}<small>佣金 ${item.commissionRatePercent ?? 2}% · ${money(item.platformFeeInCents)}</small></td>
    <td><strong>${money(item.payableAmountInCents)}</strong></td>
    <td><span class="badge ${settlementBadge(item.settlementStatus)}">${label(item.settlementStatus)}</span><small>${esc(item.frozenReason || settlementStageNotes[item.settlementStatus] || '')}</small></td>
    <td>${item.availableAt ? fmtDate(item.availableAt) : '—'}<small>${item.deliveredAt ? `核验 ${fmtDate(item.deliveredAt)}` : '未核验交付'}</small></td>
    <td>${item.settlementReference ? esc(item.settlementReference) : '—'}<small>${item.settledAt ? fmtDate(item.settledAt) : ''}</small></td>
  </tr>`);
  return cards + payoutBar
    + toolbar(items.length, { statusesList: ['PENDING_DELIVERY', 'IN_ACCOUNT_PERIOD', 'FROZEN', 'PENDING_SETTLE', 'PAYOUT_REQUESTED', 'SETTLED', 'REFUNDED'] })
    + table(['订单', '商家', '成交/佣金', '应结', '资金状态', '可结算时间', '打款凭证'], rows, items.length);
}

function settlementBadge(status) {
  if (status === 'PENDING_SETTLE') return 'green';
  if (status === 'FROZEN' || status === 'REFUNDED') return 'red';
  if (status === 'SETTLED') return 'blue';
  return 'orange';
}

const payoutStatusNotes = {
  PENDING_REVIEW: '商家已申请，等待平台核对收款账户后打款',
  SETTLED: '已完成打款',
  REJECTED: '审核未通过，金额已退回可结算余额',
  CANCELLED: '关联分账进入售后或退款，申请自动关闭'
};

function payoutBadge(status) {
  if (status === 'SETTLED') return 'blue';
  if (status === 'REJECTED' || status === 'CANCELLED') return 'red';
  return 'orange';
}

function payoutsView() {
  const requests = (state.data.payoutRequests || [])
    .filter(match)
    .filter((item) => state.status === 'ALL' || item.status === state.status);
  const all = state.data.payoutRequests || [];
  const sumBy = (status) => all.filter((item) => item.status === status).reduce((total, item) => total + (item.amountInCents || 0), 0);
  const pendingCount = all.filter((item) => item.status === 'PENDING_REVIEW').length;
  const cards = `<div class="metric-grid">
    ${metric('待审核提现', money(sumBy('PENDING_REVIEW')), `${pendingCount} 笔等待处理`, true)}
    ${metric('累计已打款', money(sumBy('SETTLED')), '含平台主动打款')}
    ${metric('已驳回', money(sumBy('REJECTED')), '金额已退回商家余额')}
    ${metric('起提金额', money(state.data.settlementSummary?.payoutMinimumInCents ?? 10000), '低于该金额不能申请')}
  </div>`;
  const rows = requests.map((item) => {
    const actions = item.status === 'PENDING_REVIEW'
      ? `<button class="text-button approve-payout" data-id="${esc(item.id)}">确认打款</button><button class="text-button danger reject-payout" data-id="${esc(item.id)}">驳回</button>`
      : '<span class="muted-empty">已处理</span>';
    return `<tr>
      <td><strong>${esc(item.requestNo)}</strong><small>${fmtDate(item.createdAt)}</small></td>
      <td>${esc(item.merchantName || item.merchantId)}<small>${item.initiatedBy === 'PLATFORM' ? '平台主动打款' : '商家申请'}</small></td>
      <td><strong>${money(item.amountInCents)}</strong><small>${item.settlementCount || 0} 笔分账</small></td>
      <td>${esc(item.accountBank || '—')}<small>${esc(item.accountName || '')} ${esc(item.accountMasked || '')}</small></td>
      <td><span class="badge ${payoutBadge(item.status)}">${label(item.status)}</span><small>${esc(item.reviewNote || payoutStatusNotes[item.status] || '')}</small></td>
      <td>${item.settlementReference ? esc(item.settlementReference) : '—'}<small>${item.reviewedAt ? fmtDate(item.reviewedAt) : ''}</small></td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>`;
  });
  return cards
    + toolbar(requests.length, { statusesList: ['PENDING_REVIEW', 'SETTLED', 'REJECTED', 'CANCELLED'] })
    + table(['提现单', '商家', '金额', '收款账户', '状态', '打款凭证', '操作'], rows, requests.length);
}

const baseBindPayoutsView = bindView;
bindView = function () {
  baseBindPayoutsView();
  document.querySelectorAll('.approve-payout').forEach((button) => button.addEventListener('click', async () => {
    const item = (state.data.payoutRequests || []).find((row) => row.id === button.dataset.id);
    const account = item ? `${item.accountBank || ''} ${item.accountName || ''} ${item.accountMasked || ''}`.trim() : '';
    const reference = prompt(`确认已向以下账户完成打款：\n${account || '请人工核对收款信息'}\n金额 ${item ? money(item.amountInCents) : ''}\n\n填写打款凭证号`, '平台线下打款');
    if (reference === null) return;
    if (!reference.trim()) return showToast('请填写打款凭证');
    await api(`/api/admin/payout-requests/${button.dataset.id}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'APPROVE', reference: reference.trim() })
    });
    showToast('提现已确认打款');
    await load();
  }));
  document.querySelectorAll('.reject-payout').forEach((button) => button.addEventListener('click', async () => {
    const reviewNote = prompt('请填写驳回原因（会通知商家）', '收款账户信息需要核对');
    if (reviewNote === null) return;
    if (!reviewNote.trim()) return showToast('请填写驳回原因');
    await api(`/api/admin/payout-requests/${button.dataset.id}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'REJECT', reviewNote: reviewNote.trim() })
    });
    showToast('提现申请已驳回');
    await load();
  }));
};

// 超时预警视图：把巡检结果落成一张“谁该做什么、还剩多久”的清单。
const slaOwnerLabels = { MERCHANT: '商家', PLATFORM: '平台运营' };
const slaJumpViews = {
  ORDER: 'orders',
  PHONE_PLAN: 'phones',
  RECHARGE: 'recharges',
  BROADBAND: 'broadband',
  PLATE: 'plates',
  AFTER_SALE: 'afterSales',
  PAYOUT: 'payouts',
  LEAD: 'leads'
};

function slaLevelBadge(alert) {
  if (alert.status === 'RESOLVED') return 'green';
  if (alert.level === 'OVERDUE') return 'red';
  return 'orange';
}

function slaCountdown(alert) {
  if (alert.status === 'RESOLVED') return '已关闭';
  const diffMinutes = Math.round((new Date(alert.dueAt).getTime() - Date.now()) / 60000);
  if (diffMinutes <= 0) {
    const overdue = Math.abs(diffMinutes);
    return overdue >= 60 ? `已超时 ${Math.floor(overdue / 60)} 小时 ${overdue % 60} 分` : `已超时 ${overdue} 分钟`;
  }
  return diffMinutes >= 60 ? `剩余 ${Math.floor(diffMinutes / 60)} 小时 ${diffMinutes % 60} 分` : `剩余 ${diffMinutes} 分钟`;
}

function patrolView() {
  const summary = state.data.slaSummary || {};
  const patrol = state.data.patrolState || {};
  const alerts = (state.data.slaAlerts || [])
    .filter(match)
    .filter((alert) => (state.status === 'ALL' ? alert.status !== 'RESOLVED' : alert.status === state.status || alert.level === state.status))
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const cards = `<div class="metric-grid">
    ${metric('已超时', summary.overdueCount || 0, '超过承诺时限仍未处理', true)}
    ${metric('即将超时', summary.warningCount || 0, '进入预警窗口需提前处理')}
    ${metric('待商家处理', summary.merchantOwnedCount || 0, '已同步站内通知给商家')}
    ${metric('待平台处理', summary.platformOwnedCount || 0, '需运营人工推进')}
  </div>
  <div class="page-actions"><p>上次巡检 ${patrol.lastRunAt ? fmtDate(patrol.lastRunAt) : '尚未执行'} · 累计 ${patrol.runCount || 0} 次 · 本次新增 ${patrol.lastCreated || 0} / 关闭 ${patrol.lastResolved || 0}</p><div><button id="runPatrol" class="primary">立即巡检</button></div></div>`;
  const rows = alerts.map((alert) => {
    const actions = alert.status === 'OPEN'
      ? `<button class="text-button ack-alert" data-id="${esc(alert.id)}">认领处理</button>`
      : (alert.status === 'ACKNOWLEDGED' ? '<span class="muted-empty">已认领</span>' : '<span class="muted-empty">已关闭</span>');
    const jump = slaJumpViews[alert.businessType]
      ? `<button class="text-button goto-alert" data-view="${slaJumpViews[alert.businessType]}">查看业务</button>`
      : '';
    return `<tr>
      <td><strong>${esc(alert.ruleLabel)}</strong><small>${esc(alert.businessNo)}</small></td>
      <td>${esc(alert.detail || '—')}</td>
      <td>${esc(slaOwnerLabels[alert.ownerRole] || alert.ownerRole)}<small>${esc(alert.merchantName || '平台内部')}</small></td>
      <td>${fmtDate(alert.dueAt)}<small>${slaCountdown(alert)}</small></td>
      <td><span class="badge ${slaLevelBadge(alert)}">${label(alert.status === 'RESOLVED' ? 'RESOLVED' : alert.level)}</span><small>${esc(alert.acknowledgeNote || alert.resolvedReason || label(alert.status))}</small></td>
      <td><div class="row-actions">${actions}${jump}</div></td>
    </tr>`;
  });
  return cards
    + toolbar(alerts.length, { statusesList: ['OVERDUE', 'WARNING', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED'] })
    + table(['预警规则', '业务详情', '责任方', '承诺时限', '状态', '操作'], rows, alerts.length);
}

const baseBindPatrolView = bindView;
bindView = function () {
  baseBindPatrolView();
  document.querySelector('#runPatrol')?.addEventListener('click', async () => {
    const result = await api('/api/admin/patrol/run', { method: 'POST' });
    showToast(`巡检完成：新增 ${result.data.created} · 关闭 ${result.data.resolved} · 待处理 ${result.data.open}`);
    await load();
  });
  document.querySelectorAll('.ack-alert').forEach((button) => button.addEventListener('click', async () => {
    const note = prompt('填写处理说明（会同步给责任商家）', '已电话联系跟进');
    if (note === null) return;
    if (!note.trim()) return showToast('请填写处理说明');
    await api(`/api/admin/sla-alerts/${button.dataset.id}/acknowledge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: note.trim() })
    });
    showToast('已认领该预警');
    await load();
  }));
  document.querySelectorAll('.goto-alert').forEach((button) => button.addEventListener('click', () => goView(button.dataset.view)));
};

// ===== 商家服务分 =====
const scoreStageBadges = { NORMAL: 'green', LIMITED: 'orange', RESTRICTED: 'red' };
const scoreStageConsequences = {
  NORMAL: '曝光正常 · 可自主上新',
  LIMITED: '曝光降权 60% · 新增商品需复核',
  RESTRICTED: '曝光降权 20% · 暂停上新'
};

function scoreBreakdownText(item) {
  return (item.breakdown || []).map((part) => `${part.label} ${part.score}`).join(' · ');
}

function scoresView() {
  const summary = state.data.merchantScoreSummary || {};
  const pending = state.data.pendingPublishProducts || [];
  const scoreCases = state.data.serviceScoreCases || [];
  const autoDelisted = state.data.autoDelistedProducts || [];
  const logs = state.data.merchantScoreLogs || [];
  const items = (state.data.merchantScores || [])
    .filter(match)
    .filter((item) => state.status === 'ALL' || item.stage === state.status || item.grade === state.status);
  const cards = `<div class="metric-grid">
    ${metric('服务分均值', summary.averageScore || 0, `已评分商家 ${summary.scoredCount || 0} 家`, true)}
    ${metric('正常经营', summary.normalCount || 0, '曝光与上新不受限')}
    ${metric('限流整改', summary.limitedCount || 0, '曝光降权且上新需复核')}
    ${metric('暂停上新', summary.restrictedCount || 0, '需先处理超时与售后')}
  </div>`;
  const templatePanel = `<section class="panel"><div class="panel-head"><h2>微信订阅消息模板</h2><span>服务分与订单提醒</span></div><div class="form-grid" style="grid-template-columns:repeat(2,1fr)">
    <label>服务分下降模板 ID<input id="scoreStageTemplate" value="${esc(state.data.settings?.scoreStageWarningTemplateId || '')}"></label>
    <label>整改申请模板 ID<input id="scoreRectifyApplyTemplate" value="${esc(state.data.settings?.scoreRectifyApplyTemplateId || '')}"></label>
    <label>整改结果模板 ID<input id="scoreRectifyResultTemplate" value="${esc(state.data.settings?.scoreRectifyResultTemplateId || '')}"></label>
    <label>申诉结果模板 ID<input id="scoreAppealResultTemplate" value="${esc(state.data.settings?.scoreAppealResultTemplateId || '')}"></label>
    <label>商品下架提醒模板 ID<input id="productAutoDelistTemplate" value="${esc(state.data.settings?.productAutoDelistTemplateId || '')}"></label>
    <label>商品恢复提醒模板 ID<input id="productComplianceRestoredTemplate" value="${esc(state.data.settings?.productComplianceRestoredTemplateId || '')}"></label>
    <label>低库存提醒模板 ID<input id="stockLowStockTemplate" value="${esc(state.data.settings?.stockLowStockTemplateId || '')}"></label>
    <label>履约超时提醒模板 ID<input id="slaWarningTemplate" value="${esc(state.data.settings?.slaWarningTemplateId || '')}"></label>
    <label>订单状态模板 ID<input id="orderStatusTemplate" value="${esc(state.data.settings?.orderStatusTemplateId || '')}"></label>
    <label>订单客服模板 ID<input id="orderServiceTemplate" value="${esc(state.data.settings?.orderServiceTemplateId || '')}"></label>
    <label>售后进度模板 ID<input id="afterSaleTemplate" value="${esc(state.data.settings?.afterSaleTemplateId || '')}"></label>
  </div><button class="primary" style="margin-top:12px" id="saveScoreTemplates">保存模板配置</button></section>`;
  const pendingPanel = pending.length
    ? `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>商品复核</h2><span>限流商家新增的商品</span></div><div class="table-wrap"><table><thead><tr><th>商品</th><th>商家</th><th>价格</th><th>说明</th><th>操作</th></tr></thead><tbody>${pending.map((product) => `<tr>
        <td><strong>${esc(product.name)}</strong></td>
        <td>${esc(product.merchantName || '—')}</td>
        <td>${money(product.priceInCents)}</td>
        <td>${esc(product.publishReviewNote || '—')}</td>
        <td><div class="row-actions"><button class="text-button review-publish" data-id="${esc(product.id)}" data-decision="APPROVED">通过上架</button><button class="text-button review-publish" data-id="${esc(product.id)}" data-decision="REJECTED">驳回</button></div></td>
      </tr>`).join('')}</tbody></table></div></section>`
    : '';
  const casePanel = `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>申诉与整改工单</h2><span>48 小时内处理</span></div><div class="table-wrap"><table><thead><tr><th>工单</th><th>商家</th><th>类型与说明</th><th>提交分</th><th>状态</th><th>操作</th></tr></thead><tbody>${scoreCases.map((item) => `<tr>
      <td><strong>${esc(item.caseNo)}</strong><small>${fmtDate(item.createdAt)}</small></td>
      <td>${esc(item.merchantName)}</td>
      <td>${esc(item.typeLabel)}${item.reasonTypeLabel ? ` · ${esc(item.reasonTypeLabel)}` : ''}${item.productName ? `<small>关联商品：${esc(item.productName)}</small>` : ''}<small>${esc(item.reason)}</small>${item.plan ? `<small>计划：${esc(item.plan)}</small>` : ''}${item.evidence?.length ? `<small>凭证 ${item.evidence.length} 张</small><div class="material-grid">${item.evidence.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="material-thumb" src="${esc(url)}" alt="申诉凭证" loading="lazy"></a>`).join('')}</div>` : ''}</td>
      <td>${item.score}<small>${esc(label(item.stage))}</small></td>
      <td><span class="badge ${item.status === 'COMPLETED' ? 'green' : item.status === 'REJECTED' ? 'red' : 'orange'}">${esc(label(item.status))}</span>${item.appliedAdjustment ? `<small>补分 +${item.appliedAdjustment}</small>` : ''}${item.adminNote ? `<small>${esc(item.adminNote)}</small>` : ''}</td>
      <td>${item.status === 'SUBMITTED' ? `<div class="row-actions"><button class="text-button review-score-case" data-id="${esc(item.id)}" data-decision="APPROVE">通过</button><button class="text-button review-score-case" data-id="${esc(item.id)}" data-decision="REJECT">驳回</button></div>` : '已处理'}</td>
    </tr>`).join('') || `<tr><td colspan="6" class="empty">暂无申诉或整改工单</td></tr>`}</tbody></table></div></section>`;
  const autoDelistPanel = `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>低质自动下架</h2><span>复核后可恢复展示</span></div><div class="table-wrap"><table><thead><tr><th>商品</th><th>商家</th><th>触发依据</th><th>整改状态</th><th>操作</th></tr></thead><tbody>${autoDelisted.map((item) => `<tr>
      <td><strong>${esc(item.name)}</strong><small>${esc(item.id)}</small></td>
      <td>${esc(item.merchantName || '')}</td>
      <td>${esc(item.reason)}<small>低分 ${item.metrics?.lowRatingCount || 0} 条 · 均分 ${item.metrics?.averageRating || 0}</small></td>
      <td><span class="badge orange">${esc({ DELISTED: '待整改', REVIEW_PENDING: '整改待复核', REVIEW_REJECTED: '整改未通过' }[item.status] || '处理中')}</span>${item.caseNo ? `<small>工单 ${esc(item.caseNo)}</small>` : ''}<small>${esc(item.reviewNote || '待商家提交整改')}</small></td>
      <td><button class="text-button restore-compliance" data-id="${esc(item.id)}">复核恢复</button></td>
    </tr>`).join('') || `<tr><td colspan="5" class="empty">暂无自动下架商品</td></tr>`}</tbody></table></div></section>`;
  const rows = items.map((item) => `<tr>
    <td><strong>${esc(item.merchantName)}</strong><small>${esc(item.merchantId)}</small></td>
    <td><strong>${item.score}</strong><small>${esc(label(item.grade))}${item.manualAdjustment ? ` · 人工 ${item.manualAdjustment > 0 ? '+' : ''}${item.manualAdjustment}` : ''}${item.metrics?.compliancePenalty ? ` · 风控 -${item.metrics.compliancePenalty}` : ''}</small></td>
    <td>${esc(scoreBreakdownText(item))}</td>
    <td>按时 ${item.metrics?.onTimeCount || 0} / 超时 ${item.metrics?.lateCount || 0}<small>售后 ${item.metrics?.afterSaleCount || 0} · 预警 ${item.metrics?.overdueAlertCount || 0}</small></td>
    <td><span class="badge ${scoreStageBadges[item.stage] || 'orange'}">${esc(label(item.stage))}</span><small>${esc(scoreStageConsequences[item.stage] || '')}</small></td>
    <td><div class="row-actions"><button class="text-button adjust-score" data-id="${esc(item.merchantId)}">人工调整</button><button class="text-button goto-alert" data-view="patrol">查看预警</button></div></td>
  </tr>`);
  const logPanel = `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>服务分变更记录</h2><span>仅记录分档变化与人工调整</span></div><div class="log-list">${logs.slice(0, 8).map((log) => `<div class="log-item"><div><strong>${esc(log.merchantName)}</strong><p>${esc(log.note || '')}</p></div><small>${fmtDate(log.createdAt)}</small></div>`).join('') || '<p class="muted-empty">暂无变更记录</p>'}</div></section>`;
  return cards
    + templatePanel
    + toolbar(items.length, { statusesList: ['NORMAL', 'LIMITED', 'RESTRICTED'] })
    + table(['商家', '服务分', '维度得分', '履约与售后', '平台处置', '操作'], rows, items.length)
    + pendingPanel
    + casePanel
    + autoDelistPanel
    + logPanel;
}

const baseBindScoresView = bindView;
bindView = function () {
  baseBindScoresView();
  document.querySelector('#dispatchSubscribe')?.addEventListener('click', async () => {
    const result = await api('/api/admin/subscribe-messages/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 20 })
    });
    showToast(`派发完成：成功 ${result.sent} · 失败 ${result.failed} · 剩余 ${result.remaining}`);
    await load();
  });
  document.querySelectorAll('.retry-subscribe').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/admin/subscribe-messages/${button.dataset.id}/retry`, { method: 'POST' });
    showToast('已加入发送队列');
    await load();
  }));
  document.querySelectorAll('.adjust-score').forEach((button) => button.addEventListener('click', async () => {
    const raw = prompt('人工调整分值（-20 到 20 的整数）', '-5');
    if (raw === null) return;
    const adjustment = Number(raw);
    if (!Number.isInteger(adjustment) || adjustment < -20 || adjustment > 20) return showToast('请输入 -20 到 20 的整数');
    const reason = prompt('调整原因（会同步给商家）', '学校反馈的服务问题');
    if (reason === null) return;
    if (!reason.trim()) return showToast('请填写调整原因');
    const result = await api(`/api/admin/merchant-scores/${button.dataset.id}/adjust`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adjustment, reason: reason.trim() })
    });
    showToast(`已调整为 ${result.data.serviceScore.score} 分（${result.data.serviceScore.stageLabel}）`);
    await load();
  }));
  document.querySelectorAll('.review-publish').forEach((button) => button.addEventListener('click', async () => {
    const decision = button.dataset.decision;
    let note = '';
    if (decision === 'REJECTED') {
      const input = prompt('填写驳回原因（会同步给商家）', '商品信息不完整');
      if (input === null) return;
      if (!input.trim()) return showToast('请填写驳回原因');
      note = input.trim();
    }
    await api(`/api/admin/products/${button.dataset.id}/publish-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, note })
    });
    showToast(decision === 'APPROVED' ? '商品已上架' : '已驳回该商品');
    await load();
  }));
  document.querySelectorAll('.review-score-case').forEach((button) => button.addEventListener('click', async () => {
    const decision = button.dataset.decision;
    const note = prompt(decision === 'APPROVE' ? '填写通过原因或核定结论' : '填写驳回原因', decision === 'APPROVE' ? '证据材料已核实' : '证据不足，维持原分');
    if (note === null) return;
    if (!note.trim()) return showToast('请填写处理结论');
    const adjustment = decision === 'APPROVE' ? Number(prompt('核定补分（0-20 的整数）', '5') || 0) : 0;
    if (decision === 'APPROVE' && (!Number.isInteger(adjustment) || adjustment < 0 || adjustment > 20)) return showToast('补分需为 0-20 的整数');
    await api(`/api/admin/score-cases/${button.dataset.id}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, note: note.trim(), adjustment })
    });
    showToast('工单已处理');
    await load();
  }));
  document.querySelectorAll('.restore-compliance').forEach((button) => button.addEventListener('click', async () => {
    const note = prompt('填写复核结论', '整改完成，允许恢复展示');
    if (note === null) return;
    if (!note.trim()) return showToast('请填写复核结论');
    await api(`/api/admin/products/${button.dataset.id}/compliance-restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: note.trim() })
    });
    showToast('商品已恢复上架');
    await load();
  }));
  document.querySelector('#saveScoreTemplates')?.addEventListener('click', async () => {
    await api('/api/admin/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scoreStageWarningTemplateId: document.querySelector('#scoreStageTemplate').value.trim(),
        scoreRectifyApplyTemplateId: document.querySelector('#scoreRectifyApplyTemplate').value.trim(),
        scoreRectifyResultTemplateId: document.querySelector('#scoreRectifyResultTemplate').value.trim(),
        scoreAppealResultTemplateId: document.querySelector('#scoreAppealResultTemplate').value.trim(),
        productAutoDelistTemplateId: document.querySelector('#productAutoDelistTemplate').value.trim(),
        productComplianceRestoredTemplateId: document.querySelector('#productComplianceRestoredTemplate').value.trim(),
        stockLowStockTemplateId: document.querySelector('#stockLowStockTemplate').value.trim(),
        slaWarningTemplateId: document.querySelector('#slaWarningTemplate').value.trim(),
        orderStatusTemplateId: document.querySelector('#orderStatusTemplate').value.trim(),
        orderServiceTemplateId: document.querySelector('#orderServiceTemplate').value.trim(),
        afterSaleTemplateId: document.querySelector('#afterSaleTemplate').value.trim()
      })
    });
    showToast('订阅模板已保存');
    await load();
  });
};

// ===== 管理员管理 =====
titles.admins = '管理员管理';
collections.admins = 'adminUsers';
Object.assign(statuses, { ACTIVE: '启用', DISABLED: '停用' });
const adminRoleLabels = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营管理员',
  FINANCE: '财务管理员',
  SUPPORT: '客服管理员'
};

function admins() {
  const items = (state.data.adminUsers || []).filter(match).filter(statusMatch);
  const rows = items.map((item) => {
    const isSelf = item.id === state.user?.id;
    return `<tr>
      <td><strong>${esc(item.displayName || item.username)}</strong><small>${esc(item.username)}</small></td>
      <td>${esc(adminRoleLabels[item.role] || item.role)}</td>
      <td><span class="badge ${item.status === 'DISABLED' ? 'red' : 'green'}">${label(item.status)}</span></td>
      <td>${fmtDate(item.createdAt)}<small>更新 ${fmtDate(item.updatedAt)}</small></td>
      <td><div class="row-actions">
        <button class="table-button edit-admin" data-id="${esc(item.id)}">编辑</button>
        <button class="text-button toggle-admin" data-id="${esc(item.id)}" data-status="${item.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED'}" ${isSelf ? 'disabled' : ''}>${item.status === 'DISABLED' ? '启用' : '停用'}</button>
        <button class="text-button reset-admin-password" data-id="${esc(item.id)}">重置密码</button>
      </div></td>
    </tr>`;
  });
  return `<div class="page-actions"><p>共 ${items.length} 个账号</p><div><button id="addAdmin" class="primary">＋ 新增管理员</button></div></div>
    <div class="filterbar"><div class="filters"><input id="listSearch" class="search" value="${esc(state.query)}" placeholder="搜索姓名或账号"><select id="statusFilter" class="filter-select"><option value="ALL">全部状态</option><option value="ACTIVE" ${state.status === 'ACTIVE' ? 'selected' : ''}>启用</option><option value="DISABLED" ${state.status === 'DISABLED' ? 'selected' : ''}>停用</option></select></div><button id="exportButton" class="export-button">导出 CSV</button></div>
    ${table(['管理员', '角色', '状态', '时间', '操作'], rows, items.length)}`;
}

const baseRenderWithAdmins = render;
render = function () {
  if (state.view === 'admins') {
    document.querySelector('#pageTitle').textContent = titles.admins;
    document.querySelector('#breadcrumb').textContent = titles.admins;
    document.querySelector('#content').innerHTML = admins();
    bindView();
    return;
  }
  return baseRenderWithAdmins();
};

function toggleAdminModal(show) {
  document.querySelector('#adminModal').classList.toggle('hidden', !show);
  document.querySelector('#modalBackdrop').classList.toggle('hidden', !show);
}

function openAdmin(admin) {
  const editing = Boolean(admin);
  document.querySelector('#adminModalTitle').textContent = editing ? '编辑管理员' : '新增管理员';
  document.querySelector('#adminId').value = admin?.id || '';
  document.querySelector('#adminUsername').value = admin?.username || '';
  document.querySelector('#adminUsername').disabled = editing;
  document.querySelector('#adminDisplayName').value = admin?.displayName || '';
  document.querySelector('#adminRole').value = admin?.role || 'OPERATOR';
  document.querySelector('#adminPassword').value = '';
  document.querySelector('#adminPassword').required = !editing;
  document.querySelector('#adminPassword').placeholder = editing ? '留空则不修改密码' : '至少 12 位';
  toggleAdminModal(true);
}

async function saveAdmin(event) {
  event.preventDefault();
  const id = document.querySelector('#adminId').value;
  const password = document.querySelector('#adminPassword').value;
  const payload = {
    displayName: document.querySelector('#adminDisplayName').value.trim(),
    role: document.querySelector('#adminRole').value
  };
  if (password) payload.password = password;
  if (!id) {
    payload.username = document.querySelector('#adminUsername').value.trim();
    payload.password = password;
  }
  await api(id ? `/api/admin/admins/${id}` : '/api/admin/admins', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  toggleAdminModal(false);
  showToast(id ? '管理员已更新' : '管理员已创建');
  await load();
}

async function toggleAdminStatus(id, nextStatus) {
  await api(`/api/admin/admins/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: nextStatus })
  });
  showToast(nextStatus === 'DISABLED' ? '管理员已停用' : '管理员已启用');
  await load();
}

async function resetAdminPassword(id) {
  const password = prompt('请输入新密码（至少 12 位）');
  if (password === null) return;
  if (password.length < 12) return showToast('密码至少需要 12 位');
  await api(`/api/admin/admins/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  });
  showToast('密码已重置');
  await load();
}

const baseBindViewWithAdmins = bindView;
bindView = function () {
  baseBindViewWithAdmins();
  document.querySelector('#addAdmin')?.addEventListener('click', () => openAdmin());
  document.querySelectorAll('.edit-admin').forEach((button) => button.addEventListener('click', () => {
    const admin = (state.data.adminUsers || []).find((item) => item.id === button.dataset.id);
    if (admin) openAdmin(admin);
  }));
  document.querySelectorAll('.toggle-admin').forEach((button) => button.addEventListener('click', () => {
    toggleAdminStatus(button.dataset.id, button.dataset.status).catch((error) => showToast(error.message));
  }));
  document.querySelectorAll('.reset-admin-password').forEach((button) => button.addEventListener('click', () => {
    resetAdminPassword(button.dataset.id).catch((error) => showToast(error.message));
  }));
};

document.querySelector('#closeAdminModal').addEventListener('click', () => toggleAdminModal(false));
document.querySelector('#cancelAdminModal').addEventListener('click', () => toggleAdminModal(false));
document.querySelector('#modalBackdrop').addEventListener('click', () => {
  if (!document.querySelector('#adminModal').classList.contains('hidden')) toggleAdminModal(false);
});
document.querySelector('#adminForm').addEventListener('submit', (event) => {
  saveAdmin(event).catch((error) => showToast(error.message));
});
