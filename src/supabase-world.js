import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Supabase URL and publishable key are intended for browser use. RLS is the security boundary.
const SUPABASE_URL = 'https://ouihbvxevslmuvkzgchr.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_1K3Ee2T5ITqegWIMbpN8OQ_LuOCS3dT';
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const $ = id => document.getElementById(id);
const cityNames = {
  'elite-city':'مدينة النخبة','business-city':'مدينة الأعمال','coast-city':'مدينة الساحل',
  'future-city':'مدينة المستقبل','challenge-city':'مدينة التحديات'
};
let currentUser = null, channel = null, plotsCache = [];
const status = message => { if ($('sbStatus')) $('sbStatus').textContent = message; };
const selectedCity = () => $('sbCity').value;
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function loadPlots() {
  if (!currentUser) {
    plotsCache = [];
    if ($('sbSummary')) $('sbSummary').textContent = 'سجّل الدخول أو أنشئ حساباً لعرض أراضي المدينة المشتركة.';
    if ($('sbPlots')) $('sbPlots').innerHTML = '';
    return;
  }
  const cityId = selectedCity();
  const { data, error } = await supabase.from('plots').select('id,city_id,plot_no,price,owner_id,owner_name').eq('city_id', cityId).order('plot_no');
  if (error) {
    if (error.code === 'PGRST205') {
      plotsCache = [];
      if ($('sbPlots')) $('sbPlots').innerHTML = '';
      if ($('sbSummary')) $('sbSummary').textContent = 'لم يتم تحميل أراضي المدينة.';
      status('قاعدة البيانات غير مهيّأة بعد — اضغط زر «إعداد المدينة المشتركة» أعلاه، دقيقة واحدة وتعمل.');
      return;
    }
    throw error;
  }
  plotsCache = data || [];
  const owned = plotsCache.filter(p => p.owner_id).length;
  $('sbSummary').textContent = `${cityNames[cityId]} · ${plotsCache.length} قطعة · ${owned} مملوكة · ${plotsCache.length-owned} متاحة`;
  $('sbPlots').innerHTML = plotsCache.map(p => `<button type="button" class="sb-plot ${p.owner_id ? 'sb-owned':'sb-free'}" data-plot="${p.plot_no}" title="قطعة ${p.plot_no}">${p.plot_no}<small>${p.owner_id ? safe(p.owner_name || 'مملوكة') : `${Number(p.price).toLocaleString()} 🪙`}</small></button>`).join('');
  $('sbPlots').querySelectorAll('[data-plot]').forEach(b => b.addEventListener('click', () => { $('sbPlot').value = b.dataset.plot; }));
}

async function refreshSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  currentUser = session?.user || null;
  status(currentUser ? `متصل: ${currentUser.email} · المزامنة مفعّلة في ${cityNames[selectedCity()]}` : 'غير مسجل الدخول. أنشئ حساباً أو سجّل الدخول.');
  if (channel) { await supabase.removeChannel(channel); channel = null; }
  if (currentUser) {
    channel = supabase.channel(`city-${selectedCity()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plots', filter: `city_id=eq.${selectedCity()}` }, async () => {
        try { await loadPlots(); status(`تم استلام تحديث مباشر لأراضي ${cityNames[selectedCity()]}.`); }
        catch (e) { status('خطأ تحديث المزامنة: ' + e.message); }
      }).subscribe();
  }
  await loadPlots();
}

$('sbRegister').addEventListener('click', async () => {
  const email = $('sbEmail').value.trim(), password = $('sbPassword').value, displayName = $('sbName').value.trim();
  if (!displayName) return status('أدخل اسم اللاعب أولاً.');
  if (password.length < 8) return status('كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
  status('جارٍ إنشاء الحساب…');
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
  if (error) return status('تعذر إنشاء الحساب: ' + error.message);
  if (!data.session) status('تم إنشاء الحساب. تحقق من بريدك لتأكيده، ثم سجّل الدخول.');
  else { currentUser = data.user; status('تم إنشاء الحساب وتسجيل الدخول.'); await loadPlots(); }
});
$('sbLogin').addEventListener('click', async () => {
  status('جارٍ تسجيل الدخول…');
  const { data, error } = await supabase.auth.signInWithPassword({ email: $('sbEmail').value.trim(), password: $('sbPassword').value });
  if (error) return status('تعذر تسجيل الدخول: ' + error.message);
  currentUser = data.user; await refreshSession(); status('تم تسجيل الدخول والمزامنة مع المدينة.');
});
$('sbLogout').addEventListener('click', async () => {
  const { error } = await supabase.auth.signOut(); if (error) return status(error.message);
  currentUser = null; await refreshSession();
});
$('sbRefresh').addEventListener('click', async () => { try { await loadPlots(); status(currentUser ? 'تم تحديث بيانات الأراضي.' : 'أنت غير مسجّل الدخول — أنشئ حساباً أو سجّل الدخول أولاً لعرض الأراضي.'); } catch(e) { status('تعذر التحديث: ' + e.message); } });
$('sbCity').addEventListener('change', async () => { try { await refreshSession(); } catch(e) { status('تعذر تبديل المدينة: ' + e.message); } });
$('sbBuy').addEventListener('click', async () => {
  if (!currentUser) return status('سجّل الدخول أولاً.');
  const plotNo = Number($('sbPlot').value);
  if (!Number.isInteger(plotNo) || plotNo < 1 || plotNo > 50) return status('رقم القطعة يجب أن يكون بين 1 و50.');
  status('جارٍ تنفيذ الشراء الذرّي بأمان…');
  const { data, error } = await supabase.rpc('purchase_plot', { p_city_id: selectedCity(), p_plot_no: plotNo });
  if (error) return status('لم تتم عملية الشراء: ' + error.message);
  status(data?.message || 'تمت معالجة عملية الشراء.');
  try { await loadPlots(); } catch(e) { status('تمت العملية لكن تعذر تحديث العرض: ' + e.message); }
});
supabase.auth.onAuthStateChange((_event, session) => { currentUser = session?.user || null; });
(async () => { try { await refreshSession(); } catch (e) { status('تعذر تحميل Supabase: ' + e.message + ' — تأكد من تنفيذ supabase/schema.sql.'); } })();
